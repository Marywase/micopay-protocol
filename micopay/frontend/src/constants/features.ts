/**
 * Que funciones estan abiertas en este build. Un solo sitio: Explorar, las
 * rutas, la barra inferior y el regreso del KYC leen de aqui.
 *
 * CETES y Blend se muestran como "Proximamente" cuando estan apagados, en vez
 * de esconderse (decision de Eric, 2026-10-19, rumbo a Play Store): la persona
 * sabe que vienen, pero no puede entrar a una pantalla que todavia no mueve su
 * dinero de verdad.
 *
 *   VITE_ENABLE_DEFI_TRADING=true  compra/venta de CETES y Blend (builds internos)
 *   VITE_ENABLE_SPEI_RAMP=true     rampa SPEI de Etherfuse (necesita su KYC)
 *
 * El build de Play (`npm run build:play`, `.env.play`) apaga las dos.
 */
export const DEFI_TRADING_ENABLED = import.meta.env.VITE_ENABLE_DEFI_TRADING === 'true';
export const SPEI_RAMP_ENABLED = import.meta.env.VITE_ENABLE_SPEI_RAMP === 'true';
/**
 * VITE_ENABLE_BANK_WITHDRAW: boton "Retirar a banco" (SPEI via Etherfuse v2).
 * Prendido en el APK de testnet, apagado en Play hasta tener la organizacion
 * de produccion aprobada y la cuenta de Play de organizacion.
 */
export const BANK_WITHDRAW_ENABLED = import.meta.env.VITE_ENABLE_BANK_WITHDRAW === 'true';

/** CETES abre si hay algo que hacer ahi: comprar desde la billetera o por SPEI. */
export const CETES_AVAILABLE = DEFI_TRADING_ENABLED || SPEI_RAMP_ENABLED;
/** Blend hoy es solo simulacion: abre unicamente con DeFi encendido. */
export const BLEND_AVAILABLE = DEFI_TRADING_ENABLED;
