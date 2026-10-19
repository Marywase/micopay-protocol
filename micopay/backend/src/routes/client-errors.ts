import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { createRateLimiter, InMemoryStore, type RateLimitStore } from '../middleware/rateLimit.middleware.js';
import db from '../db/schema.js';

export async function clientErrorRoutes(
  app: FastifyInstance,
  options: { rateLimitStore?: RateLimitStore } = {},
) {
  // Share only verified identities between the limiter and the insert handler.
  const userIds = new WeakMap<FastifyRequest, string>();
  const clientErrorRateLimit = createRateLimiter({
    windowMs: config.clientErrorRateLimitWindowMs,
    max: config.clientErrorRateLimitMax,
    store: options.rateLimitStore ?? new InMemoryStore(),
    keyGenerator: (request) => {
      const userId = userIds.get(request);
      return userId ? `client-errors:user:${userId}` : `client-errors:ip:${request.ip}`;
    },
  });
  /**
   * POST /client-errors
   *
   * APK / frontend reports a client-side error so it appears in backend logs
   * and is stored for support investigation. Auth is optional — unauthenticated
   * reports are accepted (e.g. crashes before login) but user_id is recorded
   * when available.
   */
  app.post('/client-errors', {
    preHandler: [
      async (request) => {
        try {
          const { id } = await request.jwtVerify<{ id?: unknown }>();
          if (typeof id === 'string' && id.length > 0) userIds.set(request, id);
        } catch {
          // Missing, invalid or expired tokens still permit pre-login reports.
        }
      },
      clientErrorRateLimit,
    ],
    schema: {
      body: {
        type: 'object',
        required: ['message'],
        properties: {
          request_id: { type: 'string', maxLength: 128 },
          error_code: { type: 'string', maxLength: 64 },
          message: { type: 'string', maxLength: 2048 },
          stack: { type: 'string', maxLength: 8192 },
          context: { type: 'object', maxProperties: 50, additionalProperties: true },
          app_version: { type: 'string', maxLength: 32 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      request_id?: string;
      error_code?: string;
      message: string;
      stack?: string;
      context?: Record<string, unknown>;
      app_version?: string;
    };

    const userId = userIds.get(request) ?? null;

    const userAgent = request.headers['user-agent'] || null;

    await db.execute(
      `INSERT INTO client_errors
        (request_id, user_id, error_code, message, stack, context, user_agent, app_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        body.request_id || null,
        userId,
        body.error_code || null,
        body.message,
        body.stack || null,
        body.context || {},
        userAgent,
        body.app_version || null,
      ],
    );

    request.log.warn(
      {
        category: 'client.error',
        error_code: body.error_code,
        client_request_id: body.request_id,
        user_id: userId,
        app_version: body.app_version,
      },
      `[client-error] ${body.message}`,
    );

    reply.status(201).send({ status: 'recorded' });
  });
}
