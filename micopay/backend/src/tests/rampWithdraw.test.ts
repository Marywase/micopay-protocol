/**
 * Retirar a banco (SPEI): calculos y validacion previa del retiro.
 * Ver docs/PLAN_RETIRO_SPEI_2026-10-12.md.
 *
 *   npm run test:ramp-withdraw
 */

import { strictEqual, deepStrictEqual, throws, rejects, ok } from 'assert';
import {
  parseWithdrawAsset,
  needsDex,
  splitIdentifier,
  toStroops,
  fromStroops,
  plainAmount,
  bridgeAmountAfterSlippage,
  evaluateWithdrawAccount,
  findStrictSendRoute,
  loadHorizonAccount,
  setRampWithdrawFetchForTests,
  partnerFeeBps,
  WithdrawNotReadyError,
} from '../services/rampWithdraw.service.js';
import { UpstreamError } from '../utils/errors.js';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const USDC = { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' };
const CETES = { code: 'CETES', issuer: 'GC3CW7EDYRTWQ635VDIGY6S4ZUF5L6TQ7AA4MWS7LEQDBLUSZXV7UPS4' };
const XLM = { code: 'XLM', issuer: null };

function account(xlm: string, lines: { ref: { code: string; issuer: string }; balance: string; liabilities?: string }[] = []) {
  return {
    balances: [
      ...lines.map((l) => ({
        asset_type: l.ref.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
        asset_code: l.ref.code,
        asset_issuer: l.ref.issuer,
        balance: l.balance,
        selling_liabilities: l.liabilities ?? '0',
      })),
      { asset_type: 'native', balance: xlm, selling_liabilities: '0' },
    ],
    subentry_count: lines.length,
  };
}

function fakeFetch(handler: (url: string) => { status: number; body?: unknown }) {
  setRampWithdrawFetchForTests(async (url) => {
    const { status, body } = handler(url);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  });
}

async function main() {
  console.log('activos y montos');

  await test('parseWithdrawAsset acepta mayusculas/minusculas y rechaza MXNe', () => {
    strictEqual(parseWithdrawAsset('mexe'), 'MEXe');
    strictEqual(parseWithdrawAsset(' usdc '), 'USDC');
    strictEqual(parseWithdrawAsset('MXNe'), null);
    strictEqual(parseWithdrawAsset(42), null);
  });

  await test('solo XLM pasa por el DEX', () => {
    strictEqual(needsDex('XLM'), true);
    strictEqual(needsDex('USDC'), false);
    strictEqual(needsDex('CETES'), false);
    strictEqual(needsDex('MEXe'), false);
  });

  await test('splitIdentifier separa CODE:ISSUER', () => {
    deepStrictEqual(splitIdentifier(`CETES:${CETES.issuer}`), CETES);
    throws(() => splitIdentifier('CETES'));
  });

  await test('stroops ida y vuelta, sin flotantes', () => {
    strictEqual(toStroops('12.5'), 125_000_000n);
    strictEqual(fromStroops(125_000_000n), '12.5000000');
    strictEqual(toStroops('0.0000001'), 1n);
    throws(() => toStroops('1.00000001'));
    throws(() => toStroops('-1'));
    throws(() => toStroops('1e3'));
  });

  await test('plainAmount quita ceros de relleno', () => {
    strictEqual(plainAmount('50.0000000'), '50');
    strictEqual(plainAmount('10.5000000'), '10.5');
    strictEqual(plainAmount('100'), '100');
  });

  await test('margen del DEX: 1% y hacia abajo a centavos', () => {
    // 19.5418 * 0.99 = 19.346382 -> 19.34
    strictEqual(bridgeAmountAfterSlippage('19.5418000'), '19.3400000');
    strictEqual(bridgeAmountAfterSlippage('0.0100000'), '0.0000000');
  });

  console.log('evaluateWithdrawAccount');

  await test('cuenta inexistente', () => {
    const r = evaluateWithdrawAccount(null, { sell: USDC, amount: '1' });
    strictEqual(!r.ready && r.reason, 'account_not_found');
  });

  await test('USDC directo con saldo y XLM para la comision: lista', () => {
    // reserva (2+1)*0.5 = 1.5; libre 0.5
    const r = evaluateWithdrawAccount(account('2', [{ ref: USDC, balance: '10' }]), { sell: USDC, amount: '10' });
    deepStrictEqual(r, { ready: true, needsBridgeTrustline: false });
  });

  await test('sin trustline del activo que vende', () => {
    const r = evaluateWithdrawAccount(account('5'), { sell: CETES, amount: '1' });
    strictEqual(!r.ready && r.reason, 'no_trustline');
  });

  await test('trustline con el mismo codigo pero otro emisor no cuenta', () => {
    const fake = { code: 'USDC', issuer: 'GADK7SUS7NHIGERQBKF7R67A5DNIEFWG4YKNHLTQM5JN4KP2QISMJSHG' };
    const r = evaluateWithdrawAccount(account('5', [{ ref: fake, balance: '100' }]), { sell: USDC, amount: '1' });
    strictEqual(!r.ready && r.reason, 'no_trustline');
  });

  await test('saldo insuficiente descuenta lo comprometido en ofertas', () => {
    const r = evaluateWithdrawAccount(
      account('5', [{ ref: USDC, balance: '10', liabilities: '4' }]),
      { sell: USDC, amount: '7' },
    );
    strictEqual(!r.ready && r.reason, 'insufficient_balance');
    strictEqual(!r.ready && r.available, '6.0000000');
  });

  await test('vende USDC pero no tiene XLM para la comision', () => {
    // reserva 1.5, libre 0.05
    const r = evaluateWithdrawAccount(account('1.55', [{ ref: USDC, balance: '10' }]), { sell: USDC, amount: '5' });
    strictEqual(!r.ready && r.reason, 'insufficient_xlm');
  });

  await test('XLM: deja 1 XLM libre y 0.5 para abrir la trustline de USDC', () => {
    // reserva 1, libre 19. Maximo = 19 - 1 - 0.5 = 17.5
    const ok1 = evaluateWithdrawAccount(account('20'), { sell: XLM, amount: '17.5', bridge: USDC });
    deepStrictEqual(ok1, { ready: true, needsBridgeTrustline: true });
    const r = evaluateWithdrawAccount(account('20'), { sell: XLM, amount: '17.6', bridge: USDC });
    strictEqual(!r.ready && r.reason, 'insufficient_xlm');
    strictEqual(!r.ready && r.available, '17.5000000');
  });

  await test('XLM con trustline de USDC ya abierta: no reserva los 0.5', () => {
    // reserva (2+1)*0.5 = 1.5, libre 18.5. Maximo = 17.5
    const r = evaluateWithdrawAccount(account('20', [{ ref: USDC, balance: '0' }]), { sell: XLM, amount: '17.5', bridge: USDC });
    deepStrictEqual(r, { ready: true, needsBridgeTrustline: false });
  });

  await test('el error explica cuanto XLM puede retirar', () => {
    const r = evaluateWithdrawAccount(account('20'), { sell: XLM, amount: '50', bridge: USDC });
    if (r.ready) throw new Error('debia fallar');
    const err = new WithdrawNotReadyError(r, 'XLM');
    strictEqual(err.httpStatus, 422);
    strictEqual(err.code, 'WITHDRAW_NOT_READY');
    ok(err.userMessage.includes('17.5'), err.userMessage);
  });

  console.log('Horizon');

  await test('findStrictSendRoute elige la ruta que mas entrega y arma la consulta', async () => {
    let seen = '';
    fakeFetch((url) => {
      seen = url;
      return {
        status: 200,
        body: {
          _embedded: {
            records: [
              { destination_amount: '19.0000000', path: [] },
              { destination_amount: '19.5418000', path: [{ asset_type: 'credit_alphanum12', asset_code: 'CETES', asset_issuer: CETES.issuer }] },
            ],
          },
        },
      };
    });
    const route = await findStrictSendRoute(XLM, '100.0000000', USDC);
    strictEqual(route?.destinationAmount, '19.5418000');
    deepStrictEqual(route?.path, [CETES]);
    ok(seen.includes('/paths/strict-send?'));
    ok(seen.includes('source_asset_type=native'));
    ok(seen.includes(`destination_assets=USDC%3A${USDC.issuer}`));
  });

  await test('sin rutas devuelve null', async () => {
    fakeFetch(() => ({ status: 200, body: { _embedded: { records: [] } } }));
    strictEqual(await findStrictSendRoute(XLM, '1', USDC), null);
  });

  await test('Horizon caido: UpstreamError (no se cotiza a ciegas)', async () => {
    fakeFetch(() => ({ status: 503 }));
    await rejects(findStrictSendRoute(XLM, '1', USDC), UpstreamError);
    await rejects(loadHorizonAccount('GABC'), UpstreamError);
  });

  await test('cuenta 404 en Horizon es null, no error', async () => {
    fakeFetch(() => ({ status: 404 }));
    strictEqual(await loadHorizonAccount('GABC'), null);
  });
  setRampWithdrawFetchForTests(null);

  console.log('comision de partner');

  await test('ETHERFUSE_PARTNER_FEE_BPS: 0 o invalido no se manda; tope 500', () => {
    const prev = process.env.ETHERFUSE_PARTNER_FEE_BPS;
    delete process.env.ETHERFUSE_PARTNER_FEE_BPS;
    strictEqual(partnerFeeBps(), undefined);
    process.env.ETHERFUSE_PARTNER_FEE_BPS = '50';
    strictEqual(partnerFeeBps(), 50);
    process.env.ETHERFUSE_PARTNER_FEE_BPS = '900';
    strictEqual(partnerFeeBps(), 500);
    process.env.ETHERFUSE_PARTNER_FEE_BPS = 'abc';
    strictEqual(partnerFeeBps(), undefined);
    if (prev === undefined) delete process.env.ETHERFUSE_PARTNER_FEE_BPS;
    else process.env.ETHERFUSE_PARTNER_FEE_BPS = prev;
  });

  console.log(`\n${passed} pruebas OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
