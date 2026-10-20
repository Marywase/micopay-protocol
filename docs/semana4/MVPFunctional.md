# Semana 4 — MVP Functional

**Proyecto:** MicoPay — cambiar dinero digital por pesos en efectivo con alguien de tu colonia, sin tener que confiar primero en un desconocido.

**Opción declarada en el Entregable 3:** A. Contrato propio (escrow en Soroban).

**Red:** Stellar testnet.

---

## Evidencia verificable

| Qué | Enlace |
| --- | --- |
| Video (producto funcionando + pitch, ≤3 min) | [Reel en Instagram](https://www.instagram.com/reel/DeTDmYvIn7h/) |
| Backend publicado (testnet) | [api.micopay.app/health](https://api.micopay.app/health) |
| Contrato escrow — instancia USDC | [CDUI253F…YGAX](https://stellar.expert/explorer/testnet/contract/CDUI253FSVVVXUBI4SU3PEQIDNCYWGABGUOCRBIINRCJ4SJ5XVKWYGAX) |
| Contrato escrow — instancia XLM | [CBFDXYUP…UNQWE](https://stellar.expert/explorer/testnet/contract/CBFDXYUPL4Q37JP3JD6JHFG6BQGNG6VOTTGMBTTPE5TYDHOVRY5UNQWE) |
| Transacción `lock` (19 oct 2026) | [dd467f29…2209](https://stellar.expert/explorer/testnet/tx/dd467f29fb3149f7b16c4fa8612b6c98e4db294d68fb0454cd3a1c2770622209) |
| Transacción `release` (19 oct 2026) | [d96b7abd…aee3](https://stellar.expert/explorer/testnet/tx/d96b7abd8dfd863b971dcdf97f082b0685237d6b91d918bbd52e25ce5875aee3) |

**Qué muestran las dos transacciones.** En el `lock`, el vendedor (`GBVQ…BEZ`) bloquea 10 XLM más 0.08 XLM de comisión de plataforma (0.8 %) en el escrow, con un plazo de 120 minutos; el contrato emite el evento `locked` con el identificador del intercambio `1c0c9e5d…3171`. En el `release`, el comprador (`GAWU…Q3ZW`) presenta el secreto del QR y el contrato le transfiere los 10 XLM, manda la comisión a la billetera de plataforma (`GBD4…EGMQ`) y emite `released`. Estas dos llamadas se hicieron directo contra el contrato con la CLI de `stellar`, con cuentas de prueba del equipo, para dejar evidencia pública fechada; la app usa el mismo contrato a través del backend.

### Dónde está el código en este repositorio

| Carpeta | Qué contiene |
| --- | --- |
| [`micopay/contracts/escrow/`](../../micopay/contracts/escrow/) | Contrato `MicopayEscrow` en Rust/Soroban: `initialize`, `lock`, `release`, `refund`, `get_trade`. Pruebas en `src/test.rs` (bloqueo y liberación, devolución tras el plazo, devolución antes del plazo rechazada, secreto equivocado rechazado, secreto reutilizado rechazado). |
| [`micopay/contracts/TESTNET.md`](../../micopay/contracts/TESTNET.md) | IDs canónicos de testnet y cómo redesplegar. |
| [`micopay/backend/`](../../micopay/backend/) | API en Node/TypeScript que conecta el front con el contrato: crea el intercambio, genera y cifra el secreto, arma la transacción sin firmar para que el teléfono la firme, verifica que la firma corresponda a la llamada esperada y la envía a Stellar. También calcula comisiones (plataforma 0.8 % + comisión configurable por comercio), quema el token del QR al escanear y expone el historial. |
| [`micopay/frontend/`](../../micopay/frontend/) | App React + Vite empaquetada con Capacitor para Android. Los contratos de escrow de testnet (uno por activo) están en [`micopay/contracts/TESTNET.md`](../../micopay/contracts/TESTNET.md) y el backend los toma de `ESCROW_CONTRACTS`. |

### Cómo se conecta todo

1. El usuario elige monto y comercio; el backend calcula el desglose y crea el intercambio.
2. El backend arma la transacción `lock` sin firmar; el teléfono la firma con la llave del usuario y el backend la envía. Los fondos quedan en el contrato.
3. Al entregar el efectivo, el comercio escanea el QR de un solo uso; el backend valida el token y llama `release`. El contrato paga al comercio y a la plataforma.
4. Si vence el plazo sin entrega, cualquiera puede llamar `refund` y los fondos regresan al usuario.

---

## Aprendizajes y ajustes priorizados

Lo que más aprendimos esta semana es que la parte difícil no es el contrato, sino lo que lo rodea. El escrow lleva meses estable y sus pruebas pasan; lo que falló en pruebas reales fue la liquidez (el 15 de octubre no había ningún agente con efectivo para $500 MXN cerca) y la claridad del activo: la referencia equivocada del token en testnet ya nos había hecho bloquear XLM pensando que era MXNe. Por eso ordenamos los ajustes así:

1. **Alto impacto, bajo esfuerzo — antes del cierre:** dejar en el repositorio el contrato y el backend junto al front, con evidencia pública en el explorador (hecho en esta entrega), y exigir en el backend el plazo de 120 minutos en cada `lock` firmado (hecho el 19 de octubre).
2. **Alto impacto, esfuerzo medio — antes del cierre:** grabar un intercambio completo con dos teléfonos (usuario y agente) para cubrir las pantallas de confirmación a intercambio completado.
3. **Alto impacto, esfuerzo alto — queda pendiente:** mejorar el respaldo de la llave del usuario, que la investigación marcó como la barrera más fuerte; la decisión fue mantener la llave actual en el MVP y evaluar passkeys después, con pruebas en testnet.
4. **Impacto medio, esfuerzo medio — queda pendiente:** llevar el historial de cada comercio a la red (hoy se calcula en la base de datos) y tomar el tipo de cambio de una fuente en vivo.

## Riesgos y pendientes

**Liquidez de agentes.** El producto solo funciona si hay alguien cerca con efectivo. En testnet tenemos pocos agentes registrados y en la última prueba ninguno podía atender $500 MXN. Sin una red mínima de comercios en una zona, el usuario llega al mapa y no encuentra a nadie. Pendiente: sembrar una zona piloto con agentes reales antes de pruebas con usuarios.

**Respaldo de la llave.** La billetera es *self-custodial*: si el usuario pierde el teléfono sin respaldar su llave secreta, pierde sus fondos. El aviso de respaldo existe, pero la investigación (V-4, V-22) indica que muchas personas no lo completan. Pendiente: medir cuántos lo confirman y probar una alternativa de recuperación.

**Activo en testnet frente a mainnet.** En testnet el USDC es un activo propio de pruebas, no el de Circle, para poder emitirlo a las billeteras de demo. Al pasar a mainnet hay que cambiar la dirección del activo y del contrato en `.env`, y un error en ese cambio bloquea el activo equivocado (ya nos pasó una vez). Pendiente: una verificación en el arranque que compare el token del contrato con el activo configurado.

**Rol en el escaneo del QR.** El modelo de quién escanea y quién libera quedó resuelto en el backend con un token opaco de un solo uso, pero el flujo completo con dos teléfonos todavía no está grabado de punta a punta en esta entrega.

**Dependencia del backend.** El contrato no depende de nosotros para devolver fondos (`refund` lo puede llamar cualquiera tras el plazo), pero la app sí depende del backend para armar transacciones e iniciar sesión. Si el backend cae, el usuario no puede operar aunque sus fondos estén seguros. Pendiente: documentar cómo pedir la devolución sin la app.

**Comisiones y tipo de cambio.** La comisión del comercio se configura y se cobra, pero el tipo de cambio todavía no viene de una fuente en vivo, lo que puede producir diferencias con lo que el usuario espera recibir.

**Cumplimiento.** El KYC con Didit se probó en sandbox, pero no está activado en el flujo de testnet. Antes de operar con dinero real hay que definir límites por nivel de verificación.

## Plan de validación con usuarios

**A quiénes.** Al usuario del Problem Brief: personas en México que reciben dinero digital (remesas, pagos por plataformas, USDC) y necesitan efectivo en mano, en especial quienes no tienen cuenta bancaria o viven lejos de una sucursal. Del otro lado, comercios de barrio (tiendas, farmacias, papelerías) que manejan efectivo y podrían ser agentes. Empezaremos con una zona piloto en Xalapa, donde ya tenemos un agente de prueba registrado.

**Métodos.**

1. **Pruebas asistidas con el producto** (5–8 usuarios y 3–5 comercios): cada persona hace un retiro de punta a punta en testnet con fondos de prueba, mientras la observamos sin ayudar. Registramos dónde se detiene, qué pregunta y cuánto tarda.
2. **Entrevistas cortas después de la prueba** (15 minutos): qué entendió del escrow, si confiaría en hacerlo con dinero real y cuánto pagaría por el servicio frente a su alternativa actual (remesadora, tienda de conveniencia, cambio con conocidos).
3. **Métricas de la app** durante el piloto: intercambios iniciados frente a completados, intercambios devueltos por vencimiento, tiempo desde el `lock` hasta el `release`, y porcentaje de usuarios que confirman el respaldo de su llave.

**Hipótesis y criterio de éxito.**

| Hipótesis | Cómo la medimos | Se cumple si… |
| --- | --- | --- |
| H1. El usuario entiende que su dinero está protegido sin confiar en el comercio. | Entrevista: explica con sus palabras qué pasa si el comercio no entrega. | Al menos 4 de cada 5 lo explican correctamente. |
| H2. El flujo de retiro se puede completar sin ayuda. | Prueba asistida. | Al menos 70 % completa el retiro sin intervención y en menos de 10 minutos. |
| H3. Un comercio de barrio está dispuesto a ser agente con una comisión que él mismo fija. | Entrevista a comercios + alta en la app. | Al menos 3 comercios de la zona piloto se registran y configuran su comisión. |
| H4. El costo total es menor que la alternativa actual del usuario. | Comparar comisión pagada con la que reporta pagar hoy. | La comisión total de MicoPay es menor en la mayoría de los casos. |
| H5. El respaldo de la llave no es una barrera para empezar. | Métrica de confirmación del respaldo. | Al menos 80 % confirma el respaldo antes de su primer intercambio. |

Si H2 o H5 no se cumplen, priorizamos el onboarding y la recuperación de cuenta antes de sumar funciones. Si H3 no se cumple, el problema es de oferta y el siguiente paso es trabajar con comercios antes que con usuarios.

---

## Participación del equipo

| Integrante | Usuario de GitHub | Aporte en esta entrega |
| --- | --- | --- |
| Eric Mota Tejeda | [@ericmt-98](https://github.com/ericmt-98) | Autor del contrato de escrow y del backend. Esta semana: exigió el plazo de 120 min en cada `lock` firmado ([#437](https://github.com/Micopay/micopay-protocol/pull/437)) y activó las notificaciones push de la operación ([#439](https://github.com/Micopay/micopay-protocol/pull/439)), los dos en el backend publicado desde el 19 oct; quitó MXNe de la app ([#442](https://github.com/Micopay/micopay-protocol/pull/442), en revisión) y auditó la app, de donde salieron los issues [#433](https://github.com/Micopay/micopay-protocol/issues/433), [#434](https://github.com/Micopay/micopay-protocol/issues/434) y [#435](https://github.com/Micopay/micopay-protocol/issues/435). |
| Raúl Vallejo | [@vallejoraul08-debug](https://github.com/vallejoraul08-debug) | Ejecutó el `lock` y `release` de evidencia en testnet y redactó esta documentación. |
| Anna Medina | [@annapats](https://github.com/annapats) | Coordinó el plan de 30 días del Instaward en Monday, configuró el correo del dominio (micopay.com.mx en Zoho con SPF, DKIM y DMARC verificados), creó el proyecto de Firebase para las notificaciones push y la cuenta de Play Console, y abrió el contacto con Etherfuse para resolver el KYC con Didit. |
| José Alfredo Román Cruz | [@josealfredo79](https://github.com/josealfredo79) | Analizó la documentación oficial de Etherfuse (API v2) para la rampa SPEI y el KYC, en apoyo al contacto que abrió Anna: comisiones, flujo de retiro a pesos en Stellar, requisitos de KYC/KYB y situación legal ante la CNBV. Encontró que Didit no es KYC reutilizable en Etherfuse (Sumsub sí) y que el backend aún usa la API v1, y dejó 8 preguntas abiertas para Etherfuse. |
