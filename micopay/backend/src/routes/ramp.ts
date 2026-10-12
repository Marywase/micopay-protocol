import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { verifyWebhookSignature } from '../lib/webhook-auth.js';
import db from '../db/schema.js';
import { AppError, UpstreamError, ValidationError, ForbiddenError, NotFoundError } from '../utils/errors.js';
import {
  createQuote,
  createOrder,
  getOrder,
  regenerateOrderTx,
  getCetesIdentifier,
} from '../services/etherfuse.service.js';
import { assertKycTierSufficient } from '../services/kyc-gate.service.js';
import {
  BRIDGE_SYMBOL,
  WithdrawNotReadyError,
  bridgeAmountAfterSlippage,
  evaluateWithdrawAccount,
  findStrictSendRoute,
  fromStroops,
  loadHorizonAccount,
  needsDex,
  parseWithdrawAsset,
  partnerFeeBps,
  plainAmount,
  resolveRampAsset,
  skipChainChecks,
  toStroops,
  type StellarAssetRef,
  type WithdrawAsset,
} from '../services/rampWithdraw.service.js';

interface RampUserRow {
  stellar_address: string;
  etherfuse_customer_id: string | null;
  etherfuse_bank_account_id: string | null;
}

async function requireOnboardedUser(userId: string): Promise<RampUserRow> {
  const user = await db.getOne<RampUserRow>(
    'SELECT stellar_address, etherfuse_customer_id, etherfuse_bank_account_id FROM users WHERE id = $1',
    [userId],
  );
  if (!user?.etherfuse_customer_id || !user?.etherfuse_bank_account_id) {
    throw new ForbiddenError('KYC requerido antes de continuar');
  }
  return user;
}

function ensureEtherfuseConfigured() {
  if (!process.env.ETHERFUSE_API_KEY) {
    throw new UpstreamError(
      'ETHERFUSE_NOT_CONFIGURED',
      'El servicio de rampa SPEI no está disponible por el momento.',
      'ETHERFUSE_API_KEY not configured',
      503,
    );
  }
}

/**
 * order_id is a backend-generated UUID handed to Etherfuse, never guessable —
 * but nothing previously stopped one authenticated user from polling another
 * user's order if they learned its ID. This records ownership at creation and
 * enforces it on every subsequent read (see docs/AUDIT_MOBILE_MAINNET.md,
 * "IDOR ramp order"). Orders created before this migration have no row here —
 * fail open for those (log + allow) rather than break in-flight orders.
 */
async function recordRampOrderOwner(orderId: string, userId: string, quoteId: string | null): Promise<void> {
  await db.execute(
    'INSERT INTO ramp_orders (order_id, user_id, quote_id) VALUES ($1, $2, $3)',
    [orderId, userId, quoteId],
  );
}

interface RampQuoteRow {
  quote_id: string;
  user_id: string;
  asset: string;
  send_code: string;
  send_issuer: string | null;
  send_max: string;
  dex_path: StellarAssetRef[];
  pay_code: string;
  pay_issuer: string;
  pay_amount: string;
  destination_mxn: string;
}

/**
 * Lo que el telefono tiene que firmar para un retiro. Sale de lo guardado al
 * cotizar, no de lo que mande el cliente. `conversion` solo existe cuando el
 * activo pasa por el DEX (ver rampWithdraw.service.ts).
 */
function withdrawInstructions(q: RampQuoteRow) {
  const payAmount = fromStroops(toStroops(String(q.pay_amount)));
  const isDex = q.send_code !== q.pay_code || q.send_issuer !== q.pay_issuer;
  return {
    asset: q.asset,
    payment: { code: q.pay_code, issuer: q.pay_issuer, amount: payAmount },
    conversion: isDex
      ? {
          sendAsset: { code: q.send_code, issuer: q.send_issuer },
          sendMax: fromStroops(toStroops(String(q.send_max))),
          destAsset: { code: q.pay_code, issuer: q.pay_issuer },
          destAmount: payAmount,
          path: q.dex_path,
        }
      : null,
    destinationMxn: String(q.destination_mxn),
  };
}

async function updateRampOrderStatus(orderId: string, status: string): Promise<void> {
  await db.execute(
    'UPDATE ramp_orders SET status = $2, status_updated_at = NOW() WHERE order_id = $1 AND status IS DISTINCT FROM $2',
    [orderId, status],
  );
}

/**
 * Cotiza un retiro a MXN. Devuelve el activo y monto exactos que se le pagan a
 * Etherfuse y, si hace falta, la conversion previa en el DEX.
 */
async function quoteWithdraw(params: {
  userId: string;
  user: RampUserRow;
  asset: WithdrawAsset;
  sourceAmount: string;
}) {
  const { userId, user, asset, sourceAmount } = params;
  const sellAmount = fromStroops(toStroops(sourceAmount));

  let send: StellarAssetRef;
  let pay: { code: string; issuer: string; identifier: string };
  let payAmount: string;
  let path: StellarAssetRef[] = [];

  if (needsDex(asset)) {
    // Hoy solo XLM. Se cotiza en el activo puente con lo que el DEX entrega
    // menos el margen; el usuario nunca gasta mas de lo que escribio.
    send = { code: 'XLM', issuer: null };
    pay = await resolveRampAsset(user.stellar_address, BRIDGE_SYMBOL);
    const route = await findStrictSendRoute(send, sellAmount, pay);
    if (!route) {
      throw new ValidationError(`No hay liquidez para cambiar ${asset} a ${BRIDGE_SYMBOL} en este momento.`);
    }
    payAmount = bridgeAmountAfterSlippage(route.destinationAmount);
    if (toStroops(payAmount) <= 0n) {
      throw new ValidationError('El monto es demasiado pequeño para retirar.');
    }
    path = route.path;
  } else {
    pay = await resolveRampAsset(user.stellar_address, asset);
    send = { code: pay.code, issuer: pay.issuer };
    payAmount = sellAmount;
  }

  let needsBridgeTrustline = false;
  if (!skipChainChecks()) {
    const account = await loadHorizonAccount(user.stellar_address);
    const readiness = evaluateWithdrawAccount(account, {
      sell: send,
      amount: sellAmount,
      bridge: needsDex(asset) ? pay : undefined,
    });
    if (!readiness.ready) throw new WithdrawNotReadyError(readiness, asset);
    needsBridgeTrustline = readiness.needsBridgeTrustline;
  }

  const quote = await createQuote({
    quoteId: randomUUID(),
    customerId: user.etherfuse_customer_id!,
    sourceAmount: plainAmount(payAmount),
    walletAddress: user.stellar_address,
    partnerFeeBps: partnerFeeBps(),
    quoteAssets: { type: 'offramp', sourceAsset: pay.identifier, targetAsset: 'MXN' },
  });

  const row: RampQuoteRow = {
    quote_id: quote.quoteId,
    user_id: userId,
    asset,
    send_code: send.code,
    send_issuer: send.issuer,
    send_max: sellAmount,
    dex_path: path,
    pay_code: pay.code,
    pay_issuer: pay.issuer,
    pay_amount: payAmount,
    destination_mxn: quote.destinationAmount,
  };
  await db.execute(
    `INSERT INTO ramp_quotes
       (quote_id, user_id, asset, send_code, send_issuer, send_max, dex_path,
        pay_code, pay_issuer, pay_amount, destination_mxn, fee_amount, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13)`,
    [
      row.quote_id, userId, asset, send.code, send.issuer, sellAmount, JSON.stringify(path),
      pay.code, pay.issuer, payAmount, quote.destinationAmount, quote.feeAmount ?? null, quote.expiresAt ?? null,
    ],
  );

  return {
    quoteId: quote.quoteId,
    type: 'offramp' as const,
    exchangeRate: quote.exchangeRate,
    sourceAmount: sellAmount,
    destinationAmount: quote.destinationAmount,
    feeAmount: quote.feeAmount,
    expiresAt: quote.expiresAt,
    ...withdrawInstructions(row),
    needsBridgeTrustline,
  };
}

async function assertRampOrderOwnership(orderId: string, userId: string, request: { log: { warn: (obj: unknown, msg: string) => void } }): Promise<void> {
  const owner = await db.getOne<{ user_id: string }>(
    'SELECT user_id FROM ramp_orders WHERE order_id = $1',
    [orderId],
  );
  if (!owner) {
    request.log.warn({ order_id: orderId, user_id: userId, category: 'ramp' }, '[ramp] Order has no recorded owner (pre-migration) — allowing');
    return;
  }
  if (owner.user_id !== userId) {
    throw new ForbiddenError('No tienes permiso para ver esta orden');
  }
}

export async function rampRoutes(app: FastifyInstance): Promise<void> {
  // Get quote: MXN->CETES (onramp), or asset->MXN (offramp). `asset` is one of
  // USDC, CETES, MEXe, XLM; without it the offramp sells CETES (CETESScreen).
  app.post<{ Body: { type: 'onramp' | 'offramp'; sourceAmount: string; asset?: string } }>(
    '/defi/ramp/quote',
    { preHandler: [authMiddleware] },
    async (request: any) => {
      ensureEtherfuseConfigured();

      const { type, sourceAmount, asset: rawAsset } = request.body ?? {};
      if (!type || !sourceAmount) {
        throw new ValidationError('type y sourceAmount son requeridos');
      }
      const amount = parseFloat(sourceAmount);
      if (isNaN(amount) || amount <= 0) {
        throw new ValidationError('sourceAmount invalido');
      }
      const asset = type === 'offramp' ? parseWithdrawAsset(rawAsset ?? 'CETES') : null;
      if (type === 'offramp' && !asset) {
        throw new ValidationError('asset invalido');
      }

      const user = await requireOnboardedUser(request.user.id);

      // #314: tiered KYC gate. Onramp amount is already MXN; offramp's
      // sourceAmount is in the asset being sold, so amountMxn is left undefined
      // there (falls back to the operation's base tier requirement). Passing the
      // quoted MXN here would count every re-quote toward the monthly volume.
      await assertKycTierSufficient({
        userId: request.user.id,
        operationType: type === 'onramp' ? 'cash_in' : 'cash_out',
        amountMxn: type === 'onramp' ? amount : undefined,
      });

      try {
        if (type === 'offramp') {
          return await quoteWithdraw({ userId: request.user.id, user, asset: asset!, sourceAmount: String(sourceAmount) });
        }

        const cetesIdentifier = await getCetesIdentifier(user.stellar_address);
        const quote = await createQuote({
          quoteId: randomUUID(),
          customerId: user.etherfuse_customer_id!,
          sourceAmount,
          walletAddress: user.stellar_address,
          partnerFeeBps: partnerFeeBps(),
          quoteAssets: { type: 'onramp', sourceAsset: 'MXN', targetAsset: cetesIdentifier },
        });

        return {
          quoteId: quote.quoteId,
          type,
          exchangeRate: quote.exchangeRate,
          sourceAmount: quote.sourceAmount,
          destinationAmount: quote.destinationAmount,
          feeAmount: quote.feeAmount,
          expiresAt: quote.expiresAt,
        };
      } catch (err: any) {
        // Validation, readiness and Horizon errors already carry a user message.
        if (err instanceof AppError) throw err;
        throw new UpstreamError(
          'ETHERFUSE_QUOTE_FAILED',
          'No se pudo obtener la cotización. Intenta de nuevo.',
          err.message || 'Failed to create Etherfuse quote',
        );
      }
    },
  );

  // Create order: returns CLABE deposit instructions (onramp) or anchor account+memo (offramp).
  app.post<{ Body: { quoteId: string; useAnchor?: boolean } }>(
    '/defi/ramp/order',
    { preHandler: [authMiddleware] },
    async (request: any) => {
      ensureEtherfuseConfigured();

      const { quoteId, useAnchor } = request.body ?? {};
      if (!quoteId) {
        throw new ValidationError('quoteId es requerido');
      }

      const user = await requireOnboardedUser(request.user.id);
      const orderId = randomUUID();

      // Withdrawals quoted by quoteWithdraw: the quote must belong to the caller,
      // and anchor mode is mandatory (the phone builds the payment itself).
      const stored = await db.getOne<RampQuoteRow>('SELECT * FROM ramp_quotes WHERE quote_id = $1', [quoteId]);
      if (stored && stored.user_id !== request.user.id) {
        throw new ForbiddenError('Esta cotización no es tuya');
      }

      try {
        const result = await createOrder({
          orderId,
          quoteId,
          bankAccountId: user.etherfuse_bank_account_id!,
          publicKey: user.stellar_address,
          useAnchor: stored ? true : useAnchor,
        });

        await recordRampOrderOwner(orderId, request.user.id, stored?.quote_id ?? null);

        if ('offramp' in result) {
          return stored ? { ...result.offramp, ...withdrawInstructions(stored) } : result.offramp;
        }
        return result.onramp;
      } catch (err: any) {
        throw new UpstreamError(
          'ETHERFUSE_ORDER_FAILED',
          'No se pudo crear la orden. Intenta de nuevo.',
          err.message || 'Failed to create Etherfuse order',
        );
      }
    },
  );

  // Poll order status.
  app.get<{ Params: { orderId: string } }>(
    '/defi/ramp/order/:orderId',
    { preHandler: [authMiddleware] },
    async (request) => {
      const { orderId } = request.params;
      await assertRampOrderOwnership(orderId, request.user.id, request);
      try {
        const order = await getOrder(orderId);
        await updateRampOrderStatus(orderId, order.status);
        return { orderId: order.orderId, status: order.status, type: order.orderType };
      } catch (err: any) {
        if (err.message === 'ORDER_NOT_FOUND') {
          throw new NotFoundError('Orden no encontrada');
        }
        throw new UpstreamError(
          'ETHERFUSE_ORDER_FETCH_FAILED',
          'No se pudo consultar la orden. Intenta de nuevo.',
          err.message || 'Failed to fetch Etherfuse order',
        );
      }
    },
  );

  // Regenerate expired Stellar transaction (offramp anchor mode, or stale onramp claim TX).
  app.post<{ Params: { orderId: string } }>(
    '/defi/ramp/order/:orderId/regenerate_tx',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const { orderId } = request.params;
      await assertRampOrderOwnership(orderId, request.user.id, request);
      try {
        const { status, body } = await regenerateOrderTx(orderId);
        return reply.status(status).send(body ?? {});
      } catch (err: any) {
        throw new UpstreamError(
          'ETHERFUSE_REGENERATE_TX_FAILED',
          'No se pudo regenerar la transacción. Intenta de nuevo.',
          err.message || 'Failed to regenerate Etherfuse order tx',
        );
      }
    },
  );

  // The caller's recent ramp orders, newest first, with the status last seen.
  app.get('/defi/ramp/orders', { preHandler: [authMiddleware] }, async (request: any) => {
    const orders = await db.getMany(
      `SELECT o.order_id, o.status, o.created_at, o.status_updated_at,
              q.asset, q.send_max, q.pay_code, q.pay_amount, q.destination_mxn
         FROM ramp_orders o
         LEFT JOIN ramp_quotes q ON q.quote_id = o.quote_id
        WHERE o.user_id = $1
        ORDER BY o.created_at DESC
        LIMIT 20`,
      [request.user.id],
    );
    return { orders };
  });

  // Webhook endpoints (Etherfuse calls these on order/KYC status changes).
  // One URL per event type — each POST /ramp/webhook subscription gets its
  // own signing secret, and the X-Signature header alone doesn't tell you
  // which one to verify against. See docs/SPEI_ANCHOR_PLAN.md.
  app.post<{ Body: unknown }>('/defi/ramp/webhook/order', async (request, reply) => {
    const signature = request.headers['x-signature'] as string | undefined;
    const secret = process.env.ETHERFUSE_WEBHOOK_SECRET_ORDER;
    const { valid, error } = verifyWebhookSignature(request.body, signature, secret);
    if (!valid) {
      return reply.status(401).send({ error: `webhook signature verification failed: ${error}` });
    }
    request.log.info({ body: request.body }, 'Etherfuse order_updated webhook');

    // The docs don't pin down the payload shape, and Etherfuse says to re-read
    // the order for the authoritative state. Only orders we created.
    const body = request.body as any;
    const orderId: unknown = body?.orderId ?? body?.order_id ?? body?.data?.orderId ?? body?.order?.orderId;
    if (typeof orderId === 'string') {
      const known = await db.getOne<{ order_id: string }>('SELECT order_id FROM ramp_orders WHERE order_id = $1', [orderId]);
      if (known) {
        try {
          const order = await getOrder(orderId);
          await updateRampOrderStatus(orderId, order.status);
        } catch (err: any) {
          request.log.warn({ order_id: orderId, err: err?.message, category: 'ramp' }, '[ramp] Could not refresh order from webhook');
        }
      }
    }
    return reply.status(200).send({ received: true });
  });

  app.post<{ Body: unknown }>('/defi/ramp/webhook/kyc', async (request, reply) => {
    const signature = request.headers['x-signature'] as string | undefined;
    const secret = process.env.ETHERFUSE_WEBHOOK_SECRET_KYC;
    const { valid, error } = verifyWebhookSignature(request.body, signature, secret);
    if (!valid) {
      return reply.status(401).send({ error: `webhook signature verification failed: ${error}` });
    }
    request.log.info({ body: request.body }, 'Etherfuse kyc_updated webhook');
    return reply.status(200).send({ received: true });
  });
}
