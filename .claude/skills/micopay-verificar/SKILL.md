---
name: micopay-verificar
description: Verificacion de MicoPay antes de subir un PR o hacer push. Revisa archivos ajenos en los commits, build y tests de micopay/frontend y micopay/backend, y clasifica cada test que falla como ROTO (lo rompiste), PREEXISTENTE (ya fallaba en main), INTERMITENTE o REQUIERE PG. Usala antes de cada push o PR en este repo, y cuando alguien pregunte si un cambio esta listo para subir.
---

# micopay-verificar

Corre el script y lee el resultado. No sustituyas el script por comandos sueltos:
la clasificacion de fallos es lo que evita culpar al PR de algo que ya estaba roto
o, peor, dejar pasar algo que si rompio.

```bash
.claude/skills/micopay-verificar/verify.sh               # contra origin/main
.claude/skills/micopay-verificar/verify.sh --all-backend # todos los test:* del backend
.claude/skills/micopay-verificar/verify.sh --keep-going  # no parar en el primer bloque que falla
```

Tarda de 1 a 5 minutos. Los logs quedan en `.git/micopay-verify/`.

## Que revisa

| Bloque | Que hace |
|---|---|
| Rama | Que no estes en `main` y cuantos commits vas detras de `origin/main` |
| Archivos | Lista lo que va en la rama. FALLA si hay `gradlew`, `.apk`, `.idsig`, `.docx`, `Zone.Identifier`, `fix.patch`, `opencode.json`, `.mimocode/`, `.env` o `.claude/settings.local.json` |
| Dependencias | `npm ci` si `package-lock.json` cambio desde la ultima instalacion |
| Frontend | `npm run build` y `vitest run`; repite los que fallan y compara con `main` |
| Backend | `npm run build` y los `test:*` relacionados con los archivos que cambiaste |
| SQL | Cada `.up.sql` nuevo tiene su `.down.sql`; avisa si se toco `init.sql` |

## Como leer cada resultado

- **FALLO / ROTO**: hay que arreglarlo antes de subir. Para `iconSubset.test.ts`
  el script imprime el arreglo exacto.
- **AVISO / PREEXISTENTE** o **INTERMITENTE**: no es del PR. No lo arregles dentro
  del PR (sale del scope); menciónalo en la descripcion del PR, como pide el resumen.
- **AVISO / REQUIERE PG**: ese test necesita PostgreSQL. Si el cambio toca esa
  parte, levantalo (`docker compose up -d postgres`) y vuelve a correr; si no,
  dilo en el PR.
- **cambios sin commit**: son del arbol de trabajo de la persona, no del PR. No
  los incluyas ni los descartes.

## Despues del push

El CI **no bloquea por tests**: el paso de tests del frontend es "informativo" y
el del backend solo compila. Un check verde no significa que los tests pasen.
Confirmalo en el log:

```bash
gh pr checks <n>
gh run view <run-id> --log | grep -E "Test Files|Tests |FAIL"
```

## Al reportar

Di exactamente lo que salio: cuantos tests, cuales fallaron y en que categoria.
Nunca digas "todo pasa" si hubo PREEXISTENTE, INTERMITENTE o REQUIERE PG.
