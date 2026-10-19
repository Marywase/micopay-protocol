import assert from 'node:assert/strict';
import { after, mock, test, type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import pg from 'pg';
import { InMemoryStore } from '../middleware/rateLimit.middleware.js';

// Route cases use known defaults regardless of the developer's environment.
process.env.CLIENT_ERROR_RATE_LIMIT_MAX = '20';
process.env.CLIENT_ERROR_RATE_LIMIT_WINDOW_MS = '60000';

// Keep schema initialization offline; no test may connect to a developer database.
const queryMock = mock.method(pg.Pool.prototype, 'query', async () => ({ rows: [] }));
const { default: db, pool } = await import('../db/schema.js');
const { clientErrorRoutes } = await import('../routes/client-errors.js');
const { config } = await import('../config.js');
queryMock.mock.restore();
after(async () => { await pool?.end(); });

async function setup(t: TestContext) {
  const rows: unknown[][] = [];
  t.mock.method(db, 'execute', async (sql: string, params: unknown[] = []) => {
    assert.match(sql, /INSERT INTO client_errors/);
    rows.push(params);
    return { rows: [] };
  });
  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: 'client-error-rate-limit-test-secret' });
  await app.register(clientErrorRoutes, { rateLimitStore: new InMemoryStore() });
  await app.ready();
  t.after(async () => { await app.close(); });
  const report = (token?: string, ip = '192.0.2.1', context?: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/client-errors', remoteAddress: ip,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { message: 'test crash', context },
  });
  const token = (id: string) => app.jwt.sign({ id, stellar_address: 'test-address' });
  return { app, rows, report, token };
}

test('anonymous reports: first 20 are stored, request 21 is rejected without an insert', async (t) => {
  const { rows, report } = await setup(t);
  for (let i = 0; i < 20; i++) {
    const response = await report();
    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.json(), { status: 'recorded' });
  }
  assert.equal(rows.length, 20);
  assert.ok(rows.every(row => row[1] === null && row[3] === 'test crash'));
  const blocked = await report();
  assert.equal(blocked.statusCode, 429);
  const retryAfter = Number(blocked.headers['retry-after']);
  assert.ok(retryAfter > 0 && retryAfter <= 60);
  assert.equal(rows.length, 20);
  assert.equal((await report(undefined, '192.0.2.2')).statusCode, 201);
});

test('users behind one IP have separate counters and retain their recorded authors', async (t) => {
  const { app, rows, report, token } = await setup(t);
  const alice = token('alice');
  const bob = token('bob');
  for (let i = 0; i < 20; i++) assert.equal((await report(alice)).statusCode, 201);
  assert.equal((await report(alice)).statusCode, 429);
  for (let i = 0; i < 20; i++) assert.equal((await report(bob)).statusCode, 201);
  assert.equal((await report(bob)).statusCode, 429);
  // Neither another token nor another IP resets a user's quota.
  const rotated = app.jwt.sign({ id: 'alice', stellar_address: 'test-address', jti: 'new-token' });
  assert.equal((await report(rotated, '192.0.2.2')).statusCode, 429);
  assert.equal(rows.length, 40);
  assert.ok(rows.slice(0, 20).every(row => row[1] === 'alice'));
  assert.ok(rows.slice(20).every(row => row[1] === 'bob'));
  assert.equal((await report()).statusCode, 201);
  assert.equal(rows[40][1], null);
});

test('invalid and expired tokens fall back to the same anonymous IP counter', async (t) => {
  const { app, rows, report } = await setup(t);
  const expired = app.jwt.sign({ id: 'expired', stellar_address: 'test-address', exp: 1 });
  for (let i = 0; i < 20; i++) {
    assert.equal((await report(i % 2 ? expired : `invalid-${i}`)).statusCode, 201);
  }
  assert.equal((await report()).statusCode, 429);
  assert.equal(rows.length, 20);
  assert.ok(rows.every(row => row[1] === null));
});

test('context accepts 50 properties and rejects 51 before insertion', async (t) => {
  const { rows, report } = await setup(t);
  const context = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`field${i}`, i]));
  assert.equal((await report(undefined, '192.0.2.1', context)).statusCode, 201);
  assert.deepEqual(rows[0][5], context);
  assert.equal((await report(undefined, '192.0.2.1', { ...context, extra: true })).statusCode, 400);
  assert.equal(rows.length, 1);
});

test('configured max and window govern rejection and reset', async (t) => {
  const original = { clientErrorRateLimitMax: config.clientErrorRateLimitMax, clientErrorRateLimitWindowMs: config.clientErrorRateLimitWindowMs };
  Object.assign(config, { clientErrorRateLimitMax: 2, clientErrorRateLimitWindowMs: 1000 });
  t.after(() => { Object.assign(config, original); });
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const { rows, report } = await setup(t);
  assert.equal((await report()).statusCode, 201);
  assert.equal((await report()).statusCode, 201);
  const blocked = await report();
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['retry-after'], '1');
  assert.equal(rows.length, 2);
  t.mock.timers.tick(1001);
  assert.equal((await report()).statusCode, 201);
  assert.equal(rows.length, 3);
});

test('config reads environment overrides and defaults to 20 reports per minute', () => {
  const configUrl = new URL('../config.ts', import.meta.url).href;
  for (const [max, windowMs, expected] of [['', '', [20, 60000]], ['3', '2500', [3, 2500]]] as const) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import { config } from ${JSON.stringify(configUrl)}; console.log(JSON.stringify([config.clientErrorRateLimitMax, config.clientErrorRateLimitWindowMs]));`], {
      encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', CLIENT_ERROR_RATE_LIMIT_MAX: max, CLIENT_ERROR_RATE_LIMIT_WINDOW_MS: windowMs },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout.trim()), expected);
  }
});
