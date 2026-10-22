/**
 * Didit KYC provider integration tests — #315 [4b]
 *
 * Covers the acceptance criteria that don't require a live Didit sandbox:
 *   - webhook signature verification (valid / invalid / replayed)
 *   - POST /defi/kyc/start?provider=didit → onboardingUrl (Didit API mocked
 *     via globalThis.fetch, same pattern as rateCache.test.ts)
 *   - the full start → webhook → users.kyc_level update path, against the
 *     in-memory DB fallback (no Postgres needed — same pattern as
 *     kyc-gate.service.test.ts)
 *
 * NOT covered here (needs a human with real Didit sandbox credentials —
 * see the PR description): an actual round-trip against Didit's sandbox API.
 */
import { createHmac } from 'node:crypto';
import { strictEqual, ok } from 'node:assert';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import db from '../db/schema.js';
import { kycRoutes } from '../routes/kyc.js';
import { verifyDiditWebhookSignature } from '../lib/webhook-auth.js';
import { extractDiditDecisionReason, mapDiditStatus } from '../services/didit.service.js';
import { AppError } from '../utils/errors.js';

const JWT_SECRET = 'test_jwt_secret_kyc_didit';
const DIDIT_WEBHOOK_SECRET = 'test_didit_webhook_secret';
const DIDIT_SESSION_URL = 'https://verify.didit.me/session/mock-session-abc';

process.env.DIDIT_API_KEY = 'test_didit_api_key';
process.env.DIDIT_WORKFLOW_ID = 'test_workflow';
process.env.DIDIT_WORKFLOW_ID_L2 = 'test_workflow_l2';
process.env.DIDIT_WEBHOOK_SECRET = DIDIT_WEBHOOK_SECRET;

let lastDiditRequest: { url: string; body: any } | null = null;

function mockDiditSessionCreate(sessionId: string): void {
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    lastDiditRequest = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null };
    return new Response(JSON.stringify({ session_id: sessionId, url: DIDIT_SESSION_URL }), { status: 201 });
  }) as typeof fetch;
}

function signDidit(rawBody: string, secret: string, timestampSec: number) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

async function seedUser(): Promise<string> {
  const stellarAddress = `G${Math.random().toString(36).slice(2).toUpperCase().padEnd(55, 'X')}`.slice(0, 56);
  const user = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username) VALUES ($1, $2) RETURNING id`,
    [stellarAddress, `didit_test_${Math.random().toString(36).slice(2, 8)}`],
  );
  if (!user?.id) throw new Error('Failed to seed user');
  return user.id;
}

async function createApp() {
  const app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: JWT_SECRET });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.httpStatus).send({ code: error.code, message: error.userMessage });
      return;
    }
    reply.status(500).send({ code: 'INTERNAL_ERROR', message: error.message });
  });
  await app.register(kycRoutes);
  await app.ready();
  return app;
}

function makeToken(app: Awaited<ReturnType<typeof createApp>>, userId: string) {
  return (app as any).jwt.sign({ id: userId, stellar_address: 'GTEST' });
}

// ── 1. verifyDiditWebhookSignature — pure function (valid / invalid / replayed) ──

function testSignatureVerification_valid() {
  const body = JSON.stringify({ session_id: 's1', status: 'Approved' });
  const now = Date.now();
  const timestampSec = Math.floor(now / 1000);
  const sig = signDidit(body, DIDIT_WEBHOOK_SECRET, timestampSec);

  const result = verifyDiditWebhookSignature(body, sig, String(timestampSec), DIDIT_WEBHOOK_SECRET, { now });
  strictEqual(result.valid, true, 'correctly signed, fresh payload must verify');
  console.log('verifyDiditWebhookSignature: valid signature OK');
}

function testSignatureVerification_invalidSignature() {
  const body = JSON.stringify({ session_id: 's1', status: 'Approved' });
  const now = Date.now();
  const timestampSec = Math.floor(now / 1000);
  const wrongSig = signDidit(body, 'a-completely-different-secret', timestampSec);

  const result = verifyDiditWebhookSignature(body, wrongSig, String(timestampSec), DIDIT_WEBHOOK_SECRET, { now });
  strictEqual(result.valid, false, 'signature computed with the wrong secret must be rejected');
  console.log('verifyDiditWebhookSignature: invalid signature rejected OK');
}

function testSignatureVerification_tamperedBody() {
  const originalBody = JSON.stringify({ session_id: 's1', status: 'Declined' });
  const tamperedBody = JSON.stringify({ session_id: 's1', status: 'Approved' });
  const now = Date.now();
  const timestampSec = Math.floor(now / 1000);
  const sig = signDidit(originalBody, DIDIT_WEBHOOK_SECRET, timestampSec);

  // Signature was computed over the original body but verification runs
  // against the tampered one — must fail even though the secret is correct.
  const result = verifyDiditWebhookSignature(tamperedBody, sig, String(timestampSec), DIDIT_WEBHOOK_SECRET, { now });
  strictEqual(result.valid, false, 'signature must not verify against a body it was not computed over');
  console.log('verifyDiditWebhookSignature: tampered body rejected OK');
}

function testSignatureVerification_replayed() {
  const body = JSON.stringify({ session_id: 's1', status: 'Approved' });
  const now = Date.now();
  const staleTimestampSec = Math.floor((now - 10 * 60 * 1000) / 1000); // 10 min old, outside the 5 min default window
  const sig = signDidit(body, DIDIT_WEBHOOK_SECRET, staleTimestampSec);

  const result = verifyDiditWebhookSignature(body, sig, String(staleTimestampSec), DIDIT_WEBHOOK_SECRET, { now });
  strictEqual(result.valid, false, 'a validly signed but stale/replayed delivery must be rejected');
  ok(result.error?.toLowerCase().includes('window') || result.error?.toLowerCase().includes('replay'));
  console.log('verifyDiditWebhookSignature: replayed timestamp rejected OK');
}

function testSignatureVerification_missingHeaders() {
  const body = JSON.stringify({ session_id: 's1', status: 'Approved' });
  strictEqual(verifyDiditWebhookSignature(body, undefined, '123', DIDIT_WEBHOOK_SECRET).valid, false, 'missing signature header must fail');
  strictEqual(verifyDiditWebhookSignature(body, 'abc', undefined, DIDIT_WEBHOOK_SECRET).valid, false, 'missing timestamp header must fail');
  strictEqual(verifyDiditWebhookSignature(body, 'abc', '123', undefined).valid, false, 'missing secret (not configured) must fail');
  console.log('verifyDiditWebhookSignature: missing headers rejected OK');
}

// ── 2. Route-level: start (Etherfuse untouched, Didit new) ──────────────────

async function testStart_defaultsToEtherfuse_untouched() {
  // No provider query param → must still hit the Etherfuse branch, not Didit.
  // ETHERFUSE_API_KEY is intentionally not set in this test process, so the
  // distinguishing signal is the *specific* 503 code Etherfuse's branch throws.
  const app = await createApp();
  const userId = await seedUser();
  const token = makeToken(app, userId);

  const res = await app.inject({ method: 'POST', url: '/defi/kyc/start', headers: { authorization: `Bearer ${token}` } });
  strictEqual(res.statusCode, 503);
  strictEqual(JSON.parse(res.body).code, 'ETHERFUSE_NOT_CONFIGURED', 'no provider param must default to the untouched Etherfuse path');
  console.log('POST /defi/kyc/start: defaults to Etherfuse (unaffected by this change) OK');
  await app.close();
}

async function testStart_didit_notConfigured() {
  const app = await createApp();
  const userId = await seedUser();
  const token = makeToken(app, userId);

  const savedKey = process.env.DIDIT_API_KEY;
  delete process.env.DIDIT_API_KEY;
  try {
    const res = await app.inject({ method: 'POST', url: '/defi/kyc/start?provider=didit', headers: { authorization: `Bearer ${token}` } });
    strictEqual(res.statusCode, 503);
    strictEqual(JSON.parse(res.body).code, 'DIDIT_NOT_CONFIGURED');
  } finally {
    process.env.DIDIT_API_KEY = savedKey;
  }
  console.log('POST /defi/kyc/start?provider=didit: DIDIT_NOT_CONFIGURED graceful failure OK');
  await app.close();
}

async function testStart_didit_returnsOnboardingUrlAndCreatesSession() {
  const app = await createApp();
  const userId = await seedUser();
  const token = makeToken(app, userId);
  mockDiditSessionCreate('sess-start-1');

  const res = await app.inject({ method: 'POST', url: '/defi/kyc/start?provider=didit', headers: { authorization: `Bearer ${token}` } });
  strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  strictEqual(body.onboardingUrl, DIDIT_SESSION_URL);
  ok(body.expiresAt);

  const session = await db.getOne<{ session_id: string; user_id: string; requested_level: number; status: string }>(
    `SELECT session_id, user_id, requested_level, status FROM kyc_didit_sessions WHERE session_id = $1`,
    ['sess-start-1'],
  );
  ok(session, 'a kyc_didit_sessions row must be created at start');
  strictEqual(session!.user_id, userId);
  strictEqual(session!.requested_level, 1, 'defaults to level 1 when ?level= is omitted');
  strictEqual(session!.status, 'pending');
  ok(lastDiditRequest!.url.endsWith('/v3/session/'), 'session must be created on the v3 endpoint');
  strictEqual(lastDiditRequest!.body.workflow_id, 'test_workflow');
  strictEqual(lastDiditRequest!.body.vendor_data, userId, 'vendor_data is the stable user id');
  console.log('POST /defi/kyc/start?provider=didit: onboardingUrl + pending session row OK');
  await app.close();
}

async function testStart_didit_level2UsesItsOwnWorkflow() {
  const app = await createApp();
  const userId = await seedUser();
  const token = makeToken(app, userId);
  mockDiditSessionCreate('sess-l2-workflow');

  const res = await app.inject({ method: 'POST', url: '/defi/kyc/start?provider=didit&level=2', headers: { authorization: `Bearer ${token}` } });
  strictEqual(res.statusCode, 200);
  strictEqual(lastDiditRequest!.body.workflow_id, 'test_workflow_l2', 'level 2 must use the level-2 workflow');

  const saved = process.env.DIDIT_WORKFLOW_ID_L2;
  delete process.env.DIDIT_WORKFLOW_ID_L2;
  lastDiditRequest = null;
  try {
    const res2 = await app.inject({ method: 'POST', url: '/defi/kyc/start?provider=didit&level=2', headers: { authorization: `Bearer ${token}` } });
    strictEqual(res2.statusCode, 503);
    strictEqual(JSON.parse(res2.body).code, 'DIDIT_NOT_CONFIGURED');
    strictEqual(lastDiditRequest, null, 'without a level-2 workflow Didit must not be called');
  } finally {
    process.env.DIDIT_WORKFLOW_ID_L2 = saved;
  }
  console.log('POST /defi/kyc/start?provider=didit&level=2: own workflow, 503 without it OK');
  await app.close();
}

async function testStart_didit_reusedSessionNotInsertedTwice() {
  const app = await createApp();
  const userId = await seedUser();
  const token = makeToken(app, userId);
  mockDiditSessionCreate('sess-reused-1');

  const first = await app.inject({ method: 'POST', url: '/defi/kyc/start?provider=didit', headers: { authorization: `Bearer ${token}` } });
  const second = await app.inject({ method: 'POST', url: '/defi/kyc/start?provider=didit', headers: { authorization: `Bearer ${token}` } });
  strictEqual(first.statusCode, 200);
  strictEqual(second.statusCode, 200, 'Didit returning the same unfinished session must not fail');

  const { rows } = await db.query(
    `SELECT session_id FROM kyc_didit_sessions WHERE session_id = $1`,
    ['sess-reused-1'],
  );
  strictEqual(rows.length, 1);
  console.log('POST /defi/kyc/start?provider=didit: reused Didit session stored once OK');
  await app.close();
}

function testMapDiditStatus_exactV3Vocabulary() {
  strictEqual(mapDiditStatus('Approved'), 'approved');
  for (const s of ['Declined', 'Abandoned', 'Expired', 'Kyc Expired']) {
    strictEqual(mapDiditStatus(s), 'rejected', `${s} ends the session without approval`);
  }
  for (const s of ['Not Started', 'In Progress', 'In Review', 'Resubmitted', 'approved', 'KYC Expired', undefined]) {
    strictEqual(mapDiditStatus(s as any), 'pending', `${s} must not decide anything`);
  }
  console.log('mapDiditStatus: exact v3 vocabulary OK');
}

function testExtractDiditDecisionReason() {
  strictEqual(extractDiditDecisionReason(undefined), null);
  strictEqual(extractDiditDecisionReason({ status: 'Approved', id_verifications: [{ warnings: [] }] }), null);
  strictEqual(
    extractDiditDecisionReason({
      session_id: 's',
      id_verifications: [{ warnings: [{ risk: 'DOCUMENT_EXPIRED', short_description: 'x' }] }],
      liveness_checks: [{ warnings: [{ risk: 'LOW_LIVENESS_SCORE' }, { risk: 'DOCUMENT_EXPIRED' }] }],
    }),
    'DOCUMENT_EXPIRED,LOW_LIVENESS_SCORE',
  );
  console.log('extractDiditDecisionReason: risk codes only OK');
}

// ── 3. Full path: start → webhook → users.kyc_level update ──────────────────

async function testFullPath_startWebhookApproves() {
  const app = await createApp();
  const userId = await seedUser();
  const token = makeToken(app, userId);
  mockDiditSessionCreate('sess-full-path-1');

  const startRes = await app.inject({ method: 'POST', url: '/defi/kyc/start?provider=didit&level=2', headers: { authorization: `Bearer ${token}` } });
  strictEqual(startRes.statusCode, 200);

  const webhookBodyObj = {
    session_id: 'sess-full-path-1',
    status: 'Approved',
    vendor_data: userId,
    decision: { status: 'Approved', id_verifications: [{ status: 'Approved', warnings: [] }] },
  };
  const rawBody = JSON.stringify(webhookBodyObj);
  const timestampSec = Math.floor(Date.now() / 1000);
  const signature = signDidit(rawBody, DIDIT_WEBHOOK_SECRET, timestampSec);

  const webhookRes = await app.inject({
    method: 'POST',
    url: '/defi/kyc/webhook/didit',
    payload: rawBody,
    headers: {
      'content-type': 'application/json',
      'x-signature': signature,
      'x-timestamp': String(timestampSec),
    },
  });
  strictEqual(webhookRes.statusCode, 200);
  strictEqual(JSON.parse(webhookRes.body).received, true);

  const user = await db.getOne<{ kyc_level: number; kyc_provider: string; kyc_level_verified_at: string | null }>(
    `SELECT kyc_level, kyc_provider, kyc_level_verified_at FROM users WHERE id = $1`,
    [userId],
  );
  strictEqual(user!.kyc_level, 2, 'kyc_level must be set to the level requested at session-start time');
  strictEqual(user!.kyc_provider, 'didit');
  ok(user!.kyc_level_verified_at, 'kyc_level_verified_at must be set');

  const session = await db.getOne<{ status: string }>(
    `SELECT status FROM kyc_didit_sessions WHERE session_id = $1`,
    ['sess-full-path-1'],
  );
  strictEqual(session!.status, 'approved');

  const statusRes = await app.inject({ method: 'GET', url: '/defi/kyc/status?provider=didit', headers: { authorization: `Bearer ${token}` } });
  strictEqual(statusRes.statusCode, 200);
  strictEqual(JSON.parse(statusRes.body).status, 'approved');

  console.log('start -> webhook -> users.kyc_level/provider/verified_at update (full path) OK');
  await app.close();
}

async function testWebhook_rejectsBadSignature() {
  const app = await createApp();
  const userId = await seedUser();
  mockDiditSessionCreate('sess-bad-sig');

  const rawBody = JSON.stringify({ session_id: 'sess-bad-sig', status: 'Approved', vendor_data: `${userId}:1` });
  const res = await app.inject({
    method: 'POST',
    url: '/defi/kyc/webhook/didit',
    payload: rawBody,
    headers: {
      'content-type': 'application/json',
      'x-signature': 'deadbeef',
      'x-timestamp': String(Math.floor(Date.now() / 1000)),
    },
  });
  strictEqual(res.statusCode, 401);

  const user = await db.getOne<{ kyc_level: number | null }>(`SELECT kyc_level FROM users WHERE id = $1`, [userId]);
  strictEqual(user!.kyc_level ?? 0, 0, 'an unsigned/invalid webhook must never update kyc_level');
  console.log('POST /defi/kyc/webhook/didit: bad signature rejected, no DB mutation OK');
  await app.close();
}

async function testWebhook_declinedDoesNotRaiseKycLevel() {
  const app = await createApp();
  const userId = await seedUser();
  mockDiditSessionCreate('sess-declined-1');
  const startToken = makeToken(app, userId);
  await app.inject({ method: 'POST', url: '/defi/kyc/start?provider=didit', headers: { authorization: `Bearer ${startToken}` } });

  const rawBody = JSON.stringify({
    session_id: 'sess-declined-1',
    status: 'Declined',
    vendor_data: userId,
    decision: { status: 'Declined', liveness_checks: [{ status: 'Declined', warnings: [{ risk: 'LIVENESS_FAILED' }] }] },
  });
  const timestampSec = Math.floor(Date.now() / 1000);
  const signature = signDidit(rawBody, DIDIT_WEBHOOK_SECRET, timestampSec);

  const res = await app.inject({
    method: 'POST',
    url: '/defi/kyc/webhook/didit',
    payload: rawBody,
    headers: { 'content-type': 'application/json', 'x-signature': signature, 'x-timestamp': String(timestampSec) },
  });
  strictEqual(res.statusCode, 200);

  const user = await db.getOne<{ kyc_level: number | null }>(`SELECT kyc_level FROM users WHERE id = $1`, [userId]);
  strictEqual(user!.kyc_level ?? 0, 0, 'a declined verification must not raise kyc_level');

  const session = await db.getOne<{ status: string; decision_reason: string | null }>(
    `SELECT status, decision_reason FROM kyc_didit_sessions WHERE session_id = $1`,
    ['sess-declined-1'],
  );
  strictEqual(session!.status, 'rejected');
  strictEqual(session!.decision_reason, 'LIVENESS_FAILED');
  console.log('POST /defi/kyc/webhook/didit: declined verification does not raise kyc_level OK');
  await app.close();
}

async function run() {
  console.log('Running Didit KYC provider tests...\n');
  testSignatureVerification_valid();
  testSignatureVerification_invalidSignature();
  testSignatureVerification_tamperedBody();
  testSignatureVerification_replayed();
  testSignatureVerification_missingHeaders();
  await testStart_defaultsToEtherfuse_untouched();
  await testStart_didit_notConfigured();
  await testStart_didit_returnsOnboardingUrlAndCreatesSession();
  await testStart_didit_level2UsesItsOwnWorkflow();
  await testStart_didit_reusedSessionNotInsertedTwice();
  testMapDiditStatus_exactV3Vocabulary();
  testExtractDiditDecisionReason();
  await testFullPath_startWebhookApproves();
  await testWebhook_rejectsBadSignature();
  await testWebhook_declinedDoesNotRaiseKycLevel();
  console.log('\n✅ All Didit KYC provider tests passed.');
}

run().catch((err) => {
  console.error('❌ Tests failed:', err);
  process.exit(1);
});
