# Skills de Claude Code para MicoPay

Las skills son instrucciones que Claude Code carga para trabajar en este repo con
las reglas de la casa. Viven aqui para que todo el equipo, y los contribuidores
de Wave, usen las mismas.

| Skill | Que hace | Como se usa |
|---|---|---|
| [`micopay-reglas`](micopay-reglas/SKILL.md) | Manual del codigo: seguridad, i18n, iconos, errores, estilo de commits y tests | Se carga sola al tocar `micopay/` |
| [`micopay-verificar`](micopay-verificar/SKILL.md) | Revisa la rama antes de subir y clasifica cada fallo | `/micopay-verificar` o directo: `.claude/skills/micopay-verificar/verify.sh` |
| [`micopay-resolver-issue`](micopay-resolver-issue/SKILL.md) | Lleva una issue hasta el PR: rama, codigo, tests, verificacion y PR | `/micopay-resolver-issue 448` |
| [`stellar-dev`](stellar-dev/SKILL.md) | Guia general de Stellar y Soroban (externa, `skills-lock.json`) | Se carga sola al trabajar con Stellar |

## `verify.sh` sin Claude

El script sirve solo, en Linux, macOS o WSL (necesita `bash`, `git`, `node`, `npm`):

```bash
.claude/skills/micopay-verificar/verify.sh               # contra origin/main
.claude/skills/micopay-verificar/verify.sh --all-backend # todos los test:* del backend
.claude/skills/micopay-verificar/verify.sh --keep-going  # no parar en el primer bloque que falla
```

Que significa cada resultado:

| Resultado | Significa | Bloquea |
|---|---|---|
| `FALLO` archivos | En los commits hay `gradlew`, `.apk`, `.idsig`, `.docx`, `.env`… | Si |
| `ROTO` | El test falla en tu rama y pasa en `main`, o es un test tuyo | Si |
| `PREEXISTENTE` | Tambien falla en `main`: no es tuyo, mencionalo en el PR | No |
| `INTERMITENTE` | Fallo una vez y paso al repetir | No |
| `REQUIERE PG` | El test necesita PostgreSQL (`docker compose up -d postgres`) | No |

Por que existe: en CI el paso de tests del frontend es informativo y el backend
solo compila, asi que un check verde no garantiza que los tests pasen.

## Cambiar una skill

Edita el `SKILL.md` (o sus archivos de detalle) y sube el cambio por PR, como
cualquier codigo. Si una regla cambia en el repo (un archivo se mueve, un test
nuevo de guardia), actualiza la skill en el mismo PR.
