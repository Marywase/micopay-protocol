/**
 * UX-3 (#434) · History tabs: "Expirados" and the page/limit query.
 *
 * Three things were wrong with GET /trades/history:
 *
 *  1. `expired` is never stored as a trade status; it is derived from
 *     `expires_at`. The server's rule counted every trade that was not
 *     `completed`/`cancelled` and past its deadline, which includes `refunded`
 *     trades: finished trades, whose money already went back to its owner.
 *     An expired trade is one that is still open (`pending`, `locked` or
 *     `revealing`) and past its deadline.
 *  2. `page` and `limit` went through `parseInt` with no validation. `limit=abc`
 *     became NaN, reached the SQL LIMIT and the endpoint answered 500.
 *  3. (frontend) the History screen never asked the server for a status. See
 *     src/__tests__/historyTabs.test.tsx in the frontend.
 *
 * Runs against the in-memory store (ALLOW_IN_MEMORY_DB=true, no PostgreSQL).
 *
 * SCOPE OF THIS FILE: read before trusting it. The store in src/db/schema.ts is
 * a regular-expression shim, not a SQL engine. It does not evaluate `<` (so
 * `expires_at < NOW()` always passes), and it ignores `LIMIT $n`/`OFFSET $n`
 * and the JOIN. So:
 *   - Which STORED STATES a filter selects is exercised end to end here, and
 *     that is where the refunded defect lives.
 *   - The DEADLINE comparison and the paging arithmetic are checked on the SQL
 *     and parameters the service sends (captured below), not on rows.
 * Both halves were checked to fail against the previous code.
 */

import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { strictEqual, deepStrictEqual, ok } from 'assert';
import db from '../db/schema.js';
import { config } from '../config.js';
import { tradeRoutes } from '../routes/trades.js';
import { AppError } from '../utils/errors.js';

// ── Test app and SQL capture ───────────────────────────────────────────────

async function buildTestApp() {
  const app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: config.jwtSecret });
  app.setErrorHandler((error: any, _request: any, reply: any) => {
    if (error instanceof AppError) {
      reply.status(error.httpStatus).send({ code: error.code, message: error.userMessage });
      return;
    }
    reply.status(error.statusCode ?? 500).send({ code: 'ERROR', message: error.message });
  });
  app.register(tradeRoutes);
  await app.ready();
  return app;
}

type Call = { sql: string; params: unknown[] };
const calls: Call[] = [];
const realGetMany = db.getMany;
db.getMany = (async (sql: string, params?: unknown[]) => {
  calls.push({ sql, params: params ?? [] });
  return realGetMany(sql, params);
}) as typeof db.getMany;

/** The history query sent while `fn` ran (there must be exactly one). */
async function captureHistoryQuery(fn: () => Promise<unknown>): Promise<Call> {
  const before = calls.length;
  await fn();
  const history = calls.slice(before).filter((c) => /FROM trades t/i.test(c.sql));
  strictEqual(history.length, 1, `expected exactly one history query, saw ${history.length}`);
  return history[0];
}

// ── Seed ───────────────────────────────────────────────────────────────────

let seq = 0;
async function createUser(label: string): Promise<string> {
  seq++;
  const suffix = String(seq).padStart(2, '0');
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended)
     VALUES ($1, $2, $3, true, 'online', false)
     RETURNING id`,
    [`G${'H'.repeat(53)}${suffix}`, `ux3_${label}_${suffix}`, `h_ux3_${label}_${suffix}`],
  );
  if (!row?.id) throw new Error(`Failed to seed ${label}`);
  return row.id;
}

/** `expiresInSeconds` negative = the deadline already passed. */
async function insertTrade(opts: {
  sellerId: string;
  buyerId: string;
  status: string;
  expiresInSeconds: number;
}): Promise<string> {
  seq++;
  const expiresAt = new Date(Date.now() + opts.expiresInSeconds * 1000).toISOString();
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO trades
       (seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, secret_hash,
        status, expires_at)
     VALUES ($1, $2, 'cashout', $2, 500, 5000000000, $3, $4, $5)
     RETURNING id`,
    [opts.sellerId, opts.buyerId, `h_ux3_${seq}_${Math.random()}`, opts.status, expiresAt],
  );
  if (!row?.id) throw new Error('Failed to insert trade');
  return row.id;
}

const PAST = -3600;
const FUTURE = 3600;

interface Fixture {
  me: string;
  token: string;
  ids: Record<string, string>;
  strangerTradeId: string;
}

async function seed(app: any): Promise<Fixture> {
  const me = await createUser('me');
  const other = await createUser('other');
  const x = await createUser('x');
  const y = await createUser('y');
  const trade = (status: string, expiresInSeconds: number) =>
    insertTrade({ sellerId: me, buyerId: other, status, expiresInSeconds });

  const ids = {
    pendingOpen: await trade('pending', FUTURE),
    pendingPast: await trade('pending', PAST),
    lockedPast: await trade('locked', PAST),
    revealingPast: await trade('revealing', PAST),
    completedPast: await trade('completed', PAST),
    cancelledPast: await trade('cancelled', PAST),
    refundedPast: await trade('refunded', PAST),
  };
  // Somebody else's expired trade must never show up.
  const strangerTradeId = await insertTrade({
    sellerId: x,
    buyerId: y,
    status: 'locked',
    expiresInSeconds: PAST,
  });

  return { me, token: app.jwt.sign({ id: me, stellar_address: 'GME' }), ids, strangerTradeId };
}

async function history(app: any, fx: Fixture, query = '') {
  return app.inject({
    method: 'GET',
    url: `/trades/history${query}`,
    headers: { authorization: `Bearer ${fx.token}` },
  });
}

async function historyIds(app: any, fx: Fixture, query = ''): Promise<string[]> {
  const res = await history(app, fx, query);
  strictEqual(res.statusCode, 200, `history${query} must answer 200 (got ${res.statusCode}: ${res.body})`);
  return (res.json().trades as Array<{ id: string }>).map((t) => t.id).sort();
}

const sorted = (...ids: string[]) => [...ids].sort();

// ── Expired ────────────────────────────────────────────────────────────────

/** The defect: refunded (and completed, cancelled) trades were reported as expired. */
async function testExpiredExcludesFinishedTrades(app: any, fx: Fixture) {
  const got = await historyIds(app, fx, '?status=expired');

  ok(!got.includes(fx.ids.refundedPast), 'a refunded trade is finished, not expired (this is #434)');
  ok(!got.includes(fx.ids.completedPast), 'a completed trade is not expired');
  ok(!got.includes(fx.ids.cancelledPast), 'a cancelled trade is not expired');
  ok(!got.includes(fx.strangerTradeId), "somebody else's trade must never appear");
  console.log('  ✓ expired: no refunded, completed or cancelled trades');
}

async function testExpiredIncludesOpenTradesPastTheirDeadline(app: any, fx: Fixture) {
  const got = await historyIds(app, fx, '?status=expired');

  for (const name of ['pendingPast', 'lockedPast', 'revealingPast']) {
    ok(got.includes(fx.ids[name]), `an open trade past its deadline is expired (${name})`);
  }
  console.log('  ✓ expired: includes pending, locked and revealing trades past their deadline');
}

/** The shim cannot evaluate `<`, so the deadline is checked on the SQL itself. */
async function testExpiredSqlRequiresOpenStateAndDeadline(app: any, fx: Fixture) {
  const q = await captureHistoryQuery(() => history(app, fx, '?status=expired'));

  ok(
    /t\.status IN \('pending', 'locked', 'revealing'\)/.test(q.sql),
    `expired must be limited to the open states, got: ${q.sql}`,
  );
  ok(/t\.expires_at < NOW\(\)/.test(q.sql), 'expired must compare expires_at with NOW()');
  ok(
    !/NOT IN/i.test(q.sql),
    'expired must not be defined by exclusion: that is what let refunded trades in',
  );
  ok(
    /\(t\.status IN \([^)]*\) AND t\.expires_at < NOW\(\)\)/.test(q.sql),
    'both conditions must sit in one parenthesised group so the user filter keeps applying',
  );
  console.log('  ✓ expired: the SQL asks for an open state AND a passed deadline');
}

// ── The other tabs ─────────────────────────────────────────────────────────

async function testStoredStatusTabs(app: any, fx: Fixture) {
  const { ids } = fx;
  deepStrictEqual(await historyIds(app, fx, '?status=completed'), sorted(ids.completedPast));
  deepStrictEqual(await historyIds(app, fx, '?status=cancelled'), sorted(ids.cancelledPast));
  deepStrictEqual(await historyIds(app, fx, '?status=refunded'), sorted(ids.refundedPast));
  deepStrictEqual(await historyIds(app, fx, '?status=locked'), sorted(ids.lockedPast));
  deepStrictEqual(await historyIds(app, fx, '?status=revealing'), sorted(ids.revealingPast));
  deepStrictEqual(
    await historyIds(app, fx, '?status=pending'),
    sorted(ids.pendingOpen, ids.pendingPast),
  );
  console.log('  ✓ each stored-status tab returns exactly the trades with that status');
}

async function testAllReturnsEveryTradeOfTheCaller(app: any, fx: Fixture) {
  const everything = sorted(...Object.values(fx.ids));
  deepStrictEqual(await historyIds(app, fx), everything, 'no status');
  deepStrictEqual(await historyIds(app, fx, '?status=all'), everything, 'status=all');
  deepStrictEqual(await historyIds(app, fx, '?status='), everything, 'an empty status is no filter');
  console.log("  ✓ no status / all returns every trade of the caller, and only theirs");
}

async function testUnknownStatusMatchesNothing(app: any, fx: Fixture) {
  deepStrictEqual(await historyIds(app, fx, '?status=nonsense'), []);
  console.log('  ✓ an unknown status matches nothing, as before');
}

// ── page / limit ───────────────────────────────────────────────────────────

const BAD_QUERIES = [
  'limit=abc',
  'limit=',
  'limit=0',
  'limit=-5',
  'limit=101',
  'limit=1000',
  'limit=1.5',
  'limit=1e3',
  'limit=NaN',
  'limit=1&limit=2',
  'page=abc',
  'page=',
  'page=0',
  'page=-1',
  'page=1.5',
  'page=10001',
  'page=99999999999999999999',
  'page=1e300',
  'page=0&limit=abc',
];

async function testBadPagingAnswers400NotCrash(app: any, fx: Fixture) {
  for (const q of BAD_QUERIES) {
    const before = calls.length;
    const res = await history(app, fx, `?${q}`);
    strictEqual(res.statusCode, 400, `?${q} must answer 400, got ${res.statusCode}: ${res.body}`);
    strictEqual(calls.length, before, `?${q} must be rejected before the database is queried`);
  }
  console.log(`  ✓ ${BAD_QUERIES.length} bad page/limit values answer 400 and never reach the database`);
}

async function testDefaultsAndBounds(app: any, fx: Fixture) {
  const paging = async (query: string) => {
    const q = await captureHistoryQuery(() => history(app, fx, query));
    return q.params.slice(-2);
  };

  deepStrictEqual(await paging(''), [20, 0], 'no parameters: the 20 most recent');
  deepStrictEqual(await paging('?limit=1'), [1, 0], 'limit=1 is allowed');
  deepStrictEqual(await paging('?limit=100'), [100, 0], 'limit=100 is allowed');
  deepStrictEqual(await paging('?page=3&limit=7'), [7, 14], 'page 3 of 7 starts after 14');
  deepStrictEqual(await paging('?page=10000&limit=100'), [100, 999900], 'the last allowed page');
  deepStrictEqual(await paging('?status=expired&page=2'), [20, 20], 'paging combines with a status');
  console.log('  ✓ defaults are 20 / page 1, and the bounds are inclusive');
}

async function testUnauthenticatedStillRefused(app: any) {
  const res = await app.inject({ method: 'GET', url: '/trades/history?status=expired' });
  ok(res.statusCode === 401 || res.statusCode === 403, `got ${res.statusCode}`);
  console.log('  ✓ no token: still refused');
}

async function main() {
  console.log('\n  UX-3 (#434) — History: expired filter and page/limit validation:\n');
  const app = await buildTestApp();
  const fx = await seed(app);

  await testExpiredExcludesFinishedTrades(app, fx);
  await testExpiredIncludesOpenTradesPastTheirDeadline(app, fx);
  await testExpiredSqlRequiresOpenStateAndDeadline(app, fx);
  await testStoredStatusTabs(app, fx);
  await testAllReturnsEveryTradeOfTheCaller(app, fx);
  await testUnknownStatusMatchesNothing(app, fx);
  await testBadPagingAnswers400NotCrash(app, fx);
  await testDefaultsAndBounds(app, fx);
  await testUnauthenticatedStillRefused(app);

  await app.close();
  console.log('\nAll UX-3 history tests passed.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
