import { config } from '../config.js';
import { AppError, UpstreamError, ValidationError } from '../utils/errors.js';
import { getRampAssets } from './etherfuse.service.js';
import {
  BASE_RESERVE_XLM,
  horizonUrl,
  spendableXlmOf,
  type HorizonAccount,
} from './receiverReadiness.service.js';

/**
 * Retirar a banco (SPEI) — docs/PLAN_RETIRO_SPEI_2026-10-12.md.
 *
 * Etherfuse (modo anchor) solo acepta ciertos activos: en el sandbox cotiza
 * CETES, USDC y MEXe a MXN y rechaza XLM (400). Lo que no acepta pasa primero
 * por el DEX de Stellar a USDC, en la misma transaccion que paga a Etherfuse:
 *
 *   1. changeTrust USDC (solo si falta)
 *   2. pathPaymentStrictReceive del usuario a si mismo: recibe exactamente el
 *      USDC cotizado y gasta como maximo lo que escribio
 *   3. payment del USDC a withdrawAnchorAccount con Memo.hash
 *
 * Asi Etherfuse solo ve el `payment` que documenta, y si la conversion falla no
 * se mueve nada. Los identificadores (CODE:ISSUER) salen siempre de
 * GET /ramp/assets: los issuers del sandbox y de produccion son distintos y no
 * coinciden con los del .env de la app.
 */

export const WITHDRAW_ASSETS = ['USDC', 'CETES', 'MEXe', 'XLM'] as const;
export type WithdrawAsset = (typeof WITHDRAW_ASSETS)[number];

/** Activos que Etherfuse no recibe y que se convierten a USDC en el DEX. */
const DEX_ASSETS: ReadonlySet<WithdrawAsset> = new Set(['XLM']);
export const BRIDGE_SYMBOL = 'USDC';

/** Margen de deslizamiento del DEX, en puntos base. */
export const DEX_SLIPPAGE_BPS = 100;
/** XLM que se le deja libre al usuario despues de vender XLM (comisiones futuras). */
export const XLM_KEEP_FREE = 1;
/** XLM minimo libre para pagar la comision de red cuando no vende XLM. */
export const TX_FEE_BUFFER_XLM = 0.1;

const STROOPS = 10_000_000n;
/** Etherfuse cotiza montos de offramp con 2 decimales en sus ejemplos; se redondea hacia abajo a centavos. */
const CENT_STROOPS = 100_000n;

export interface StellarAssetRef {
  code: string;
  /** null = XLM nativo. */
  issuer: string | null;
}

export function parseWithdrawAsset(input: unknown): WithdrawAsset | null {
  if (typeof input !== 'string') return null;
  const wanted = input.trim().toUpperCase();
  return WITHDRAW_ASSETS.find((a) => a.toUpperCase() === wanted) ?? null;
}

export function needsDex(asset: WithdrawAsset): boolean {
  return DEX_ASSETS.has(asset);
}

export function splitIdentifier(identifier: string): StellarAssetRef {
  const [code, issuer] = identifier.split(':');
  if (!code || !issuer) throw new Error(`Identificador de Etherfuse invalido: ${identifier}`);
  return { code, issuer };
}

/** "12.5" -> 125000000n. Rechaza mas de 7 decimales, negativos y basura. */
export function toStroops(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(amount.trim());
  if (!m) throw new ValidationError('Monto invalido');
  return BigInt(m[1]) * STROOPS + BigInt((m[2] ?? '').padEnd(7, '0'));
}

/** 125000000n -> "12.5000000" (formato de Horizon y del SDK). */
export function fromStroops(stroops: bigint): string {
  const whole = stroops / STROOPS;
  const frac = (stroops % STROOPS).toString().padStart(7, '0');
  return `${whole}.${frac}`;
}

/** "12.5000000" -> "12.5": los montos que se le mandan a Etherfuse, sin ceros de relleno. */
export function plainAmount(amount: string): string {
  return amount.includes('.') ? amount.replace(/\.?0+$/, '') : amount;
}

/**
 * USDC que se puede prometer a Etherfuse a partir de lo que el DEX dice que
 * entrega hoy: se descuenta el margen y se redondea hacia abajo a centavos.
 */
export function bridgeAmountAfterSlippage(dexDestinationAmount: string): string {
  const raw = toStroops(dexDestinationAmount);
  const afterSlippage = (raw * BigInt(10_000 - DEX_SLIPPAGE_BPS)) / 10_000n;
  return fromStroops((afterSlippage / CENT_STROOPS) * CENT_STROOPS);
}

// ── Validacion de la cuenta ────────────────────────────────────────────────

export type WithdrawReadiness =
  | { ready: true; needsBridgeTrustline: boolean }
  | {
      ready: false;
      reason: 'account_not_found' | 'insufficient_xlm' | 'no_trustline' | 'insufficient_balance';
      /** Para XLM: lo maximo que puede vender hoy. Para otros: su saldo disponible. */
      available?: string;
      requiredXlm?: number;
      spendableXlm?: number;
    };

function hasAsset(account: HorizonAccount, ref: StellarAssetRef) {
  return account.balances.find(
    (b) => b.asset_type !== 'native' && b.asset_code === ref.code && b.asset_issuer === ref.issuer,
  );
}

/**
 * Decide con la cuenta ya leida de Horizon (sin red, para probarla sola).
 *
 * Etherfuse falla en silencio si la wallet no existe, no tiene XLM o no tiene
 * la trustline del activo, asi que todo eso se revisa antes de cotizar.
 */
export function evaluateWithdrawAccount(
  account: HorizonAccount | null,
  params: { sell: StellarAssetRef; amount: string; bridge?: StellarAssetRef },
): WithdrawReadiness {
  if (!account) return { ready: false, reason: 'account_not_found' };

  const spendableStroops = BigInt(Math.floor(spendableXlmOf(account) * 1e7));
  const amountStroops = toStroops(params.amount);
  const toXlm = (s: bigint) => Number(fromStroops(s > 0n ? s : 0n));

  if (params.sell.issuer === null) {
    const needsBridgeTrustline = !!params.bridge && !hasAsset(account, params.bridge);
    const extra =
      BigInt(XLM_KEEP_FREE) * STROOPS + (needsBridgeTrustline ? BigInt(Math.round(BASE_RESERVE_XLM * 1e7)) : 0n);
    if (spendableStroops - extra < amountStroops) {
      return {
        ready: false,
        reason: 'insufficient_xlm',
        available: fromStroops(spendableStroops - extra > 0n ? spendableStroops - extra : 0n),
        requiredXlm: toXlm(amountStroops + extra),
        spendableXlm: toXlm(spendableStroops),
      };
    }
    return { ready: true, needsBridgeTrustline };
  }

  const line = hasAsset(account, params.sell);
  if (!line) return { ready: false, reason: 'no_trustline' };

  const available = toStroops(line.balance) - toStroops(line.selling_liabilities ?? '0');
  if (available < amountStroops) {
    return { ready: false, reason: 'insufficient_balance', available: fromStroops(available > 0n ? available : 0n) };
  }

  const feeBuffer = BigInt(Math.round(TX_FEE_BUFFER_XLM * 1e7));
  if (spendableStroops < feeBuffer) {
    return {
      ready: false,
      reason: 'insufficient_xlm',
      requiredXlm: TX_FEE_BUFFER_XLM,
      spendableXlm: toXlm(spendableStroops),
    };
  }
  return { ready: true, needsBridgeTrustline: false };
}

export class WithdrawNotReadyError extends AppError {
  constructor(public readonly readiness: Exclude<WithdrawReadiness, { ready: true }>, assetLabel: string) {
    const userMessage = {
      account_not_found: 'Tu cuenta todavia no esta activa en la red. Agrega XLM a tu billetera.',
      insufficient_xlm:
        readiness.available !== undefined
          ? `No te alcanza: hoy puedes retirar hasta ${Number(readiness.available)} XLM (se te deja XLM para comisiones).`
          : `Necesitas al menos ${readiness.requiredXlm} XLM libres para la comision de red.`,
      no_trustline: `Tu billetera no tiene ${assetLabel}.`,
      insufficient_balance: `Saldo insuficiente: tienes ${Number(readiness.available ?? 0)} ${assetLabel} disponibles.`,
    }[readiness.reason];
    super('WITHDRAW_NOT_READY', userMessage, `Withdraw preflight failed: ${JSON.stringify(readiness)}`, 422);
  }
}

// ── Horizon ────────────────────────────────────────────────────────────────

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init);

/** Solo para pruebas. */
export function setRampWithdrawFetchForTests(next: FetchLike | null): void {
  fetchImpl = next ?? ((url, init) => fetch(url, init));
}

function horizonFailed(err: unknown): UpstreamError {
  return new UpstreamError(
    'HORIZON_UNAVAILABLE',
    'No pudimos consultar la red de Stellar. Intenta de nuevo en un momento.',
    `Horizon request failed: ${(err as Error)?.message ?? err}`,
  );
}

export async function loadHorizonAccount(address: string): Promise<HorizonAccount | null> {
  try {
    const res = await fetchImpl(`${horizonUrl()}/accounts/${address}`, { signal: AbortSignal.timeout(5000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Horizon respondio ${res.status}`);
    return (await res.json()) as HorizonAccount;
  } catch (err) {
    throw horizonFailed(err);
  }
}

export interface DexRoute {
  destinationAmount: string;
  path: StellarAssetRef[];
}

interface HorizonPathRecord {
  destination_amount: string;
  path: { asset_type: string; asset_code?: string; asset_issuer?: string }[];
}

/**
 * Mejor ruta del DEX para vender exactamente `sendAmount` de `send` a cambio de
 * `dest` (strict-send). null si no hay liquidez.
 */
export async function findStrictSendRoute(
  send: StellarAssetRef,
  sendAmount: string,
  dest: StellarAssetRef,
): Promise<DexRoute | null> {
  const q = new URLSearchParams({
    source_asset_type: send.issuer === null ? 'native' : send.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
    source_amount: sendAmount,
    destination_assets: dest.issuer === null ? 'native' : `${dest.code}:${dest.issuer}`,
  });
  if (send.issuer !== null) {
    q.set('source_asset_code', send.code);
    q.set('source_asset_issuer', send.issuer);
  }

  let records: HorizonPathRecord[];
  try {
    const res = await fetchImpl(`${horizonUrl()}/paths/strict-send?${q}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Horizon respondio ${res.status}`);
    records = ((await res.json()) as { _embedded: { records: HorizonPathRecord[] } })._embedded.records;
  } catch (err) {
    throw horizonFailed(err);
  }

  let best: HorizonPathRecord | null = null;
  for (const r of records) {
    if (!best || toStroops(r.destination_amount) > toStroops(best.destination_amount)) best = r;
  }
  if (!best) return null;
  return {
    destinationAmount: best.destination_amount,
    path: best.path.map((p) =>
      p.asset_type === 'native' ? { code: 'XLM', issuer: null } : { code: p.asset_code!, issuer: p.asset_issuer! },
    ),
  };
}

// ── Etherfuse ──────────────────────────────────────────────────────────────

export interface RampAssetRef extends StellarAssetRef {
  identifier: string;
  issuer: string;
}

/** Busca el activo por simbolo en GET /ramp/assets (nunca en el .env). */
export async function resolveRampAsset(wallet: string, symbol: string): Promise<RampAssetRef> {
  const assets = await getRampAssets(wallet, 'mxn');
  const found = assets.find((a) => a.symbol.toUpperCase() === symbol.toUpperCase());
  if (!found) {
    throw new UpstreamError(
      'RAMP_ASSET_UNAVAILABLE',
      `Etherfuse no acepta ${symbol} por ahora.`,
      `${symbol} not found in Etherfuse /ramp/assets`,
    );
  }
  const ref = splitIdentifier(found.identifier);
  return { identifier: found.identifier, code: ref.code, issuer: ref.issuer! };
}

export function partnerFeeBps(): number | undefined {
  const raw = Number(process.env.ETHERFUSE_PARTNER_FEE_BPS ?? 0);
  if (!Number.isInteger(raw) || raw <= 0) return undefined;
  return Math.min(raw, 500);
}

/** Para pruebas sin red: `MOCK_STELLAR` salta la validacion de la cuenta. */
export function skipChainChecks(): boolean {
  return config.mockStellar;
}
