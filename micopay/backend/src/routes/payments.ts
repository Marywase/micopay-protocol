import type { FastifyInstance } from 'fastify';
import db from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { createRateLimiter } from '../middleware/rateLimit.middleware.js';
import { notifyIncomingPayment } from '../services/paymentNotify.service.js';

// Cada envio llama una vez; el tope solo frena a quien lo use para leer Horizon gratis.
const notifyRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: 20,
  keyGenerator: (req) => `payments-notify:${(req.user as { id?: string } | undefined)?.id ?? req.ip}`,
});

export async function paymentRoutes(app: FastifyInstance) {
  /**
   * POST /payments/notify
   * La app lo llama despues de mandar un pago desde "Enviar pago". Si quien
   * recibe es usuario de MicoPay, le llega un aviso. Ver paymentNotify.service.
   * Response: { notified }
   */
  app.post(
    '/payments/notify',
    {
      preHandler: [authMiddleware, notifyRateLimit],
      schema: {
        body: {
          type: 'object',
          required: ['tx_hash'],
          properties: {
            tx_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { tx_hash } = request.body as { tx_hash: string };
      const sender = await db.getOne<{ username: string | null; stellar_address: string }>(
        'SELECT username, stellar_address FROM users WHERE id = $1',
        [request.user.id],
      );
      if (!sender) return { notified: 0 };
      const result = await notifyIncomingPayment({
        senderAddress: sender.stellar_address,
        senderUsername: sender.username,
        txHash: tx_hash,
      });
      request.log.info(
        { user_id: request.user.id, tx_hash, ...result, category: 'push' },
        '[push] Payment notification requested',
      );
      return { notified: result.notified };
    },
  );
}
