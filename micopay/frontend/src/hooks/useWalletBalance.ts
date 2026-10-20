import { useState, useEffect, useCallback } from 'react';
import { getPublicKey } from '../lib/keystore';
import { getUsdcMxnRate } from '../services/api';

const HORIZON_URL = import.meta.env.VITE_HORIZON_URL || 'https://horizon-testnet.stellar.org';

export interface TokenBalance {
  code: string;
  balance: number;
  issuer?: string;
}

export interface UseWalletBalanceResult {
  xlmBalance: string | null;    // XLM formatted (legacy)
  stellarAddress: string | null;
  loading: boolean;
  error: any;
  refresh: () => void;
  tokens: TokenBalance[];       // all assets
  usdMxnRate: number | null;
}

// Peso-pegged assets: treat 1 token = 1 MXN
const MXN_PEGGED = new Set(['CETES', 'GTOKEN', 'MXN']);

/**
 * El FX viene del backend (multi-fuente + caché), no de CoinGecko desde el
 * dispositivo: llamarlo client-side comparte el rate limit por IP y obliga a
 * inventar un fallback. Si no hay cotización, `usdMxnRate` queda en null y la
 * UI muestra "—" (docs/AUDIT_MOBILE_MAINNET.md §3 y §5).
 */

export function useWalletBalance(): UseWalletBalanceResult {
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [stellarAddress, setStellarAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<any>(null);
  const [usdMxnRate, setUsdMxnRate] = useState<number | null>(null);
  const [trigger, setTrigger] = useState<number>(0);

  const refresh = useCallback(() => setTrigger((p) => p + 1), []);

  useEffect(() => {
    getUsdcMxnRate()
      .then(({ rate }) => setUsdMxnRate(rate))
      .catch(() => setUsdMxnRate(null));
  }, []);

  useEffect(() => {
    let active = true;

    async function fetchBalance() {
      try {
        setLoading(true);
        setError(null);

        const address = await getPublicKey();
        if (!active) return;

        if (!address) {
          setStellarAddress(null);
          setTokens([]);
          setLoading(false);
          return;
        }

        setStellarAddress(address);

        const res = await fetch(`${HORIZON_URL}/accounts/${address}`);
        if (!active) return;

        if (res.status === 404) {
          setTokens([{ code: 'XLM', balance: 0 }]);
        } else if (!res.ok) {
          throw new Error(`Horizon returned status ${res.status}`);
        } else {
          const data = await res.json();
          if (!active) return;

          const parsed: TokenBalance[] = (data.balances ?? []).map((b: any) => ({
            code: b.asset_type === 'native' ? 'XLM' : b.asset_code,
            balance: parseFloat(b.balance ?? '0'),
            issuer: b.asset_issuer,
          }));
          setTokens(parsed);
        }
      } catch (err) {
        if (active) {
          setError(err);
          setTokens([]);
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    fetchBalance();
    return () => { active = false; };
  }, [trigger]);

  // Legacy fields derived from tokens
  const xlmToken = tokens.find((t) => t.code === 'XLM');

  const xlmBalance = xlmToken != null
    ? xlmToken.balance.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : null;

  return { xlmBalance, stellarAddress, loading, error, refresh, tokens, usdMxnRate };
}
