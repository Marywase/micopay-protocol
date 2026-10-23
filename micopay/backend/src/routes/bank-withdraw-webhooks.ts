import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import db from '../db/schema.js';
import { verifyWebhookSignature, EtherfuseV2Error } from '../services/etherfuseV2.service.js';
import {
  applyKycUpdate,
  applyOrderUpdate,
  applyPaymentAccountUpdate,
} from '../services/rampWithdraw.service.js';
import { sendBankWithdrawCompletedNotification } from '../services/push.service.js';

// Fastify parsea JSON por defecto; para verificar HMAC necesitamos los bytes
// crudos del body. Este plugin re-registra el parser de application/json en
// el contexto encapsulado de los webhooks: solo esas rutas reciben rawBody.
// Fuera del plugin el parser por defecto sigue intacto.

interface WithRawBody {
  rawBody: Buffer;
}

function readSecret(eventType: 'orderUpdated' | 'kycUpdated' | 'paymentAccountUpdated'): string | null {
  const envName =
    eventType === 'orderUpdated' ? 'ETHERFUSE_WEBHOOK_SECRET_ORDER_UPDATED' :
    eventType === 'kycUpdated' ? 'ETHERFUSE_WEBHOOK_SECRET_KYC_UPDATED' :
    'ETHERFUSE_WEBHOOK_SECRET_PAYMENT_ACCOUNT_UPDATED';
  return process.env[envName] ?? null;
}

function verifyOrDeny(
  eventType: 'orderUpdated' | 'kycUpdated' | 'paymentAccountUpdated',
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const secret = readSecret(eventType);
  if (!secret) {
    request.log.error({ eventType }, 'webhook: secret no configurado');
    reply.status(503).send({ code: 'secret-missing', message: 'webhook no esta configurado' });
    return false;
  }
  const sig = request.headers['x-signature'];
  const sigValue = Array.isArray(sig) ? sig[0] : sig;
  const raw = (request as unknown as WithRawBody).rawBody;
  if (!raw || !verifyWebhookSignature(raw, sigValue, secret)) {
    request.log.warn({ eventType, hasSig: !!sigValue }, 'webhook: firma invalida');
    reply.status(401).send({ code: 'bad-signature' });
    return false;
  }
  return true;
}

function catchUpstream(reply: FastifyReply, err: unknown, request: FastifyRequest): void {
  if (err instanceof EtherfuseV2Error) {
    request.log.warn({ err, status: err.status, code: err.code }, 'webhook upstream error');
    reply.status(502).send({ code: 'upstream-error' });
    return;
  }
  request.log.error({ err }, 'webhook handler threw');
  reply.status(500).send({ code: 'internal' });
}

export async function bankWithdrawWebhookRoutes(app: FastifyInstance) {
  // Content type parser encapsulado: preserva el body crudo. Afecta solo a
  // las rutas registradas en este plugin.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      const buf = body as Buffer;
      (req as unknown as WithRawBody).rawBody = buf;
      try {
        done(null, buf.length ? JSON.parse(buf.toString('utf-8')) : {});
      } catch (err) {
        done(err as Error);
      }
    },
  );

  /**
   * orderUpdated: refresca el estado desde Etherfuse. Si cambia a 'completed'
   * manda una push al usuario. El cuerpo que manda Etherfuse incluye el
   * orderId; el customerOrgId esta ligado al secret (una subscripcion por org).
   */
  app.post('/defi/ramp/webhook/order-updated', async (request, reply) => {
    if (!verifyOrDeny('orderUpdated', request, reply)) return;
    const body = request.body as { data?: { id?: string; organizationId?: string } } | undefined;
    const orderId = body?.data?.id;
    const customerOrgId = body?.data?.organizationId;
    if (!orderId || !customerOrgId) {
      return reply.status(400).send({ code: 'bad-payload' });
    }
    try {
      const result = await applyOrderUpdate(customerOrgId, orderId);
      if (!result) return reply.status(404).send({ code: 'unknown-order' });

      if (result.previousStatus !== 'completed' && result.order.status === 'completed') {
        const row = await db.getOne<{ clabe_last4: string | null; destination_mxn: string | null }>(
          `SELECT u.clabe_last4, q.destination_mxn
             FROM ramp_orders o
             JOIN users u ON u.id = o.user_id
             LEFT JOIN ramp_quotes q ON q.quote_id = o.quote_id
            WHERE o.order_id = $1`,
          [orderId],
        );
        await sendBankWithdrawCompletedNotification(result.userId, {
          orderId,
          amountMxn: row?.destination_mxn ?? result.order.destination.amount,
          clabeLast4: row?.clabe_last4 ?? null,
        });
      }
      return { ok: true };
    } catch (err) {
      return catchUpstream(reply, err, request);
    }
  });

  /**
   * kycUpdated: refresca el estado de verificacion desde Etherfuse. No manda
   * push (el usuario esta mirando la pantalla; la UI consulta /status).
   */
  app.post('/defi/ramp/webhook/kyc-updated', async (request, reply) => {
    if (!verifyOrDeny('kycUpdated', request, reply)) return;
    const body = request.body as { data?: { organizationId?: string } } | undefined;
    const customerOrgId = body?.data?.organizationId;
    if (!customerOrgId) return reply.status(400).send({ code: 'bad-payload' });
    try {
      const status = await applyKycUpdate(customerOrgId);
      if (!status) return reply.status(404).send({ code: 'unknown-customer' });
      return { ok: true };
    } catch (err) {
      return catchUpstream(reply, err, request);
    }
  });

  /**
   * paymentAccountUpdated: solo refresca de Etherfuse (log). El estado real
   * se vera cuando el usuario intente cotizar.
   */
  app.post('/defi/ramp/webhook/payment-account-updated', async (request, reply) => {
    if (!verifyOrDeny('paymentAccountUpdated', request, reply)) return;
    const body = request.body as { data?: { organizationId?: string; id?: string } } | undefined;
    const customerOrgId = body?.data?.organizationId;
    const paymentAccountId = body?.data?.id;
    if (!customerOrgId || !paymentAccountId) return reply.status(400).send({ code: 'bad-payload' });
    try {
      await applyPaymentAccountUpdate(customerOrgId, paymentAccountId);
      return { ok: true };
    } catch (err) {
      return catchUpstream(reply, err, request);
    }
  });
}
