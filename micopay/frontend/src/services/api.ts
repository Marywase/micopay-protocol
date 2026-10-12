import axios from 'axios';
import { extractApiErrorPayload, toApiError } from '../utils/apiError';
import { signChallenge, getPublicKey, signTransactionXdr } from '../lib/keystore';
// CASH-5A: el conjunto canónico de estados vive en TradeStateBadge, que es su
// dueño según el issue. Import de solo tipo: se borra al compilar, así que no
// crea dependencia en runtime de services -> components.
import type { TradeState } from '../components/TradeStateBadge';
import { removeKey } from './secureStorage';
import { PLATFORM_FEE_PERCENT } from '../constants/trade';
import type { MutationType, MutationPayloadMap } from './offlineQueue';


const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

const http = axios.create({ baseURL: BASE_URL });

function authHeaders(token: string) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

// ─── DeFi: KYC (hosted flows — Etherfuse for CETES onboarding, Didit for #314's
// tiered gate; both share the same POST start / GET status polling contract) ──

export type KYCProvider = 'etherfuse' | 'didit';
export type KYCStatus = 'pending' | 'approved' | 'rejected';

export interface KYCStatusResponse {
  status: KYCStatus;
  reason?: string | null;
}

/**
 * Generates a short-lived (≈15 min) onboarding URL.
 * URL must be generated at button touch (not earlier).
 */
export async function startKYC(
  token: string,
  provider: KYCProvider = 'etherfuse',
  email?: string,
): Promise<{ onboardingUrl: string }> {
  const res = await http.post('/defi/kyc/start', { email }, { ...authHeaders(token), params: { provider } });
  return res.data;
}

/**
 * Poll KYC verification status.
 */
export async function getKYCStatus(
  token: string,
  provider: KYCProvider = 'etherfuse',
): Promise<KYCStatusResponse> {
  const res = await http.get('/defi/kyc/status', { ...authHeaders(token), params: { provider } });
  return res.data;
}


export interface UserData {
  id: string;
  username: string;
  token: string;
}

export interface CurrentUserProfile {
  id: string;
  username: string;
  stellar_address: string;
  phone_hash?: string | null;
  deleted_at?: string | null;
  wallet_type?: string | null;
  created_at?: string;
  /** Completed trades (reputation) — computed by GET /users/me */
  trades_completed?: number;
  /** Completion rate (%) over terminal trades, null if no history */
  completion_rate?: number | null;
  /** Reputation tier: Nuevo | Bronce | Plata | Oro */
  reputation_tier?: string;

  /**
   * KYC-1: identidad real del KYC general. `Home` y `MerchantSettings` leían
   * `verification_status`, un campo que no existe en la respuesta —el propio
   * código lo casteaba con `as any`— así que su valor era siempre `undefined`.
   */
  kyc_level?: number | null;
  kyc_provider?: 'didit' | 'etherfuse' | null;
  kyc_level_verified_at?: string | null;
  /**
   * RED-1: pertenencia a Red MicoPay. Es un hecho aparte de tener sesión, de
   * estar verificado y de estar disponible ahora mismo. Ausente = no inscrito;
   * nunca se debe inferir de que haya sesión, que era el defecto anterior.
   */
  provider_status?: ProviderStatus | null;
  /**
   * Disponibilidad comercial actual. Solo significa algo si eres agente activo.
   * El KYC dice quién eres, no si estás atendiendo.
   */
  availability?: 'online' | 'offline' | 'paused' | null;
  merchant_available?: boolean | null;
}

/** RED-1: los cuatro estados posibles de pertenencia a Red MicoPay. */
export type ProviderStatus = 'not_enrolled' | 'pending_verification' | 'active' | 'suspended';

export interface ProviderReadinessItem {
  /** Identificador estable: la app no depende del texto del servidor. */
  key: 'kyc' | 'location' | 'limits';
  done: boolean;
  detail: string | null;
}

export interface ProviderReadiness {
  status: ProviderStatus;
  /** La elegibilidad la decide el servidor. La app no la deduce sumando items. */
  can_activate: boolean;
  items: ProviderReadinessItem[];
  availability: string | null;
  merchant_available: boolean;
  required_kyc_level: number;
  kyc_level: number;
  kyc_provider: string | null;
}

/** RED-1: inicia el alta como agente. Idempotente. */
export async function enrollAsProvider(token: string): Promise<ProviderReadiness> {
  const res = await http.post('/merchants/me/enroll', {}, authHeaders(token));
  return res.data;
}

/** RED-1: qué falta para poder activarse. La verdad la dice el servidor. */
export async function fetchProviderReadiness(token: string): Promise<ProviderReadiness> {
  const res = await http.get('/merchants/me/readiness', authHeaders(token));
  return res.data;
}

/** RED-1: activa al agente. Falla cerrada en el servidor si falta algo. */
export async function activateProvider(token: string): Promise<ProviderReadiness> {
  const res = await http.post('/merchants/me/activate', {}, authHeaders(token));
  return res.data;
}

/** CASH-1 (#372): canonical product flow, independent of the escrow roles. */
export type TradeFlow = 'deposit' | 'cashout';

export interface TradeData {
  id: string;
  /** CASH-5A: estado canónico. El tipo documenta el contrato; la realidad
   *  en runtime se valida con parseTradeState antes de usarla. */
  status: TradeState;
  secret_hash: string;
  amount_mxn: number;
  /** Roles del escrow. GET /trades/:id y POST /trades los devuelven. */
  seller_id?: string;
  buyer_id?: string;
  lock_tx_hash?: string | null;
  release_tx_hash?: string | null;
  /**
   * WP-A: activo y cifras del escrow, congelados por el servidor al crear la
   * operacion. Opcionales porque una respuesta antigua o una operacion demo no
   * los trae: en ese caso la UI muestra solo pesos y no inventa el activo.
   */
  asset_code?: string | null;
  /** MXN por 1 unidad del activo, decimal en cadena. */
  rate_mxn?: string | null;
  /**
   * Cifras en unidades minimas (stroops), como cadenas enteras. Nunca se
   * recalculan en el cliente. El contrato bloquea `amount + platform_fee`:
   *  - `amount_stroops`: lo que recibe el comprador al liberar;
   *  - `platform_fee_stroops`: la comision de plataforma;
   *  - `total_locked_stroops`: lo que retiene el escrow y devuelve si hay reembolso.
   */
  amount_stroops?: string | null;
  platform_fee_stroops?: string | null;
  total_locked_stroops?: string | null;
  /**
   * H5: `cash_in_hand` = el monto es el efectivo que cambia de mano. Las
   * anteriores (`amount_is_escrow`) no traen el desglose del cliente.
   */
  fee_model?: string | null;
  /** Lo que paga el cliente: saldo en retiro (monto + comisiones), efectivo en deposito. */
  client_pays_mxn?: number | null;
  /** Lo que recibe el cliente: efectivo en retiro, saldo en deposito. */
  client_receives_mxn?: number | null;
}

export interface TradeDetailResponse {
  trade: TradeData & {
    lock_tx_hash?: string | null;
    release_tx_hash?: string | null;
    platform_fee_mxn?: number;
    /** Congeladas al crear la operacion (tradeFees.ts del backend). */
    provider_fee_mxn?: number;
    payout_mxn?: number;
    seller_id?: string;
    buyer_id?: string;
    flow?: TradeFlow;
    provider_id?: string;
    created_at?: string;
    completed_at?: string | null;
    expires_at?: string;
  };
  merchant_unavailable: boolean;
  seller_username: string | null;
  buyer_username: string | null;
}

export async function fetchTradeDetail(tradeId: string, buyerToken: string): Promise<TradeDetailResponse> {
  const res = await http.get(`/trades/${tradeId}`, authHeaders(buyerToken));
  return res.data;
}

/** Mirrors backend `CancelTradeResult` after POST /trades/:id/cancel (#20). */
export interface CancelTradeResponse {
  status: 'cancelled';
  /**
   * CASH-2: hay fondos que volverán a su dueño. NO significa que ya hayan
   * vuelto: cancelar detiene el flujo de la app, no liquida la cadena.
   */
  refund_expected: boolean;
  /** CASH-2: desde cuándo se puede reclamar. `null` si no hay fondos. */
  refund_available_at: string | null;
  lock_tx_hash: string | null;
}

export async function cancelTradeRequest(tradeId: string, buyerToken: string): Promise<CancelTradeResponse> {
  try {
    const res = await http.post(`/trades/${tradeId}/cancel`, {}, authHeaders(buyerToken));
    return res.data as CancelTradeResponse;
  } catch (e: unknown) {
    throw toApiError(extractApiErrorPayload(e));
  }
}

export async function patchMerchantAvailability(
    token: string,
    merchant_available: boolean,
): Promise<{ merchant_available: boolean }> {
  const res = await http.patch('/users/me', { merchant_available }, authHeaders(token));
  return res.data.user;
}

/**
 * Mirrors backend `MerchantLocation` after PATCH /merchants/me/location.
 *
 * RED-3: `address_text` era un solo campo de texto libre que acababa en el
 * discovery anonimo. Ahora son dos cosas distintas, porque lo son: la zona es
 * publica y el punto exacto es privado.
 */
export interface MerchantLocation {
  latitude: number;
  longitude: number;
  /** Zona amplia y publica. */
  area_label: string | null;
  /** Punto exacto. Privado salvo consentimiento explicito. */
  meeting_point: string | null;
  /** Consentimiento para publicar el punto exacto. Nunca se infiere. */
  publish_storefront: boolean;
  updated_at: string;
}

export async function updateMerchantLocation(
    input: {
      latitude: number;
      longitude: number;
      area_label?: string;
      meeting_point?: string;
      publish_storefront?: boolean;
    },
    token: string,
): Promise<MerchantLocation> {
  const res = await http.patch('/merchants/me/location', input, authHeaders(token));
  return res.data.location;
}

/**
 * Registers a new user. The backend requires proof that this device holds
 * stellar_address's private key (same challenge/response dance as login) —
 * otherwise anyone could register someone else's public Stellar address
 * before they do. See docs/AUDIT_MOBILE_MAINNET.md, "Registro sin prueba de
 * posesión de llave".
 *
 * `phoneHash` stays optional and is forwarded untouched: it belongs to the
 * anti-abuse controls added in #319 and is unrelated to key possession.
 */
export async function registerUser(username: string, phoneHash?: string): Promise<UserData> {
  // No fallback address here: a synthetic address whose key we do not hold
  // could never sign the challenge, so it would fail server-side anyway.
  const stellar_address = await getPublicKey();
  if (!stellar_address) {
    throw new Error('No device keypair found — generateAndStoreKeypair() must run before registerUser()');
  }

  const challengeRes = await fetch(`${BASE_URL}/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stellar_address }),
  });
  const challengeData = await challengeRes.json();
  const challenge: string | undefined = challengeData.challenge;
  if (!challenge) throw new Error(`Auth challenge failed (${challengeRes.status}): ${challengeData.error ?? 'no challenge'}`);

  const signature = await signChallenge(challenge);

  try {
    const body: Record<string, string> = { username, stellar_address, challenge, signature };
    if (phoneHash) {
      body.phone_hash = phoneHash;
    }
    const res = await http.post("/users/register", body);
    return { ...res.data.user, token: res.data.token };
  } catch (e: unknown) {
    // Surface the backend's code (ADDRESS_ALREADY_REGISTERED / USERNAME_TAKEN)
    // as an ApiError — the two 409s need very different UI, see Register.tsx.
    throw toApiError(extractApiErrorPayload(e));
  }
}

/**
 * Exchanges the device keypair for a JWT. Authentication is by Stellar address
 * only: the server finds the account from the signed challenge, so there is no
 * username to pass. (It used to take one, which was never sent anywhere — the
 * login screen was asking for a value it then ignored.)
 */
export async function getAuthToken(): Promise<string> {
  const stellar_address = await getPublicKey();
  if (!stellar_address) {
    throw new Error('No device keypair found — generateAndStoreKeypair() must run before getAuthToken()');
  }

  // Step 1: request a one-time challenge from the server
  const challengeRes = await fetch(`${BASE_URL}/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stellar_address }),
  });
  const challengeData = await challengeRes.json();
  const challenge: string | undefined = challengeData.challenge;
  if (!challenge) throw new Error(`Auth challenge failed (${challengeRes.status}): ${challengeData.error ?? 'no challenge'}`);

  // Step 2: sign with the device keypair — private key never leaves the device
  const signature = await signChallenge(challenge);

  // Step 3: exchange challenge + signature for a JWT
  const tokenRes = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stellar_address, challenge, signature }),
  });
  const tokenData = await tokenRes.json();
  const token: string | undefined = tokenData.token;
  if (!token) throw new Error(tokenData.error ?? `Auth failed (${tokenRes.status})`);

  return token;
}

/**
 * Creates a trade between the caller and a counterparty.
 *
 * CASH-1 (#372): the payload carries the *product* flow, not the caller's
 * escrow role. 'deposit' means the caller buys crypto with cash (the
 * counterparty locks funds as escrow seller); 'cashout' means the caller sells
 * crypto for cash and is therefore the escrow seller, because only the seller
 * can lock funds and reveal the HTLC secret. The backend derives the escrow
 * roles and the Red MicoPay provider from this flow — the client never sends a
 * provider id, and the API rejects the request if it tries.
 */
export async function createTrade(
    counterpartyId: string,
    amountMxn: number,
    callerToken: string,
    flow: TradeFlow = 'deposit',
    /** WP-B: `asset_code` del escrow. Omitido -> el backend usa XLM. */
    assetCode?: string,
): Promise<TradeData> {
  try {
    const body: Record<string, unknown> = { counterparty_id: counterpartyId, amount_mxn: amountMxn, flow };
    if (assetCode !== undefined) body.asset_code = assetCode;
    const res = await http.post('/trades', body, authHeaders(callerToken));
    return res.data.trade;
  } catch (e: unknown) {
    throw toApiError(extractApiErrorPayload(e));
  }
}

export async function getTrade(
    tradeId: string,
    token: string,
): Promise<TradeData> {
  const res = await http.get(`/trades/${tradeId}`, authHeaders(token));
  return res.data.trade;
}

/**
 * Locks the trade on-chain. The seller's own device key signs the lock()
 * call locally (the contract requires seller.require_auth()) — the backend
 * only ever sees the already-signed transaction.
 */
export async function lockTrade(
    tradeId: string,
    sellerToken: string,
): Promise<{ status?: TradeState; lock_tx_hash: string }> {
  const prepareRes = await http.post(
      `/trades/${tradeId}/lock/prepare`,
      {},
      authHeaders(sellerToken),
  );
  const prepared = prepareRes.data as { mock: true } | { xdr: string; network_passphrase: string };
  const signedXdr =
    'mock' in prepared
      ? undefined
      : await signTransactionXdr(prepared.xdr, prepared.network_passphrase, 'lock');

  const res = await http.post(
      `/trades/${tradeId}/lock`,
      signedXdr ? { signed_xdr: signedXdr } : {},
      authHeaders(sellerToken),
  );
  // El `status` viaja tambien. Descartarlo dejaba el estado local en `pending`
  // despues de un bloqueo exitoso, y la pantalla del QR volvia a intentar
  // bloquear una operacion ya bloqueada: el servidor respondia 409 y la app lo
  // traducia a "otra persona movio esta operacion antes que tu".
  return { status: res.data.status as TradeState | undefined, lock_tx_hash: res.data.lock_tx_hash };
}

export async function revealTrade(
    tradeId: string,
    sellerToken: string,
): Promise<void> {
  await http.post(
      `/trades/${tradeId}/reveal`,
      undefined,
      authHeaders(sellerToken),
  );
}

/**
 * Devuelve el QR de cobro del vendedor. El payload lleva un token opaco de un
 * solo uso, no el preimage HTLC (SEC-02).
 */
export async function getSecret(
    tradeId: string,
    sellerToken: string,
): Promise<{ qr_payload: string; expires_at: string; expires_in: number }> {
  const res = await http.get(
      `/trades/${tradeId}/secret`,
      authHeaders(sellerToken),
  );
  return res.data;
}

export interface CompleteTradeResponse {
  /** CASH-5A: estado canónico. El tipo documenta el contrato; la realidad
   *  en runtime se valida con parseTradeState antes de usarla. */
  status: TradeState;
  release_tx_hash: string;
}

/**
 * Releases the trade on-chain. The buyer's own device key signs the release()
 * call locally (the contract requires buyer.require_auth()) — the backend
 * only ever sees the already-signed transaction.
 */
export async function completeTrade(
    tradeId: string,
    token: string,
): Promise<CompleteTradeResponse> {
  // Quien recibe un activo emitido (USDC) necesita su trustline ANTES del
  // prepare: sin ella la simulacion del release falla. El activo sale de la
  // operacion, no de la configuracion del APK. XLM no necesita nada.
  const trade = await getTrade(tradeId, token);
  if (trade.asset_code && trade.asset_code.toUpperCase() !== 'XLM') {
    const { ensureTrustline } = await import('./payment');
    await ensureTrustline(trade.asset_code);
  }

  const prepareRes = await http.post(`/trades/${tradeId}/complete/prepare`, {}, authHeaders(token));
  const prepared = prepareRes.data as { mock: true } | { xdr: string; network_passphrase: string };
  const signedXdr =
    'mock' in prepared
      ? undefined
      : await signTransactionXdr(prepared.xdr, prepared.network_passphrase, 'release');

  const res = await http.post(`/trades/${tradeId}/complete`, signedXdr ? { signed_xdr: signedXdr } : {}, authHeaders(token));
  return res.data;
}

export interface RefundTradeResponse {
  status: 'refunded';
  refund_tx_hash: string;
}

export async function refundTradeRequest(tradeId: string, token: string): Promise<RefundTradeResponse> {
  try {
    const res = await http.post(`/trades/${tradeId}/refund`, {}, authHeaders(token));
    return res.data as RefundTradeResponse;
  } catch (e: unknown) {
    const { message } = extractApiErrorPayload(e);
    throw new Error(message);
  }
}

export interface TradeHistoryItem {
  id: string;
  /** CASH-5A: estado canónico. El tipo documenta el contrato; la realidad
   *  en runtime se valida con parseTradeState antes de usarla. */
  status: TradeState;
  amount_mxn: number;
  platform_fee_mxn: number;
  lock_tx_hash: string | null;
  release_tx_hash: string | null;
  created_at: string;
  completed_at: string | null;
  seller_id: string;
  buyer_id: string;
  flow: TradeFlow;
  provider_id: string;
}

export interface MerchantTrade {
  id: string;
  /** CASH-3: la contraparte es el CLIENTE, que en cash-out es el vendedor del
   *  escrow y no el comprador. Antes se llamaba `buyer_handle` y en cash-out
   *  traia el nombre del propio proveedor. */
  client_handle: string;
  /** CASH-3: sin esto las dos clases de solicitud se ven identicas en la
   *  bandeja, y el proveedor no sabe si va a entregar o a recibir efectivo. */
  flow: TradeFlow;
  amount_mxn: number;
  /** CASH-5A: estado canónico. El tipo documenta el contrato; la realidad
   *  en runtime se valida con parseTradeState antes de usarla. */
  status: TradeState;
  created_at: string;
}

export async function getMerchantTrades(
    token: string,
    state: string = 'all',
): Promise<MerchantTrade[]> {
  const res = await http.get(`/merchants/me/trades?state=${state}`, authHeaders(token));
  return res.data.trades;
}

export async function getTradeHistory(
    token: string,
): Promise<TradeHistoryItem[]> {
  const res = await http.get("/trades/history", authHeaders(token));
  return res.data.trades;
}

export async function getCurrentUser(
    token: string,
): Promise<CurrentUserProfile> {
  const res = await http.get("/users/me", authHeaders(token));
  return res.data.user;
}

export async function deleteAccount(
    token: string,
    username: string,
): Promise<{ status: string }> {
  const res = await http.post(
      "/users/me/delete",
      { username },
      authHeaders(token),
  );
  return res.data;
}

export async function getAccountBalance(): Promise<{
  xlm: string;
  address: string;
}> {
  const res = await http.get("/account/balance");
  return res.data;
}

export type Availability = 'online' | 'offline' | 'paused';

export async function setAvailability(availability: Availability, token: string): Promise<void> {
  await http.patch('/users/me/availability', { availability }, authHeaders(token));
}

// ─── DeFi: CETES ──────────────────────────────────────────────────────────

export interface CETESRate {
  apy: number;
  xlmPerUsdc: number;
  cetesIssuer: string;
  cesPriceMxn: number;
  network: string;
  note: string;
}

export interface CETESTxResult {
  hash: string;
  status: string;
  simulated: boolean;
  amount: string;
  sourceAsset?: string;
  cetesReceived?: string;
  destReceived?: string;
  explorerUrl: string;
  note?: string;
}

export interface XlmMxnRate {
  rate: number;
  source: string;
  fetchedAt: string;
  /** true cuando se sirvió la última cotización conocida porque las fuentes fallaron. */
  stale?: boolean;
}

export async function getXlmMxnRate(): Promise<XlmMxnRate> {
  const res = await http.get('/rate/xlm-mxn');
  return res.data;
}

/** Tasas por `code` de `ESCROW_ASSET_OPTIONS`. Solo activos con escrow. */
const ESCROW_RATE_FETCHERS: Record<string, () => Promise<XlmMxnRate>> = {
  XLM: getXlmMxnRate,
  USDC: getUsdcMxnRate,
};

/**
 * WP-B: MXN por 1 unidad del activo del escrow, para mostrar el equivalente
 * ESTIMADO antes de crear la operacion. La tasa vinculante la congela el
 * servidor al crearla; esta nunca se envia de vuelta.
 *
 * Rechaza una tasa que no sea un numero finito y positivo: dividir el monto
 * entre 0, NaN o un negativo pintaria un equivalente absurdo con apariencia de
 * dato real.
 */
export async function getEscrowAssetRate(code: string): Promise<XlmMxnRate> {
  const fetcher = ESCROW_RATE_FETCHERS[code];
  if (!fetcher) {
    throw new Error(`No rate source for escrow asset ${code}`);
  }
  const data = await fetcher();
  return { ...data, rate: parseEscrowAssetRate(data?.rate) };
}

export function parseEscrowAssetRate(raw: unknown): number {
  const rate = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Invalid escrow asset rate: ${String(raw)}`);
  }
  return rate;
}

/**
 * USDC→MXN desde el backend (multi-fuente + caché). El frontend nunca debe
 * llevar un FX literal: si esto falla, la UI muestra "—"
 * (docs/AUDIT_MOBILE_MAINNET.md §3).
 */
export async function getUsdcMxnRate(): Promise<XlmMxnRate> {
  const res = await http.get('/rate/usdc-mxn');
  return res.data;
}

export async function getCETESRate(amount = "100"): Promise<CETESRate> {
  const res = await http.get(`/defi/cetes/rate?amount=${amount}`);
  return res.data;
}

export async function buyCETES(
    amount: string,
    sourceAsset: "XLM" | "USDC",
): Promise<CETESTxResult> {
  const res = await http.post("/defi/cetes/buy", { amount, sourceAsset });
  return res.data;
}

export async function sellCETES(
    amount: string,
    destAsset: "XLM" | "USDC",
): Promise<CETESTxResult> {
  const res = await http.post("/defi/cetes/sell", { amount, destAsset });
  return res.data;
}

// ─── DeFi: Blend ──────────────────────────────────────────────────────────

export interface BlendPoolAsset {
  code: string;
  supplyApy: number;
  borrowApy: number;
  liquidity: number;
}

export interface BlendPool {
  id: string;
  name: string;
  tvl: number;
  assets: BlendPoolAsset[];
}

export interface BlendPoolsResponse {
  pools: BlendPool[];
  network: string;
  simulated: boolean;
}

export interface BlendTxResult {
  hash: string;
  status: string;
  simulated: boolean;
  amount: string;
  asset: string;
  explorerUrl: string;
  note?: string;
}

export async function getBlendPools(): Promise<BlendPoolsResponse> {
  const res = await http.get("/defi/blend/pools");
  return res.data;
}

export async function blendSupply(
    amount: string,
    asset: string,
    collateral = false,
): Promise<BlendTxResult> {
  const res = await http.post("/defi/blend/supply", {
    amount,
    asset,
    collateral,
  });
  return res.data;
}

export async function blendBorrow(
    amount: string,
    asset: string,
): Promise<BlendTxResult> {
  const res = await http.post("/defi/blend/borrow", { amount, asset });
  return res.data;
}

export interface MerchantConfig {
  rate_percent: number;
  min_trade_mxn: number;
  max_trade_mxn: number;
  daily_cap_mxn: number;
  latitude?: number | null;
  longitude?: number | null;
  address_text?: string | null;
  /**
   * RED-3: campos de ubicacion. Opcionales aqui porque los escribe
   * PATCH /merchants/me/location, no el PATCH de tarifas y limites.
   */
  area_label?: string | null;
  meeting_point?: string | null;
  publish_storefront?: boolean;
}

export interface UserProfile {
  id: string;
  username: string;
  stellar_address: string;
  wallet_type?: string;
  rate_percent?: number;
  min_trade_mxn?: number;
  max_trade_mxn?: number;
  daily_cap_mxn?: number;
  kyc_status?: string;
  clabe?: string;
}

export async function getMyProfile(token: string): Promise<UserProfile> {
  const res = await http.get('/users/me', authHeaders(token));
  return res.data.user;
}

export async function getMerchantConfig(token: string): Promise<MerchantConfig> {
  const res = await http.get('/merchants/me/config', authHeaders(token));
  return res.data.config;
}

export async function updateMerchantConfig(token: string, config: MerchantConfig): Promise<MerchantConfig> {
  const res = await http.put('/merchants/me/config', config, authHeaders(token));
  return res.data.config;
}

// Genérico y no `(string, unknown)`: así TypeScript verifica que el payload
// que se encola tiene la forma que el sincronizador espera leer.
type QueueFn = <T extends MutationType>(
  type: T,
  payload: MutationPayloadMap[T],
) => Promise<string>;

export async function updateMerchantConfigWithOfflineSupport(
  token: string,
  config: MerchantConfig,
  queueFn: QueueFn,
): Promise<{ config: MerchantConfig; queued: boolean }> {
  try {
    const updated = await updateMerchantConfig(token, config);
    return { config: updated, queued: false };
  } catch (err: any) {
    // Solo se encola si NO hubo respuesta del servidor, es decir, si fue un
    // fallo de red. Un 400 de validación o un 401 de sesión expirada se van a
    // rechazar igual al reintentar: propagarlos deja que la UI muestre el
    // error real en vez de fingir que quedó guardado para más tarde.
    if (err?.response) throw err;
    await queueFn('config', { config });
    return { config, queued: true };
  }
}

export async function updateMerchantAvailabilityWithOfflineSupport(
  token: string,
  available: boolean,
  queueFn: QueueFn,
): Promise<{ queued: boolean }> {
  try {
    await patchMerchantAvailability(token, available);
    return { queued: false };
  } catch (err: any) {
    // Mismo criterio que en updateMerchantConfigWithOfflineSupport: encolar
    // solo los fallos de red, nunca los errores que el servidor sí respondió.
    if (err?.response) throw err;
    await queueFn('availability', { merchant_available: available });
    return { queued: true };
  }
}

// ─── Merchant discovery (#102) ────────────────────────────────────────────

/** Mirrors backend `AvailableMerchant` from GET /merchants/available. */
export interface AvailableMerchant {
  /** Desglose de comisiones calculado por el servidor, en MXN. Llega entero
   *  para que la app no tenga que deducir ninguna parte restando. */
  provider_fee_mxn?: number;
  platform_fee_mxn?: number;
  effective_fee_percent?: number;
  seller_id: string;
  username: string;
  rate_percent: number;
  min_trade_mxn: number;
  max_trade_mxn: number;
  daily_cap_mxn: number;
  latitude: number;
  longitude: number;
  /** RED-3: zona publica. Nunca el punto exacto. */
  area_label: string | null;
  /** RED-3: solo si el proveedor consintio publicar su local. */
  storefront_address: string | null;
  distance_km: number;
  /** Lo que recibe el cliente: efectivo en retiro, saldo en deposito (H5). */
  payout_mxn: number;
  /** Lo que le cuesta al cliente: saldo en retiro (monto + comisiones), efectivo en deposito. */
  client_pays_mxn?: number;
  /** Reputation: fraction 0..1 of completed trades (optional) */
  completion_rate?: number;
  /** Total completed trades (optional) */
  trades_completed?: number;
  /** Reputation tier (optional) */
  tier?: string;
  /** Optional seller type flag coming from API (e.g. 'business' | 'individual') */
  seller_type?: string;
  /** Backwards-compatible boolean marker for business sellers (optional) */
  is_business?: boolean;
  /** Platform fee (%) for this merchant. Falls back to PLATFORM_FEE_PERCENT if absent. */
  platform_fee_pct?: number;
}

/**
 * Effective-fee guardrail. Validations V-1/V-3/V-7/V-8 found a universal ceiling:
 * users abandon MicoPay when the *total* cost exceeds ~5%. The UI warns above this
 * threshold. Kept here (not hardcoded in components) so it can be tuned centrally.
 */
export const MAX_EFFECTIVE_FEE_PERCENT = 5;

/**
 * Total effective cost the user pays = provider commission + platform fee.
 * `platformPct` defaults to the shared `PLATFORM_FEE_PERCENT` constant because the
 * `/merchants/available` response does not (yet) carry a per-merchant platform fee.
 */
export function effectiveFeePercent(
  providerPct: number,
  platformPct: number = PLATFORM_FEE_PERCENT,
): number {
  return providerPct + platformPct;
}

export interface MerchantsAvailableQuery {
  lat: number;
  lng: number;
  radius_km: number;
  amount_mxn: number;
  flow?: 'cashout' | 'deposit';
}

/**
 * Public endpoint: find merchants near the caller that can handle the amount.
 * No auth required.
 */
export async function getMerchantsAvailable(
  query: MerchantsAvailableQuery,
): Promise<AvailableMerchant[]> {
  const params: Record<string, string | number> = {
    lat: query.lat,
    lng: query.lng,
    radius_km: query.radius_km,
    amount_mxn: query.amount_mxn,
  };
  if (query.flow) params.flow = query.flow;

  const res = await http.get('/merchants/available', { params });
  return res.data.merchants;
}

// ─── Merchant QR scan confirmation (issue #70) ────────────────────────────

export interface MerchantConfirmResult {
  trade_id: string;
  /** CASH-5A: estado canónico. El tipo documenta el contrato; la realidad
   *  en runtime se valida con parseTradeState antes de usarla. */
  status: TradeState;
  /** CASH-4: flujo canónico; la UI no lo infiere de los roles del escrow. */
  flow: TradeFlow;
  amount_mxn: number;
  platform_fee_mxn: number;
  /** H5: comision del agente en esta operacion. */
  provider_fee_mxn?: number;
  /**
   * CASH-4: la contraparte de quien escanea, es decir el cliente. Antes era
   * `buyer_handle` y en un cash-out el proveedor ES el comprador, así que la
   * pantalla le mostraba su propio nombre.
   */
  client_handle: string;
  expires_at: string;
  expired: boolean;
  created_at: string;
  lock_tx_hash: string | null;
  release_tx_hash: string | null;
  /** CASH-4: true si esta llamada reanudó una entrega ya confirmada. */
  resumed: boolean;
  handoff_confirmed_at: string;
}

/**
 * Merchant scans a QR containing a trade_id and calls the backend to validate
 * that the trade exists, the merchant is a participant, and the trade state is valid.
 */
export async function merchantConfirmScan(
  tradeId: string,
  claimToken: string,
  token: string,
): Promise<MerchantConfirmResult> {
  try {
    const res = await http.post(
      `/trades/${tradeId}/merchant-confirm`,
      { claim_token: claimToken },
      authHeaders(token),
    );
    return res.data as MerchantConfirmResult;
  } catch (e: unknown) {
    const { message } = extractApiErrorPayload(e);
    throw new Error(message);
  }
}

// ─── DeFi: SPEI Onramp / Offramp (Etherfuse) ─────────────────────────────

export interface RampQuote {
  quoteId: string;
  type: 'onramp' | 'offramp';
  exchangeRate: string;
  sourceAmount: string;
  destinationAmount: string;
  expiresAt: string;
}

export interface RampOrder {
  orderId: string;
  depositClabe?: string;
  depositAmount?: string;
  depositBankName?: string;
  depositAccountHolder?: string;
  withdrawAnchorAccount?: string;
  withdrawMemo?: string;
  withdrawMemoType?: string;
}

export interface RampOrderStatus {
  orderId: string;
  status: 'pending' | 'funded' | 'completed' | 'failed';
  type: 'onramp' | 'offramp';
  stellarTxHash?: string;
}

export interface BankAccountResult {
  bankAccountId: string;
  clabe: string;
}

export async function getRampQuote(
  type: 'onramp' | 'offramp',
  sourceAmount: string,
  token: string,
): Promise<RampQuote> {
  const res = await http.post(
    '/defi/ramp/quote',
    { type, sourceAsset: 'MXN', targetAsset: 'CETES', sourceAmount },
    authHeaders(token),
  );
  return res.data as RampQuote;
}

/**
 * Creates a ramp order (SPEI onramp deposit instructions, or offramp anchor
 * account+memo). `bankAccountId` is resolved server-side from the caller's
 * onboarded Etherfuse profile — the backend ignores it if sent, so it is not
 * a parameter here. `useAnchor` (offramp only) requests anchor-rail withdraw
 * instructions instead of a raw wallet payout.
 */
export async function createRampOrder(
  quoteId: string,
  token: string,
  useAnchor = true,
): Promise<RampOrder> {
  const res = await http.post(
    '/defi/ramp/order',
    { quoteId, useAnchor },
    authHeaders(token),
  );
  return res.data as RampOrder;
}

export async function getRampOrderStatus(
  orderId: string,
  token: string,
): Promise<RampOrderStatus> {
  const res = await http.get(`/defi/ramp/order/${orderId}`, authHeaders(token));
  return res.data as RampOrderStatus;
}

export async function regenerateRampOrderTx(orderId: string, token: string): Promise<RampOrder> {
  const res = await http.post(`/defi/ramp/order/${orderId}/regenerate_tx`, {}, authHeaders(token));
  return res.data as RampOrder;
}

// Global 401 handler: clear the persisted session and bounce to login.
http.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      removeKey('micopay_user');
      window.location.href = '/#/login';
    }
    return Promise.reject(error);
  }
);

// ─── RED-3 · punto de encuentro (solo participantes) ──────────────────────

export interface TradeMeetingPoint {
  trade_id: string;
  area_label: string | null;
  meeting_point: string | null;
  reason: 'shared' | 'not_set' | 'trade_not_accepted' | 'trade_terminal';
}

/**
 * El punto exacto vive detrás de esta llamada autenticada, nunca en el
 * discovery público. El backend exige participación en la operación.
 */
export async function fetchTradeMeetingPoint(
    tradeId: string,
    token: string,
): Promise<TradeMeetingPoint> {
  const res = await http.get(`/trades/${tradeId}/meeting-point`, authHeaders(token));
  return res.data as TradeMeetingPoint;
}

// ─── CASH-6 · elegibilidad de reembolso (autoritativa del servidor) ────────

export interface RefundEligibility {
  trade_id: string;
  eligible: boolean;
  reason:
    | 'eligible'
    | 'not_participant'
    | 'no_funds_locked'
    | 'not_expired_yet'
    | 'already_settled';
  expires_at: string;
  /** Hora del servidor: la cuenta atrás no depende del reloj del teléfono. */
  server_time: string;
  seconds_remaining: number;
}

export async function fetchRefundEligibility(
    tradeId: string,
    token: string,
): Promise<RefundEligibility> {
  const res = await http.get(`/trades/${tradeId}/refund-eligibility`, authHeaders(token));
  return res.data as RefundEligibility;
}
