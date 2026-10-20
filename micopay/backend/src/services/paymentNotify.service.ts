/**
 * Aviso de pago recibido entre usuarios de MicoPay.
 *
 * "Enviar pago" firma y manda la transaccion directo a Stellar desde el
 * telefono; el backend no se entera. Al terminar, la app nos pasa el hash y
 * aqui se lee la transaccion en Horizon antes de avisar: el aviso solo sale si
 * la transaccion existe, salio bien, la mando quien lo pide y es reciente. Asi
 * nadie puede fabricar avisos de pagos que no hizo.
 *
 * Pagos que llegan de fuera de MicoPay (Lobstr, un exchange) no pasan por
 * aqui; eso necesita escuchar la red.
 */
import db from '../db/schema.js';
import { config } from '../config.js';
import pino from 'pino';
import { sendPaymentReceivedNotification } from './push.service.js';

const logger = pino({ name: 'paymentNotify.service' });

/** Un pago mas viejo que esto ya no se avisa: el aviso es de "acaba de llegar". */
const MAX_AGE_MS = 15 * 60 * 1000;

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init);

/** Solo para pruebas. */
export function setPaymentNotifyFetchForTests(next: FetchLike | null): void {
  fetchImpl = next ?? ((url, init) => fetch(url, init));
}

function horizonUrl(): string {
  return config.stellarNetwork === 'TESTNET'
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org';
}

/**
 * Pagos ya avisados, para que reintentos de la app no repitan el aviso. En
 * memoria basta: el backend corre en una sola tarea y, tras reiniciar, el
 * limite de 15 minutos acota cuanto se podria repetir.
 */
const notified = new Map<string, number>();

function alreadyNotified(key: string, now: number): boolean {
  for (const [k, at] of notified) {
    if (now - at > MAX_AGE_MS) notified.delete(k);
  }
  return notified.has(key);
}

/** Solo para pruebas. */
export function resetPaymentNotifyForTests(): void {
  notified.clear();
}

interface HorizonTx {
  successful: boolean;
  source_account: string;
  created_at: string;
}

interface HorizonOp {
  id: string;
  type: string;
  transaction_successful?: boolean;
  from?: string;
  to?: string;
  funder?: string;
  account?: string;
  amount?: string;
  starting_balance?: string;
  asset_type?: string;
  asset_code?: string;
}

/** "50.0000000" -> "50"; "1.2500000" -> "1.25". */
export function formatAmount(amount: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  return n.toLocaleString('es-MX', { maximumFractionDigits: 7 });
}

function assetLabel(op: HorizonOp): string {
  if (op.type === 'create_account' || op.asset_type === 'native') return 'XLM';
  return op.asset_code ?? '';
}

async function getJson<T>(url: string): Promise<T | null> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Horizon respondio ${res.status}`);
  return (await res.json()) as T;
}

export type NotifyResult =
  | { notified: number }
  | { notified: 0; reason: 'not_found' | 'failed' | 'not_sender' | 'too_old' | 'horizon_error' };

/**
 * Lee la transaccion `txHash` y avisa a cada usuario de MicoPay que recibio
 * un pago en ella. Nunca lanza: el pago ya se hizo y un aviso que no sale no
 * debe verse como error en la app.
 */
export async function notifyIncomingPayment(params: {
  senderAddress: string;
  senderUsername: string | null;
  txHash: string;
  now?: number;
}): Promise<NotifyResult> {
  const now = params.now ?? Date.now();
  const base = horizonUrl();

  let tx: HorizonTx | null;
  let ops: HorizonOp[];
  try {
    tx = await getJson<HorizonTx>(`${base}/transactions/${params.txHash}`);
    if (!tx) return { notified: 0, reason: 'not_found' };
    if (!tx.successful) return { notified: 0, reason: 'failed' };
    if (tx.source_account !== params.senderAddress) return { notified: 0, reason: 'not_sender' };
    if (now - new Date(tx.created_at).getTime() > MAX_AGE_MS) return { notified: 0, reason: 'too_old' };

    const page = await getJson<{ _embedded?: { records?: HorizonOp[] } }>(
      `${base}/transactions/${params.txHash}/operations?limit=100`,
    );
    ops = page?._embedded?.records ?? [];
  } catch (err) {
    logger.warn({ err, tx_hash: params.txHash }, 'Horizon lookup failed, payment notification skipped');
    return { notified: 0, reason: 'horizon_error' };
  }

  let count = 0;
  for (const op of ops) {
    // Solo lo que sale de la cuenta de quien lo pide: una operacion con otra
    // cuenta de origen dentro de la misma transaccion no es su pago.
    const isPayment = op.type === 'payment' && op.from === params.senderAddress;
    const isCreate = op.type === 'create_account' && op.funder === params.senderAddress;
    if (!isPayment && !isCreate) continue;

    const destination = isPayment ? op.to : op.account;
    const amount = isPayment ? op.amount : op.starting_balance;
    if (!destination || !amount || destination === params.senderAddress) continue;

    const key = `${params.txHash}:${op.id}`;
    if (alreadyNotified(key, now)) continue;

    const recipient = await db.getOne<{ id: string }>(
      'SELECT id FROM users WHERE stellar_address = $1',
      [destination],
    );
    if (!recipient) continue;

    notified.set(key, now);
    const sent = await sendPaymentReceivedNotification(recipient.id, {
      txHash: params.txHash,
      amount: formatAmount(amount),
      asset: assetLabel(op),
      senderUsername: params.senderUsername,
    });
    if (sent) count++;
  }
  return { notified: count };
}
