/**
 * POST /defi/cetes/buy segun la red.
 *
 *   - Red principal (STELLAR_NETWORK=PUBLIC, MOCK_STELLAR=false): 501
 *     CETES_BUY_DISABLED_ON_MAINNET, sin enviar transaccion y sin leer
 *     config.platformSecretKey.
 *   - Testnet: misma respuesta simulada que antes.
 *   - Sin token: rechazada.
 *
 *   npm run test:cetes-buy
 */

import { strictEqual, ok } from 'node:assert';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { Horizon } from '@stellar/stellar-sdk';
import db from '../db/schema.js';
import { config } from '../config.js';
import { defiRoutes } from '../routes/defi.js';
import { AppError } from '../utils/errors.js';

const JWT_SECRET = 'test-cetes-buy-secret';
const cfg = config as any;

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// Cualquier envio o carga de cuenta en Horizon queda registrado y no sale a la red.
let submitCalls = 0;
let loadAccountCalls = 0;
(Horizon.Server.prototype as any).submitTransaction = async () => {
  submitCalls++;
  return { hash: 'should-not-happen' };
};
(Horizon.Server.prototype as any).loadAccount = async () => {
  loadAccountCalls++;
  throw new Error('loadAccount should not be called');
};

// Cuenta las lecturas de la llave de la plataforma.
let secretReads = 0;
const realSecret = cfg.platformSecretKey;
Object.defineProperty(cfg, 'platformSecretKey', {
  configurable: true,
  get() {
    secretReads++;
    return realSecret;
  },
});

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
  await app.register(defiRoutes);
  await app.ready();
  return app;
}

async function seedUser(): Promise<string> {
  const stellarAddress = `G${Math.random().toString(36).slice(2).toUpperCase().padEnd(55, 'X')}`.slice(0, 56);
  const user = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username) VALUES ($1, $2) RETURNING id`,
    [stellarAddress, `cetes_test_${Math.random().toString(36).slice(2, 8)}`],
  );
  if (!user?.id) throw new Error('Failed to seed user');
  return user.id;
}

function buy(app: Awaited<ReturnType<typeof createApp>>, token?: string) {
  return app.inject({
    method: 'POST',
    url: '/defi/cetes/buy',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { amount: '100', sourceAsset: 'USDC' },
  });
}

async function main() {
  console.log(`POST /defi/cetes/buy (STELLAR_NETWORK=${process.env.STELLAR_NETWORK}, MOCK_STELLAR=${process.env.MOCK_STELLAR})`);

  const app = await createApp();
  const userId = await seedUser();
  const token = (app as any).jwt.sign({ id: userId, stellar_address: 'GTEST' });

  await test('red principal: 501 CETES_BUY_DISABLED_ON_MAINNET', async () => {
    cfg.stellarNetwork = 'PUBLIC';
    cfg.mockStellar = false;
    submitCalls = 0;
    loadAccountCalls = 0;
    secretReads = 0;

    const res = await buy(app, token);
    strictEqual(res.statusCode, 501);
    strictEqual(JSON.parse(res.body).code, 'CETES_BUY_DISABLED_ON_MAINNET');
    strictEqual(submitCalls, 0, 'submitTransaction no debe llamarse');
    strictEqual(loadAccountCalls, 0, 'loadAccount no debe llamarse');
    strictEqual(secretReads, 0, 'config.platformSecretKey no debe leerse');
  });

  await test('testnet: respuesta simulada sin cambios', async () => {
    cfg.stellarNetwork = 'TESTNET';
    cfg.mockStellar = false;
    submitCalls = 0;

    const res = await buy(app, token);
    strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    ok(body.hash.startsWith('mock_cetes_buy_'));
    strictEqual(body.status, 'success');
    strictEqual(body.simulated, true);
    strictEqual(body.amount, '100');
    strictEqual(body.sourceAsset, 'USDC');
    strictEqual(body.cetesReceived, '95.0000');
    ok(body.explorerUrl.includes('/testnet/tx/'));
    strictEqual(submitCalls, 0);
  });

  await test('MOCK_STELLAR=true en red principal: respuesta simulada sin cambios', async () => {
    cfg.stellarNetwork = 'PUBLIC';
    cfg.mockStellar = true;

    const res = await buy(app, token);
    strictEqual(res.statusCode, 200);
    strictEqual(JSON.parse(res.body).simulated, true);
    strictEqual(submitCalls, 0);
  });

  await test('sin token: rechazada', async () => {
    cfg.stellarNetwork = 'PUBLIC';
    cfg.mockStellar = false;

    const res = await buy(app);
    strictEqual(res.statusCode, 401);
    strictEqual(submitCalls, 0);
  });

  await app.close();
  console.log(`\nAll ${passed} CETES buy tests passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Tests failed:', err);
  process.exit(1);
});
