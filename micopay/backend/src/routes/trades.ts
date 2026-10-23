import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { createRateLimiter } from '../middleware/rateLimit.middleware.js';
import { config } from '../config.js';
import * as tradeService from '../services/trade.service.js';
import { ASSET_CODE_MAX_LENGTH, normalizeEscrowAssetCode } from '../services/assetRate.service.js';

const tradeRateLimit = createRateLimiter({
  windowMs: config.tradeRateLimitWindowMs,
  max: config.tradeRateLimitMax,
  keyGenerator: (req) => req.user?.id || req.ip,
});

export async function tradeRoutes(app: FastifyInstance) {
  // All trade routes require authentication
  app.addHook('preHandler', authMiddleware);

  /**
   * POST /trades
   * Creates a trade between the caller and a counterparty.
   *
   * CASH-1 (#372): the request carries the *product* flow, not the escrow role.
   * The two are not the same thing and they reverse relative to each other:
   *
   *   flow 'deposit'  — the caller buys crypto with cash. The counterparty is
   *                     the Red MicoPay provider and must be the escrow seller,
   *                     because only the seller can lock funds and reveal the
   *                     HTLC secret.
   *   flow 'cashout'  — the caller sells crypto for cash. The caller gives up
   *                     the crypto, so the caller is the escrow seller and the
   *                     provider is the escrow buyer.
   *
   * In both directions the Red MicoPay liquidity provider is the counterparty,
   * never the caller. provider_id is derived here from the authenticated caller
   * and that rule; it is never read from the request body. With Fastify's
   * default ajv options `additionalProperties: false` STRIPS unknown fields
   * instead of rejecting them (pinned by tradeFlow.test.ts), so a forged
   * provider_id is dropped before the handler runs.
   *
   * `asset_code` (optional): the escrow asset. Absent -> XLM, so installed APKs
   * keep working. Error contract:
   *   400 VALIDATION_ERROR / INVALID_ASSET_CODE — not a string (null, number,
   *       boolean, object), empty, or longer than the column;
   *   422 ASSET_NOT_ENABLED — well-formed code without a deployed escrow.
   */
  app.post('/trades', {
    preHandler: [tradeRateLimit],
    // Fastify's default ajv runs with `coerceTypes`, which would turn 123 into
    // "123" and null into "" before the schema check — so the schema alone
    // cannot promise a 400 for a wrong type. The ORIGINAL type is checked here,
    // before validation, without changing ajv globally.
    preValidation: async (request) => {
      const body = request.body as Record<string, unknown> | null | undefined;
      if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'asset_code')) {
        normalizeEscrowAssetCode(body.asset_code);
      }
    },
    schema: {
      body: {
        type: 'object',
        required: ['counterparty_id', 'amount_mxn', 'flow'],
        properties: {
          counterparty_id: { type: 'string', format: 'uuid' },
          amount_mxn: { type: 'integer', minimum: 100, maximum: 50000 },
          flow: { type: 'string', enum: ['deposit', 'cashout'] },
          asset_code: { type: 'string', minLength: 1, maxLength: ASSET_CODE_MAX_LENGTH },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { counterparty_id, amount_mxn, flow, asset_code } = request.body as {
      counterparty_id: string;
      amount_mxn: number;
      flow: 'deposit' | 'cashout';
      asset_code?: string;
    };
    const callerId = request.user.id;
    const sellerId = flow === 'cashout' ? callerId : counterparty_id;
    const buyerId = flow === 'cashout' ? counterparty_id : callerId;

    const trade = await tradeService.createTrade({
      request,
      sellerId,
      buyerId,
      flow,
      amountMxn: amount_mxn,
      assetCode: asset_code,
    });

    // Don't expose encrypted secret fields in response
    const { secret_enc, secret_nonce, ...safeTrade } = trade;

    reply.status(201);
    return { trade: { ...safeTrade, ...tradeService.escrowAmountsForTrade(trade), ...tradeService.cashBreakdownForTrade(trade) } };
  });

  /**
   * GET /trades/:id/refund-eligibility
   *
   * CASH-6: el reloj que decide es el del servidor. La UI mostraba el
   * reembolso solo con estado `expired`, que nunca se persiste, asi que una
   * operacion vencida quedaba sin salida.
   */
  app.get('/trades/:id/refund-eligibility', async (request) => {
    const { id } = request.params as { id: string };
    return tradeService.getRefundEligibility(id, request.user.id);
  });

  /**
   * GET /trades/:id/meeting-point
   *
   * RED-3: el punto exacto sale de aqui y nunca del discovery anonimo. Exige
   * autenticacion y participacion en la operacion; un tercero recibe 403 sin
   * que se llegue a leer el dato.
   */
  app.get('/trades/:id/meeting-point', async (request) => {
    const { id } = request.params as { id: string };
    return tradeService.getTradeMeetingPoint(id, request.user.id);
  });

  /**
   * GET /trades/active
   * List active trades for the authenticated user.
   */
  app.get('/trades/active', async (request) => {
    const trades = await tradeService.getActiveTrades(request.user.id);
    const safeTrades = trades.map(({ secret_enc, secret_nonce, ...t }: any) => t);
    return { trades: safeTrades };
  });

  /**
   * GET /trades/history
   * All trades (active + completed) for the authenticated user, newest first.
   */
  app.get('/trades/history', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          // 'all', a stored status, or the derived 'expired'. An unknown value
          // simply matches nothing, as before.
          status: { type: 'string', maxLength: 32 },
          page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
    },
  }, async (request) => {
    const { status, page, limit } = request.query as { status?: string; page: number; limit: number };
    const trades = await tradeService.getTradeHistory(request.user.id, status, page, limit);
    return { trades };
  });

  /**
   * GET /trades/:id
   * Get trade detail (only for participants).
   */
  app.get('/trades/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { trade, merchant_unavailable, seller_username, buyer_username } =
      await tradeService.getTradeDetailForParticipant(id, request.user.id);

    const { secret_enc, secret_nonce, ...safeTrade } = trade;
    return {
      trade: { ...safeTrade, ...tradeService.escrowAmountsForTrade(trade), ...tradeService.cashBreakdownForTrade(trade) },
      merchant_unavailable,
      seller_username,
      buyer_username,
    };
  });

  /**
   * POST /trades/:id/lock/prepare
   * Seller-only. Returns an unsigned lock() XDR for the seller to sign
   * client-side with their own key (the contract requires seller.require_auth()).
   */
  app.post('/trades/:id/lock/prepare', async (request) => {
    const { id } = request.params as { id: string };
    return tradeService.prepareLockTrade(request, id, request.user.id);
  });

  /**
   * POST /trades/:id/lock
   * Seller-only. Submits the seller-signed lock() XDR and returns the tx hash.
   */
  app.post('/trades/:id/lock', {
    schema: {
      body: {
        type: 'object',
        properties: {
          signed_xdr: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const { signed_xdr } = (request.body as { signed_xdr?: string } | undefined) ?? {};
    return tradeService.lockTrade(request, id, request.user.id, signed_xdr);
  });

  /**
   * POST /trades/:id/reveal
   * Seller confirms cash was received. Enables secret access.
   */
  app.post('/trades/:id/reveal', async (request) => {
    const { id } = request.params as { id: string };
    return tradeService.revealTrade(request, id, request.user.id);
  });

  /**
   * GET /trades/:id/secret
   * Seller gets the HTLC secret to show QR to buyer.
   * Only available in 'revealing' state.
   */
  app.get('/trades/:id/secret', async (request) => {
    const { id } = request.params as { id: string };
    return tradeService.getTradeSecret(
      request,
      id,
      request.user.id,
      request.ip,
      request.headers['user-agent'] || 'unknown',
    );
  });

  /**
   * POST /trades/:id/complete/prepare
   * Buyer-only. Returns an unsigned release() XDR for the buyer to sign
   * client-side with their own key (the contract requires buyer.require_auth()).
   */
  app.post('/trades/:id/complete/prepare', async (request) => {
    const { id } = request.params as { id: string };
    return tradeService.prepareReleaseTrade(request, id, request.user.id);
  });

  /**
   * POST /trades/:id/complete
   * Buyer confirms cash received. Submits the buyer-signed release() XDR and returns the tx hash.
   */
  app.post('/trades/:id/complete', {
    schema: {
      body: {
        type: 'object',
        properties: {
          signed_xdr: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const { signed_xdr } = (request.body as { signed_xdr?: string } | undefined) ?? {};
    return tradeService.completeTrade(request, id, request.user.id, signed_xdr);
  });

  /**
   * POST /trades/:id/cancel
   *
   * Returns `{ status, refund_expected, lock_tx_hash }` for client copy (#20). Errors use `{ error, message }`
   * (`ConflictError`, `ForbiddenError`, …) from the global Fastify error handler.
   */
  app.post('/trades/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    const { reason } = (request.body as { reason?: string } | undefined) ?? {};
    return tradeService.cancelTrade(request, id, request.user.id, reason);
  });

  /**
   * POST /trades/:id/refund
   *
   * Buyer triggers on-chain refund for an expired trade. Calls refund() on the Soroban contract
   * and transitions the trade to 'refunded' status. Returns `{ status, refund_tx_hash }`.
   * Errors use `{ error, message }` via the global Fastify error handler.
   */
  app.post('/trades/:id/refund', async (request) => {
    const { id } = request.params as { id: string };
    return tradeService.refundTrade(request, id, request.user.id);
  });

  /**
   * GET /trades/:id/audit
   * Ordered trade transition audit trail for support/ops.
   */
  app.get('/trades/:id/audit', async (request) => {
    const { id } = request.params as { id: string };
    const audit = await tradeService.getTradeAuditTrail(id, request.user.id);
    return { audit };
  });

  /**
   * GET /audit/lookup?request_id=<uuid>
   * Look up audit events by correlation ID. Useful for support when a user
   * reports a support code — support can find the request_id from logs and
   * query this endpoint to see exactly what happened.
   */
  app.get('/audit/lookup', {
    schema: {
      querystring: {
        type: 'object',
        required: ['request_id'],
        properties: {
          request_id: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request) => {
    const { request_id } = request.query as { request_id: string };
    const events = await tradeService.lookupAuditByRequestId(request_id);
    return { audit: events };
  });

  /**
   * POST /trades/:id/merchant-confirm
   * El comercio escanea el QR del usuario. Valida trade, participante, estado y
   * expiración, y quema el `claim_token` del QR (SEC-02) para que un mismo
   * código no sirva dos veces. Devuelve el resumen para la pantalla de
   * confirmación — no mueve fondos.
   */
  app.post('/trades/:id/merchant-confirm', {
    schema: {
      body: {
        type: 'object',
        required: ['claim_token'],
        properties: {
          claim_token: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const { claim_token } = request.body as { claim_token: string };
    return tradeService.merchantConfirmScan(request, id, request.user.id, claim_token);
  });

  /**
   * GET /merchants/me/trades
   * List incoming trades for the authenticated provider, filtered by state.
   * Returns trades where the caller is the Red MicoPay provider (CASH-3:
   * antes era el vendedor del escrow, que en cash-out es el cliente), newest
   * first.
   */
  app.get('/merchants/me/trades', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            enum: ['all', 'pending', 'locked', 'revealing', 'completed', 'cancelled', 'expired', 'refunded'],
            default: 'all'
          },
        },
      },
    },
  }, async (request) => {
    const { state } = request.query as { state?: string };
    const trades = await tradeService.getMerchantTrades(request.user.id, state || 'all');
    return { trades };
  });
}
