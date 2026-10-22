import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.middleware.js';
import db from '../db/schema.js';
import { UpstreamError, NotFoundError, BadRequestError } from '../utils/errors.js';
import { createOnboardingUrl, getKycStatus } from '../services/etherfuse.service.js';
import {
  createDiditSession,
  diditWorkflowIdForLevel,
  extractDiditDecisionReason,
  mapDiditStatus,
} from '../services/didit.service.js';
import { verifyDiditWebhookSignature } from '../lib/webhook-auth.js';
import { CircuitOpenError, UpstreamTimeoutError } from '../lib/circuitBreaker.js';

// Etherfuse uses a HOSTED onboarding flow: we generate customerId/bankAccountId
// UUIDs and a presigned URL; the user completes identity verification, document
// upload, bank account (CLABE) linking, and agreement signing on Etherfuse's own
// page. We never collect KYC data ourselves. These IDs are permanently bound to
// the user once submitted — see docs/SPEI_ANCHOR_PLAN.md.

interface UserRow {
  id: string;
  stellar_address: string;
  username: string | null;
  email: string | null;
  etherfuse_customer_id: string | null;
  etherfuse_bank_account_id: string | null;
}

// RFC 5322 is a whole thing; this just catches obvious typos before we round-trip
// to Etherfuse (which does its own real validation server-side).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface DiditSessionRow {
  session_id: string;
  user_id: string;
  requested_level: number;
  status: 'pending' | 'approved' | 'rejected';
  decision_reason: string | null;
}

// KYC-1: aqui vivia `parseVendorData`, que leia usuario y nivel del cuerpo
// del webhook para decidir a quien verificar. Se retira a proposito: ese dato
// vuelve del proveedor y no puede ser la fuente de la decision. Ahora el
// `session_id` se resuelve contra `kyc_didit_sessions` y de ahi salen el
// usuario y el nivel. `vendor_data` va solo como el user id: Didit pide un
// identificador estable por persona, no uno por nivel.

async function startEtherfuseKyc(request: any) {
  if (!process.env.ETHERFUSE_API_KEY) {
    throw new UpstreamError(
      'ETHERFUSE_NOT_CONFIGURED',
      'La verificación de identidad no está disponible por el momento.',
      'ETHERFUSE_API_KEY not configured',
      503,
    );
  }

  const userId = request.user.id;
  const user = await db.getOne<UserRow>(
    'SELECT id, stellar_address, username, email, etherfuse_customer_id, etherfuse_bank_account_id FROM users WHERE id = $1',
    [userId],
  );
  if (!user) {
    throw new NotFoundError('User not found');
  }

  // Etherfuse's userInfo.email was optional until 2026-07-25, when it started
  // rejecting onboarding-url requests without it. MicoPay's Stellar-keypair
  // auth never collected an email from anyone, so the first time a user hits
  // this route we need one — either already on file, or freshly submitted.
  let email = user.email;
  const submittedEmail = typeof request.body?.email === 'string' ? request.body.email.trim() : undefined;
  if (!email && submittedEmail) {
    if (!EMAIL_RE.test(submittedEmail)) {
      throw new BadRequestError(
        'INVALID_EMAIL',
        'El correo no parece válido.',
        `Rejected malformed email for user ${userId}`,
      );
    }
    await db.execute('UPDATE users SET email = $1 WHERE id = $2', [submittedEmail, userId]);
    email = submittedEmail;
  }
  if (!email) {
    throw new BadRequestError(
      'EMAIL_REQUIRED',
      'Etherfuse necesita un correo para verificar tu identidad.',
      `User ${userId} has no email on file and none was submitted`,
    );
  }

  let { etherfuse_customer_id: customerId, etherfuse_bank_account_id: bankAccountId } = user;
  if (!customerId || !bankAccountId) {
    customerId = customerId ?? randomUUID();
    bankAccountId = bankAccountId ?? randomUUID();
    await db.execute(
      'UPDATE users SET etherfuse_customer_id = $1, etherfuse_bank_account_id = $2 WHERE id = $3',
      [customerId, bankAccountId, userId],
    );
  }

  try {
    const onboardingUrl = await createOnboardingUrl({
      customerId,
      bankAccountId,
      publicKey: user.stellar_address,
      userInfo: { email, displayName: user.username ?? undefined },
    });
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    return { onboardingUrl, expiresAt };
  } catch (err: any) {
    // Upstream unavailable or timed out: keep its 503/504 and message.
    if (err instanceof CircuitOpenError || err instanceof UpstreamTimeoutError) throw err;
    throw new UpstreamError(
      'ETHERFUSE_ONBOARDING_FAILED',
      'No se pudo iniciar la verificación de identidad. Intenta de nuevo en unos minutos.',
      err.message || 'Failed to create Etherfuse onboarding URL',
    );
  }
}

async function startDiditKyc(request: any) {
  if (!process.env.DIDIT_API_KEY) {
    throw new UpstreamError(
      'DIDIT_NOT_CONFIGURED',
      'La verificación de identidad no está disponible por el momento.',
      'DIDIT_API_KEY not configured',
      503,
    );
  }

  const userId = request.user.id;
  const level = request.query?.level === '2' ? 2 : 1;

  // Cada nivel tiene su workflow. Antes el nivel 2 usaba el del nivel 1 y al
  // aprobarse grababa nivel 2 sin que nadie revisara el domicilio.
  const workflowId = diditWorkflowIdForLevel(level);
  if (!workflowId) {
    throw new UpstreamError(
      'DIDIT_NOT_CONFIGURED',
      'La verificación de identidad no está disponible por el momento.',
      `Didit workflow for level ${level} not configured`,
      503,
    );
  }

  const user = await db.getOne<{ id: string }>('SELECT id FROM users WHERE id = $1', [userId]);
  if (!user) {
    throw new NotFoundError('User not found');
  }

  try {
    const session = await createDiditSession({ vendorData: userId, workflowId });

    // Didit devuelve la misma sesion si la persona tiene una sin terminar en
    // ese workflow. Ya esta registrada: no se inserta dos veces. En una sola
    // sentencia, para que un doble toque simultaneo no choque con el UNIQUE.
    await db.execute(
      `INSERT INTO kyc_didit_sessions (session_id, user_id, requested_level, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (session_id) DO NOTHING`,
      [session.sessionId, userId, level],
    );

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    return { onboardingUrl: session.url, expiresAt };
  } catch (err: any) {
    // Didit unavailable or timed out: keep its 503/504 and message.
    if (err instanceof CircuitOpenError || err instanceof UpstreamTimeoutError) throw err;
    throw new UpstreamError(
      'DIDIT_ONBOARDING_FAILED',
      'No se pudo iniciar la verificación de identidad. Intenta de nuevo en unos minutos.',
      err.message || 'Failed to create Didit session',
    );
  }
}

async function getEtherfuseStatus(request: any) {
  const userId = request.user.id;
  const user = await db.getOne<UserRow>(
    'SELECT etherfuse_customer_id FROM users WHERE id = $1',
    [userId],
  );
  if (!user?.etherfuse_customer_id) {
    return { status: 'not_started' };
  }

  try {
    const kyc = await getKycStatus(user.etherfuse_customer_id);
    await db.execute('UPDATE users SET kyc_status = $1 WHERE id = $2', [kyc.status, userId]);
    return { status: kyc.status, rejectionReason: kyc.currentRejectionReason };
  } catch (err: any) {
    // Upstream unavailable or timed out: keep its 503/504 and message.
    if (err instanceof CircuitOpenError || err instanceof UpstreamTimeoutError) throw err;
    throw new UpstreamError(
      'ETHERFUSE_KYC_STATUS_FAILED',
      'No se pudo consultar el estado de verificación. Intenta de nuevo en unos minutos.',
      err.message || 'Failed to fetch Etherfuse KYC status',
    );
  }
}

async function getDiditStatus(request: any) {
  const userId = request.user.id;
  // Didit's decision only ever arrives via webhook (no live status API call
  // here, unlike Etherfuse) — so this reads our own last-known session state
  // rather than round-tripping to Didit on every poll.
  const session = await db.getOne<DiditSessionRow>(
    `SELECT session_id, user_id, requested_level, status, decision_reason
     FROM kyc_didit_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (!session) {
    return { status: 'not_started' };
  }
  return { status: session.status, rejectionReason: session.decision_reason };
}

export async function kycRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/defi/kyc/start',
    { preHandler: [authMiddleware] },
    async (request: any) => {
      const provider = request.query?.provider === 'didit' ? 'didit' : 'etherfuse';
      return provider === 'didit' ? startDiditKyc(request) : startEtherfuseKyc(request);
    },
  );

  app.get(
    '/defi/kyc/status',
    { preHandler: [authMiddleware] },
    async (request: any) => {
      const provider = request.query?.provider === 'didit' ? 'didit' : 'etherfuse';
      return provider === 'didit' ? getDiditStatus(request) : getEtherfuseStatus(request);
    },
  );

  // Didit webhook — scoped to its own encapsulated Fastify context so the
  // raw-body content-type parser below only applies to this one route and
  // never affects JSON parsing anywhere else in the app. Exact raw bytes are
  // required here (unlike Etherfuse's webhook, which re-canonicalizes the
  // parsed body) — see webhook-auth.ts's verifyDiditWebhookSignature comment.
  await app.register(async function diditWebhookScope(scoped: FastifyInstance) {
    scoped.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_request, body: string, done) => {
        try {
          const json = body.length ? JSON.parse(body) : {};
          done(null, { raw: body, json });
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );

    scoped.post('/defi/kyc/webhook/didit', async (request: any, reply) => {
      const { raw, json } = request.body as { raw: string; json: any };
      const signature = request.headers['x-signature'] as string | undefined;
      const timestamp = request.headers['x-timestamp'] as string | undefined;
      const secret = process.env.DIDIT_WEBHOOK_SECRET;

      const { valid, error } = verifyDiditWebhookSignature(raw, signature, timestamp, secret);
      if (!valid) {
        return reply.status(401).send({ error: `webhook signature verification failed: ${error}` });
      }

      const sessionId: string | undefined = json?.session_id;
      const status = mapDiditStatus(json?.status);

      // KYC-1: nunca se loguea el cuerpo. Traia documentos y datos personales
      // del proveedor, y aqui iba entero al log ante cualquier payload raro.
      if (!sessionId) {
        request.log.warn({ category: 'kyc.didit' }, 'Didit webhook: missing session_id');
        return reply.status(200).send({ received: true });
      }

      // KYC-1: la decision se ata a NUESTRA fila, no a lo que venga en el
      // cuerpo. Antes se tomaban `user_id` y `level` de `vendor_data`, o sea
      // del propio payload: quien lograra una firma valida podia subirle el
      // nivel a cualquier usuario. Ahora el payload solo dice QUE sesion y
      // CON QUE resultado; a quien y a que nivel lo dice la base.
      const session = await db.getOne<DiditSessionRow & { requested_level: number }>(
        `SELECT session_id, user_id, requested_level, status
         FROM kyc_didit_sessions WHERE session_id = $1`,
        [sessionId],
      );

      if (!session) {
        // Sesion desconocida: se ignora sin ruido y sin tocar a nadie.
        request.log.warn({ session_id: sessionId, category: 'kyc.didit' }, 'Didit webhook: unknown session');
        return reply.status(200).send({ received: true });
      }

      // Entrega duplicada: no se reescribe nada. Sin esto, cada reintento del
      // proveedor refrescaba `kyc_level_verified_at` y estiraba la vigencia.
      if (session.status === status) {
        request.log.info(
          { session_id: sessionId, status, category: 'kyc.didit' },
          'Didit webhook: duplicate delivery ignored',
        );
        return reply.status(200).send({ received: true });
      }

      // Una sesion ya resuelta no vuelve atras.
      if (session.status === 'approved' && status !== 'approved') {
        request.log.warn(
          { session_id: sessionId, from: session.status, to: status, category: 'kyc.didit' },
          'Didit webhook: refusing to undo an approved session',
        );
        return reply.status(200).send({ received: true });
      }

      const reason = extractDiditDecisionReason(json?.decision);

      await db.execute(
        `UPDATE kyc_didit_sessions SET status = $1, decision_reason = $2, updated_at = NOW() WHERE session_id = $3`,
        [status, reason, sessionId],
      );

      if (status === 'approved') {
        // Monotonico: una aprobacion de nivel inferior no degrada un nivel
        // mayor ya vigente. El WHERE lo resuelve la base, sin leer-comparar-
        // escribir, que es donde se colaria una carrera.
        await db.execute(
          `UPDATE users
           SET kyc_level = $1, kyc_provider = 'didit', kyc_level_verified_at = NOW()
           WHERE id = $2 AND (kyc_level IS NULL OR kyc_level < $1)`,
          [session.requested_level, session.user_id],
        );
      }

      request.log.info(
        { session_id: sessionId, status, level: session.requested_level, category: 'kyc.didit' },
        'Didit webhook processed',
      );
      return reply.status(200).send({ received: true });
    });
  });
}
