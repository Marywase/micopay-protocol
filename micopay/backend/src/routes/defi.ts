import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { AppError, UpstreamError, ValidationError } from '../utils/errors.js';
import { getRampAssets } from '../services/etherfuse.service.js';
import { CircuitOpenError, UpstreamTimeoutError } from '../lib/circuitBreaker.js';
import { authMiddleware } from '../middleware/auth.middleware.js';

const CETES_APY = 5.6;
const HORIZON_TESTNET = 'https://horizon-testnet.stellar.org';
const HORIZON_MAINNET = 'https://horizon.stellar.org';

export async function defiRoutes(app: FastifyInstance) {
  const horizonBase = config.stellarNetwork === 'TESTNET' ? HORIZON_TESTNET : HORIZON_MAINNET;

  // ─── CETES ───────────────────────────────────────────────────────────────

  /**
   * GET /defi/ramp/assets
   * Real Stellar asset identifiers (CODE:ISSUER) supported by the Etherfuse
   * ramp — the CETES issuer differs between sandbox and production, so it
   * must always be read from here instead of hardcoded.
   */
  app.get('/defi/ramp/assets', async (request, reply) => {
    if (!process.env.ETHERFUSE_API_KEY) {
      throw new UpstreamError(
        'ETHERFUSE_NOT_CONFIGURED',
        'El servicio de rampa SPEI no está disponible por el momento.',
        'ETHERFUSE_API_KEY not configured',
        503,
      );
    }

    const { wallet, currency } = request.query as { wallet?: string; currency?: string };
    if (!wallet) {
      throw new ValidationError('wallet querystring es requerido');
    }

    try {
      const assets = await getRampAssets(wallet, currency);
      return assets;
    } catch (err: any) {
      // Etherfuse unavailable or timed out: keep its 503/504 and message.
      if (err instanceof CircuitOpenError || err instanceof UpstreamTimeoutError) throw err;
      throw new UpstreamError(
        'ETHERFUSE_ASSETS_FAILED',
        'No se pudieron obtener los activos disponibles.',
        err.message || 'Failed to fetch Etherfuse ramp assets',
      );
    }
  });

  /**
   * GET /defi/cetes/rate
   * Returns APY, approximate XLM→USDC rate from Horizon paths, and CETES metadata.
   */
  app.get('/defi/cetes/rate', async (request, reply) => {
    try {
      const amountXLM = (request.query as any).amount ?? '100';

      // Query Horizon find-payment-paths for XLM → USDC (proxy for CETES on testnet)
      const usdcIssuerTestnet = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
      const usdcIssuerMainnet = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
      const usdcIssuer = config.stellarNetwork === 'TESTNET' ? usdcIssuerTestnet : usdcIssuerMainnet;

      let xlmPerUsdc = 17.24; // fallback: ~1 USDC = 17.24 XLM

      try {
        const pathUrl = `${horizonBase}/paths/strict-receive?source_assets=native&destination_asset_type=credit_alphanum4&destination_asset_code=USDC&destination_asset_issuer=${usdcIssuer}&destination_amount=1`;
        const res = await fetch(pathUrl, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          const data = await res.json() as { _embedded: { records: { source_amount: string }[] } };
          const records = data._embedded?.records;
          if (records && records.length > 0) {
            xlmPerUsdc = parseFloat(records[0].source_amount);
          }
        }
      } catch {
        // fallback rate
      }

      return {
        apy: CETES_APY,
        xlmPerUsdc,
        // On testnet, USDC acts as CETES proxy. On mainnet, use real CETES issuer.
        cetesIssuer: config.cetesIssuer,
        cetesAssetCode: 'CETES',
        // Approximate price in MXN (1 CETES ≈ 10 MXN for demo)
        cesPriceMxn: 10.0,
        network: config.stellarNetwork,
        note:
          config.stellarNetwork === 'TESTNET'
            ? 'Demo: USDC/XLM rate from Horizon testnet. CETES issuer is mainnet-only.'
            : 'Live CETES tokenizados por Etherfuse',
      };
    } catch (err: any) {
      throw new UpstreamError(
        'DEFI_RATE_FETCH_FAILED',
        'No se pudieron obtener las tasas de DeFi desde Horizon.',
        err.message || 'Failed to fetch DeFi rates'
      );
    }
  });

  /**
   * POST /defi/cetes/buy
   * Body: { amount: string, sourceAsset: "XLM"|"USDC"|"MXNe" }
   * On TESTNET / mockStellar: returns simulated hash.
   * On MAINNET: 501 CETES_BUY_DISABLED_ON_MAINNET.
   */
  app.post('/defi/cetes/buy', {
    preHandler: [authMiddleware],
    schema: {
      body: {
        type: 'object',
        required: ['amount', 'sourceAsset'],
        properties: {
          amount: { type: 'string' },
          sourceAsset: { type: 'string', enum: ['XLM', 'USDC', 'MXNe'] },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { amount, sourceAsset } = request.body as { amount: string; sourceAsset: string };

    // Testnet / mock mode: simulate
    if (config.mockStellar || config.stellarNetwork === 'TESTNET') {
      const hash = `mock_cetes_buy_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const cetesReceived = (parseFloat(amount) * 0.95).toFixed(4);
      return {
        hash,
        status: 'success',
        simulated: true,
        amount,
        sourceAsset,
        cetesReceived,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${hash}`,
        note: 'Demo: CETES compra simulada. En mainnet usa pathPaymentStrictReceive real.',
      };
    }

    // Red principal: la compra todavia no esta disponible. Se responde antes
    // de construir, firmar o enviar cualquier transaccion.
    throw new AppError(
      'CETES_BUY_DISABLED_ON_MAINNET',
      'La compra de CETES todavía no está disponible.',
      'POST /defi/cetes/buy is disabled outside testnet/mock',
      501,
    );
  });

  /**
   * POST /defi/cetes/sell
   * Body: { amount: string, destAsset: "XLM"|"USDC"|"MXNe" }
   */
  app.post('/defi/cetes/sell', {
    preHandler: [authMiddleware],
    schema: {
      body: {
        type: 'object',
        required: ['amount', 'destAsset'],
        properties: {
          amount: { type: 'string' },
          destAsset: { type: 'string', enum: ['XLM', 'USDC', 'MXNe'] },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { amount, destAsset } = request.body as { amount: string; destAsset: string };

    if (config.mockStellar || config.stellarNetwork === 'TESTNET') {
      const hash = `mock_cetes_sell_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      return {
        hash,
        status: 'success',
        simulated: true,
        cetesAmount: amount,
        destAsset,
        destReceived: (parseFloat(amount) * 0.95).toFixed(4),
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${hash}`,
      };
    }

    throw new ValidationError(
      'NOT_IMPLEMENTED',
      'La venta de CETES en mainnet aún no está disponible.',
      'Mainnet CETES sell not yet implemented',
      501
    );
  });

  // ─── BLEND ───────────────────────────────────────────────────────────────

  /**
   * GET /defi/blend/pools
   * Returns Blend pool stats. On testnet uses realistic mock data.
   * In production would query Blend SDK Pool.loadFromRpc.
   */
  app.get('/defi/blend/pools', async (_request, reply) => {
    return {
      pools: [
        {
          id: config.blendPoolId,
          name: 'Pool Principal',
          tvl: 2_450_000,
          assets: [
            { code: 'XLM', supplyApy: 4.2, borrowApy: 7.8, liquidity: 850_000 },
            { code: 'USDC', supplyApy: 6.5, borrowApy: 9.2, liquidity: 1_200_000 },
            { code: 'MXNe', supplyApy: 8.1, borrowApy: 12.5, liquidity: 400_000 },
          ],
        },
      ],
      network: config.stellarNetwork,
      simulated: config.stellarNetwork === 'TESTNET',
    };
  });

  /**
   * POST /defi/blend/supply
   * Body: { amount: string, asset: string, collateral?: boolean }
   * Supply tokens to Blend pool (platform keypair). Demo: simulated on testnet.
   */
  app.post('/defi/blend/supply', {
    preHandler: [authMiddleware],
    schema: {
      body: {
        type: 'object',
        required: ['amount', 'asset'],
        properties: {
          amount: { type: 'string' },
          asset: { type: 'string' },
          collateral: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, _reply) => {
    const { amount, asset, collateral } = request.body as {
      amount: string;
      asset: string;
      collateral?: boolean;
    };

    const hash = `mock_blend_supply_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    return {
      hash,
      status: 'success',
      simulated: true,
      amount,
      asset,
      collateral: collateral ?? false,
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${hash}`,
      note: 'Demo: Blend supply simulado en testnet',
    };
  });

  /**
   * POST /defi/blend/borrow
   * Body: { amount: string, asset: string }
   * Borrow against collateral. Demo: simulated on testnet.
   */
  app.post('/defi/blend/borrow', {
    preHandler: [authMiddleware],
    schema: {
      body: {
        type: 'object',
        required: ['amount', 'asset'],
        properties: {
          amount: { type: 'string' },
          asset: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, _reply) => {
    const { amount, asset } = request.body as { amount: string; asset: string };

    const hash = `mock_blend_borrow_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    return {
      hash,
      status: 'success',
      simulated: true,
      amount,
      asset,
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${hash}`,
      note: 'Demo: Blend préstamo simulado en testnet',
    };
  });
}
