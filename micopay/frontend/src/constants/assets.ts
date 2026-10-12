// Central registry of the assets the wallet can hold / send / receive.
// Issuers come from env so testnet/mainnet swap without code changes.

/* Sin campo `color`: en el sistema "Mercado / Rótulo" el color significa
   digital-vs-efectivo, no "qué token". El activo se distingue por su CÓDIGO.
   Ver §4.3 y D-5 de docs/PLAN_REDISENO_VISUAL_APK_2026-08.md. */
export interface AssetDef {
  /** Asset code as it appears on-chain (e.g. 'XLM', 'MEXe', 'USDC', 'CETES'). */
  code: string;
  /** Human label shown in the UI. */
  label: string;
  /** True for the native Lumens asset. */
  native: boolean;
  /** Classic-asset issuer (undefined for native). */
  issuer?: string;
  /** Display decimals. */
  decimals: number;
  /** Short note shown on the receive screen. */
  note?: string;
}

// MEXe es el peso digital de Etherfuse (1 MEXe = 1 MXN) y se retira a SPEI.
// Sustituye a "MXNe": ese token es de Brale, Etherfuse no lo recibe, y el
// issuer que teniamos en testnet ni siquiera era una cuenta valida.
const MEXE_ISSUER = import.meta.env.VITE_MEXE_ISSUER as string | undefined;
const USDC_ISSUER = import.meta.env.VITE_USDC_ISSUER as string | undefined;
const CETES_ISSUER = import.meta.env.VITE_CETES_ISSUER as string | undefined;

export const ASSETS: AssetDef[] = [
  { code: 'MEXe', label: 'Peso Digital', native: false, issuer: MEXE_ISSUER, decimals: 2, note: 'Peso digital de Etherfuse, 1 MEXe = 1 peso' },
  { code: 'USDC', label: 'USD Coin', native: false, issuer: USDC_ISSUER, decimals: 2, note: 'Dólar digital' },
  { code: 'CETES', label: 'CETES tokenizados', native: false, issuer: CETES_ISSUER, decimals: 2, note: 'Bono del Gobierno de México' },
  { code: 'XLM', label: 'Stellar Lumens', native: true, decimals: 4, note: 'Token de red (gas)' },
];

export function getAsset(code: string): AssetDef | undefined {
  return ASSETS.find((a) => a.code.toLowerCase() === code.toLowerCase());
}

/** Assets that are actually configured (have an issuer, or are native). */
export const SENDABLE_ASSETS: AssetDef[] = ASSETS.filter((a) => a.native || !!a.issuer);
