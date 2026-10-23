# Frontend (`micopay/frontend`)

```bash
npm run build          # tsc + vite build (bloqueante en CI)
npm run test           # vitest run (en CI NO bloquea: revisa el log)
npm run build:play     # build de Play Store (.env.play)
```

## Donde vive cada cosa

| Necesitas | Usa |
|---|---|
| Llamar al backend | `services/api.ts` (nunca `fetch` suelto) |
| Guardar algo | `services/secureStorage.ts`: `readJSON`, `writeJSON`, `removeKey` |
| Firmar o leer la llave | `lib/keystore.ts` (ya pide presencia antes de firmar) |
| Pedir huella/PIN | `lib/userPresence.ts`: `requireUserPresence(reason, force?)` |
| Mostrar la llave | `lib/secureScreen.ts`: `withSecureScreen(fn)` |
| Errores del backend | `utils/apiError.ts`: `ApiError` con `.code` |
| Reportar un error | `utils/reportError.ts` (ya redacta tokens y semillas) |
| Sesion | clave `micopay_user` en secureStorage; `handleAccountDeleted` la borra |

`localStorage` solo se usa para preferencias no sensibles (idioma). Nada mas.

## Huella o PIN (`requireUserPresence`)

- Un `PresenceReason` por accion, con texto que dice **que** se autoriza.
- `force = true` cuando una confirmacion reciente no debe valer (entrar a la
  cuenta, ver la llave). Sin `force` hay 60 s de gracia para firmas encadenadas.
- Atrapa `PresenceDeniedError`: no sigas, deja a la persona en la pantalla con
  un mensaje claro y el boton habilitado para reintentar.
- Si agregas un reason, el literal (p. ej. `'login'`) puede chocar con un icono:
  mira la seccion de iconos.

## Textos (i18n)

- Texto visible nuevo -> `useTranslation()` y la clave en **ambos**
  `src/i18n/es.json` y `src/i18n/en.json`. El idioma por defecto es `es`.
- Hay pantallas que todavia tienen texto fijo (`Login`, `Welcome`, `Terms`,
  `Privacy`, `ClaimQR`). No las migres si la issue no lo pide: es otra issue.

## Iconos (Material Symbols)

Los iconos se escriben como texto y la fuente empaquetada los dibuja. Si el icono
no esta en el subconjunto, la app pinta la palabra cruda.

- `iconSubset.test.ts` toma **cualquier** literal en minusculas del codigo que sea
  nombre valido de Material Symbols (`'login'`, `'lock'`, `'home'`…), aunque no
  sea un icono.
- Si falla: `python scripts/build-icon-subset.py` (requiere
  `pip install fonttools brotli`) y luego **revierte**
  `scripts/material-symbols-names.txt` (el script lo reescribe con la lista mas
  nueva de Google). En el PR quedan `public/fonts/ICONOS.txt` y
  `public/fonts/material-symbols-subset.woff2`; explicalo, porque nunca estan en
  el In-scope de la issue.

## Accesibilidad

Todo `<button>` necesita nombre: texto visible, `aria-label` o un `sr-only`.
`accessibleNames.test.ts` lo exige.

## Builds y entornos

`.env.testnet`, `.env.play`, `.env.mainnet`… `playBuild.test.ts` exige que
`.env.play` sea `.env.testnet` con CETES y Blend apagados: si cambias uno,
cambia el otro. `VITE_DEMO_MODE` nunca va encendido en un build de release.

## Tests

Vitest + jsdom + Testing Library. Archivos en `src/__tests__/<tema>.test.tsx`.

```tsx
/**
 * AUTH-1 · Que hueco fija este archivo, en una o dos frases.
 *
 * Lo que se fija aqui:
 *   1. ...
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../i18n';

const mockGetAuthToken = vi.fn();
vi.mock('../services/api', () => ({
  getAuthToken: (...a: unknown[]) => mockGetAuthToken(...a),
}));
// Para conservar clases reales (p. ej. PresenceDeniedError) y mockear una funcion:
vi.mock('../lib/userPresence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/userPresence')>()),
  requireUserPresence: (...a: unknown[]) => mockPresence(...a),
}));

beforeEach(async () => {
  await i18n.changeLanguage('es');
  vi.clearAllMocks();
});
```

- Paginas con navegacion: envuelvelas en `<MemoryRouter>`.
- Para probar el orden (pregunta antes de pedir token):
  `mock.invocationCallOrder[0]`.
- `<input type="password">` no tiene rol `textbox`: buscalo por placeholder.
- Para modulos con estado interno (`userPresence`): `vi.resetModules()` y
  `import()` dinamico en cada test.
- Hay tests intermitentes bajo carga (`onboarding`, `historyTransfers`): si
  fallan solo en la suite completa, `micopay-verificar` lo distingue.
