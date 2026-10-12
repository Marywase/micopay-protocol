import { breakers } from "../lib/breakers.js";
import { breakerFetch, isIdempotentMethod } from "../lib/circuitBreaker.js";

const ETHERFUSE_API = process.env.ETHERFUSE_API_URL ?? "https://api.etherfuse.com";

export interface EtherfuseRampAsset {
  identifier: string; // "CODE:ISSUER" on Stellar
  symbol: string;
  name: string;
  currency: string | null;
  balance: string | null;
  image: string | null;
}

// Authenticated client for the /ramp/* endpoints. Sandbox keys go in the
// Authorization header with no "Bearer" prefix — unlike most REST APIs.
function etherfuseRampClient(path: string, init: RequestInit = {}): Promise<Response> {
  const apiKey = process.env.ETHERFUSE_API_KEY;
  if (!apiKey) {
    throw new Error("ETHERFUSE_API_KEY not configured");
  }

  // Quotes and orders are POSTs: never retried, so a lost response cannot
  // turn into a duplicate order. Reads are retried.
  return breakerFetch(breakers.etherfuse, `${ETHERFUSE_API}${path}`, {
    ...init,
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
      ...init.headers,
    },
  }, { idempotent: isIdempotentMethod(init.method) });
}

// GET /ramp/assets requires blockchain, currency (sort priority), and a
// wallet address (Etherfuse uses it to enrich the response with balances).
export async function getRampAssets(
  wallet: string,
  currency = "mxn"
): Promise<EtherfuseRampAsset[]> {
  const params = new URLSearchParams({ blockchain: "stellar", currency, wallet });
  const response = await etherfuseRampClient(`/ramp/assets?${params}`);
  if (!response.ok) {
    throw new Error(`Etherfuse API error: ${response.status}`);
  }
  const data = (await response.json()) as { assets: EtherfuseRampAsset[] };
  return data.assets;
}

export async function getCetesIdentifier(wallet: string): Promise<string> {
  const assets = await getRampAssets(wallet, "mxn");
  const cetes = assets.find((a) => a.symbol === "CETES");
  if (!cetes) {
    throw new Error("CETES asset not found in Etherfuse /ramp/assets response");
  }
  return cetes.identifier;
}

// ── Onboarding (A-2: hosted KYC) ────────────────────────────────────────────

export interface OnboardingUrlParams {
  customerId: string;
  bankAccountId: string;
  publicKey: string;
  userInfo?: { email?: string; displayName?: string };
}

// Etherfuse responds with snake_case here even though every request body is
// camelCase — see "Field naming convention" in the onboarding guide.
export async function createOnboardingUrl(params: OnboardingUrlParams): Promise<string> {
  const response = await etherfuseRampClient("/ramp/onboarding-url", {
    method: "POST",
    body: JSON.stringify({ ...params, blockchain: "stellar" }),
  });
  if (!response.ok) {
    throw new Error(`Etherfuse API error: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as { presigned_url: string };
  return data.presigned_url;
}

export interface EtherfuseKycStatus {
  customerId: string;
  status: "not_started" | "proposed" | "approved" | "approved_chain_deploying" | "rejected";
  currentRejectionReason: string | null;
  approvedAt: string | null;
}

export async function getKycStatus(customerId: string): Promise<EtherfuseKycStatus> {
  const response = await etherfuseRampClient(`/ramp/customer/${customerId}/kyc`);
  if (!response.ok) {
    throw new Error(`Etherfuse API error: ${response.status}`);
  }
  return response.json() as Promise<EtherfuseKycStatus>;
}

// ── Quotes & orders (A-3) ────────────────────────────────────────────────────

export interface CreateQuoteParams {
  quoteId: string;
  customerId: string;
  sourceAmount: string;
  walletAddress?: string;
  /** Comision del partner (MicoPay), hasta 500 bps; Etherfuse la liquida cada mes. */
  partnerFeeBps?: number;
  quoteAssets:
    | { type: "onramp"; sourceAsset: "MXN"; targetAsset: string }
    | { type: "offramp"; sourceAsset: string; targetAsset: "MXN" };
}

export interface EtherfuseQuote {
  quoteId: string;
  blockchain: string;
  quoteAssets: CreateQuoteParams["quoteAssets"];
  sourceAmount: string;
  destinationAmount: string;
  exchangeRate: string;
  nominalRate: string;
  feeBps: string;
  feeAmount: string;
  expiresAt: string | null;
  requiresSwap: boolean;
}

export async function createQuote(params: CreateQuoteParams): Promise<EtherfuseQuote> {
  const response = await etherfuseRampClient("/ramp/quote", {
    method: "POST",
    body: JSON.stringify({ ...params, blockchain: "stellar" }),
  });
  if (!response.ok) {
    throw new Error(`Etherfuse API error: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<EtherfuseQuote>;
}

export interface CreateOrderParams {
  orderId: string;
  quoteId: string;
  bankAccountId: string;
  publicKey: string;
  useAnchor?: boolean;
}

export interface OnrampOrderDetails {
  orderId: string;
  depositClabe: string;
  depositAmount: string;
  depositBankName: string;
  depositAccountHolder: string;
}

export interface OfframpOrderDetails {
  orderId: string;
  withdrawAnchorAccount: string | null;
  withdrawMemo: string | null;
  withdrawMemoType: string | null;
}

export async function createOrder(
  params: CreateOrderParams
): Promise<{ onramp: OnrampOrderDetails } | { offramp: OfframpOrderDetails }> {
  const response = await etherfuseRampClient("/ramp/order", {
    method: "POST",
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`Etherfuse API error: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<{ onramp: OnrampOrderDetails } | { offramp: OfframpOrderDetails }>;
}

export type EtherfuseOrderStatus =
  | "created"
  | "funded"
  | "completed"
  | "failed"
  | "refunded"
  | "canceled"
  | "finalized";

export interface EtherfuseOrder {
  orderId: string;
  status: EtherfuseOrderStatus;
  orderType: "onramp" | "offramp";
  [key: string]: unknown;
}

export async function getOrder(orderId: string): Promise<EtherfuseOrder> {
  const response = await etherfuseRampClient(`/ramp/order/${orderId}`);
  if (response.status === 404) {
    throw new Error("ORDER_NOT_FOUND");
  }
  if (!response.ok) {
    throw new Error(`Etherfuse API error: ${response.status}`);
  }
  return response.json() as Promise<EtherfuseOrder>;
}

// Offramp (status "created"): regenerated TX is sent async via order_updated
// webhook, this returns 202. Stellar onramp claim TX: returns 200 with fresh XDR.
export async function regenerateOrderTx(orderId: string): Promise<{ status: number; body: unknown }> {
  const response = await etherfuseRampClient(`/ramp/order/${orderId}/regenerate_tx`, {
    method: "POST",
  });
  if (!response.ok && response.status !== 202) {
    throw new Error(`Etherfuse API error: ${response.status}`);
  }
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

export interface EtherfuseBondCost {
  bond_cost_in_payment_token: string;
  bond_cost_in_usd: string;
  fiat_exchange_rate_with_usd: number;
  bond_cost_in_fiat: string;
  current_basis_points: number;
  bond_symbol: string;
  currency: string;
  current_time: string;
  mint: string;
  symbol: string;
}

export interface EtherfuseBondInfo {
  symbol: string;
  name: string;
  apy: number;
  price_mxn: number;
  mint: string;
  network: string;
}

export async function getCETESRate(): Promise<EtherfuseBondCost> {
  const response = await breakerFetch(breakers.etherfuse, `${ETHERFUSE_API}/lookup/bonds/cost/CETES`, {}, { idempotent: true });
  if (!response.ok) {
    throw new Error(`Etherfuse API error: ${response.status}`);
  }
  return response.json() as Promise<EtherfuseBondCost>;
}

export async function getAllBondCosts(): Promise<Record<string, EtherfuseBondCost>> {
  const response = await breakerFetch(breakers.etherfuse, `${ETHERFUSE_API}/lookup/bonds/cost`, {}, { idempotent: true });
  if (!response.ok) {
    throw new Error(`Etherfuse API error: ${response.status}`);
  }
  return response.json() as Promise<Record<string, EtherfuseBondCost>>;
}

export function formatCETESRate(bondCost: EtherfuseBondCost): EtherfuseBondInfo {
  const basisPoints = bondCost.current_basis_points;
  const apy = (basisPoints / 10000) * 100;

  return {
    symbol: bondCost.bond_symbol,
    name: "Certificados de la Tesorería de la Federación",
    apy: parseFloat(apy.toFixed(2)),
    price_mxn: parseFloat(bondCost.bond_cost_in_fiat),
    mint: bondCost.mint,
    network: "Stellar",
  };
}

export function calculateCETESPreview(
  amount: number,
  sourceAsset: "XLM" | "USDC" | "MXNe",
  bondCost: EtherfuseBondCost
): { cetes: number; priceImpact: number } {
  const pricePerCetes = parseFloat(bondCost.bond_cost_in_fiat);
  const usdToMxn = bondCost.fiat_exchange_rate_with_usd;

  let mxnAmount: number;

  if (sourceAsset === "XLM") {
    const xlmPerUsdc = usdToMxn / parseFloat(bondCost.bond_cost_in_usd);
    mxnAmount = (amount / xlmPerUsdc) * usdToMxn;
  } else if (sourceAsset === "USDC") {
    mxnAmount = amount * usdToMxn;
  } else {
    mxnAmount = amount;
  }

  const cetes = mxnAmount / pricePerCetes;

  return {
    cetes: parseFloat(cetes.toFixed(2)),
    priceImpact: 0,
  };
}
