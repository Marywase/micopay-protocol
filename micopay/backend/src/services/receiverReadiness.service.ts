import { config } from '../config.js';
import { AppError, UpstreamError } from '../utils/errors.js';

/**
 * Quien recibe del escrow tiene que poder recibir ANTES de que exista la operacion.
 *
 * Hallazgo del 2026-10-09 (pruebas de Raul, cuenta `Macuin`): una cuenta que no
 * existia en la red, sin XLM y sin trustline pudo crear depositos. En un
 * deposito el agente bloquea el cripto y el cliente es quien libera: si el
 * cliente no puede firmar `release` (cuenta inexistente o sin XLM para la
 * comision de red) ni recibir el activo, la operacion vence y el contrato le
 * devuelve el cripto al agente, que ya tiene el efectivo. El cliente pierde sus
 * billetes. En cash-out pasa lo mismo al reves con el agente.
 *
 * En el contrato, quien recibe y quien firma `release` es el mismo: el buyer del
 * escrow (`trade.buyer.require_auth()`). Por eso basta revisar al buyer.
 *
 * La app crea la trustline sola antes de liberar (`ensureTrustline` en
 * `frontend/src/services/api.ts`), asi que una trustline faltante no bloquea si
 * la cuenta tiene XLM para su reserva. La cuenta inexistente si bloquea: crearla
 * exige que alguien mas la fondee.
 */

/** Reserva base de la red, en XLM (protocolo actual). */
export const BASE_RESERVE_XLM = 0.5;
/**
 * Margen para la comision de `release`. Las invocaciones de Soroban cobran
 * recursos ademas de la base; el reembolso administrativo ofrece hasta 0.1 XLM
 * (`callRefundOnChain`), y aqui se usa el mismo tope.
 */
export const RELEASE_FEE_BUFFER_XLM = 0.1;

export type ReceiverReadiness =
  | { ready: true }
  | { ready: false; reason: 'account_not_found' | 'insufficient_xlm'; requiredXlm?: number; spendableXlm?: number };

export interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  selling_liabilities?: string;
}

export interface HorizonAccount {
  balances: HorizonBalance[];
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
}

/**
 * Decide con la cuenta ya leida de Horizon. Sin red, para poder probarla sola.
 *
 * La trustline se busca por codigo: el backend no conoce el emisor del activo
 * del escrow (vive en la configuracion del APK). Si hay una trustline con ese
 * codigo y es de otro emisor, la app la detecta al liberar; aqui solo se evita
 * crear operaciones que no pueden terminar por falta de cuenta o de XLM.
 */
/** XLM que la cuenta puede gastar sin bajar de su reserva minima. */
export function spendableXlmOf(account: HorizonAccount): number {
  const native = account.balances.find((b) => b.asset_type === 'native');
  const balance = Number(native?.balance ?? 0);
  const sellingLiabilities = Number(native?.selling_liabilities ?? 0);
  const entries = 2 + account.subentry_count + (account.num_sponsoring ?? 0) - (account.num_sponsored ?? 0);
  return balance - entries * BASE_RESERVE_XLM - sellingLiabilities;
}

export function evaluateReceiverAccount(account: HorizonAccount | null, assetCode: string): ReceiverReadiness {
  if (!account) return { ready: false, reason: 'account_not_found' };

  const spendableXlm = spendableXlmOf(account);

  const code = assetCode.trim().toUpperCase();
  const needsTrustline =
    code !== 'XLM' &&
    !account.balances.some((b) => b.asset_type !== 'native' && b.asset_code?.toUpperCase() === code);

  const requiredXlm = RELEASE_FEE_BUFFER_XLM + (needsTrustline ? BASE_RESERVE_XLM : 0);
  if (spendableXlm < requiredXlm) {
    return {
      ready: false,
      reason: 'insufficient_xlm',
      requiredXlm,
      spendableXlm: Math.max(0, Number(spendableXlm.toFixed(7))),
    };
  }
  return { ready: true };
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init);

/** Solo para pruebas. */
export function setReceiverReadinessFetchForTests(next: FetchLike | null): void {
  fetchImpl = next ?? ((url, init) => fetch(url, init));
}

export function horizonUrl(): string {
  return config.stellarNetwork === 'TESTNET'
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org';
}

export class ReceiverNotReadyError extends AppError {
  constructor(public readonly readiness: Exclude<ReceiverReadiness, { ready: true }>, receiverIsCaller: boolean) {
    const userMessage =
      readiness.reason === 'account_not_found'
        ? receiverIsCaller
          ? 'Tu cuenta todavia no esta activa en la red. Agrega XLM a tu billetera para poder recibir.'
          : 'Este agente todavia no puede recibir pagos. Elige otro agente.'
        : receiverIsCaller
          ? `Necesitas al menos ${readiness.requiredXlm} XLM disponibles para recibir y pagar la comision de red.`
          : 'Este agente no tiene XLM suficiente para recibir el pago. Elige otro agente.';
    super(
      'RECEIVER_NOT_READY',
      userMessage,
      `Escrow buyer cannot receive: ${readiness.reason}` +
        (readiness.requiredXlm !== undefined ? ` (spendable ${readiness.spendableXlm} XLM, required ${readiness.requiredXlm})` : ''),
      422,
    );
  }
}

/**
 * Lee la cuenta en Horizon y lanza si quien recibe no puede recibir.
 *
 * Si Horizon falla se rechaza la operacion (502): crearla sin saber si quien
 * recibe puede cobrar es justo el riesgo que esto cierra.
 */
export async function assertReceiverCanReceive(params: {
  stellarAddress: string;
  assetCode: string;
  receiverIsCaller: boolean;
}): Promise<void> {
  if (config.mockStellar) return;

  let account: HorizonAccount | null;
  try {
    const res = await fetchImpl(`${horizonUrl()}/accounts/${params.stellarAddress}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) {
      account = null;
    } else if (!res.ok) {
      throw new Error(`Horizon respondio ${res.status}`);
    } else {
      account = (await res.json()) as HorizonAccount;
    }
  } catch (err: any) {
    throw new UpstreamError(
      'RECEIVER_CHECK_FAILED',
      'No pudimos revisar la cuenta en la red. Intenta de nuevo en un momento.',
      `Horizon account lookup failed: ${err?.message ?? err}`,
    );
  }

  const readiness = evaluateReceiverAccount(account, params.assetCode);
  if (!readiness.ready) throw new ReceiverNotReadyError(readiness, params.receiverIsCaller);
}
