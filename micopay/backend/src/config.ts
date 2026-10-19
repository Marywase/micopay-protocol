import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env file manually (no dotenv dependency needed)
function loadEnv() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envPath = join(__dirname, '..', '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

// Load .env file only in development if not in CI/Production
if (process.env.NODE_ENV !== 'production') {
  loadEnv();
}

/**
 * Parse CORS_ALLOWED_ORIGINS from environment variable.
 * Format: comma-separated list of origins (e.g., "https://example.com,https://app.example.com")
 * Defaults to localhost in development, empty array in production.
 */
function parseAllowedOrigins(originsEnv: string | undefined, nodeEnv: string | undefined): string[] {
  if (!originsEnv) {
    // Development: allow localhost
    if (nodeEnv !== 'production') {
      return ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:5173'];
    }
    // Production: empty array means no CORS (must be explicitly configured)
    return [];
  }
  return originsEnv.split(',').map((origin) => origin.trim()).filter((origin) => origin.length > 0);
}

export type KycOperationType = 'p2p_transfer' | 'cash_in' | 'cash_out' | 'cetes_purchase';

export interface KycThresholdTier {
  /** Inclusive MXN ceiling for this tier; null = no ceiling (final/catch-all tier). */
  maxAmountMxn: number | null;
  requiredLevel: 0 | 1 | 2;
}

// KYC tier thresholds per operation. Levels: 0 = account only, 1 = identified
// (INE/passport + selfie liveness + CURP), 2 = verified (+ proof of address).
//
// ⚠️ CORRECTED 2026-07-21 against the official SAT/SPPLD source: for "activos
// virtuales" (Art. 17 fracción XVI LFPIORPI) client identification is required
// "siempre — desde el primer peso" (no threshold). So NO cash↔crypto operation
// may run at Level 0. The earlier defaults wrongly allowed up to $3,000 MXN at
// Level 0 — that was a placeholder written before the rule was verified. See
// docs/CAMINO_A_MAINNET_CUMPLIMIENTO_2026-07.md and
// docs/HALLAZGOS_VERIFICACION_REGULATORIA_2026-07.md.
//
// Level 1 up to ~$3,000 MXN/op and Level 2 above come from the compliance
// plan's Option B tier table and remain PROVISIONAL pending the legal dictamen
// (the exact tier amounts are the lawyer's call; the "no Level 0" floor is the
// verified legal rule, not a proposal). Override via KYC_OPERATION_THRESHOLDS_JSON
// without a code change (#314's "keep thresholds config-driven" requirement).
//
// NOTE: the 210 UMA (~$24,635) AVISO threshold and the 4 UMA (~$469) commission
// AVISO threshold are REPORTING triggers, not identification tiers — they belong
// to the reporting engine (#317), not to this gate. See kycAvisoThresholdUma /
// kycCommissionAvisoThresholdUma below.
const DEFAULT_KYC_OPERATION_THRESHOLDS: Record<KycOperationType, KycThresholdTier[]> = {
  p2p_transfer: [
    { maxAmountMxn: 3000, requiredLevel: 1 },
    { maxAmountMxn: null, requiredLevel: 2 },
  ],
  cash_in: [
    { maxAmountMxn: 3000, requiredLevel: 1 },
    { maxAmountMxn: null, requiredLevel: 2 },
  ],
  cash_out: [
    { maxAmountMxn: 3000, requiredLevel: 1 },
    { maxAmountMxn: null, requiredLevel: 2 },
  ],
  cetes_purchase: [
    { maxAmountMxn: 3000, requiredLevel: 1 },
    { maxAmountMxn: null, requiredLevel: 2 },
  ],
};

function parseKycOperationThresholds(
  json: string | undefined,
): Record<KycOperationType, KycThresholdTier[]> {
  if (!json) return DEFAULT_KYC_OPERATION_THRESHOLDS;
  try {
    const parsed = JSON.parse(json);
    return { ...DEFAULT_KYC_OPERATION_THRESHOLDS, ...parsed };
  } catch {
    console.warn('[config] KYC_OPERATION_THRESHOLDS_JSON is not valid JSON — using defaults');
    return DEFAULT_KYC_OPERATION_THRESHOLDS;
  }
}

// #316: monthly cumulative volume ceilings per KYC level, MXN. Staying under
// #314's per-operation threshold does not exempt a user from a monthly cap —
// otherwise a user can move arbitrary volume by splitting it into many small
// operations (pitufeo/structuring), staying under the per-operation limit
// every time. null = no ceiling. Level 0 is 0 because #314's verified
// first-peso rule already means no cash<->crypto operation may run at Level
// 0 in the first place; kept explicit here rather than omitted so every
// level has a defined ceiling. Level 1/2 figures are PROVISIONAL pending the
// legal dictamen — same caveat as #314's DEFAULT_KYC_OPERATION_THRESHOLDS.
// Override via KYC_MONTHLY_VOLUME_CEILINGS_MXN_JSON without a code change.
const DEFAULT_KYC_MONTHLY_VOLUME_CEILINGS_MXN: Record<number, number | null> = {
  0: 0,
  1: 10000,
  2: null,
};

function parseKycMonthlyVolumeCeilings(json: string | undefined): Record<number, number | null> {
  if (!json) return DEFAULT_KYC_MONTHLY_VOLUME_CEILINGS_MXN;
  try {
    const parsed = JSON.parse(json);
    return { ...DEFAULT_KYC_MONTHLY_VOLUME_CEILINGS_MXN, ...parsed };
  } catch {
    console.warn('[config] KYC_MONTHLY_VOLUME_CEILINGS_MXN_JSON is not valid JSON — using defaults');
    return DEFAULT_KYC_MONTHLY_VOLUME_CEILINGS_MXN;
  }
}

/**
 * Instancias del escrow, una por activo: cada contrato guarda UN token desde
 * `initialize`. Formato `ESCROW_CONTRACTS=USDC=C...,XLM=C...`.
 * Sin esa variable se usa la forma anterior (`ESCROW_ASSET` + `ESCROW_CONTRACT_ID`),
 * para que un despliegue viejo siga arrancando igual.
 */
function parseEscrowContracts(
  raw: string | undefined,
  legacyContractId: string,
  legacyAsset: string,
): Record<string, string> {
  if (!raw || !raw.trim()) {
    return legacyContractId ? { [legacyAsset.trim().toUpperCase()]: legacyContractId } : {};
  }
  const map: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [asset, contractId] = pair.split('=').map((x) => x?.trim());
    if (!asset || !contractId) {
      throw new Error(`ESCROW_CONTRACTS mal formado: "${pair}". Se espera ACTIVO=CONTRATO.`);
    }
    map[asset.toUpperCase()] = contractId;
  }
  return map;
}

const ESCROW_ASSET_ENV = process.env.ESCROW_ASSET || 'XLM';
const ESCROW_CONTRACTS = parseEscrowContracts(
  process.env.ESCROW_CONTRACTS,
  process.env.ESCROW_CONTRACT_ID || '',
  ESCROW_ASSET_ENV,
);

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://localhost:5432/micopay_dev',

  // Stellar
  stellarRpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
  stellarNetwork: process.env.STELLAR_NETWORK || 'TESTNET',
  platformSecretKey: process.env.PLATFORM_SECRET_KEY || '',
  /** Activo -> contrato del escrow (ver parseEscrowContracts). */
  escrowContracts: ESCROW_CONTRACTS as Readonly<Record<string, string>>,
  /**
   * Contrato de las operaciones creadas antes de `escrow_contract_id`. Si se
   * redespliega un activo (p. ej. XLM de testnet tras el fix de #420), las
   * operaciones viejas siguen bloqueadas en el contrato anterior: sin esto, su
   * refund iria al contrato nuevo, que no las conoce.
   */
  escrowLegacyContractId: process.env.ESCROW_LEGACY_CONTRACT_ID || '',
  /** Activo por defecto de las operaciones nuevas (ver assetRate.service). */
  escrowAsset: ESCROW_ASSET_ENV,
  /**
   * Contrato del activo por defecto. Lo usan el listener de eventos y /health;
   * las operaciones usan el contrato congelado en cada una.
   */
  escrowContractId:
    ESCROW_CONTRACTS[ESCROW_ASSET_ENV.trim().toUpperCase()] ?? Object.values(ESCROW_CONTRACTS)[0] ?? '',
  mxneContractId: process.env.MXNE_CONTRACT_ID || '',
  mxneIssuerAddress: process.env.MXNE_ISSUER_ADDRESS || '',

  // HTLC Secret Encryption
  secretEncryptionKey: process.env.SECRET_ENCRYPTION_KEY || '',

  // JWT
  jwtSecret: process.env.JWT_SECRET || 'dev_jwt_secret',
  jwtExpiry: process.env.JWT_EXPIRY || '24h',

  // Firebase / FCM (for push notifications)
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID,
  firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  firebasePrivateKey: process.env.FIREBASE_PRIVATE_KEY,
  fcmServiceAccountJson: process.env.FCM_SERVICE_ACCOUNT_JSON,

  // DeFi integrations
  cetesIssuer: process.env.CETES_ISSUER || 'GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC',
  blendPoolId: process.env.BLEND_POOL_ID || 'CB5UDFTJ6VFOK63ZHQASNODV4PP2HVGPYRF754LRGO7YRG5SFCAZWTDD',

  // Environment
  isProduction: process.env.NODE_ENV === 'production',

  // MVP flags
  mockStellar: process.env.MOCK_STELLAR === 'true',

  // Demo data seeding (B-4): only seed when explicitly enabled
  seedDemoData: process.env.SEED_DEMO_DATA === 'true',

  // DB fallback (B-3): the ephemeral in-memory store is an explicit opt-in only;
  // in production a missing PostgreSQL connection is fatal unless this is set.
  allowInMemoryDb: process.env.ALLOW_IN_MEMORY_DB === 'true',

  // Soroban event listener (off by default; polling fallback covers the rest)
  eventListenerEnabled: process.env.EVENT_LISTENER_ENABLED === 'true',
  eventListenerPollMs: parseInt(process.env.EVENT_LISTENER_POLL_MS || '5000', 10),
  eventListenerHealthStaleMs: parseInt(process.env.EVENT_LISTENER_HEALTH_STALE_MS || '30000', 10),

  // Rate Limiting
  clientErrorRateLimitWindowMs: parseInt(process.env.CLIENT_ERROR_RATE_LIMIT_WINDOW_MS || '60000', 10),
  clientErrorRateLimitMax: parseInt(process.env.CLIENT_ERROR_RATE_LIMIT_MAX || '20', 10),
  authRateLimitWindowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '600000', 10), // 10 min
  // Un solo bucket por IP cubre /auth/challenge, /auth/token y /users/register
  // (comparten el store por defecto del middleware). Como cada registro o
  // login cuesta DOS peticiones — challenge y luego la operación — un máximo
  // de 5 daba 2.5 intentos por cada 10 minutos: el usuario se bloqueaba solo
  // al segundo intento, y detrás de un NAT (café, oficina, CGNAT móvil) los
  // usuarios se bloqueaban entre sí. El riesgo real aquí no es adivinar
  // credenciales (no hay password que romper: se firma un challenge), sino el
  // alta masiva de cuentas, y 30 por 10 min por IP sigue frenando eso.
  authRateLimitMax: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '30', 10),
  tradeRateLimitWindowMs: parseInt(process.env.TRADE_RATE_LIMIT_WINDOW_MS || '3600000', 10), // 1 hour
  tradeRateLimitMax: parseInt(process.env.TRADE_RATE_LIMIT_MAX || '10', 10),
  messageRateLimitWindowMs: parseInt(process.env.MESSAGE_RATE_LIMIT_WINDOW_MS || '60000', 10),
  messageRateLimitMax: parseInt(process.env.MESSAGE_RATE_LIMIT_MAX || '30', 10),
  disputeRateLimitWindowMs: parseInt(process.env.DISPUTE_RATE_LIMIT_WINDOW_MS || '3600000', 10),
  disputeRateLimitMax: parseInt(process.env.DISPUTE_RATE_LIMIT_MAX || '5', 10),
  deviceRateLimitWindowMs: parseInt(process.env.DEVICE_RATE_LIMIT_WINDOW_MS || '86400000', 10),
  deviceRateLimitMax: parseInt(process.env.DEVICE_RATE_LIMIT_MAX || '15', 10),
  ipRateLimitWindowMs: parseInt(process.env.IP_RATE_LIMIT_WINDOW_MS || '86400000', 10),
  ipRateLimitMax: parseInt(process.env.IP_RATE_LIMIT_MAX || '20', 10),

  // Abuse / safety (#82)
  buyerDailyTradeMax: parseInt(process.env.BUYER_DAILY_TRADE_MAX || '20', 10),
  buyerDailyAmountMxnMax: parseInt(process.env.BUYER_DAILY_AMOUNT_MXN_MAX || '100000', 10),
  cancelCooldownWindowMs: parseInt(process.env.CANCEL_COOLDOWN_WINDOW_MS || '3600000', 10),
  cancelCooldownThreshold: parseInt(process.env.CANCEL_COOLDOWN_THRESHOLD || '3', 10),
  cancelCooldownMs: parseInt(process.env.CANCEL_COOLDOWN_MS || '300000', 10),
  merchantCancelPauseThreshold: parseInt(process.env.MERCHANT_CANCEL_PAUSE_THRESHOLD || '5', 10),
  merchantDisputePauseThreshold: parseInt(process.env.MERCHANT_DISPUTE_PAUSE_THRESHOLD || '3', 10),
  adminApiKey: process.env.ADMIN_API_KEY || '',

  // Tiered KYC gate (#314) — audit-only (never blocks) until this is
  // explicitly enabled. The "no Level 0 for cash↔crypto" floor is a verified
  // legal rule (identification from the first peso); the exact per-tier amounts
  // remain provisional pending the legal dictamen. See
  // docs/CAMINO_A_MAINNET_CUMPLIMIENTO_2026-07.md.
  kycGateEnabled: process.env.KYC_GATE_ENABLED === 'true',
  kycLevelExpiryDays: parseInt(process.env.KYC_LEVEL_EXPIRY_DAYS || '365', 10),
  kycOperationThresholds: parseKycOperationThresholds(process.env.KYC_OPERATION_THRESHOLDS_JSON),
  kycMonthlyVolumeCeilingsMxn: parseKycMonthlyVolumeCeilings(process.env.KYC_MONTHLY_VOLUME_CEILINGS_MXN_JSON),

  // LFPIORPI aviso (reporting) thresholds, in UMA — consumed by the compliance
  // reporting engine (#317), NOT by the KYC gate above. Kept here so the
  // verified 2026-07-21 values aren't lost. UMA 2026 = $117.31 MXN/day.
  //   - 210 UMA (~$24,635 MXN): aviso when a single operation reaches it.
  //   - 4 UMA  (~$469 MXN): aviso when the commission WE charge reaches it —
  //     ⚠️ this is on the protocol fee, not the trade amount; model it when
  //     setting mainnet fee parameters. Source: portal SPPLD del SAT.
  umaDailyMxn: parseFloat(process.env.UMA_DAILY_MXN || '117.31'),
  kycAvisoThresholdUma: parseInt(process.env.KYC_AVISO_THRESHOLD_UMA || '210', 10),
  kycCommissionAvisoThresholdUma: parseInt(process.env.KYC_COMMISSION_AVISO_THRESHOLD_UMA || '4', 10),

  // CORS & Security
  corsAllowedOrigins: parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS, process.env.NODE_ENV),
  nodeEnv: process.env.NODE_ENV || 'development',
} as const;

export function validateConfig() {
  const errors: string[] = [];

  if (!config.databaseUrl) {
    errors.push("DATABASE_URL is missing.");
  }

  if (!config.secretEncryptionKey) {
    errors.push("SECRET_ENCRYPTION_KEY is missing.");
  } else if (!/^[0-9a-fA-F]{64}$/.test(config.secretEncryptionKey)) {
    // AES-256-GCM needs a 32-byte key — 64 hex chars. An invalid key here would
    // otherwise crash at first encrypt/decrypt call instead of at boot.
    errors.push("SECRET_ENCRYPTION_KEY must be 64 hex characters (32 bytes) for AES-256-GCM.");
  }

  if (config.isProduction) {
    if (!process.env.JWT_SECRET || config.jwtSecret === 'dev_jwt_secret' || config.jwtSecret.length < 32) {
      errors.push("JWT_SECRET is missing or too weak (min 32 chars) — required in production.");
    }
    if (config.mockStellar) {
      errors.push("MOCK_STELLAR=true is not allowed in production (it disables on-chain verification and auth signature checks).");
    }
  }

  if (!config.mockStellar) {
    // Platform Secret Key validation
    if (!config.platformSecretKey) {
      errors.push("PLATFORM_SECRET_KEY is missing (required when MOCK_STELLAR=false).");
    } else {
      // Validate secret key format: starts with S, contains only uppercase letters/numbers 2-7, length 56
      const stellarSecretRegex = /^S[A-Z2-7]{55}$/;
      if (!stellarSecretRegex.test(config.platformSecretKey)) {
        errors.push("PLATFORM_SECRET_KEY is invalid. It must be a valid Stellar secret key (56 characters starting with 'S').");
      }
    }

    // Escrow contracts validation (one per asset)
    const escrowEntries = Object.entries(config.escrowContracts);
    if (escrowEntries.length === 0) {
      errors.push("ESCROW_CONTRACTS (or ESCROW_CONTRACT_ID) is missing (required when MOCK_STELLAR=false).");
    }
    for (const [asset, contractId] of escrowEntries) {
      if (!/^C[A-Z2-7]{55}$/.test(contractId)) {
        errors.push(`Escrow contract for ${asset} is invalid. It must be a valid Stellar contract ID (56 characters starting with 'C').`);
      }
    }

    // MXNE_CONTRACT_ID es opcional: ningun flujo lo usa (el escrow toma su
    // token de initialize). Si viene, que al menos tenga forma valida.
    if (config.mxneContractId && !/^C[A-Z2-7]{55}$/.test(config.mxneContractId)) {
      errors.push("MXNE_CONTRACT_ID is invalid. It must be a valid Stellar contract ID (56 characters starting with 'C').");
    }
  }

  if (errors.length > 0) {
    throw new Error("Configuration Validation Failed:\n" + errors.map(e => `  - ${e}`).join("\n"));
  }
}

/**
 * Configure CORS based on environment and allowed origins.
 * Development: allows localhost and 127.0.0.1
 * Production: requires explicit CORS_ALLOWED_ORIGINS configuration
 */
export function getCorsOptions() {
  const origins = config.corsAllowedOrigins;

  if (origins.length === 0) {
    // Fail-safe: if no origins configured in production, reject all CORS
    if (config.nodeEnv === 'production') {
      console.warn('[SECURITY] No CORS origins configured in production. CORS requests will be rejected.');
      return {
        origin: false,
        credentials: false,
      };
    }
    // Development with no explicit config: use defaults
    return {
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    };
  }

  // Specific origins configured
  return {
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400, // 24 hours
  };
}
