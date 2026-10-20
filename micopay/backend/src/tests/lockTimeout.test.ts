/**
 * `submitLockTx` rechaza un lock firmado con un timeout distinto al que arma
 * `prepareLockTx`.
 *
 * El contrato acepta cualquier `timeout_minutes`, incluso 0, y `refund` lo puede
 * llamar cualquiera al llegar el timeout. Si el backend no revisa ese argumento,
 * un vendedor puede firmar un lock con timeout 0, recibir el efectivo y
 * reembolsarse antes de que llegue el release.
 */
import { strictEqual, notStrictEqual } from 'assert';
import {
  Account, Contract, Keypair, Networks, StrKey, TransactionBuilder, nativeToScVal,
} from '@stellar/stellar-sdk';
import { LOCK_TIMEOUT_MINUTES, submitLockTx } from '../services/stellar.service.js';

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
const SELLER = Keypair.random().publicKey();
const BUYER = Keypair.random().publicKey();
const AMOUNT = 5_000_000n;
const FEE = 40_000n;
const SECRET_HASH = 'ab'.repeat(32);

const request = { log: { error() {}, warn() {}, info() {} } } as any;

function signedLock(timeoutMinutes: number): string {
  const tx = new TransactionBuilder(new Account(SELLER, '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(CONTRACT_ID).call(
      'lock',
      nativeToScVal(SELLER, { type: 'address' }),
      nativeToScVal(BUYER, { type: 'address' }),
      nativeToScVal(AMOUNT, { type: 'i128' }),
      nativeToScVal(FEE, { type: 'i128' }),
      nativeToScVal(Buffer.from(SECRET_HASH, 'hex'), { type: 'bytes' }),
      nativeToScVal(timeoutMinutes, { type: 'u32' }),
    ))
    .setTimeout(300)
    .build();
  return tx.toXDR();
}

async function submitError(timeoutMinutes: number): Promise<any> {
  try {
    await submitLockTx({
      request,
      contractId: CONTRACT_ID,
      signedXdr: signedLock(timeoutMinutes),
      sellerAddress: SELLER,
      buyerAddress: BUYER,
      amountStroops: AMOUNT,
      platformFeeStroops: FEE,
      secretHash: SECRET_HASH,
    });
  } catch (err) {
    return err;
  }
  throw new Error('submitLockTx no fallo');
}

async function testRejectsOtherTimeouts() {
  for (const t of [0, 1, LOCK_TIMEOUT_MINUTES - 1, LOCK_TIMEOUT_MINUTES + 1]) {
    const err = await submitError(t);
    strictEqual(err.code, 'TX_ARGS_MISMATCH', `timeout ${t}: ${err.message}`);
  }
  console.log('  ✓ rechaza un lock con timeout 0, 1, 119 o 121');
}

async function testAcceptsExpectedTimeout() {
  // Con el timeout correcto pasa la revision y llega a enviarse; STELLAR_RPC_URL
  // apunta a un puerto cerrado, asi que falla despues, en la red.
  const err = await submitError(LOCK_TIMEOUT_MINUTES);
  notStrictEqual(err.code, 'TX_ARGS_MISMATCH', err.message);
  console.log(`  ✓ deja pasar el lock con timeout ${LOCK_TIMEOUT_MINUTES}`);
}

(async () => {
  console.log('lockTimeout');
  await testRejectsOtherTimeouts();
  await testAcceptsExpectedTimeout();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
