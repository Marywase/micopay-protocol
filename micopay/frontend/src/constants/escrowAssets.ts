/**
 * WP-B del plan de selector de activo (docs/PLAN_SELECTOR_ACTIVO_2026-09-14.md).
 *
 * Los activos con los que se puede RESPALDAR una operacion de efectivo. No es el
 * catalogo de la cartera (`constants/assets.ts`): aquel lista lo que la cartera
 * tiene y envia, incluido CETES; este, lo que un escrow puede bloquear.
 *
 * Solo se habilitan los activos con escrow desplegado (`VITE_ESCROW_ASSETS`).
 * La misma politica vive en el backend (`ESCROW_CONTRACTS`), que rechaza con
 * 422 cualquier otro activo; `enabled` aqui solo decide que se puede elegir en
 * la pantalla, nunca que se pueda operar.
 *
 * LIMITE (D4 del plan): `key` = red + codigo identifica una opcion del catalogo,
 * no un token on-chain. Un activo emitido (p. ej. USDC) necesita ademas issuer o
 * contrato; eso se resuelve cuando se habilite el primero (WP3).
 *
 * Sin campo de color: en Mercado/Rotulo el color significa digital frente a
 * efectivo, no "que token". El activo se distingue por su codigo.
 */

export type EscrowNetwork = 'stellar' | 'xrpl' | 'solana';

export interface EscrowAssetOption {
  /** Clave estable de catalogo: `<network>:<code>`. */
  key: string;
  /** Lo que viaja como `asset_code` en `POST /trades`. */
  code: string;
  network: EscrowNetwork;
  /** Nombre de la red para la UI. */
  networkLabel: string;
  /** Se puede elegir. Solo los activos con escrow desplegado. */
  enabled: boolean;
  /**
   * Decimales para MOSTRAR el equivalente. No es la precision del token: las
   * cifras reales llegan del servidor en unidades minimas.
   */
  displayDecimals: number;
}

/**
 * Los activos con escrow desplegado en la red de este build: las claves de
 * `ESCROW_CONTRACTS` en el backend (una instancia del contrato por activo).
 * `VITE_ESCROW_ASSETS=USDC,XLM`; sin ella, solo `VITE_ESCROW_ASSET_CODE`.
 * El default es `VITE_ESCROW_ASSET_CODE` (el primero de la lista si falta).
 */
const DEPLOYED_ESCROW_ASSETS = (
  import.meta.env.VITE_ESCROW_ASSETS || import.meta.env.VITE_ESCROW_ASSET_CODE || 'XLM'
)
  .split(',')
  .map((c: string) => c.trim().toUpperCase())
  .filter(Boolean);
const DEFAULT_CODE = (import.meta.env.VITE_ESCROW_ASSET_CODE || DEPLOYED_ESCROW_ASSETS[0]).toUpperCase();
const DEPLOYED_ESCROW_ASSET = DEPLOYED_ESCROW_ASSETS.includes(DEFAULT_CODE) ? DEFAULT_CODE : DEPLOYED_ESCROW_ASSETS[0];

function isDeployed(network: EscrowNetwork, code: string): boolean {
  return network === 'stellar' && DEPLOYED_ESCROW_ASSETS.includes(code.toUpperCase());
}

export const ESCROW_ASSET_OPTIONS: readonly EscrowAssetOption[] = (
  [
    { key: 'stellar:XLM', code: 'XLM', network: 'stellar', networkLabel: 'Stellar', displayDecimals: 2 },
    { key: 'stellar:USDC', code: 'USDC', network: 'stellar', networkLabel: 'Stellar', displayDecimals: 2 },
    { key: 'xrpl:XRP', code: 'XRP', network: 'xrpl', networkLabel: 'XRPL', displayDecimals: 2 },
    { key: 'solana:USDC', code: 'USDC', network: 'solana', networkLabel: 'Solana', displayDecimals: 2 },
  ] as const
).map((o) => ({ ...o, enabled: isDeployed(o.network, o.code) }));

/**
 * Las opciones que el selector MUESTRA. XRP y Solana siguen en el catalogo
 * (son la hoja de ruta) pero, por decision de Eric del 2026-10-08, no se
 * ensenan todavia: solo las de Stellar, habilitadas o en "Proximamente".
 */
export const VISIBLE_ESCROW_ASSET_OPTIONS: readonly EscrowAssetOption[] = ESCROW_ASSET_OPTIONS.filter(
  (o) => o.network === 'stellar',
);

export const DEFAULT_ESCROW_ASSET_KEY = `stellar:${DEPLOYED_ESCROW_ASSET}`;

export function getEscrowAssetOption(key: string): EscrowAssetOption | undefined {
  return ESCROW_ASSET_OPTIONS.find((o) => o.key === key);
}

/**
 * La opcion por defecto. El test del catalogo fija que existe y esta
 * habilitada; si alguien la rompe, esto falla fuerte en vez de mandar un
 * activo que el backend rechazaria.
 */
export function getDefaultEscrowAsset(): EscrowAssetOption {
  const option = getEscrowAssetOption(DEFAULT_ESCROW_ASSET_KEY);
  if (!option || !option.enabled) {
    throw new Error(`Default escrow asset ${DEFAULT_ESCROW_ASSET_KEY} is missing or disabled`);
  }
  return option;
}
