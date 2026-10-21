import db, { pool as dbPool } from '../db/schema.js';
import { computeTradeFees, PLATFORM_FEE_PERCENT } from './tradeFees.js';
import {
  AssetNotEnabledError,
  assertEnabledEscrowAsset,
  convertMxnToAsset,
  resolveRequestedEscrowAsset,
  stroopsAtFrozenRate,
  type SupportedAsset,
} from './assetRate.service.js';
import { StrKey } from '@stellar/stellar-sdk';
import { config } from '../config.js';
import pino from 'pino';
import { generateTradeSecret, encryptSecret, decryptSecret } from './secret.service.js';
import { createHash, randomBytes } from 'crypto';
import type { FastifyRequest } from 'fastify';
import { prepareLockTx, submitLockTx, prepareReleaseTx, submitReleaseTx, callRefundOnChain, verifyLockOnChain, assertNotReplayed } from './stellar.service.js';
import { escrowContractForTrade } from './escrowContract.js';
import { assertReceiverCanReceive } from './receiverReadiness.service.js';
import { AppError, NotFoundError, ForbiddenError, ConflictError, BadRequestError, AuthError, ValidationError, TradeStateError, MerchantLimitError, KycMonthlyCapExceededError } from '../utils/errors.js';
import {
  getTradeAuditTrail as getTradeAuditTrailRows,
  getAuditEventsByRequestId,
  insertTradeAuditEvent,
} from '../db/audit-log.model.js';
import {
  assertCanCreateTrade,
  deriveInitiatorId,
  assertCanCancelTrade,
  recordTradeCancelled,
} from './abuse.service.js';
import {
  evaluateKycForParticipant,
  kycDecisionToError,
  logKycDecision,
  currentMonthWindow,
} from './kyc-gate.service.js';
import {
  lockUsersForVolume,
  reserveVolume,
  getMonthlyReservedMxn,
} from './kycVolumeLedger.service.js';
import { sendTradeNotificationToMerchant, sendTradeUpdateNotification, type TradeUpdatePayload } from './push.service.js';

const logger = pino({ name: 'trade.service' });

// --- Trade lifecycle ---

/** Trade states where the buyer still depends on the merchant before cash handoff / release (#31). */
const MERCHANT_DEPENDENT_STATUSES = ['pending', 'locked', 'revealing'] as const;

/**
 * Avisa a la contraparte de quien movio la operacion. Va despues de guardar el
 * cambio y no se espera: un aviso que falla no deshace ni frena la operacion.
 */
function notifyTradeUpdate(userId: string | null | undefined, payload: TradeUpdatePayload) {
  if (!userId) return;
  sendTradeUpdateNotification(userId, payload).catch((err: unknown) => {
    logger.error({ err, trade_id: payload.tradeId, kind: payload.kind, category: 'trade.lifecycle' }, '[trade] Push notification failed silently');
  });
}

async function getSellerMerchantRow(sellerId: string) {
  return db.getOne<{ username: string; merchant_available: boolean | null }>(
    'SELECT username, merchant_available FROM users WHERE id = $1',
    [sellerId],
  );
}

function isMerchantUnavailableForTrade(
  trade: { status: string },
  sellerRow: { merchant_available: boolean | null } | null,
) {
  if (!MERCHANT_DEPENDENT_STATUSES.includes(trade.status as (typeof MERCHANT_DEPENDENT_STATUSES)[number])) {
    return false;
  }
  return sellerRow?.merchant_available === false;
}

/** Extract the correlation ID attached by requestId middleware. */
function getRequestId(request: FastifyRequest): string | undefined {
  return (request as any).requestId;
}

const STROOPS_PER_MXN = 10_000_000; // 7 decimals
// El desglose vive en tradeFees.ts, un solo sitio: tenerlo en dos fue el
// origen de que el agente cobrara menos de lo que configuraba.
const DEFAULT_TIMEOUT_MINUTES = 120; // 2 hours
const UNKNOWN_STATE = 'unknown';
/** SEC-02: TTL corto del token del QR. Nunca sobrepasa `trades.expires_at`. */
const CLAIM_TOKEN_TTL_MINUTES = 15;

interface TransitionFailureContext {
  tradeId: string;
  fromState: string;
  toState: string;
  actor: string;
  metadata?: Record<string, unknown>;
}

function transitionFailureMetadata(error: unknown, metadata: Record<string, unknown> = {}) {
  if (error instanceof Error) {
    return {
      ...metadata,
      success: false,
      reason: error.message,
      error_name: error.name,
    };
  }

  return {
    ...metadata,
    success: false,
    reason: String(error),
    error_name: 'UnknownError',
  };
}

async function logTransitionFailure(context: TransitionFailureContext, error: unknown) {
  try {
    await insertTradeAuditEvent({
      tradeId: context.tradeId,
      fromState: context.fromState,
      toState: context.toState,
      actor: context.actor,
      metadata: transitionFailureMetadata(error, context.metadata),
    });
  } catch (auditError) {
    logger.error({ err: auditError, category: 'trade.lifecycle', trade_id: context.tradeId }, '[audit_log] Failed to persist failed transition');
  }
}

const DAILY_CAP_RESET_NOTE = 'Daily cap usage resets at 00:00 UTC.';

function getUtcDayRange(date = new Date()) {
  const start = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0,
    0,
    0,
    0,
  ));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

async function validateAgainstMerchantLimits(sellerId: string, amountMxn: number) {
  const merchantConfig = await db.getOne(
    `SELECT user_id, min_trade_mxn, max_trade_mxn, daily_cap_mxn
     FROM merchant_configs
     WHERE user_id = $1`,
    [sellerId],
  );

  const minTrade = merchantConfig?.min_trade_mxn ?? 100;
  const maxTrade = merchantConfig?.max_trade_mxn ?? 50000;
  const dailyCap = merchantConfig?.daily_cap_mxn ?? 250000;

  if (amountMxn < minTrade || amountMxn > maxTrade) {
    throw new MerchantLimitError(
      `Trade amount must be between merchant limits: ${minTrade} and ${maxTrade} MXN`,
    );
  }

  const { start, end } = getUtcDayRange();
  const todayTrades = await db.getMany<{ amount_mxn: number }>(
    `SELECT amount_mxn
     FROM trades
     WHERE seller_id = $1
       AND created_at >= $2
       AND created_at < $3
       AND status IN ('pending', 'locked', 'revealing', 'completed')`,
    [sellerId, start.toISOString(), end.toISOString()],
  );

  const todayVolume = todayTrades.reduce((sum, t) => sum + Number(t.amount_mxn || 0), 0);
  const projectedVolume = todayVolume + amountMxn;

  if (projectedVolume > dailyCap) {
    throw new MerchantLimitError(
      `Daily merchant cap exceeded (${projectedVolume}/${dailyCap} MXN). ${DAILY_CAP_RESET_NOTE}`,
    );
  }
}

/** CASH-1 (#372): canonical product flow, independent of the escrow roles. */
export type TradeFlow = 'deposit' | 'cashout';

export interface CreateTradeInput {
  request: FastifyRequest;
  sellerId: string;
  buyerId: string;
  /**
   * Product flow. Callers pass this explicitly — it must never be inferred
   * from the escrow roles, which reverse between the two flows.
   */
  flow: TradeFlow;
  amountMxn: number;
  /**
   * Activo pedido, tal como llega. `undefined` -> XLM (APK ya instalados). Se
   * valida con `resolveRequestedEscrowAsset` antes de cualquier otro efecto.
   */
  assetCode?: unknown;
}

/**
 * Traduce la politica de activos al contexto del BLOQUEO.
 *
 * Al crear, un activo no habilitado es un error de quien pide (422
 * ASSET_NOT_ENABLED). Al bloquear, la operacion ya existe: si su activo no tiene
 * escrow, el registro es incoherente con el contrato que se va a invocar, y eso
 * es un conflicto de estado (409 ASSET_ESCROW_MISMATCH), no una peticion mal
 * formada.
 *
 * Sin default: un registro con `asset_code` nulo o vacio NO se trata como XLM.
 * Bloquear fondos sobre una suposicion es exactamente lo que no debe pasar.
 * Tampoco se normaliza: un 'xlm' guardado en minusculas tambien es incoherente,
 * porque la creacion siempre persiste el codigo normalizado.
 */
export function assertLockableEscrowAsset(trade: { id?: string; asset_code?: unknown }): SupportedAsset {
  const stored = trade.asset_code;
  const mismatch = (detail: string) =>
    new ConflictError(
      'ASSET_ESCROW_MISMATCH',
      'Esta operacion no se puede bloquear con el escrow disponible.',
      `Trade ${trade.id ?? '?'}: ${detail}`,
      409,
    );

  if (typeof stored !== 'string' || stored.length === 0) {
    throw mismatch(`asset_code is missing (${stored === null ? 'null' : typeof stored})`);
  }
  try {
    return assertEnabledEscrowAsset(stored);
  } catch (err) {
    if (err instanceof AssetNotEnabledError) {
      throw mismatch(`asset_code ${stored} has no deployed escrow`);
    }
    throw err;
  }
}

/**
 * Las tres cifras del escrow en stroops, como cadenas enteras (D9 del plan).
 *
 * El contrato transfiere `amount + platform_fee` al bloquear y ese mismo total
 * al reembolsar; al liberar, `amount` va al comprador y la comision aparte. La
 * comision sale de la tasa congelada, igual que en `prepareLockTrade`, para que
 * la cifra que ve la app sea la que se firma.
 *
 * Con datos incompletos devuelve `null` en lugar de adivinar.
 */
/**
 * H5 · lo que paga y recibe el CLIENTE, calculado por el servidor para que la
 * app no reste nada. Solo para operaciones `cash_in_hand`: las anteriores se
 * liquidaron con otro modelo y sus cifras no admiten esta lectura (null).
 *
 *   retiro:   paga monto + comisiones de su saldo; recibe el monto en efectivo
 *   deposito: paga el monto en efectivo; recibe lo que libera el escrow
 */
export function cashBreakdownForTrade(trade: {
  fee_model?: unknown;
  flow?: unknown;
  amount_mxn?: unknown;
  provider_fee_mxn?: unknown;
  platform_fee_mxn?: unknown;
  escrow_amount_mxn?: unknown;
}): { client_pays_mxn: number | null; client_receives_mxn: number | null } {
  if (trade.fee_model !== 'cash_in_hand') return { client_pays_mxn: null, client_receives_mxn: null };
  const amount = Number(trade.amount_mxn);
  const provider = Number(trade.provider_fee_mxn ?? 0);
  const platform = Number(trade.platform_fee_mxn ?? 0);
  const escrow = Number(trade.escrow_amount_mxn);
  if (![amount, provider, platform, escrow].every(Number.isFinite)) {
    return { client_pays_mxn: null, client_receives_mxn: null };
  }
  return trade.flow === 'cashout'
    ? { client_pays_mxn: amount + provider + platform, client_receives_mxn: amount }
    : { client_pays_mxn: amount, client_receives_mxn: escrow };
}

export function escrowAmountsForTrade(trade: {
  asset_code?: unknown;
  amount_stroops?: unknown;
  platform_fee_mxn?: unknown;
  rate_mxn?: unknown;
}): {
  amount_stroops: string | null;
  platform_fee_stroops: string | null;
  total_locked_stroops: string | null;
} {
  const empty = { amount_stroops: null, platform_fee_stroops: null, total_locked_stroops: null };
  if (typeof trade.asset_code !== 'string' || trade.asset_code.length === 0) return empty;
  if (trade.amount_stroops === null || trade.amount_stroops === undefined) return empty;
  if (trade.rate_mxn === null || trade.rate_mxn === undefined) return empty;

  let amount: bigint;
  try {
    amount = BigInt(String(trade.amount_stroops));
  } catch {
    return empty;
  }
  // `platform_fee_mxn` es INTEGER (init.sql). Los mismos argumentos que
  // `prepareLockTrade`: si esto calculara distinto, la app mostraria una cifra
  // y se firmaria otra.
  let fee: bigint;
  try {
    fee = stroopsAtFrozenRate(Number(trade.platform_fee_mxn), String(trade.rate_mxn));
  } catch {
    return { amount_stroops: amount.toString(), platform_fee_stroops: null, total_locked_stroops: null };
  }
  return {
    amount_stroops: amount.toString(),
    platform_fee_stroops: fee.toString(),
    total_locked_stroops: (amount + fee).toString(),
  };
}

/**
 * The Red MicoPay liquidity provider for a flow, derived from the escrow roles.
 * This is the single definition of that rule: 'deposit' means the provider
 * locks the crypto (escrow seller), 'cashout' means the provider receives it
 * and hands over cash (escrow buyer). The same rule is enforced by
 * chk_trades_flow_provider at the database boundary.
 */
export function deriveProviderId(
  flow: TradeFlow,
  sellerId: string,
  buyerId: string,
): string {
  return flow === 'cashout' ? buyerId : sellerId;
}

export async function createTrade(input: CreateTradeInput) {
  const { request, sellerId, buyerId, flow, amountMxn } = input;

  // PRIMERA instruccion, a proposito: antes del log, KYC, limites, el secreto
  // HTLC, la conversion, la transaccion CASH-10 y los avisos. Un activo sin
  // escrow no debe dejar ningun efecto de negocio. La ruta ya lo valida, pero
  // esto cubre tambien a quien llame al servicio directamente.
  const assetCode = resolveRequestedEscrowAsset(input.assetCode);

  if (flow !== 'deposit' && flow !== 'cashout') {
    throw new ValidationError(
      'INVALID_FLOW',
      'Tipo de operacion invalido',
      `flow must be 'deposit' or 'cashout'`,
    );
  }

  const providerId = deriveProviderId(flow, sellerId, buyerId);
  request.log.info({ seller_id: sellerId, buyer_id: buyerId, flow, provider_id: providerId, amount_mxn: amountMxn, category: 'trade.lifecycle' }, '[trade] Creating trade');

  if (amountMxn < 100 || amountMxn > 50000) {
    throw new ValidationError(
      'INVALID_AMOUNT',
      'El monto debe ser entre 100 y 50,000 MXN',
      'amount_mxn must be between 100 and 50,000'
    );
  }

  if (sellerId === buyerId) {
    throw new ValidationError(
      'INVALID_PARTICIPANTS',
      'No puedes crear un intercambio contigo mismo',
      'Cannot trade with yourself',
    );
  }

  await assertCanCreateTrade({ request, buyerId, sellerId, flow, providerId, amountMxn });

  // CASH-10: el KYC general aplica a las DOS personas, no solo al comprador
  // del escrow. En cash-out el comprador es el proveedor, asi que la version
  // anterior dejaba fuera al cliente. Se evalua aqui sin escribir nada; la
  // reserva de volumen ocurre mas abajo, dentro de la misma transaccion que
  // crea la operacion.
  const kycDecisions = await Promise.all(
    [sellerId, buyerId].map((userId) =>
      evaluateKycForParticipant({ userId, operationType: 'p2p_transfer', amountMxn }),
    ),
  );
  for (const decision of kycDecisions) {
    const error = kycDecisionToError(decision, 'p2p_transfer');
    if (error) throw error;
  }

  // `username` se necesita para nombrar al cliente en el aviso al proveedor:
  // en cash-out el cliente es el seller, no el buyer.
  const seller = await db.getOne<{ id: string; stellar_address: string; username: string | null }>(
    'SELECT id, stellar_address, username FROM users WHERE id = $1',
    [sellerId],
  );
  if (!seller) {
    throw new NotFoundError('USER_NOT_FOUND', 'El usuario vendedor no existe', 'Seller not found');
  }

  const buyer = await db.getOne<{ id: string; stellar_address: string; username: string | null }>(
    'SELECT id, stellar_address, username FROM users WHERE id = $1',
    [buyerId],
  );
  if (!buyer) {
    throw new NotFoundError('USER_NOT_FOUND', 'El usuario comprador no existe', 'Buyer not found');
  }

  // El buyer del escrow es quien firma `release` y quien recibe el activo. Si
  // no puede, la operacion vence y el contrato devuelve los fondos a quien
  // bloqueo, despues de que el efectivo ya cambio de mano. Ver
  // receiverReadiness.service.ts.
  await assertReceiverCanReceive({
    stellarAddress: buyer.stellar_address,
    assetCode,
    receiverIsCaller: buyerId === (request as any).user?.id,
  });

  await validateAgainstMerchantLimits(sellerId, amountMxn);

  // Generate HTLC secret
  const { secret, secretHash } = generateTradeSecret();

  // La tarifa del agente se congela AQUI. `merchant_configs.rate_percent` es
  // configuracion mutable: si se leyera al liquidar, un agente podria cambiar
  // retroactivamente lo que cobro por operaciones ya pactadas.
  const providerConfig = await db.getOne<{ rate_percent: string | number }>(
    'SELECT rate_percent FROM merchant_configs WHERE user_id = $1',
    [providerId],
  );
  // H5: el monto escrito es el efectivo que cambia de mano, y lo que va al
  // contrato es lo que recibe el comprador del escrow (`escrowAmountMxn`), que
  // ya lleva la comision del agente segun el flujo. Ver `tradeFees.ts`.
  const fees = computeTradeFees(amountMxn, Number(providerConfig?.rate_percent ?? 0), flow);
  const { providerFeeMxn, platformFeeMxn, payoutMxn, escrowAmountMxn } = fees;
  if (escrowAmountMxn < 1) {
    throw new ValidationError(
      'AMOUNT_BELOW_FEES',
      'El monto no alcanza para cubrir las comisiones.',
      `escrow amount ${escrowAmountMxn} MXN after fees on ${amountMxn} MXN`,
    );
  }

  // El peso es la denominacion del acuerdo; el activo es solo el vehiculo. La
  // conversion vive en UN sitio (`assetRate.service`) y la tasa se congela aqui.
  //
  // Antes esto era `amountMxn * 10^7`, o sea 1 MXN = 1 unidad del activo. Con el
  // escrow bloqueando XLM a ~3.13 MXN, una operacion de 500 pesos bloqueaba 500
  // XLM = ~1 563 pesos: el cliente entregaba 3.13 veces lo que valia.
  const conversion = await convertMxnToAsset(escrowAmountMxn, assetCode, request);
  const amountStroops = conversion.stroops;

  // Encrypt and store secret immediately (Option A from spec)
  const { encrypted, nonce } = encryptSecret(secret);

  const expiresAt = new Date(Date.now() + DEFAULT_TIMEOUT_MINUTES * 60 * 1000);

  // CASH-10: la operacion y las reservas de volumen entran juntas o no entra
  // ninguna. Antes el volumen se incrementaba antes de que la operacion
  // existiera, asi que un fallo posterior dejaba volumen fantasma cargado a
  // una persona por una operacion que nunca ocurrio.
  const insertTradeSql = `INSERT INTO trades
      (seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, platform_fee_mxn,
       provider_fee_mxn, provider_rate_percent, payout_mxn,
       asset_code, rate_mxn, rate_source, rate_locked_at,
       secret_hash, secret_enc, secret_nonce, status, expires_at, escrow_contract_id,
       fee_model, escrow_amount_mxn)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'pending', $18, $19, $20, $21)
     RETURNING *`;
  // En el MISMO orden que las columnas de arriba. El store en memoria parsea el
  // SQL posicionalmente, asi que intercalar los marcadores lo rompia — y el
  // error que daba ("Cannot read properties of undefined") no señalaba a nada.
  const insertTradeParams = [
    sellerId,
    buyerId,
    flow,
    providerId,
    amountMxn,
    amountStroops.toString(),
    platformFeeMxn,
    providerFeeMxn,
    fees.providerRatePercent,
    payoutMxn,
    conversion.assetCode,
    conversion.rateMxn,
    conversion.rateSource,
    // Como parametro y no `NOW()`: el store en memoria corta el VALUES en el
    // primer parentesis de cierre, asi que una llamada a funcion ahi dentro
    // trunca la lista y el error resultante no señala a nada.
    new Date(),
    secretHash,
    encrypted,
    nonce,
    expiresAt,
    // El contrato donde se bloqueara, congelado como la tasa: lock, release y
    // refund van a este aunque cambie ESCROW_CONTRACTS. Null con MOCK_STELLAR.
    config.escrowContracts[conversion.assetCode] ?? null,
    'cash_in_hand',
    escrowAmountMxn,
  ];

  let result: any;
  const client = dbPool ? await dbPool.connect() : null;

  if (client) {
    try {
      await client.query('BEGIN');

      // Lock por usuario dentro de la transaccion: `keyedMutex` solo servia
      // dentro de un proceso, asi que con dos instancias del backend dos
      // peticiones podian pasar el tope juntas.
      await lockUsersForVolume(client, [sellerId, buyerId]);

      // Se relee el volumen YA con el lock tomado: la lectura previa solo
      // sirvio para decidir, y entre esa lectura y este punto otra peticion
      // pudo haber reservado.
      for (const decision of kycDecisions) {
        const reserved = await getMonthlyReservedMxn(decision.userId, undefined, client);
        if (
          config.kycGateEnabled &&
          decision.ceilingMxn !== null &&
          reserved + amountMxn > decision.ceilingMxn
        ) {
          throw new KycMonthlyCapExceededError(
            Math.max(decision.ceilingMxn - reserved, 0),
            decision.ceilingMxn,
            currentMonthWindow().resetAt,
            decision.currentLevel,
          );
        }
      }

      const inserted = await client.query(insertTradeSql, insertTradeParams);
      result = inserted.rows[0];

      for (const userId of [sellerId, buyerId]) {
        await reserveVolume(client, { tradeId: result.id, userId, amountMxn });
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } else {
    // Store en memoria: sin transacciones ni locks de aviso. Se deja
    // funcionando para los tests de servicio, pero la atomicidad y la
    // concurrencia NO se pueden verificar aqui — ver kycVolumeLedger.test.ts.
    result = await db.getOne(insertTradeSql, insertTradeParams);
  }

  // CASH-9: el actor de la creacion es quien la inicio. Antes era `buyerId`,
  // que en cash-out es el proveedor: la auditoria atribuia la creacion a quien
  // solo respondio a ella.
  const initiatorId = deriveInitiatorId(flow, sellerId, buyerId);

  // CASH-10: la decision se registra DESPUES de commitear, para que la
  // auditoria refleje operaciones durables y no intentos fallidos.
  for (const decision of kycDecisions) {
    await logKycDecision(decision, 'p2p_transfer', amountMxn, result.id);
  }

  await insertTradeAuditEvent({
    tradeId: result.id,
    fromState: UNKNOWN_STATE,
    toState: 'pending',
    actor: initiatorId,
    requestId: getRequestId(request),
    metadata: {
      success: true,
      amount_mxn: amountMxn,
      seller_id: sellerId,
      buyer_id: buyerId,
      flow,
      provider_id: providerId,
      initiator_id: initiatorId,
    },
  });

  // El aviso va al PROVEEDOR, no al `seller`.
  //
  // Antes iba a `sellerId`, que es correcto solo en deposito. En cash-out el
  // seller del escrow es el CLIENTE —lo fijo CASH-1 con `deriveProviderId`— asi
  // que la app le notificaba a la persona su propia operacion recien creada,
  // mientras el agente, que es quien tiene que actuar, no se enteraba de nada.
  // Este codigo es anterior al modelo de flujos y nunca se actualizo.
  //
  // Y por lo mismo el nombre que se anuncia es el del CLIENTE: la contraparte
  // del proveedor, sea comprador o vendedor del escrow segun el flujo.
  const clientParty = providerId === sellerId ? buyer : seller;
  const clientUsername = clientParty.username || clientParty.stellar_address || 'Usuario';
  sendTradeNotificationToMerchant(providerId, {
    tradeId: result.id,
    amount: `${amountMxn.toLocaleString('es-MX')} MXN`,
    buyerUsername: clientUsername,
  }).catch((err: unknown) => {
    logger.error({ err, trade_id: result.id, category: 'trade.lifecycle' }, '[trade] Push notification failed silently');
  });

  return result;
}


export async function getTradeById(tradeId: string, userId: string) {
  const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
  if (!trade) throw new NotFoundError('TRADE_NOT_FOUND', 'El intercambio no existe', 'Trade not found');

  // Only seller or buyer can view
  if (trade.seller_id !== userId && trade.buyer_id !== userId) {
    throw new AuthError('UNAUTHORIZED_ACCESS', 'No tienes permiso para ver este intercambio', 'Not a participant of this trade', 403);
  }

  return trade;
}

/** Trade row for API plus flags for merchant-unavailable UX (issue #31). */
export async function getTradeDetailForParticipant(tradeId: string, userId: string) {
  const trade = await getTradeById(tradeId, userId);
  const seller = await getSellerMerchantRow(trade.seller_id);
  const merchant_unavailable = isMerchantUnavailableForTrade(trade, seller);
  const buyer = await db.getOne<{ username: string | null }>(
    'SELECT username FROM users WHERE id = $1',
    [trade.buyer_id],
  );

  return {
    trade,
    merchant_unavailable,
    seller_username: seller?.username ?? null,
    buyer_username: buyer?.username ?? null,
  };
}

export async function getActiveTrades(userId: string) {
  return db.getMany(
    `SELECT * FROM trades
     WHERE (seller_id = $1 OR buyer_id = $1)
       AND status IN ('pending', 'locked', 'revealing')
     ORDER BY created_at DESC`,
    [userId],
  );
}

export async function getTradeHistory(userId: string, status?: string, page = 1, limit = 20) {
  // 'expired' is a derived status (not stored) — computed from expires_at,
  // same rule as before, just pushed into SQL instead of filtered client-side.
  const conditions = ['(t.seller_id = $1 OR t.buyer_id = $1)'];
  const params: unknown[] = [userId];

  if (status && status !== 'all') {
    if (status === 'expired') {
      conditions.push(`t.status NOT IN ('completed', 'cancelled') AND t.expires_at < NOW()`);
    } else {
      params.push(status);
      conditions.push(`t.status = $${params.length}`);
    }
  }

  params.push(limit, (page - 1) * limit);

  const trades = await db.getMany<{
    id: string; status: string; amount_mxn: number; platform_fee_mxn: number;
    lock_tx_hash: string | null; release_tx_hash: string | null; created_at: string;
    completed_at: string | null; seller_id: string; buyer_id: string; expires_at: string;
    // CASH-1 (#372): canonical product flow + Red MicoPay provider.
    flow: string; provider_id: string;
    seller_username: string | null; buyer_username: string | null;
  }>(
    `SELECT
       t.id, t.status, t.amount_mxn, t.platform_fee_mxn, t.lock_tx_hash, t.release_tx_hash,
       t.created_at, t.completed_at, t.seller_id, t.buyer_id, t.expires_at,
       t.flow, t.provider_id,
       su.username AS seller_username, bu.username AS buyer_username
     FROM trades t
     JOIN users su ON su.id = t.seller_id
     JOIN users bu ON bu.id = t.buyer_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY t.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return trades.map(({ seller_username, buyer_username, ...t }) => {
    const isBuyer = t.buyer_id === userId;
    return {
      ...t,
      direction: isBuyer ? 'cash-in' : 'cash-out',
      merchant_username: (isBuyer ? seller_username : buyer_username) || 'Usuario Micopay',
    };
  });
}

/**
 * Build the unsigned lock() transaction for the seller to sign with their own key.
 * Backend never holds or needs the seller's secret key.
 */

/**
 * Una direccion Stellar valida no es solo una cadena de 56 caracteres que
 * empieza por G: lleva checksum. Los agentes sembrados por el seed tenian
 * direcciones fabricadas a partir del nombre de usuario
 * (`GABARROTESXLAXESQUINAXXX...`) que pasaban cualquier comprobacion superficial
 * y reventaban dentro del SDK.
 */
function assertUsableStellarAddress(address: string | null | undefined, whose: string): void {
  if (address && StrKey.isValidEd25519PublicKey(address)) return;
  throw new AppError(
    'INVALID_STELLAR_ADDRESS',
    `No se puede bloquear el dinero: ${whose} no tiene una cuenta Stellar valida.`,
    `Invalid Stellar address for ${whose}: ${address ?? 'null'}`,
    422,
  );
}

export async function prepareLockTrade(
  request: FastifyRequest,
  tradeId: string,
  userId: string,
) {
  const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
  if (!trade) throw new NotFoundError('Trade not found');
  if (trade.seller_id !== userId) throw new ForbiddenError('Only the seller can lock');
  if (trade.status !== 'pending') throw new ConflictError(`Trade is ${trade.status}, expected pending`);

  // Antes del atajo mock: un registro incoherente se rechaza igual en pruebas
  // que en cadena, y nunca se construye un XDR para el contrato equivocado.
  assertLockableEscrowAsset(trade);

  if (config.mockStellar) {
    return { mock: true as const };
  }

  const seller = await db.getOne('SELECT stellar_address FROM users WHERE id = $1', [userId]);
  const buyer = await db.getOne('SELECT stellar_address FROM users WHERE id = $1', [trade.buyer_id]);
  if (!seller) throw new NotFoundError('Seller not found');
  if (!buyer) throw new NotFoundError('Buyer not found');

  // Se comprueba ANTES de llamar a Soroban. Una direccion invalida hacia
  // reventar el SDK con "Unsupported address type", que salia como 500 y la app
  // mostraba "el servidor no responde": un mensaje que manda a buscar el fallo
  // en el sitio equivocado. El problema no es la red, son los datos.
  assertUsableStellarAddress(seller.stellar_address, 'tu cuenta');
  assertUsableStellarAddress(buyer.stellar_address, 'la cuenta de la otra parte');

  const { xdr, networkPassphrase } = await prepareLockTx({
    request,
    contractId: escrowContractForTrade(trade),
    sellerAddress: seller.stellar_address,
    buyerAddress: buyer.stellar_address,
    amountStroops: BigInt(trade.amount_stroops),
    // A la MISMA tasa congelada de la operacion. Volver a consultar la tasa
    // viva aqui cambiaria por detras lo pactado al crearla.
    platformFeeStroops: stroopsAtFrozenRate(trade.platform_fee_mxn, trade.rate_mxn),
    secretHash: trade.secret_hash,
  });

  return { xdr, network_passphrase: networkPassphrase };
}

export async function lockTrade(
  request: FastifyRequest,
  tradeId: string,
  userId: string,
  signedXdr?: string,
) {
  request.log.info({ trade_id: tradeId, user_id: userId, category: 'trade.lifecycle' }, '[trade] Locking trade');
  let fromState = UNKNOWN_STATE;

  try {
    const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
    if (!trade) throw new NotFoundError('Trade not found');

    fromState = trade.status;
    if (trade.seller_id !== userId) throw new ForbiddenError('Only the seller can lock');
    if (trade.status !== 'pending') throw new ConflictError(`Trade is ${trade.status}, expected pending`);

    // Mismo guard que en `prepareLockTrade`, antes de enviar nada (y antes de
    // la rama mock). Si alguien llega aqui sin pasar por prepare, tampoco pasa.
    assertLockableEscrowAsset(trade);

    let lockTxHash: string;
    let stellarTradeId: string;

    if (!config.mockStellar) {
      // Real on-chain lock — the seller already signed the XDR client-side.
      if (!signedXdr) {
        throw new BadRequestError('SIGNED_XDR_REQUIRED', 'Falta la transacción firmada.', 'signed_xdr is required when MOCK_STELLAR=false');
      }
      const seller = await db.getOne('SELECT stellar_address FROM users WHERE id = $1', [userId]);
      const buyer = await db.getOne('SELECT stellar_address FROM users WHERE id = $1', [trade.buyer_id]);
      if (!seller) throw new NotFoundError('Seller not found');
      if (!buyer) throw new NotFoundError('Buyer not found');

      const result = await submitLockTx({
        request,
        contractId: escrowContractForTrade(trade),
        signedXdr,
        sellerAddress: seller.stellar_address,
        buyerAddress: buyer.stellar_address,
        amountStroops: BigInt(trade.amount_stroops),
        // Debe coincidir EXACTAMENTE con lo que se firmo en `prepare`: si
        // difiere, `assertInvocationMatches` rechaza el XDR, que es lo que se
        // busca. Por eso ambos salen de la tasa congelada, no de la viva.
        platformFeeStroops: stroopsAtFrozenRate(trade.platform_fee_mxn, trade.rate_mxn),
        secretHash: trade.secret_hash,
      });
      lockTxHash = result.txHash;
      stellarTradeId = result.txHash;
    } else {
      // Mock mode — generate placeholder hashes
      const verified = await verifyLockOnChain(
        request,
        `mock_${Date.now()}`,
        trade.seller_id,
        BigInt(trade.amount_stroops),
      );
      if (!verified) throw new BadRequestError('Could not verify lock on-chain');
      lockTxHash = `mock_${Date.now()}`;
      stellarTradeId = lockTxHash;
    }

    await assertNotReplayed(lockTxHash, 'trade/lock', userId);

    // Compute contract_trade_id = sha256(secret_hash_bytes), matching compute_trade_id()
    // in the Soroban contract. Stored for O(1) lookup when on-chain events arrive.
    const secretHashBytes = Buffer.from(trade.secret_hash, 'hex');
    const contractTradeId = createHash('sha256').update(secretHashBytes).digest('hex');

    await db.execute(
      `UPDATE trades
       SET status = 'locked',
           stellar_trade_id = $2,
           lock_tx_hash = $3,
           locked_at = NOW(),
           contract_trade_id = $4
       WHERE id = $1`,
      [tradeId, stellarTradeId, lockTxHash, contractTradeId],
    );

    await insertTradeAuditEvent({
      tradeId,
      fromState,
      toState: 'locked',
      actor: userId,
      requestId: getRequestId(request),
      metadata: {
        success: true,
        lock_tx_hash: lockTxHash,
        stellar_trade_id: stellarTradeId,
      },
    });

    // Bloquea el vendedor; el aviso es para el comprador.
    notifyTradeUpdate(trade.buyer_id, { tradeId, kind: 'locked', amountMxn: Number(trade.amount_mxn) });

    return { status: 'locked', lock_tx_hash: lockTxHash };
  } catch (error) {
    await logTransitionFailure({
      tradeId,
      fromState,
      toState: 'locked',
      actor: userId,
    }, error);
    throw error;
  }
}

export async function revealTrade(request: FastifyRequest, tradeId: string, userId: string) {
  request.log.info({ trade_id: tradeId, user_id: userId, category: 'trade.lifecycle' }, '[trade] Revealing trade');
  let fromState = UNKNOWN_STATE;

  try {
    const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
    if (!trade) throw new NotFoundError('Trade not found');

    fromState = trade.status;
    if (trade.seller_id !== userId) throw new ForbiddenError('Only the seller can reveal');
    if (trade.status !== 'locked') throw new ConflictError(`Trade is ${trade.status}, expected locked`);

    await db.execute(
      `UPDATE trades
       SET status = 'revealing', reveal_requested_at = NOW()
       WHERE id = $1`,
      [tradeId],
    );

    await insertTradeAuditEvent({
      tradeId,
      fromState,
      toState: 'revealing',
      actor: userId,
      requestId: getRequestId(request),
      metadata: { success: true },
    });

    return { status: 'revealing' };
  } catch (error) {
    await logTransitionFailure({
      tradeId,
      fromState,
      toState: 'revealing',
      actor: userId,
    }, error);
    throw error;
  }
}

export async function getTradeSecret(request: FastifyRequest, tradeId: string, userId: string, ip: string, userAgent: string) {
  request.log.info({ trade_id: tradeId, user_id: userId, category: 'trade.lifecycle' }, '[trade] Secret accessed');
  const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
  if (!trade) throw new NotFoundError('TRADE_NOT_FOUND', 'El intercambio no existe', 'Trade not found');

  // Only seller can see the secret
  if (trade.seller_id !== userId) {
    throw new AuthError('UNAUTHORIZED_ACTION', 'Solo el vendedor puede ver el secreto', 'Only the seller can access the secret', 403);
  }

  // Only in revealing state
  if (trade.status !== 'revealing') {
    throw new TradeStateError('INVALID_STATE', `El intercambio no está en estado de revelación (actual: ${trade.status})`, `Trade is ${trade.status}, must be revealing`);
  }

  // Check not expired
  if (new Date(trade.expires_at) < new Date()) {
    throw new TradeStateError('TRADE_EXPIRED', 'El intercambio ha expirado', 'Trade has expired');
  }

  // SEC-02: el preimage ya no sale del backend. El QR lleva un token opaco de
  // un solo uso; quien libera on-chain sigue siendo el backend, que descifra el
  // secreto por su cuenta en prepareReleaseTrade/completeTrade.
  const claimToken = randomBytes(32).toString('hex');
  const tokenExpiresAt = new Date(Math.min(
    Date.now() + CLAIM_TOKEN_TTL_MINUTES * 60 * 1000,
    new Date(trade.expires_at).getTime(),
  ));

  await db.execute(
    `INSERT INTO trade_claim_tokens (token_hash, trade_id, issued_to, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [hashClaimToken(claimToken), tradeId, userId, tokenExpiresAt],
  );

  // Log access
  await db.execute(
    `INSERT INTO secret_access_log (trade_id, user_id, ip_address, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [tradeId, userId, ip, userAgent],
  );

  const qrPayload = `micopay://release?trade_id=${tradeId}&claim_token=${claimToken}`;

  return {
    qr_payload: qrPayload,
    expires_at: tokenExpiresAt.toISOString(),
    expires_in: Math.max(0, Math.floor((tokenExpiresAt.getTime() - Date.now()) / 1000)),
  };
}

/** El token en claro nunca se persiste — mismo principio que `trades.secret_hash`. */
function hashClaimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Marca un token de QR como usado. El UPDATE filtra por `consumed_at IS NULL`,
 * así que bajo concurrencia solo un escaneo puede ganarlo; el SELECT posterior
 * confirma quién fue.
 */
async function consumeClaimToken(tradeId: string, claimToken: string, consumedBy: string) {
  const tokenHash = hashClaimToken(claimToken);
  const selectToken = `SELECT consumed_at, consumed_by, expires_at FROM trade_claim_tokens
     WHERE token_hash = $1 AND trade_id = $2`;

  const before = await db.getOne<{
    consumed_at: string | null;
    consumed_by: string | null;
    expires_at: string;
  }>(selectToken, [tokenHash, tradeId]);

  if (!before) {
    throw new NotFoundError(
      'INVALID_CLAIM_TOKEN',
      'Este código QR no es válido para esta operación',
      `No claim token matching trade ${tradeId}`,
    );
  }

  // `?? null`: el store in-memory omite las columnas que nunca se escribieron,
  // así que un token virgen llega con `consumed_at` undefined, no null.
  if ((before.consumed_at ?? null) !== null) {
    throw new ConflictError(
      'CLAIM_TOKEN_USED',
      'Este código QR ya fue usado',
      `Claim token for trade ${tradeId} was already consumed`,
    );
  }

  if (new Date(before.expires_at) < new Date()) {
    throw new TradeStateError(
      'CLAIM_TOKEN_EXPIRED',
      'Este código QR expiró. Pide al usuario que genere uno nuevo',
      `Claim token for trade ${tradeId} expired at ${before.expires_at}`,
    );
  }

  await db.execute(
    `UPDATE trade_claim_tokens
     SET consumed_at = NOW(), consumed_by = $3
     WHERE token_hash = $1 AND trade_id = $2 AND consumed_at IS NULL`,
    [tokenHash, tradeId, consumedBy],
  );

  // Dos escaneos simultáneos pasan los checks de arriba; solo uno gana el
  // UPDATE (`consumed_at IS NULL`). Releer dice cuál fue.
  const after = await db.getOne<{ consumed_by: string | null }>(selectToken, [tokenHash, tradeId]);
  if (after?.consumed_by !== consumedBy) {
    throw new ConflictError(
      'CLAIM_TOKEN_USED',
      'Este código QR ya fue usado',
      `Claim token for trade ${tradeId} was consumed by another scan`,
    );
  }
}

/**
 * Build the unsigned release() transaction for the buyer to sign with their own key.
 * Backend never holds or needs the buyer's secret key.
 */
export async function prepareReleaseTrade(request: FastifyRequest, tradeId: string, userId: string) {
  const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
  if (!trade) throw new NotFoundError('Trade not found');
  if (trade.buyer_id !== userId) throw new ForbiddenError('Only the buyer can complete');
  if (trade.status !== 'revealing') {
    throw new ConflictError(`Trade is ${trade.status}, expected revealing`);
  }

  // CASH-4: este es el punto de aplicacion real, no `completeTrade`. Aqui el
  // backend descifra el preimage HTLC y lo embebe en el XDR; quien obtiene
  // ese XDR puede firmarlo y enviarlo a la red por su cuenta. Si la compuerta
  // viviera solo en `completeTrade`, seria cosmetica.
  if (trade.flow === 'cashout') {
    const handoff = await getCashHandoff(tradeId);
    if (!handoff) {
      throw new ConflictError(
        'CASH_HANDOFF_REQUIRED',
        'Escanea el código del cliente antes de liberar los fondos',
        `Trade ${tradeId} is a cashout with no confirmed cash handoff`,
      );
    }
    if (handoff.provider_id !== userId) {
      throw new ForbiddenError(
        'HANDOFF_BELONGS_TO_ANOTHER_PROVIDER',
        'Otro proveedor atendió este intercambio',
        `Handoff for trade ${tradeId} belongs to ${handoff.provider_id}, not ${userId}`,
      );
    }
  }

  if (config.mockStellar) {
    return { mock: true as const };
  }

  const buyer = await db.getOne('SELECT stellar_address FROM users WHERE id = $1', [userId]);
  if (!buyer) throw new NotFoundError('Buyer not found');

  const secret = decryptSecret(trade.secret_enc, trade.secret_nonce);
  const secretHashBytes = Buffer.from(trade.secret_hash, 'hex');
  const tradeIdBytes = createHash('sha256').update(secretHashBytes).digest();
  const secretBytes = Buffer.from(secret, 'hex');

  const { xdr, networkPassphrase } = await prepareReleaseTx({
    request,
    contractId: escrowContractForTrade(trade),
    buyerAddress: buyer.stellar_address,
    tradeIdBytes,
    secretBytes,
  });

  return { xdr, network_passphrase: networkPassphrase };
}

export async function completeTrade(request: FastifyRequest, tradeId: string, userId: string, signedXdr?: string) {
  request.log.info({ trade_id: tradeId, user_id: userId, category: 'trade.lifecycle' }, '[trade] Completing trade');
  let fromState = UNKNOWN_STATE;

  try {
    const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
    if (!trade) throw new NotFoundError('Trade not found');

    fromState = trade.status;
    if (trade.buyer_id !== userId) throw new ForbiddenError('Only the buyer can complete');

    // CASH-4: una liberacion ya confirmada se puede releer con seguridad. El
    // proveedor puede perder la respuesta de red despues de que la operacion
    // se completo; reintentar debe devolverle el hash existente, no un 409 ni
    // una segunda liberacion on-chain.
    if (trade.status === 'completed' && trade.release_tx_hash) {
      request.log.info(
        { trade_id: tradeId, user_id: userId, category: 'trade.lifecycle' },
        '[trade] Completion replayed; returning the existing release',
      );
      return { status: 'completed' as const, release_tx_hash: trade.release_tx_hash };
    }

    if (trade.status !== 'revealing') {
      throw new ConflictError(`Trade is ${trade.status}, expected revealing`);
    }

    // CASH-4: en cash-out el proveedor entrega efectivo ANTES de liberar el
    // escrow. Exigir la constancia durable del escaneo impide liberar sin que
    // esa entrega haya ocurrido. El deposito no la lleva: ahi el cliente es
    // quien completa desde su propia pantalla y no hay efectivo que entregar
    // contra el QR del agente.
    if (trade.flow === 'cashout') {
      const handoff = await getCashHandoff(tradeId);
      if (!handoff) {
        throw new ConflictError(
          'CASH_HANDOFF_REQUIRED',
          'Escanea el código del cliente antes de liberar los fondos',
          `Trade ${tradeId} is a cashout with no confirmed cash handoff`,
        );
      }
      if (handoff.provider_id !== userId) {
        throw new ForbiddenError(
          'HANDOFF_BELONGS_TO_ANOTHER_PROVIDER',
          'Otro proveedor atendió este intercambio',
          `Handoff for trade ${tradeId} belongs to ${handoff.provider_id}, not ${userId}`,
        );
      }
    }

    let releaseTxHash: string;

    if (!config.mockStellar) {
      // Real on-chain release — the buyer already signed the XDR client-side.
      if (!signedXdr) {
        throw new BadRequestError('SIGNED_XDR_REQUIRED', 'Falta la transacción firmada.', 'signed_xdr is required when MOCK_STELLAR=false');
      }
      const secret = decryptSecret(trade.secret_enc, trade.secret_nonce);
      const secretHashBytes = Buffer.from(trade.secret_hash, 'hex');
      const tradeIdBytes = createHash('sha256').update(secretHashBytes).digest();
      const secretBytes = Buffer.from(secret, 'hex');

      const result = await submitReleaseTx({ request, contractId: escrowContractForTrade(trade), signedXdr, tradeIdBytes, secretBytes });
      releaseTxHash = result.txHash;
    } else {
      // Con MOCK_STELLAR el hash lo inventa el backend. Usar solo Date.now()
      // hace que dos operaciones cerradas en el mismo milisegundo produzcan
      // el MISMO hash, y el guard de replay rechaza la segunda: un fallo
      // intermitente que no dice nada sobre el codigo real. El sufijo
      // aleatorio lo elimina.
      releaseTxHash = `mock_release_${Date.now()}_${randomBytes(4).toString('hex')}`;
    }

    await assertNotReplayed(releaseTxHash, 'trade/complete', userId);

    // Clear encrypted secret from DB now that release is confirmed on-chain
    await db.execute(
      `UPDATE trades
       SET status = 'completed',
           release_tx_hash = $2,
           completed_at = NOW(),
           secret_enc = NULL,
           secret_nonce = NULL
       WHERE id = $1`,
      [tradeId, releaseTxHash],
    );

    await insertTradeAuditEvent({
      tradeId,
      fromState,
      toState: 'completed',
      actor: userId,
      requestId: getRequestId(request),
      metadata: {
        success: true,
        release_tx_hash: releaseTxHash,
      },
    });

    // Libera el comprador; el aviso es para el vendedor.
    notifyTradeUpdate(trade.seller_id, { tradeId, kind: 'completed', amountMxn: Number(trade.amount_mxn) });

    return { status: 'completed', release_tx_hash: releaseTxHash };
  } catch (error) {
    await logTransitionFailure({
      tradeId,
      fromState,
      toState: 'completed',
      actor: userId,
    }, error);
    throw error;
  }
}

/** Response shape for POST /trades/:id/cancel — drives refund copy on the client (#20). */
export interface CancelTradeResult {
  status: 'cancelled';
  /**
   * CASH-2: hay fondos en el contrato que volveran a su dueño. NO significa
   * que ya hayan vuelto: cancelar detiene el flujo de la app, no liquida la
   * cadena. Sin un `decline` en el contrato —fuera de alcance por decision de
   * producto— la unica via on-chain tras el bloqueo es el reembolso por
   * vencimiento.
   */
  refund_expected: boolean;
  /** CASH-2: a partir de cuando se puede reclamar. `null` si no hay fondos. */
  refund_available_at: string | null;
  lock_tx_hash: string | null;
}

async function finalizeTradeCancellation(tradeId: string) {
  await db.execute(
    `UPDATE trades
     SET status = 'cancelled',
         secret_enc = NULL,
         secret_nonce = NULL
     WHERE id = $1`,
    [tradeId],
  );
}

/**
 * CASH-2 · Quien puede cancelar, segun flujo y actor.
 *
 * La version anterior consultaba la disponibilidad comercial sobre
 * `trade.seller_id`. En deposito ese es el proveedor, pero en cash-out es el
 * CLIENTE: se preguntaba por la persona equivocada, asi que quien habia
 * bloqueado su USDC se quedaba sin via de recuperacion en la app mientras el
 * proveedor podia cancelar en casos donde debia mandar el cliente.
 *
 * La tabla aprobada, y la razon de cada fila:
 *
 *   pending     · cualquiera de los dos. No hay nada en cadena todavia.
 *   locked      · el CLIENTE puede detener el flujo. El PROVEEDOR solo si el
 *                 mismo esta marcado como no disponible: es su via de
 *                 repliegue, no una forma de deshacer operaciones ajenas.
 *   revealing   · igual, y ademas nadie puede cancelar si ya existe la
 *                 constancia durable de entrega de efectivo (CASH-4). Ahi el
 *                 dinero ya cambio de manos: las salidas son completar o
 *                 soporte, no cancelar.
 *   terminal    · nadie.
 *
 * En ningun caso cancelar devuelve fondos. Sin un `decline` en el contrato
 * —que producto decidio no implementar todavia— la unica via on-chain tras el
 * bloqueo sigue siendo el reembolso por vencimiento (CASH-6).
 */
export async function cancelTrade(
  request: FastifyRequest,
  tradeId: string,
  userId: string,
  reason?: string,
): Promise<CancelTradeResult> {
  let fromState = UNKNOWN_STATE;

  const audit = async (result: CancelTradeResult) => {
    await insertTradeAuditEvent({
      tradeId,
      fromState,
      toState: 'cancelled',
      actor: userId,
      requestId: getRequestId(request),
      metadata: {
        success: true,
        cancel_reason: reason ?? null,
        refund_expected: result.refund_expected,
        lock_tx_hash: result.lock_tx_hash,
      },
    });
  };

  try {
    const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
    if (!trade) throw new NotFoundError('Trade not found');
    fromState = trade.status;

    if (trade.seller_id !== userId && trade.buyer_id !== userId) {
      throw new ForbiddenError('Not a participant of this trade');
    }

    await assertCanCancelTrade(userId);

    const lockTx: string | null = trade.lock_tx_hash ?? null;
    // CASH-2: el proveedor sale de la columna canonica, nunca del rol del
    // escrow. Es el arreglo central de este issue.
    const isProvider = trade.provider_id === userId;

    const buildResult = (): CancelTradeResult => ({
      status: 'cancelled',
      refund_expected: Boolean(lockTx),
      refund_available_at: lockTx ? trade.expires_at : null,
      lock_tx_hash: lockTx,
    });

    const finishCancel = async () => {
      const result = buildResult();
      await finalizeTradeCancellation(tradeId);
      await audit(result);
      await recordTradeCancelled({
        tradeId,
        sellerId: trade.seller_id,
        cancelledBy: userId,
      });
      // El aviso es para la otra parte. Si es quien bloqueo los fondos, se le
      // dice desde cuando regresan: es lo primero que va a preguntar.
      const recipient = userId === trade.seller_id ? trade.buyer_id : trade.seller_id;
      notifyTradeUpdate(recipient, {
        tradeId,
        kind: 'cancelled',
        amountMxn: Number(trade.amount_mxn),
        refundAvailableAt: recipient === trade.seller_id ? result.refund_available_at : null,
      });
      return result;
    };

    if (trade.status === 'pending') {
      // Nada en cadena: cancelar aqui solo suelta la reserva.
      return finishCancel();
    }

    if (trade.status === 'locked' || trade.status === 'revealing') {
      // Con la entrega ya confirmada, el efectivo cambio de manos. Cancelar
      // dejaria al proveedor sin cripto y sin efectivo.
      const handoff = await getCashHandoff(tradeId);
      if (handoff) {
        throw new ConflictError(
          'CASH_HANDOFF_CONFIRMED',
          'La entrega de efectivo ya fue confirmada. Completa la operación o abre soporte.',
          `Trade ${tradeId} has a confirmed cash handoff by ${handoff.provider_id}`,
        );
      }

      if (isProvider) {
        // Repliegue del proveedor: solo si el mismo esta no disponible.
        const providerRow = await getSellerMerchantRow(trade.provider_id);
        if (!isMerchantUnavailableForTrade(trade, providerRow)) {
          throw new ForbiddenError(
            'PROVIDER_MUST_PAUSE_FIRST',
            'Pausa tu disponibilidad si necesitas dejar de atender esta operación.',
            `Provider ${userId} cannot cancel an active trade while still available`,
          );
        }
        return finishCancel();
      }

      // El cliente puede detener el flujo. No recupera los fondos aqui: eso
      // ocurre con el reembolso por vencimiento.
      return finishCancel();
    }

    throw new ConflictError(
      'TRADE_NOT_CANCELLABLE',
      `No se puede cancelar una operación en estado ${trade.status}.`,
      `Cannot cancel trade in status ${trade.status}.`,
    );
  } catch (error) {
    await logTransitionFailure({
      tradeId,
      fromState,
      toState: 'cancelled',
      actor: userId,
      metadata: { cancel_reason: reason ?? null },
    }, error);
    throw error;
  }
}

/**
 * Response shape for POST /trades/:id/refund.
 */
export interface RefundTradeResult {
  status: 'refunded';
  refund_tx_hash: string;
}

/**
 * Shared on-chain refund execution, used by both the user-triggered
 * `refundTrade` and the automatic `sweepPendingRefunds` background job.
 * The contract's `refund()` is permissionless and always pays out to
 * `trade.seller` (whoever originally locked the funds) regardless of who
 * calls it — `actorUserId` only identifies who/what triggered the call for
 * the replay-guard and audit trail, not who receives the funds.
 */
async function executeRefundOnChain(
  request: Pick<FastifyRequest, 'log'>,
  tradeId: string,
  trade: { status: string; secret_hash: string; asset_code?: string | null; escrow_contract_id?: string | null },
  actorUserId: string,
  extraMetadata: Record<string, unknown> = {},
): Promise<RefundTradeResult> {
  let refundTxHash: string;

  if (!config.mockStellar) {
    const secretHashBytes = Buffer.from(trade.secret_hash, 'hex');
    const tradeIdBytes = createHash('sha256').update(secretHashBytes).digest();

    const result = await callRefundOnChain({ request, contractId: escrowContractForTrade(trade), tradeIdBytes });
    refundTxHash = result.txHash;
  } else {
    refundTxHash = `mock_refund_${Date.now()}_${randomBytes(4).toString('hex')}`;
  }

  await assertNotReplayed(refundTxHash, 'trade/refund', actorUserId);

  await db.execute(
    `UPDATE trades
     SET status = 'refunded',
         release_tx_hash = $2,
         completed_at = NOW()
     WHERE id = $1`,
    [tradeId, refundTxHash],
  );

  await insertTradeAuditEvent({
    tradeId,
    fromState: trade.status,
    toState: 'refunded',
    actor: actorUserId,
    metadata: {
      success: true,
      refund_tx_hash: refundTxHash,
      ...extraMetadata,
    },
  });

  // El contrato siempre reembolsa al vendedor, la llame quien la llame (incluido
  // el sweep, que corre sin nadie mirando la pantalla).
  const refunded = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
  if (refunded) {
    notifyTradeUpdate(refunded.seller_id, { tradeId, kind: 'refunded', amountMxn: Number(refunded.amount_mxn) });
  }

  return { status: 'refunded', refund_tx_hash: refundTxHash };
}

/**
 * CASH-6 · Elegibilidad de reembolso, decidida por el servidor.
 *
 * El backend ya permitia reembolsar tras `expires_at` con fondos bloqueados,
 * pero la UI solo ofrecia la accion cuando el estado era `expired`... y ese
 * estado NUNCA se persiste. Una operacion `locked` o `revealing` que vencia
 * quedaba sin salida visible, justo en el momento en que el reembolso por
 * timeout es la ultima garantia del usuario.
 *
 * La elegibilidad se calcula aqui y no en la proyeccion compartida del
 * detalle, a proposito: el reloj que decide es el del servidor. Un cliente
 * con la hora corrida no debe poder adelantar ni retrasar la unica via de
 * recuperacion, y tampoco tiene que deducirla de tres campos sueltos.
 */
export interface RefundEligibility {
  trade_id: string;
  eligible: boolean;
  /** Por que no, cuando no. */
  reason:
    | 'eligible'
    | 'not_participant'
    | 'no_funds_locked'
    | 'not_expired_yet'
    | 'already_settled';
  expires_at: string;
  /** Hora del servidor, para que el cliente pinte la cuenta atras sin usar la suya. */
  server_time: string;
  /** Segundos que faltan; 0 si ya vencio. */
  seconds_remaining: number;
}

export async function getRefundEligibility(
  tradeId: string,
  userId: string,
): Promise<RefundEligibility> {
  const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
  if (!trade) throw new NotFoundError('TRADE_NOT_FOUND', 'El intercambio no existe', 'Trade not found');

  const now = new Date();
  const expiresAt = new Date(trade.expires_at);
  const secondsRemaining = Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));

  const base = {
    trade_id: trade.id,
    expires_at: trade.expires_at,
    server_time: now.toISOString(),
    seconds_remaining: secondsRemaining,
  };

  // Mismo orden de comprobaciones que `refundTrade`, para que esta respuesta
  // no pueda prometer algo que la accion luego rechace.
  if (trade.seller_id !== userId && trade.buyer_id !== userId) {
    return { ...base, eligible: false, reason: 'not_participant' };
  }
  if (!trade.lock_tx_hash) {
    return { ...base, eligible: false, reason: 'no_funds_locked' };
  }
  if (['completed', 'refunded'].includes(trade.status)) {
    return { ...base, eligible: false, reason: 'already_settled' };
  }
  if (secondsRemaining > 0) {
    return { ...base, eligible: false, reason: 'not_expired_yet' };
  }

  return { ...base, eligible: true, reason: 'eligible' };
}

export async function refundTrade(
  request: FastifyRequest,
  tradeId: string,
  userId: string,
): Promise<RefundTradeResult> {
  request.log.info({ trade_id: tradeId, user_id: userId, category: 'trade.lifecycle' }, '[trade] Refunding trade');
  let fromState = UNKNOWN_STATE;

  try {
    const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
    if (!trade) throw new NotFoundError('Trade not found');
    fromState = trade.status;

    // Either participant may trigger the refund — the contract's refund() is
    // permissionless and always pays out to trade.seller (whoever locked the
    // funds), so it doesn't matter which side of the trade calls this. This
    // matters most for the cashout flow, where the caller who locked their
    // own crypto is `seller_id`, not `buyer_id`.
    if (trade.seller_id !== userId && trade.buyer_id !== userId) {
      throw new ForbiddenError('Not a participant of this trade');
    }

    if (!trade.lock_tx_hash) {
      throw new ConflictError('No hay fondos en cadena para reembolsar en este intercambio');
    }

    if (new Date(trade.expires_at) > new Date()) {
      throw new TradeStateError(
        'TRADE_NOT_EXPIRED',
        'El intercambio aún no ha expirado. Espera a que venza el tiempo.',
        `Trade ${tradeId} has not expired yet (expires at ${trade.expires_at})`
      );
    }

    // 'cancelled' is deliberately allowed through here: cancelling a
    // locked/revealing trade (see cancelTrade below) no longer implies the
    // on-chain funds have been settled — it only stops the app-level flow.
    // Only 'completed' (buyer already released) and 'refunded' (already
    // settled) are terminal on-chain states that make a refund() call moot.
    if (['completed', 'refunded'].includes(trade.status)) {
      throw new ConflictError(`No se puede reembolsar un intercambio en estado ${trade.status}`);
    }

    return await executeRefundOnChain(request, tradeId, trade, userId);
  } catch (error) {
    await logTransitionFailure({
      tradeId,
      fromState,
      toState: 'refunded',
      actor: userId,
    }, error);
    throw error;
  }
}

/**
 * Background safety net (see docs/AUDIT_MOBILE_MAINNET.md finding B3):
 * cancelling a 'locked'/'revealing' trade only stops the app-level flow —
 * the contract's refund() requires its on-chain timeout to have passed, so a
 * cancelled trade can be left with real funds still sitting in escrow with
 * no further app-driven trigger. This scans for exactly that situation and
 * settles it automatically, so a user is never depending on remembering to
 * manually retry a refund. Safe to call repeatedly — each trade is only
 * refunded once (replay-guarded by `assertNotReplayed` + the `release_tx_hash
 * IS NULL` filter). Errors are per-trade and non-fatal so one bad trade can't
 * block the rest of the sweep.
 */
export async function sweepPendingRefunds(
  request: Pick<FastifyRequest, 'log'>,
): Promise<{ swept: number; failed: number }> {
  // No `mockStellar` early-return here — `executeRefundOnChain` already
  // branches on it per-trade (mock hash vs real on-chain call), same as
  // `refundTrade`. Skipping the whole sweep in mock mode would leave
  // mock-mode 'cancelled' trades permanently stuck, unlike production.
  const candidates = await db.getMany<{
    id: string; status: string; secret_hash: string; seller_id: string; expires_at: string;
  }>(
    `SELECT id, status, secret_hash, seller_id, expires_at, asset_code, escrow_contract_id FROM trades
     WHERE status = 'cancelled'
       AND lock_tx_hash IS NOT NULL
       AND release_tx_hash IS NULL
       AND expires_at < NOW()`,
  );

  let swept = 0;
  let failed = 0;

  for (const trade of candidates) {
    // Defense in depth: don't rely solely on the SQL-level expiry filter —
    // re-check in application code before ever calling on-chain refund().
    // The contract itself would reject an early call (TimeoutNotReached),
    // but failing fast here avoids a wasted RPC round-trip either way.
    if (new Date(trade.expires_at) > new Date()) continue;
    try {
      // Attribute the audit trail to the seller (the actual funds recipient)
      // since there's no HTTP-authenticated actor for a background sweep.
      await executeRefundOnChain(request, trade.id, trade, trade.seller_id, {
        triggered_by: 'refund_sweep',
      });
      swept++;
    } catch (err) {
      failed++;
      logger.error(
        { err, trade_id: trade.id, category: 'trade.lifecycle' },
        '[refund-sweep] Failed to auto-refund cancelled trade',
      );
    }
  }

  return { swept, failed };
}

export async function getTradeAuditTrail(tradeId: string, userId: string) {
  await getTradeById(tradeId, userId);

  const events = await getTradeAuditTrailRows(tradeId);
  return events.map((event) => ({
    ...event,
    timestamp: event.occurred_at,
  }));
}

/** Look up audit events by correlation / request ID (support use-case). */
export async function lookupAuditByRequestId(requestId: string) {
  const events = await getAuditEventsByRequestId(requestId);
  return events.map((event) => ({
    ...event,
    timestamp: event.occurred_at,
  }));
}

/**
 * CASH-3: la bandeja del proveedor.
 *
 * Filtraba por `seller_id`. En deposito eso es el proveedor, pero en cash-out
 * el vendedor del escrow es el CLIENTE: el proveedor no veia ni una sola
 * solicitud de cash-out, que es justo el flujo donde tiene que salir de lo que
 * este haciendo para entregar efectivo. Ahora filtra por `provider_id`, la
 * columna canonica de CASH-1 — la misma que ya usa `idx_trades_provider`.
 *
 * La contraparte tampoco se podia leer del JOIN sobre `buyer_id`: en cash-out
 * ese es el propio proveedor, asi que la fila mostraba su nombre como si fuera
 * el del cliente. El nombre se resuelve aparte con `deriveInitiatorId`, que es
 * la unica definicion de quien es el cliente segun el flujo (CASH-9).
 */
export async function getMerchantTrades(providerId: string, state: string = 'all') {
  const statusValues = state === 'all'
    ? ['pending', 'locked', 'revealing', 'completed', 'cancelled', 'refunded']
    : [state];

  const trades = await db.getMany<{
    id: string; seller_id: string; buyer_id: string; flow: TradeFlow;
    amount_mxn: number; status: string; created_at: string;
  }>(
    `SELECT
       t.id,
       t.seller_id,
       t.buyer_id,
       t.flow,
       t.amount_mxn,
       t.status,
       t.created_at
     FROM trades t
     WHERE t.provider_id = $1
       AND t.status = ANY($2)
     ORDER BY t.created_at DESC`,
    [providerId, statusValues],
  );

  const clientIds = [
    ...new Set(trades.map((t) => deriveInitiatorId(t.flow, t.seller_id, t.buyer_id))),
  ];
  const clients = clientIds.length
    ? await db.getMany<{ id: string; username: string | null }>(
        'SELECT id, username FROM users WHERE id = ANY($1)',
        [clientIds],
      )
    : [];
  const handleById = new Map(clients.map((c) => [c.id, c.username]));

  return trades.map((t) => ({
    id: t.id,
    seller_id: t.seller_id,
    buyer_id: t.buyer_id,
    flow: t.flow,
    amount_mxn: t.amount_mxn,
    status: t.status,
    created_at: t.created_at,
    client_handle:
      handleById.get(deriveInitiatorId(t.flow, t.seller_id, t.buyer_id)) ?? 'Usuario MicoPay',
  }));
}

/**
 * Merchant QR scan confirmation endpoint (issue #70).
 *
 * Called when the merchant scans a buyer's QR code. Validates:
 *   1. The trade exists
 *   2. The scanning user is the persisted `provider_id` for this trade
 *   3. The trade has not expired
 *   4. The trade is in the correct state for the scanned QR type
 *
 * CASH-4 (#70 follow-up): antes autorizaba contra `seller_id`, que en un
 * cash-out es el CLIENTE, no el proveedor. El proveedor real recibia 403 en
 * el unico paso que le tocaba. Ahora se autoriza contra `provider_id`, la
 * columna canonica que CASH-1 persiste, y el escaneo deja una constancia
 * durable de la entrega de efectivo para poder reanudar.
 */
export interface MerchantConfirmResult {
  trade_id: string;
  status: string;
  /** CASH-4: flujo canonico, para que la UI no lo infiera de los roles. */
  flow: TradeFlow;
  amount_mxn: number;
  platform_fee_mxn: number;
  /**
   * CASH-4: la CONTRAPARTE de quien escanea, es decir el cliente. Antes
   * devolvia siempre el handle del comprador, y como en cash-out el
   * proveedor ES el comprador, la pantalla le mostraba su propio nombre.
   */
  client_handle: string;
  /** H5: la comision del agente, para que vea lo que gana con esta entrega. */
  provider_fee_mxn: number;
  expires_at: string;
  expired: boolean;
  created_at: string;
  lock_tx_hash: string | null;
  release_tx_hash: string | null;
  /** CASH-4: true si esta llamada reanudo una entrega ya confirmada. */
  resumed: boolean;
  handoff_confirmed_at: string;
}

/** CASH-4: constancia durable de que el efectivo se entrego. */
export interface CashHandoff {
  trade_id: string;
  provider_id: string;
  confirmed_at: string;
}

/**
 * Lee la constancia de entrega de una operacion, si existe.
 * Es la pieza que hace reanudable el cierre del cash-out.
 */
export async function getCashHandoff(tradeId: string): Promise<CashHandoff | null> {
  const row = await db.getOne<CashHandoff>(
    'SELECT trade_id, provider_id, confirmed_at FROM trade_cash_handoffs WHERE trade_id = $1',
    [tradeId],
  );
  return row ?? null;
}

export async function merchantConfirmScan(
  request: FastifyRequest,
  tradeId: string,
  scannerId: string,
  claimToken: string,
): Promise<MerchantConfirmResult> {
  request.log.info(
    { trade_id: tradeId, scanner_id: scannerId, category: 'trade.lifecycle' },
    '[trade] Provider QR scan confirmation',
  );

  // 1. La operacion debe existir
  const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
  if (!trade) {
    throw new NotFoundError(
      'TRADE_NOT_FOUND',
      'El intercambio no existe o el QR es inválido',
      `Trade ${tradeId} not found`,
    );
  }

  // 2. CASH-4: autoriza el PROVEEDOR persistido, no el vendedor del escrow.
  //    En cash-out el vendedor es el cliente; comprobar seller_id le daba 403
  //    justo a quien entrega el efectivo.
  if (trade.provider_id !== scannerId) {
    throw new ForbiddenError(
      'NOT_TRADE_PROVIDER',
      'No eres el proveedor de este intercambio',
      `User ${scannerId} is not the provider of trade ${tradeId}`,
    );
  }

  // 3. Cancelada: no hay nada que entregar.
  if (trade.status === 'cancelled') {
    throw new ConflictError(
      'TRADE_CANCELLED',
      'Este intercambio fue cancelado',
      `Trade ${tradeId} is cancelled`,
    );
  }

  const existingHandoff = await getCashHandoff(tradeId);

  // 4. Ya completada: se puede releer con seguridad, pero solo por quien
  //    entrego el efectivo. No libera nada de nuevo.
  if (trade.status === 'completed') {
    if (!existingHandoff || existingHandoff.provider_id !== scannerId) {
      throw new ConflictError(
        'TRADE_ALREADY_COMPLETED',
        'Este intercambio ya fue completado',
        `Trade ${tradeId} is already completed`,
      );
    }
    return buildConfirmResult(trade, existingHandoff, true);
  }

  // 5. Expirada. Se comprueba DESPUES de la reanudacion para no dejar
  //    atrapado a un proveedor que ya entrego efectivo y cuya operacion
  //    expiro mientras reintentaba la firma.
  if (!existingHandoff && new Date(trade.expires_at) < new Date()) {
    throw new TradeStateError(
      'TRADE_EXPIRED',
      'Este intercambio ha expirado',
      `Trade ${tradeId} expired at ${trade.expires_at}`,
    );
  }

  // 6. Reanudar: la entrega ya estaba confirmada por este mismo proveedor.
  //    No se vuelve a quemar el QR ni se crea una segunda entrega.
  if (existingHandoff) {
    if (existingHandoff.provider_id !== scannerId) {
      throw new ForbiddenError(
        'HANDOFF_BELONGS_TO_ANOTHER_PROVIDER',
        'Otro proveedor ya atendió este intercambio',
        `Handoff for trade ${tradeId} belongs to ${existingHandoff.provider_id}`,
      );
    }
    request.log.info(
      { trade_id: tradeId, provider_id: scannerId, category: 'trade.lifecycle' },
      '[trade] Resuming an already-confirmed cash handoff',
    );
    return buildConfirmResult(trade, existingHandoff, true);
  }

  // 7. Primera vez: el QR debe traer un token vivo y sin usar (SEC-02). Se
  //    quema aqui, ya validada la operacion, para que un QR contra un trade
  //    invalido no lo gaste.
  await consumeClaimToken(tradeId, claimToken, scannerId);

  // 8. Constancia durable de la entrega. `trade_id` es la llave primaria, asi
  //    que dos escaneos concurrentes no pueden crear dos entregas.
  await db.execute(
    `INSERT INTO trade_cash_handoffs (trade_id, provider_id, claim_token_hash)
     VALUES ($1, $2, $3)`,
    [tradeId, scannerId, hashClaimToken(claimToken)],
  );

  const handoff = await getCashHandoff(tradeId);
  if (!handoff) {
    throw new ConflictError(
      'HANDOFF_NOT_RECORDED',
      'No se pudo registrar la entrega. Intenta de nuevo.',
      `Cash handoff for trade ${tradeId} could not be read back`,
    );
  }

  await insertTradeAuditEvent({
    tradeId,
    fromState: trade.status,
    toState: trade.status,
    actor: scannerId,
    requestId: getRequestId(request),
    metadata: {
      success: true,
      event: 'cash_handoff_confirmed',
      flow: trade.flow,
      provider_id: scannerId,
    },
  });

  return buildConfirmResult(trade, handoff, false);
}

/**
 * Resumen para la pantalla del proveedor.
 *
 * CASH-4: la contraparte es el CLIENTE, que depende del flujo — en cash-out
 * el cliente es el vendedor del escrow, en deposito el comprador. Antes se
 * devolvia siempre el comprador, asi que en cash-out el proveedor veia su
 * propio nombre como contraparte.
 */
async function buildConfirmResult(
  trade: any,
  handoff: CashHandoff,
  resumed: boolean,
): Promise<MerchantConfirmResult> {
  const clientId = deriveInitiatorId(trade.flow, trade.seller_id, trade.buyer_id);
  const client = await db.getOne<{ username: string }>(
    'SELECT username FROM users WHERE id = $1',
    [clientId],
  );

  return {
    trade_id: trade.id,
    status: trade.status,
    flow: trade.flow,
    amount_mxn: Number(trade.amount_mxn),
    platform_fee_mxn: Number(trade.platform_fee_mxn ?? 0),
    client_handle: client?.username ?? 'Usuario MicoPay',
    provider_fee_mxn: Number(trade.provider_fee_mxn ?? 0),
    expires_at: trade.expires_at,
    expired: new Date(trade.expires_at) < new Date(),
    created_at: trade.created_at,
    lock_tx_hash: trade.lock_tx_hash ?? null,
    release_tx_hash: trade.release_tx_hash ?? null,
    resumed,
    handoff_confirmed_at: handoff.confirmed_at,
  };
}


// ── RED-3 · punto de encuentro, solo para participantes ───────────────────

/**
 * Estados en que compartir el punto exacto tiene sentido.
 *
 * `pending` NO entra: la operacion existe pero nadie comprometio fondos, asi
 * que basta con crear operaciones contra un proveedor para sacarle la
 * direccion — la misma enumeracion que RED-3 viene a cerrar, con un paso mas.
 * Los estados terminales tampoco: ahi la politica de retencion es dejar de
 * revelarlo.
 */
const MEETING_POINT_STATES = ['locked', 'revealing'];

export interface TradeMeetingPoint {
  trade_id: string;
  /** Zona publica; se devuelve siempre que haya. */
  area_label: string | null;
  /**
   * Punto exacto. `null` si el proveedor no lo configuro, o si la operacion
   * ya no esta en un estado que justifique revelarlo.
   */
  meeting_point: string | null;
  /** Por que no viene el punto, cuando no viene. */
  reason: 'shared' | 'not_set' | 'trade_not_accepted' | 'trade_terminal';
}

/**
 * RED-3: devuelve el punto de encuentro de una operacion a quien participa en
 * ella. Reutiliza la autorizacion normal de participante, asi que un tercero
 * recibe 403 antes de que se lea nada.
 */
export async function getTradeMeetingPoint(
  tradeId: string,
  userId: string,
): Promise<TradeMeetingPoint> {
  // Lanza 403 si no es participante y 404 si no existe.
  const trade = await getTradeById(tradeId, userId);

  const config = await db.getOne<{ area_label: string | null; meeting_point: string | null }>(
    `SELECT area_label, meeting_point FROM merchant_configs WHERE user_id = $1`,
    [trade.provider_id],
  );

  const terminal = ['completed', 'cancelled', 'expired', 'refunded'].includes(trade.status);
  if (terminal) {
    return {
      trade_id: trade.id,
      area_label: config?.area_label ?? null,
      meeting_point: null,
      reason: 'trade_terminal',
    };
  }

  if (!MEETING_POINT_STATES.includes(trade.status)) {
    return {
      trade_id: trade.id,
      area_label: config?.area_label ?? null,
      meeting_point: null,
      reason: 'trade_not_accepted',
    };
  }

  return {
    trade_id: trade.id,
    area_label: config?.area_label ?? null,
    meeting_point: config?.meeting_point ?? null,
    reason: config?.meeting_point ? 'shared' : 'not_set',
  };
}
