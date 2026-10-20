# Backend (`micopay/backend`)

```bash
npm run build                  # tsc (lo unico que corre en CI)
npm run test:<nombre>          # cada suite es un script propio
npm run migrate                # aplica init.sql + migraciones pendientes
docker compose up -d postgres  # (desde la raiz) para los tests que lo necesitan
```

## Estructura

| Carpeta | Que va |
|---|---|
| `src/routes/` | Rutas Fastify, una funcion `xxxRoutes(app)` por archivo, registrada en `src/index.ts` |
| `src/services/` | Logica de negocio (`trade.service.ts`, `kyc-gate.service.ts`…) |
| `src/middleware/` | `auth`, `deviceAuth`, `rateLimit` (`createRateLimiter`), `requestId` |
| `src/utils/errors.ts` | `AppError(code, userMessage, devMessage, httpStatus)` |
| `src/tests/` | Suites como scripts de Node |

- Errores: lanza `AppError` con un `code` estable en MAYUSCULAS
  (`ADDRESS_ALREADY_REGISTERED`, `USERNAME_TAKEN`). El frontend ramifica por ese
  codigo, asi que cambiarlo rompe la app.
- Rutas autenticadas: `app.addHook('preHandler', authMiddleware)`.
- Rate limit por ruta: `preHandler: [createRateLimiter({ windowMs, max, keyGenerator })]`.
- Identidad: el proveedor sale de `provider_id` y el actor del usuario autenticado,
  nunca de un campo que mande el cliente.

## Base de datos

- Cambios de esquema: **migracion nueva**, nunca editar `init.sql` (las bases ya
  creadas no lo vuelven a aplicar).
- Archivos: `micopay/sql/migrations/<YYYYMMDDHHMMSS>_<nombre>.up.sql` y su
  `.down.sql`. `src/db/migrate.ts` las aplica una vez cada una (tabla
  `schema_migrations`), en orden de nombre.

## Tests

No hay runner: cada archivo es un script con `assert` de Node y una funcion
`main()` que llama a cada caso y sale con codigo 1 si algo lanza.

```ts
/**
 * CASH-2 · Que regla fija este archivo y por que existe.
 */
import { strictEqual, ok } from "assert";

async function testAlgoConcreto() {
  // ...
  strictEqual(actual, esperado, "que deberia pasar");
  console.log("  ✓ descripcion corta");
}

async function main() {
  await testAlgoConcreto();
  console.log("\nAll <ID> tests passed.\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
```

Registralo en `package.json`. Sin PostgreSQL, usa la base en memoria:

```json
"test:mi-tema": "cross-env ALLOW_IN_MEMORY_DB=true MOCK_STELLAR=true SECRET_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 node --import tsx src/tests/miTema.test.ts"
```

- `cross-env` es obligatorio para que corra en Windows.
- Sin `ALLOW_IN_MEMORY_DB=true` el test intenta conectarse a `127.0.0.1:5432`.
- `test:compliance` falla en `main` en algunos meses (supone que el mes actual
  no tiene datos). No es tuyo; `micopay-verificar` lo marca PREEXISTENTE.
