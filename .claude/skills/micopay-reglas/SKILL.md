---
name: micopay-reglas
description: Reglas y convenciones del codigo de MicoPay (app Capacitor + React en micopay/frontend, API Fastify en micopay/backend, migraciones en micopay/sql). Cargala antes de escribir o modificar codigo, tests, commits o comentarios en micopay/, sobre todo si el cambio toca dinero, la llave Stellar, sesion, textos visibles, iconos o la base de datos.
---

# Reglas de MicoPay

MicoPay mueve dinero real de personas en Mexico (efectivo <-> cripto en Stellar).
Casi todas las reglas de abajo existen porque alguien ya rompio eso una vez; el
porque esta en el encabezado de los archivos y tests citados. Leelo antes de
cambiar algo cercano.

## Mapa

| Ruta | Que es |
|---|---|
| `micopay/frontend` | App Android (Capacitor 8) + PWA. React, Vite, Vitest, i18next |
| `micopay/backend` | API Fastify + PostgreSQL. Tests como scripts `node --import tsx` |
| `micopay/sql` | `init.sql` + `migrations/<timestamp>_<nombre>.{up,down}.sql` |
| `contracts/`, `micopay/contracts` | Contratos Soroban (escrow, HTLC). Ver skill `stellar-dev` |
| `apps/`, `packages/` | Agente, bot de Telegram, API x402, SDK. Fuera del flujo diario |

Detalle por area: [frontend.md](frontend.md) y [backend.md](backend.md).

## Las reglas que no se negocian

1. **Toda accion que mueve dinero o revela algo sensible pasa por
   `requireUserPresence`** (`frontend/src/lib/userPresence.ts`). Ya la usan
   `keystore.ts`, `payment.ts`, `stellarRamp.ts`, `Login` y `Register`. Para un
   caso nuevo agrega un `PresenceReason` con su texto concreto; nunca uno generico.
2. **La llave secreta solo se toca desde `lib/keystore.ts`**, y se guarda con
   `services/secureStorage.ts` (`readJSON`/`writeJSON`/`removeKey`). Nunca en
   `localStorage`, nunca en un log, nunca por HTTP. Al mostrarla, `withSecureScreen`
   (`lib/secureScreen.ts`).
3. **No dejar a nadie fuera de su propio dinero.** En web, o sin bloqueo de
   pantalla, la compuerta de presencia deja pasar. No cambies esa politica sin que
   la issue lo pida.
4. **Errores por codigo, no por texto**: ramifica con `e instanceof ApiError &&
   e.code === 'X'` (`utils/apiError.ts`). Comparar `e.message` ya fallo antes.
5. **Scope de la issue**: toca solo los archivos de *In-scope files*. Si un
   criterio de aceptacion no se cumple sin salir de ahi, hazlo y explicalo en el PR.
6. **Si la issue dice que esperes una decision del maintainer, para y pregunta.**

## Estilo

- **Comentarios en espanol** que explican el *porque*, no el *que*. Para un
  hueco de seguridad o un bug, el patron de la casa es un encabezado con
  `EL HUECO` / `LO QUE ESTO ES, Y LO QUE NO` (ver `lib/userPresence.ts`).
- Nombres de codigo en ingles (`handleLogin`, `requireUserPresence`).
- **Commits**: `tipo(area): descripcion en espanol (ID)`. Ej:
  `feat(cancel): politica de cancelacion por flujo y actor (CASH-2)`.
  Tipos: `feat`, `fix`, `chore`, `docs`, `test`. Cuerpo con el porque y
  `Closes #N`.
- Las issues usan IDs con prefijo por area: `AUTH-`, `CASH-`, `UX-`, `API-`,
  `I18N-`, `DEV-`, `TEST-`, `APK-`, `RED-`, `SEC-`.

## Tests

Cada comportamiento nuevo lleva un test, y el test abre con un comentario que
dice que hueco fija. Antes de cerrar, **inyecta la regresion**: vuelve a meter el
bug a mano y confirma que algun test falla. Si ninguno falla, el test no sirve.
Patrones concretos en [frontend.md](frontend.md#tests) y
[backend.md](backend.md#tests).
