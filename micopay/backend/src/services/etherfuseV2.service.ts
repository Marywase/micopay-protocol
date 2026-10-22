// Cliente de la API v2 de Etherfuse (docs.etherfuse.com/llms.txt).
//
// Modelo: cada usuario de MicoPay necesita su propia "personal organization"
// hija de la nuestra. Nuestra API key actua sobre esas hijas. El `sub` del JWT
// que firma `signLaunchToken` es el id de la personal org.
//
// Este archivo cubre solo lo que WP1 necesita en este slice: crear la org,
// mandar los datos de verificacion y leer el estado. Payment accounts, quotes
// y orders llegan en el siguiente slice.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { breakers } from '../lib/breakers.js';
import { breakerFetch, isIdempotentMethod } from '../lib/circuitBreaker.js';
import { signLaunchToken } from '../lib/etherfuseJwt.js';

const V2_API = process.env.ETHERFUSE_V2_API_URL ?? process.env.ETHERFUSE_API_URL ?? 'https://api.sand.etherfuse.com';
const V2_APP = process.env.ETHERFUSE_V2_APP_URL ?? 'https://sandbox.etherfuse.com';

export class EtherfuseV2Error extends Error {
  constructor(public status: number, public code: string | null, message: string, public body?: unknown) {
    super(message);
    this.name = 'EtherfuseV2Error';
  }
}

async function v2Fetch(path: string, init: RequestInit = {}): Promise<Response> {
  const apiKey = process.env.ETHERFUSE_API_KEY;
  if (!apiKey) throw new Error('ETHERFUSE_API_KEY no esta configurado');
  // v2 usa Authorization: Bearer <key> (v1 era sin prefijo, hay que cuidarlo).
  const res = await breakerFetch(breakers.etherfuse, `${V2_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  }, { idempotent: isIdempotentMethod(init.method) });
  return res;
}

async function v2Json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await v2Fetch(path, init);
  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { /* vacio */ }
    const b = body as { code?: string; message?: string } | undefined;
    throw new EtherfuseV2Error(res.status, b?.code ?? null, b?.message ?? `${res.status} ${res.statusText}`, body);
  }
  return (await res.json()) as T;
}

// ---- Organizations ------------------------------------------------------

export type OrgAccountType = 'personal' | 'business';

export interface CreateOrgRequest {
  accountType: OrgAccountType;
  displayName: string;
  /** UUID; debe coincidir con el `sub` del JWT para que el launch amarre. */
  id: string;
  userInfo: { email: string; displayName: string };
}

export interface Organization {
  id: string;
  displayName: string;
  accountType: OrgAccountType;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Crea una personal org para un usuario. Idempotente desde el cliente: si
 * Etherfuse responde 409 porque la id ya existe, hace GET y devuelve la
 * existente. Asi la ruta publica puede llamarse mas de una vez.
 */
export async function createPersonalOrg(req: CreateOrgRequest): Promise<Organization> {
  try {
    return await v2Json<Organization>('/organization', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  } catch (err) {
    if (err instanceof EtherfuseV2Error && err.status === 409) {
      return await getOrganization(req.id);
    }
    throw err;
  }
}

export async function getOrganization(id: string): Promise<Organization> {
  return v2Json<Organization>(`/organization/${encodeURIComponent(id)}`);
}

// ---- Verification (KYC personal) ----------------------------------------

export interface VerificationAddress {
  street: string;
  city: string;
  /** ISO 3166-1 alpha-3, p.ej. "MEX". */
  country: string;
  region?: string | null;
  postalCode?: string | null;
  buildingNumber?: string | null;
  flatNumber?: string | null;
}

export interface SubmitVerificationRequest {
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD */
  dateOfBirth: string;
  /** RFC en Mexico. */
  taxId: string;
  /** ISO 3166-1 alpha-3. */
  country: string;
  address: VerificationAddress;
}

export type KycRequirementStatus = 'satisfied' | 'awaitingReview' | 'actionRequired' | 'requiresLaunch';

export interface VerificationStatus {
  overall: 'approved' | 'pending' | 'actionRequired' | 'rejected' | 'notStarted';
  personalData?: KycRequirementStatus;
  identityDocument?: KycRequirementStatus;
  taxDocument?: KycRequirementStatus;
  selfie?: KycRequirementStatus;
  occupation?: KycRequirementStatus;
  /** Mensaje legible devuelto por Etherfuse, si lo hay. */
  userMessage?: string | null;
}

export async function submitVerification(customerOrgId: string, data: SubmitVerificationRequest): Promise<VerificationStatus> {
  return v2Json<VerificationStatus>(`/organization/${encodeURIComponent(customerOrgId)}/verification`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getVerificationStatus(customerOrgId: string): Promise<VerificationStatus> {
  return v2Json<VerificationStatus>(`/organization/${encodeURIComponent(customerOrgId)}/verification/status`);
}

// ---- Launch de /idv -----------------------------------------------------

export interface LaunchForm {
  /** POST a esta URL con los `fields` como `application/x-www-form-urlencoded`. */
  url: string;
  fields: Record<string, string>;
}

/**
 * Devuelve lo necesario para abrir /idv en el navegador del telefono. El
 * cliente lo abre con POST (grant_type JWT bearer). Si queremos abrirlo sin
 * form, Etherfuse tambien acepta GET con los campos como query (no documentado
 * tan claro; preferimos POST para que el token no termine en el historial).
 *
 * @param customerOrgId  UUID de la personal org del usuario (= sub del JWT).
 * @param userInfo       email y nombre, exigidos en el JWT.
 * @param target         ruta del app (p.ej. "/kyc").
 * @param returnUrl      a donde regresar si el usuario sale.
 */
export function buildLaunchForm(
  customerOrgId: string,
  userInfo: { email: string; name: string },
  target: string = '/kyc',
  returnUrl?: string
): LaunchForm {
  const aud = `${V2_API.replace(/\/$/, '')}/auth/token`;
  const token = signLaunchToken(customerOrgId, {
    ttlSeconds: 300,
    extraClaims: {
      aud,
      scope: 'kyc',
      email: userInfo.email,
      name: userInfo.name,
    },
  });
  const fields: Record<string, string> = {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: token,
    target,
  };
  if (returnUrl) fields.return_url = returnUrl;
  return { url: `${V2_APP.replace(/\/$/, '')}/auth/launch`, fields };
}

// ---- Payment Accounts ---------------------------------------------------

export type PaymentAccountKind = 'bank' | 'wallet' | 'embeddedWallet' | 'debitCard' | 'cash';
export type PaymentAccountStatus = 'pending' | 'ready' | 'rejected' | 'disabled';

export type WalletDetails = { kind: 'address'; address: string; chain: 'stellar' | 'ethereum' | 'solana' };
export type ClabeDetails = { kind: 'clabe'; clabe: string };
export type AccountDetails = WalletDetails | ClabeDetails;

export interface RegistrationInfo {
  accountHolderName?: string;
  taxId?: string;
  curp?: string;
  firstName?: string;
  paternalLastName?: string;
  maternalLastName?: string;
  dateOfBirth?: string;
  countryOfBirth?: string;
}

export interface RegisterPaymentAccountRequest {
  kind: PaymentAccountKind;
  label: string;
  /** ISO 3166-1 alpha-2 (bank only). */
  country?: string;
  /** ISO 4217 (bank only). */
  currency?: string;
  accountDetails: AccountDetails;
  registrationInfo?: RegistrationInfo;
}

export interface PaymentAccountRail {
  currency?: string;
  source: { isDefault: boolean; status: PaymentAccountStatus; minAmount?: string; maxAmount?: string; rejection?: { code: string; message: string } } | null;
  destination: { isDefault: boolean; status: PaymentAccountStatus; minAmount?: string; maxAmount?: string; rejection?: { code: string; message: string } } | null;
}

export interface PaymentAccount {
  id: string;
  status: PaymentAccountStatus;
  label: string;
  rails: Record<string, PaymentAccountRail>;
  createdAt: string;
}

export async function registerPaymentAccount(customerOrgId: string, req: RegisterPaymentAccountRequest): Promise<PaymentAccount> {
  return v2Json<PaymentAccount>(`/organization/${encodeURIComponent(customerOrgId)}/payment_account`, {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function getPaymentAccount(customerOrgId: string, id: string): Promise<PaymentAccount> {
  return v2Json<PaymentAccount>(`/organization/${encodeURIComponent(customerOrgId)}/payment_account/${encodeURIComponent(id)}`);
}

export async function listPaymentAccounts(customerOrgId: string): Promise<PaymentAccount[]> {
  const r = await v2Json<{ data?: PaymentAccount[] } | PaymentAccount[]>(`/organization/${encodeURIComponent(customerOrgId)}/payment_account`);
  return Array.isArray(r) ? r : (r.data ?? []);
}

// ---- Quotes -------------------------------------------------------------

export interface PaymentAccountRef {
  type: 'stored';
  id: string;
}

export interface CreateQuoteRequest {
  source: PaymentAccountRef;
  destination: PaymentAccountRef;
  /** Decimal string positivo. */
  sourceAmount: string;
  /** "USDC:ISSUER", "XLM" o "MXN". */
  sourceAsset: string;
  destinationAsset: string;
  sourceRail?: string;
  destinationRail?: string;
  /** 0..500. */
  partnerFeeBpsOverride?: number;
}

export interface Quote {
  quoteId: string;
  sourceAmount: string;
  destinationAmount: string;
  sourceAsset: string;
  destinationAsset: string;
  sourceRail: string;
  destinationRail: string;
  rateBeforeFees: string;
  rateAfterFees: string;
  feeBps: number;
  feeAmount: string;
  fees: Array<{ type: string; amount: string; asset: string }>;
  createdAt: string;
  /** Vence a los 2 minutos. */
  expiresAt: string;
}

export async function createQuote(customerOrgId: string, req: CreateQuoteRequest): Promise<Quote> {
  return v2Json<Quote>(`/organization/${encodeURIComponent(customerOrgId)}/quote`, {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

// ---- Orders -------------------------------------------------------------

export type OrderStatus =
  | 'created'
  | 'funded'
  | 'claimable'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'refunded';

export interface OrderAmount {
  asset: string;
  rail: string;
  amount: string;
}

export interface FundingInstructions {
  rail: string;
  reference: string;
  fundingDeadline: string;
  destination?: {
    /** Para rails de banco. */
    clabe?: string;
    bankName?: string;
    recipientName?: string;
    /** Para rails de wallet (Stellar). */
    address?: string;
    memo?: string;
    chain?: string;
  };
}

export interface Order {
  id: string;
  organizationId: string;
  status: OrderStatus;
  memo: string | null;
  source: OrderAmount;
  destination: OrderAmount;
  fees?: Array<{ type: string; amount: string; asset: string }>;
  fundingInstructions?: FundingInstructions;
  claimInstructions?: unknown | null;
  authorization?: unknown | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export interface CreateOrderRequest {
  quoteId: string;
  memo?: string;
}

export async function createOrder(customerOrgId: string, req: CreateOrderRequest): Promise<Order> {
  // Reenviar el mismo quoteId devuelve 200 con la misma orden; esta operacion
  // es idempotente desde ambos lados.
  return v2Json<Order>(`/organization/${encodeURIComponent(customerOrgId)}/order`, {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function getOrder(customerOrgId: string, id: string): Promise<Order> {
  return v2Json<Order>(`/organization/${encodeURIComponent(customerOrgId)}/order/${encodeURIComponent(id)}`);
}

export async function refreshFundingInstructions(customerOrgId: string, id: string): Promise<Order> {
  return v2Json<Order>(`/organization/${encodeURIComponent(customerOrgId)}/order/${encodeURIComponent(id)}/refresh_funding_instructions`, {
    method: 'POST',
    body: '{}',
  });
}

// ---- Webhook subscriptions ----------------------------------------------

export type WebhookEventType =
  | 'orderUpdated'
  | 'paymentAccountUpdated'
  | 'kycUpdated'
  | 'kybUpdated';

export interface WebhookSubscription {
  id: string;
  eventType: WebhookEventType;
  url: string;
  createdAt: string;
  updatedAt: string;
  /** Solo se devuelve al crear; guardar en SSM, no en logs. */
  secret?: string;
}

export async function createWebhookSubscription(
  customerOrgId: string,
  req: { url: string; eventType: WebhookEventType }
): Promise<WebhookSubscription> {
  return v2Json<WebhookSubscription>(`/organization/${encodeURIComponent(customerOrgId)}/webhook_subscription`, {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function listWebhookSubscriptions(customerOrgId: string): Promise<WebhookSubscription[]> {
  const r = await v2Json<{ data?: WebhookSubscription[] } | WebhookSubscription[]>(`/organization/${encodeURIComponent(customerOrgId)}/webhook_subscription`);
  return Array.isArray(r) ? r : (r.data ?? []);
}

/**
 * Verifica la firma de un webhook de Etherfuse. Header: `X-Signature: sha256=<hex>`.
 * HMAC-SHA256 sobre el body **crudo** (bytes tal como llegaron) con el secret
 * decodificado desde base64url. El route handler debe preservar el raw body;
 * ver docs/webhooks de Etherfuse (RFC 8785 canonicalizado del lado del emisor).
 *
 * Devuelve `true` solo si la firma coincide; `false` sin lanzar en todos los
 * casos de error (header ausente, mal formato, etc.) para que la ruta pueda
 * responder 401 uniformemente.
 */
export function verifyWebhookSignature(rawBody: Buffer | string, headerValue: string | undefined, base64urlSecret: string): boolean {
  if (!headerValue || !base64urlSecret) return false;
  const m = /^sha256=([0-9a-fA-F]+)$/.exec(headerValue.trim());
  if (!m) return false;
  const providedHex = m[1].toLowerCase();
  let secret: Buffer;
  try {
    secret = Buffer.from(base64urlSecret, 'base64url');
  } catch { return false; }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody;
  const expectedHex = createHmac('sha256', secret).update(bodyBuf).digest('hex');
  if (expectedHex.length !== providedHex.length) return false;
  const a = Buffer.from(expectedHex);
  const b = Buffer.from(providedHex);
  return timingSafeEqual(a, b);
}

// Para pruebas: permite inyectar hosts sin tocar process.env.
export const _INTERNAL = {
  getApiHost: () => V2_API,
  getAppHost: () => V2_APP,
};
