---
name: micopay-resolver-issue
description: Resuelve una issue de Micopay/micopay-protocol de punta a punta - rama desde origin/main, implementacion dentro del scope, tests, verificacion y PR. Usala cuando pidan resolver, implementar o tomar una issue de MicoPay (por numero, por ID como AUTH-1, o por enlace de GitHub o de Drips Wave).
argument-hint: <numero de issue>
---

# Resolver una issue de MicoPay

Argumento: `$ARGUMENTS` (numero de issue). Si falta, pregunta cual.

Antes de escribir codigo carga la skill **micopay-reglas**. Antes de subir, corre
**micopay-verificar**. Este flujo las une; no las reemplaza.

## 1. Leer la issue completa

```bash
gh issue view <n> --repo Micopay/micopay-protocol --json title,body,labels,assignees,author
```

Extrae y ten a la vista durante todo el trabajo:

- **In-scope files**: los unicos archivos que deberias tocar.
- **Out-of-scope**: lo que NO se hace aunque parezca relacionado.
- **Acceptance criteria**: cada casilla se va a cumplir y a probar, una por una.
- **Test notes** y **Dependency notes**.

Para. **Pregunta antes de seguir** si:
- La issue dice que se espere una decision del maintainer (p. ej. "Do not
  implement until the maintainer approves").
- Esta asignada a otra persona.
- Tiene la etiqueta `wave:blocked` o `wave:needs-product`.

## 2. Partir de main actualizado

El codigo local suele estar atrasado: las referencias de la issue (`archivo:linea`)
estan escritas contra `origin/main`, no contra tu copia.

```bash
git fetch origin
git switch -c feat/<id-en-minusculas>-<tema-corto> origin/main   # p. ej. feat/auth-1-login-presence
```

Si hay cambios sin commit en el arbol (es comun: `gradlew`, `.docx`, `.apk.idsig`),
**no los toques**: viajan con el cambio de rama y nunca entran al commit.

Verifica que cada `archivo:linea` de la issue exista y diga lo que la issue
dice. Si no coincide, dilo antes de implementar.

## 3. Implementar

- Reutiliza lo que ya existe: la issue casi siempre lo nombra
  (`requireUserPresence`, `ApiError`, `createRateLimiter`…). No agregues
  dependencias si la issue dice que no.
- Respeta el texto exacto que pida la issue (mensajes, prompts, nombres).
- Un archivo fuera de In-scope solo si un criterio de aceptacion no se cumple
  sin el. Anotalo para explicarlo en el PR.

## 4. Tests

- Un test por criterio de aceptacion, incluido el camino negativo (que pasa si
  la persona cancela, si el servidor dice que no, si no hay llave).
- **Inyecta la regresion**: deshaz a mano tu arreglo (o rompe la condicion
  clave) y corre los tests nuevos. Deben fallar. Anota cuantos fallan: va en el
  PR. Restaura el arreglo despues.

## 5. Verificar

Corre la skill **micopay-verificar**. No sigas con ROTO o FALLO. Los
PREEXISTENTE, INTERMITENTE y REQUIERE PG se mencionan en el PR, no se arreglan
en este PR.

## 6. Commit

Agrega **solo** tus archivos por nombre (nunca `git add -A` ni `git add .`):

```bash
git add <archivo1> <archivo2> ...
git commit
```

Mensaje: `tipo(area): descripcion en espanol (ID)`, cuerpo con el porque, la
lista de cambios y `Closes #<n>`.

## 7. PR

Pregunta antes de hacer push y de abrir el PR si la persona no lo pidio
explicitamente.

```bash
git push -u origin <rama>
gh pr create --repo Micopay/micopay-protocol --base main --title "<igual que el commit>" --body-file <archivo>
```

Escribe el PR en el idioma de la issue. Estructura:

```markdown
Closes #<n>

## What changed / Que cambia
El problema en una frase y cada cambio, con archivo y funcion.

## Out of scope on purpose / Lo que no cambia a proposito
Lo que la issue excluye y como se respeto.

## Files outside In-scope
Solo si hay. Que archivo y que criterio lo exige.

## Tests
- Cada criterio -> el test que lo cubre.
- Regresion inyectada: <que se rompio> -> <N> de <M> tests fallan.
- build / test: resultado exacto. Fallos PREEXISTENTE / INTERMITENTE, si hubo.

## Manual check (pending)
Pasos en el telefono, si la issue los pide. Di que estan pendientes; no los
marques como hechos.
```

## 8. Despues del push

- `gh pr checks <n>`, y como el CI no bloquea por tests, **lee el log** (ver
  micopay-verificar).
- Reporta: enlace del PR, que cambio, resultado real de las pruebas, y lo que
  queda pendiente (normalmente la prueba manual en Android).
