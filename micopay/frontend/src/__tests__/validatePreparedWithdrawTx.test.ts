// @vitest-environment node
// Prueba: validatePreparedWithdrawTx acepta solo transacciones que coinciden
// EXACTAMENTE con la orden (plan decision 7). Cualquier diferencia (destino,
// activo, monto, memo, source) debe fallar antes de firmar.
// Corre en entorno node (no jsdom) porque @stellar/stellar-sdk invoca
// @noble/curves que es exquisito con el tipo de los seeds.

import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import { Keypair, TransactionBuilder, Operation, Memo, Networks, Asset, Account } from '@stellar/stellar-sdk';
import { validatePreparedWithdrawTx, WithdrawTxMismatchError, type ExpectedBankWithdraw } from '../services/stellarRamp';

const PASS = Networks.TESTNET;
// Seeds fijos (Uint8Array; Buffer en jsdom se parsea distinto y @noble/curves
// lo rechaza) para que el test sea deterministico.
function seed(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}
const USER = Keypair.fromRawEd25519Seed(seed(0x11));
const ATTACKER = Keypair.fromRawEd25519Seed(seed(0x22));
const USDC_ISSUER_KP = Keypair.fromRawEd25519Seed(seed(0x33));
const ETHERFUSE_DEST_KP = Keypair.fromRawEd25519Seed(seed(0x44));
const USDC_ISSUER = USDC_ISSUER_KP.publicKey();
const ETHERFUSE_DEST = ETHERFUSE_DEST_KP.publicKey();

function buildTx(opts: {
  from?: Keypair;
  to?: string;
  asset?: Asset;
  amount?: string;
  memo?: Memo;
  secondOp?: boolean;
}): string {
  const from = opts.from ?? USER;
  const account = new Account(from.publicKey(), '1');
  const builder = new TransactionBuilder(account, { fee: '100', networkPassphrase: PASS });
  builder.addOperation(Operation.payment({
    destination: opts.to ?? ETHERFUSE_DEST,
    asset: opts.asset ?? new Asset('USDC', USDC_ISSUER),
    amount: opts.amount ?? '10.0000000',
  }));
  if (opts.secondOp) {
    builder.addOperation(Operation.payment({
      destination: ATTACKER.publicKey(),
      asset: new Asset('USDC', USDC_ISSUER),
      amount: '1.0000000',
    }));
  }
  if (opts.memo) builder.addMemo(opts.memo);
  return builder.setTimeout(300).build().toXDR();
}

const expected: ExpectedBankWithdraw = {
  fromAddress: USER.publicKey(),
  toAddress: ETHERFUSE_DEST,
  memo: null,
  assetCode: 'USDC',
  assetIssuer: USDC_ISSUER,
  amount: '10',
};

describe('validatePreparedWithdrawTx', () => {
  it('acepta tx correcta', () => {
    expect(() => validatePreparedWithdrawTx(buildTx({}), expected, PASS)).not.toThrow();
  });

  it('acepta tx con monto equivalente (10 vs 10.0000000)', () => {
    expect(() => validatePreparedWithdrawTx(buildTx({ amount: '10' }), expected, PASS)).not.toThrow();
  });

  it('rechaza destino cambiado (pago al atacante)', () => {
    expect(() => validatePreparedWithdrawTx(
      buildTx({ to: ATTACKER.publicKey() }), expected, PASS,
    )).toThrowError(WithdrawTxMismatchError);
  });

  it('rechaza monto cambiado', () => {
    expect(() => validatePreparedWithdrawTx(
      buildTx({ amount: '100.0000000' }), expected, PASS,
    )).toThrowError(/monto/);
  });

  it('rechaza emisor del activo cambiado', () => {
    const otherIssuer = Keypair.fromRawEd25519Seed(seed(0x55)).publicKey();
    expect(() => validatePreparedWithdrawTx(
      buildTx({ asset: new Asset('USDC', otherIssuer) }), expected, PASS,
    )).toThrowError(/emisor/);
  });

  it('rechaza source distinto (no es la wallet del usuario)', () => {
    expect(() => validatePreparedWithdrawTx(
      buildTx({ from: ATTACKER }), expected, PASS,
    )).toThrowError(/source/);
  });

  it('rechaza una segunda operacion (dos pagos)', () => {
    // decoded.type sera 'unsupported' cuando hay mas de un op; ese caso
    // tambien lo rechaza (no es "payment" simple).
    expect(() => validatePreparedWithdrawTx(
      buildTx({ secondOp: true }), expected, PASS,
    )).toThrowError(WithdrawTxMismatchError);
  });

  it('rechaza XDR vacio', () => {
    expect(() => validatePreparedWithdrawTx('', expected, PASS)).toThrowError(WithdrawTxMismatchError);
  });

  it('exige memo cuando la orden lo pide', () => {
    const withMemo = { ...expected, memo: 'orden-abc-123' };
    // sin memo: falla
    expect(() => validatePreparedWithdrawTx(buildTx({}), withMemo, PASS)).toThrowError(/memo/);
    // con memo correcto: pasa
    expect(() => validatePreparedWithdrawTx(
      buildTx({ memo: Memo.text('orden-abc-123') }), withMemo, PASS,
    )).not.toThrow();
  });
});
