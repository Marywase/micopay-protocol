# Plan · Retirar a banco (SPEI) · 2026-10-12

Botón "Retirar a mi banco (SPEI)": el usuario cambia lo que tiene en la wallet a
pesos en su CLABE usando el offramp de Etherfuse en modo anchor.

## Hechos verificados (2026-10-12)

- Cotizaciones de offramp en el sandbox de Etherfuse (100 unidades → MXN):
  CETES 114.37, USDC 1,820.72 (`requiresSwap: true`), MEXe 99.80.
  **XLM y `native` dan 400.** La API de swap tampoco acepta XLM ("non-stable").
- MEXe es el peso digital de Etherfuse: "principal token" de CETES, 1 MEXe = 1 MXN
  (docs + `GET /lookup/tokens/cost/mexe` = 1.000000). "MXNe" no aparece en la
  documentación ni en el `stellar.toml`; el issuer de MXNe en `.env.testnet` no es
  una cuenta válida.
- Modo anchor: Etherfuse da `withdrawAnchorAccount` + `withdrawMemo` (hash) y
  nosotros armamos un `payment`. Los docs no dicen si reconocen un `path_payment`.
  Un pago sin memo o con memo desconocido se reembolsa.
- Offramp y swap fallan en silencio si la wallet no existe, no tiene XLM o le
  falta la trustline del activo que vende.
- DEX: mainnet XLM→USDC (Circle) con ruta directa, XLM→CETES con ruta,
  XLM→MEX(e) sin rutas. Testnet: XLM→USDC y XLM→CETES del sandbox con rutas.

## Decisiones

1. **Activo puente: USDC.**
2. **Rutas:** USDC, CETES y MEXe van directo a Etherfuse. XLM pasa por el DEX a USDC.
   MXNe sale del flujo (se reemplaza por MEXe en un cambio aparte).
3. **Una transacción atómica**, firmada en el teléfono:
   1. `changeTrust` a USDC, solo si falta.
   2. `pathPaymentStrictReceive` del usuario a sí mismo: recibe exactamente el USDC
      cotizado, gasta como máximo el XLM que escribió.
   3. `payment` del USDC a `withdrawAnchorAccount` con `Memo.hash`.
   El path payment directo a Etherfuse queda como pregunta para ellos.
4. **Cotización:** el usuario escribe cuánto vende. Para XLM, el backend consulta
   `/paths/strict-send` en Horizon, descuenta 1% de margen y cotiza ese USDC con
   Etherfuse. `sendMax` = el XLM escrito.
5. **Validación previa** (patrón de `receiverReadiness`): cuenta existente, saldo
   del activo, XLM para comisiones y, si vende XLM, reserva mínima + 1 XLM libre
   (+0.5 si hay que abrir la trustline de USDC). Hay ruta en el DEX.
6. **Identificadores** siempre de `GET /ramp/assets`, nunca del `.env`.
7. **Estado de la orden** guardado en `ramp_orders`; el webhook `order_updated`
   lo actualiza releyendo la orden en Etherfuse.
8. **Pantalla** `/retirar-banco` con botón en Home, detrás de `VITE_ENABLE_SPEI_RAMP`.
9. **Comisión de partner** configurable (`ETHERFUSE_PARTNER_FEE_BPS`), 0 por defecto.

## Paquetes de trabajo

- **WP1 · Backend** (este PR): `rampWithdraw.service.ts` (activos, ruta DEX,
  validación de la cuenta), `/defi/ramp/quote` con `asset`, tabla `ramp_quotes`,
  estado en `ramp_orders`, webhook que actualiza el estado, `GET /defi/ramp/orders`.
  Compatible con `CETESScreen` (sin `asset` sigue siendo CETES).
- **WP2 · Firma en la app:** `stellarRamp.ts` arma la transacción de 1–3 operaciones
  a partir de las instrucciones del backend.
- **WP3 · Pantalla y botón:** activo → monto → resumen → firmar → seguimiento.
- **WP4 · MXNe → MEXe** en el catálogo de activos de la app.
- **WP5 · Precios:** `/lookup/bonds/cost` está deprecado; pasar a `/lookup/tokens/cost`.

## Pendiente fuera del código

- KYC de Etherfuse completo en sandbox para probar hasta `funded`.
- Preguntas a Etherfuse: ¿reconocen un `path_payment` en modo anchor? ¿la CLABE
  puede ser de otra persona? ¿plazo para pagar una orden anchor?
- Llave de producción y aprobación de la organización.
