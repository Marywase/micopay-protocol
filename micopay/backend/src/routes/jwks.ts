import type { FastifyInstance } from 'fastify';
import { getPublicJwks } from '../lib/etherfuseJwt.js';

/**
 * JWKS publico para que Etherfuse (y cualquier otro) verifique los JWT que
 * firmamos con nuestra llave privada. Se registra en el panel de Etherfuse como
 * JWKS URL = https://api.micopay.app/.well-known/jwks.json.
 */
export async function jwksRoutes(app: FastifyInstance) {
  app.get('/.well-known/jwks.json', async (_req, reply) => {
    try {
      const jwks = getPublicJwks();
      reply
        .status(200)
        .header('Content-Type', 'application/json')
        .header('Cache-Control', 'public, max-age=3600')
        .send(jwks);
    } catch (err) {
      app.log.error({ err }, 'jwks: no se pudo servir');
      reply.status(503).send({ error: 'jwks not configured' });
    }
  });
}
