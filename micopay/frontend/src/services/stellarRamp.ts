import { Keypair, TransactionBuilder, Operation, Memo, Networks, Asset, Horizon, Transaction } from '@stellar/stellar-sdk';
import { requireUserPresence } from '../lib/userPresence';
import { exportSecretKey } from '../lib/keystore';
import { Buffer } from 'buffer';
import { buildTxUrl } from '../utils/stellarExplorer';
import { decodeTransactionXdr } from './transactionDecoder';

const HORIZON_URL = import.meta.env.VITE_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = import.meta.env.VITE_NETWORK_PASSPHRASE || Networks.TESTNET;

const server = new Horizon.Server(HORIZON_URL);

export async function sendCETESToEtherfuse(
  cetesAmount: string,
  withdrawAnchorAccount: string,
  withdrawMemo: string,
  cetesIssuer: string
): Promise<{ hash: string; explorerUrl: string }> {
  // Mueve dinero: se confirma antes de tocar la llave.
  await requireUserPresence('payment');
  const secret = await exportSecretKey();
  if (!secret) throw new Error("No se encontró la llave privada del dispositivo.");

  const keypair = Keypair.fromSecret(secret);
  
  const account = await server.loadAccount(keypair.publicKey());

  const memoBuffer = Buffer.from(withdrawMemo, 'base64');
  const memo = Memo.hash(memoBuffer);

  const asset = new Asset('CETES', cetesIssuer);

  const tx = new TransactionBuilder(account, {
    fee: '10000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: withdrawAnchorAccount,
        asset: asset,
        amount: cetesAmount,
      })
    )
    .setTimeout(90)
    .addMemo(memo)
    .build();

  tx.sign(keypair);

  try {
    const response = await server.submitTransaction(tx);
    return {
      hash: response.hash,
      explorerUrl: buildTxUrl(response.hash)
    };
  } catch (error: any) {
    if (error?.response?.data?.extras?.result_codes?.transaction === 'tx_too_late') {
      throw new Error('tx_too_late');
    }
    throw error;
  }
}

// ---- Retirar a banco (SPEI) --------------------------------------------
//
// Para una orden de offramp USDC->MXN, Etherfuse puede devolver una
// `preparedTransaction` (XDR sin firmar) ademas de las fundingInstructions.
// La app NUNCA firma a ciegas lo que llega: antes compara que esa tx
// coincida con la orden que el usuario autorizo (plan decision 7).

export interface ExpectedBankWithdraw {
  /** Direccion de la wallet del usuario (debe ser el source de la tx). */
  fromAddress: string;
  /** Direccion a la que Etherfuse espera recibir los fondos (fundingInstructions.destination.address). */
  toAddress: string;
  /** Memo que Etherfuse pide (opcional segun orden). */
  memo?: string | null;
  /** Codigo del activo que paga el usuario. Siempre 'USDC' en este flujo. */
  assetCode: 'USDC';
  /** Emisor que Etherfuse acepta (ETHERFUSE_USDC_ASSET en el backend). */
  assetIssuer: string;
  /** Monto exacto que debe salir, decimal string con hasta 7 decimales. */
  amount: string;
}

export class WithdrawTxMismatchError extends Error {
  constructor(public reason: string, public detail?: Record<string, string | undefined>) {
    super(`La transaccion no coincide con la orden: ${reason}`);
    this.name = 'WithdrawTxMismatchError';
  }
}

/**
 * Normaliza una cantidad decimal (strict-equal entre "1.00" y "1.0000000").
 */
function normalizeAmount(amount: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 'invalid';
  return n.toFixed(7);
}

/**
 * Parsea y valida la preparedTransaction contra la orden. Lanza
 * WithdrawTxMismatchError si algo no cuadra. No firma.
 */
export function validatePreparedWithdrawTx(
  xdr: string,
  expected: ExpectedBankWithdraw,
  networkPassphrase: string = NETWORK_PASSPHRASE,
): void {
  const decoded = decodeTransactionXdr(xdr, networkPassphrase);
  if (decoded.type !== 'payment') {
    throw new WithdrawTxMismatchError('la transaccion no es un pago simple', {
      type: decoded.type,
    });
  }
  if (decoded.sourceAccount && decoded.sourceAccount !== expected.fromAddress) {
    throw new WithdrawTxMismatchError('source account incorrecta', {
      got: decoded.sourceAccount,
      expected: expected.fromAddress,
    });
  }
  if (decoded.destination !== expected.toAddress) {
    throw new WithdrawTxMismatchError('destino incorrecto', {
      got: decoded.destination,
      expected: expected.toAddress,
    });
  }
  if (decoded.assetCode !== expected.assetCode) {
    throw new WithdrawTxMismatchError('activo incorrecto', {
      got: decoded.assetCode,
      expected: expected.assetCode,
    });
  }
  if (decoded.assetIssuer !== expected.assetIssuer) {
    throw new WithdrawTxMismatchError('emisor del activo incorrecto', {
      got: decoded.assetIssuer,
      expected: expected.assetIssuer,
    });
  }
  if (normalizeAmount(decoded.amount) !== normalizeAmount(expected.amount)) {
    throw new WithdrawTxMismatchError('monto incorrecto', {
      got: decoded.amount,
      expected: expected.amount,
    });
  }
  if (expected.memo) {
    if (!decoded.memo || decoded.memo !== expected.memo) {
      throw new WithdrawTxMismatchError('memo incorrecto', {
        got: decoded.memo,
        expected: expected.memo,
      });
    }
  }
}

/**
 * Firma y envia la preparedTransaction a Horizon despues de validarla.
 * Pide la huella (`requireUserPresence`). No reintenta: si `tx_bad_seq`,
 * la pantalla pide nuevas instrucciones y vuelve a cotizar.
 */
export async function signAndSubmitPreparedWithdrawTx(
  xdr: string,
  expected: ExpectedBankWithdraw,
): Promise<{ hash: string; explorerUrl: string }> {
  validatePreparedWithdrawTx(xdr, expected);

  await requireUserPresence('payment');
  const secret = await exportSecretKey();
  if (!secret) throw new Error('No se encontró la llave privada del dispositivo.');
  const keypair = Keypair.fromSecret(secret);
  if (keypair.publicKey() !== expected.fromAddress) {
    throw new WithdrawTxMismatchError('la llave del dispositivo no coincide con la cuenta del retiro');
  }

  const parsed = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
  if (!(parsed instanceof Transaction)) {
    throw new WithdrawTxMismatchError('la tx es un fee-bump; no se soporta');
  }
  parsed.sign(keypair);

  try {
    const response = await server.submitTransaction(parsed);
    return { hash: response.hash, explorerUrl: buildTxUrl(response.hash) };
  } catch (error: any) {
    const code = error?.response?.data?.extras?.result_codes?.transaction;
    if (code === 'tx_bad_seq') throw new Error('tx_bad_seq');
    if (code === 'tx_too_late') throw new Error('tx_too_late');
    throw error;
  }
}