import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { createRateLimiter } from '../middleware/rateLimit.middleware.js';
import { EtherfuseV2Error } from '../services/etherfuseV2.service.js';
import {
  confirmWithdrawOrder,
  createWithdrawQuote,
  getBankWithdrawStatus,
  listUserWithdrawOrders,
  registerBankAccount,
  registerWalletAccount,
  startKyc,
  validateClabe,
} from '../services/rampWithdraw.service.js';

// Un usuario no deberia hacer mas de un retiro cada pocos segundos; el tope
// limita bucles accidentales de la pantalla ("volver a cotizar").
const bankWithdrawRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  keyGenerator: (req) => `bank-withdraw:${(req.user as { id?: string } | undefined)?.id ?? req.ip}`,
});

function requireUserId(request: FastifyRequest): string {
  const u = request.user as { id?: string } | undefined;
  if (!u?.id) throw new Error('bank-withdraw: sesion sin userId');
  return u.id;
}

function sendEtherfuseError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof EtherfuseV2Error) {
    return reply.status(err.status).send({ code: err.code, message: err.message });
  }
  throw err;
}

export async function bankWithdrawRoutes(app: FastifyInstance) {
  /**
   * GET /defi/bank-withdraw/status
   * Devuelve en que paso del flujo esta el usuario para pintar el stepper.
   */
  app.get(
    '/defi/bank-withdraw/status',
    { preHandler: [authMiddleware, bankWithdrawRateLimit] },
    async (request, reply) => {
      try {
        return await getBankWithdrawStatus(requireUserId(request));
      } catch (err) { return sendEtherfuseError(reply, err); }
    },
  );

  /**
   * POST /defi/bank-withdraw/kyc
   * Crea la personal org del usuario en Etherfuse, le envia los datos de
   * verificacion y devuelve el launch form para abrir /idv en la app.
   */
  app.post(
    '/defi/bank-withdraw/kyc',
    {
      preHandler: [authMiddleware, bankWithdrawRateLimit],
      schema: {
        body: {
          type: 'object',
          required: ['firstName', 'lastName', 'dateOfBirth', 'taxId', 'country', 'address', 'email', 'displayName'],
          properties: {
            firstName: { type: 'string', minLength: 1, maxLength: 80 },
            lastName: { type: 'string', minLength: 1, maxLength: 80 },
            dateOfBirth: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
            taxId: { type: 'string', minLength: 1, maxLength: 32 },
            country: { type: 'string', pattern: '^[A-Z]{3}$' },
            email: { type: 'string', format: 'email', maxLength: 254 },
            displayName: { type: 'string', minLength: 1, maxLength: 120 },
            address: {
              type: 'object',
              required: ['street', 'city', 'country'],
              properties: {
                street: { type: 'string', minLength: 1, maxLength: 200 },
                city: { type: 'string', minLength: 1, maxLength: 100 },
                country: { type: 'string', pattern: '^[A-Z]{3}$' },
                region: { type: 'string', maxLength: 100 },
                postalCode: { type: 'string', maxLength: 20 },
                buildingNumber: { type: 'string', maxLength: 20 },
                flatNumber: { type: 'string', maxLength: 20 },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        return await startKyc(requireUserId(request), request.body as Parameters<typeof startKyc>[1]);
      } catch (err) { return sendEtherfuseError(reply, err); }
    },
  );

  /**
   * POST /defi/bank-withdraw/bank-account
   * Registra la CLABE del usuario como payment account. Antes registra la
   * wallet de Stellar si todavia no esta.
   */
  app.post(
    '/defi/bank-withdraw/bank-account',
    {
      preHandler: [authMiddleware, bankWithdrawRateLimit],
      schema: {
        body: {
          type: 'object',
          required: ['clabe', 'accountHolderName', 'taxId'],
          properties: {
            clabe: { type: 'string', pattern: '^[0-9]{18}$' },
            accountHolderName: { type: 'string', minLength: 1, maxLength: 200 },
            taxId: { type: 'string', minLength: 1, maxLength: 32 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { clabe: string; accountHolderName: string; taxId: string };
      if (!validateClabe(body.clabe)) {
        return reply.status(400).send({ code: 'invalid-clabe', message: 'La CLABE no es valida (digito de control)' });
      }
      try {
        const userId = requireUserId(request);
        await registerWalletAccount(userId);
        const pa = await registerBankAccount(userId, body);
        return { paymentAccountId: pa.id, status: pa.status };
      } catch (err) { return sendEtherfuseError(reply, err); }
    },
  );

  /**
   * POST /defi/bank-withdraw/quote
   * Cotiza un retiro. La cotizacion vence a los 2 minutos.
   */
  app.post(
    '/defi/bank-withdraw/quote',
    {
      preHandler: [authMiddleware, bankWithdrawRateLimit],
      schema: {
        body: {
          type: 'object',
          required: ['asset', 'amount'],
          properties: {
            asset: { type: 'string', enum: ['USDC'] },
            amount: { type: 'string', pattern: '^[0-9]+(\\.[0-9]{1,7})?$' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        return await createWithdrawQuote(requireUserId(request), request.body as { asset: 'USDC'; amount: string });
      } catch (err) { return sendEtherfuseError(reply, err); }
    },
  );

  /**
   * POST /defi/bank-withdraw/order
   * Convierte un quote en una orden. Devuelve las instrucciones de pago (la
   * direccion a la que la app debe mandar los USDC) y, si viene,
   * preparedTransaction para que la app la revise y la firme.
   */
  app.post(
    '/defi/bank-withdraw/order',
    {
      preHandler: [authMiddleware, bankWithdrawRateLimit],
      schema: {
        body: {
          type: 'object',
          required: ['quoteId'],
          properties: { quoteId: { type: 'string', format: 'uuid' } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        return await confirmWithdrawOrder(requireUserId(request), (request.body as { quoteId: string }).quoteId);
      } catch (err) { return sendEtherfuseError(reply, err); }
    },
  );

  /**
   * GET /defi/bank-withdraw/orders
   * Los ultimos 50 retiros del usuario (de la base; puede estar atrasado
   * respecto a Etherfuse hasta que llegue el webhook).
   */
  app.get(
    '/defi/bank-withdraw/orders',
    { preHandler: [authMiddleware, bankWithdrawRateLimit] },
    async (request, reply) => {
      try {
        const orders = await listUserWithdrawOrders(requireUserId(request));
        return { orders };
      } catch (err) { return sendEtherfuseError(reply, err); }
    },
  );
}
