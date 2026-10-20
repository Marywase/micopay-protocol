/**
 * Transferencias de la cuenta del usuario, para el Historial.
 *
 * Las operaciones de efectivo viven en la tabla `trades`, pero "Enviar pago" y
 * los pagos que llegan de fuera (Lobstr, un exchange) solo existen en la red.
 * Se leen de Horizon y a la otra parte se le pone su @usuario si es de
 * MicoPay. Solo se resuelven direcciones con las que el usuario de verdad
 * cruzo un pago: esto no sirve para averiguar de quien es cualquier direccion.
 *
 * Los movimientos del escrow son `invoke_host_function`, no pagos, asi que no
 * salen aqui: ya se ven como operacion.
 */
import db from '../db/schema.js';
import { config } from '../config.js';

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init);

/** Solo para pruebas. */
export function setPaymentHistoryFetchForTests(next: FetchLike | null): void {
  fetchImpl = next ?? ((url, init) => fetch(url, init));
}

function horizonUrl(): string {
  return config.stellarNetwork === 'TESTNET'
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org';
}

export interface PaymentHistoryItem {
  id: string;
  tx_hash: string;
  created_at: string;
  direction: 'in' | 'out';
  amount: string;
  asset: string;
  counterparty: string;
  counterparty_username: string | null;
}

interface HorizonOp {
  id: string;
  paging_token: string;
  type: string;
  transaction_hash: string;
  transaction_successful?: boolean;
  created_at: string;
  from?: string;
  to?: string;
  funder?: string;
  account?: string;
  amount?: string;
  starting_balance?: string;
  source_amount?: string;
  asset_type?: string;
  asset_code?: string;
  source_asset_type?: string;
  source_asset_code?: string;
}

function code(type: string | undefined, assetCode: string | undefined): string {
  return type === 'native' ? 'XLM' : assetCode ?? '';
}

/** Una operacion de Horizon como renglon del Historial, o null si no es un pago. */
export function toHistoryItem(op: HorizonOp, me: string): Omit<PaymentHistoryItem, 'counterparty_username'> | null {
  if (op.transaction_successful === false) return null;
  const base = { id: op.id, tx_hash: op.transaction_hash, created_at: op.created_at };

  if (op.type === 'create_account') {
    if (op.account === me && op.funder) {
      return { ...base, direction: 'in', amount: op.starting_balance ?? '0', asset: 'XLM', counterparty: op.funder };
    }
    if (op.funder === me && op.account) {
      return { ...base, direction: 'out', amount: op.starting_balance ?? '0', asset: 'XLM', counterparty: op.account };
    }
    return null;
  }

  const isPath = op.type === 'path_payment_strict_send' || op.type === 'path_payment_strict_receive';
  if (op.type !== 'payment' && !isPath) return null;
  if (!op.from || !op.to || op.from === op.to) return null;

  if (op.to === me) {
    return { ...base, direction: 'in', amount: op.amount ?? '0', asset: code(op.asset_type, op.asset_code), counterparty: op.from };
  }
  if (op.from === me) {
    // En un pago con conversion, quien envia ve lo que salio de su cuenta.
    return isPath
      ? { ...base, direction: 'out', amount: op.source_amount ?? '0', asset: code(op.source_asset_type, op.source_asset_code), counterparty: op.to }
      : { ...base, direction: 'out', amount: op.amount ?? '0', asset: code(op.asset_type, op.asset_code), counterparty: op.to };
  }
  return null;
}

/**
 * Ultimos pagos de `stellarAddress`, del mas nuevo al mas viejo. Una cuenta que
 * aun no existe en la red no tiene pagos: lista vacia, no error.
 */
export async function getPaymentHistory(stellarAddress: string, limit = 50): Promise<PaymentHistoryItem[]> {
  const url = `${horizonUrl()}/accounts/${stellarAddress}/payments?order=desc&limit=${limit}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Horizon respondio ${res.status}`);
  const page = (await res.json()) as { _embedded?: { records?: HorizonOp[] } };

  const items = (page._embedded?.records ?? [])
    .map((op) => toHistoryItem(op, stellarAddress))
    .filter((x): x is Omit<PaymentHistoryItem, 'counterparty_username'> => x !== null);

  const addresses = [...new Set(items.map((i) => i.counterparty))];
  const names = new Map<string, string>();
  if (addresses.length > 0) {
    const rows = await db.getMany<{ stellar_address: string; username: string | null }>(
      'SELECT stellar_address, username FROM users WHERE stellar_address = ANY($1)',
      [addresses],
    );
    for (const r of rows) if (r.username) names.set(r.stellar_address, r.username);
  }

  return items.map((i) => ({ ...i, counterparty_username: names.get(i.counterparty) ?? null }));
}
