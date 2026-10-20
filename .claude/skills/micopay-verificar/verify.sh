#!/usr/bin/env bash
# Verificacion antes de subir un PR de MicoPay.
#
# Uso: verify.sh [--all-backend] [--keep-going] [base]
#   base           rama contra la que se compara (por defecto origin/main)
#   --all-backend  corre TODOS los test:* del backend, no solo los relacionados
#   --keep-going   no se detiene en el primer bloque que falla
#
# Por que cada fallo se vuelve a correr sobre main
# ------------------------------------------------
# "Fallo un test" no dice nada por si solo. En este repo hay tres clases y
# cada una pide algo distinto:
#   ROTO         falla en tu rama y pasa en main      -> lo rompiste tu
#   PREEXISTENTE falla tambien en main                -> no es tuyo; mencionalo en el PR
#   INTERMITENTE falla una vez y pasa al repetir      -> no es tuyo; mencionalo en el PR
#   REQUIERE PG  el test no encontro PostgreSQL       -> no se pudo verificar aqui
# Solo ROTO hace fallar este script.

set -uo pipefail

BASE="origin/main"
ALL_BACKEND=0
KEEP_GOING=0
for arg in "$@"; do
  case "$arg" in
    --all-backend) ALL_BACKEND=1 ;;
    --keep-going) KEEP_GOING=1 ;;
    *) BASE="$arg" ;;
  esac
done

ROOT=$(git rev-parse --show-toplevel) || exit 2
cd "$ROOT" || exit 2
FE="micopay/frontend"
BE="micopay/backend"
# Los logs quedan en .git/ (nunca se versionan) para poder leerlos al final.
TMP="$(git rev-parse --absolute-git-dir)/micopay-verify"
rm -rf "$TMP"; mkdir -p "$TMP"
WORKTREE=""
cleanup() {
  if [ -n "$WORKTREE" ]; then
    git worktree remove --force "$WORKTREE" >/dev/null 2>&1
    rm -rf "$(dirname "$WORKTREE")"
  fi
  git worktree prune >/dev/null 2>&1
}
trap cleanup EXIT

RED=$'\e[31m'; GRN=$'\e[32m'; YEL=$'\e[33m'; BLD=$'\e[1m'; RST=$'\e[0m'
ok()   { echo "  ${GRN}OK${RST}    $*"; }
warn() { echo "  ${YEL}AVISO${RST} $*"; WARNINGS=$((WARNINGS+1)); }
bad()  { echo "  ${RED}FALLO${RST} $*"; FAILURES=$((FAILURES+1)); }
section() { echo; echo "${BLD}== $*${RST}"; }
stop_if_failed() { [ "$FAILURES" -gt 0 ] && [ "$KEEP_GOING" -eq 0 ] && summary; }
FAILURES=0; WARNINGS=0
# macOS no trae `timeout`; sin el, los tests corren sin limite de tiempo.
TIMEOUT=""
command -v timeout >/dev/null 2>&1 && TIMEOUT="timeout 180"
NOTES=()

summary() {
  section "Resumen"
  for n in "${NOTES[@]}"; do echo "  - $n"; done
  echo "  Logs: $TMP"
  if [ "$FAILURES" -gt 0 ]; then
    echo "${RED}${BLD}NO SUBIR: $FAILURES problema(s) que bloquean.${RST}"; exit 1
  fi
  echo "${GRN}${BLD}Listo para subir.${RST} ($WARNINGS aviso(s) que revisar)"; exit 0
}

# Copia limpia de BASE con los node_modules ya instalados, para volver a
# correr un test que fallo y saber si ya fallaba antes de tus cambios.
# Se llama sin $(...): en un subshell WORKTREE no sobreviviria y la segunda
# llamada fallaria al recrear la misma ruta.
base_worktree() {
  [ -n "$WORKTREE" ] && return 0
  local dir; dir="$(mktemp -d)/base"
  git worktree add --detach "$dir" "$BASE" >/dev/null 2>&1 || return 1
  for pkg in "$FE" "$BE"; do
    [ -d "$pkg/node_modules" ] && ln -s "$ROOT/$pkg/node_modules" "$dir/$pkg/node_modules"
  done
  WORKTREE="$dir"
}

# ── 1. Rama ──────────────────────────────────────────────────────────────
section "Rama"
git fetch -q origin 2>/dev/null || warn "no se pudo hacer git fetch; comparo contra el $BASE local"
BRANCH=$(git branch --show-current)
if [ "$BRANCH" = "main" ]; then
  bad "estas en main. Crea una rama: git switch -c feat/<id>-<tema> $BASE"
fi
BEHIND=$(git rev-list --count HEAD.."$BASE" 2>/dev/null || echo 0)
if [ "$BEHIND" -gt 0 ]; then
  warn "tu rama va $BEHIND commit(s) detras de $BASE. Actualiza: git rebase $BASE"
else
  ok "al dia con $BASE"
fi

# ── 2. Archivos ──────────────────────────────────────────────────────────
section "Archivos"
COMMITTED=$(git diff --name-only "$BASE"...HEAD)
UNCOMMITTED=$(git diff --name-only HEAD)
CHANGED=$(printf '%s\n%s\n' "$COMMITTED" "$UNCOMMITTED" | sed '/^$/d' | sort -u)

if [ -z "$COMMITTED" ]; then
  warn "la rama no tiene commits respecto a $BASE"
else
  echo "  En la rama ($(echo "$COMMITTED" | wc -l) archivos):"
  echo "$COMMITTED" | sed 's/^/    /'
fi

# Archivos que aparecen en el arbol de trabajo de la gente y nunca van en un PR.
STRAY='(^|/)gradlew$|\.idsig$|\.apk$|\.aab$|\.docx$|Zone\.Identifier$|(^|/)fix\.patch$|(^|/)opencode\.json$|^\.mimocode/|(^|/)\.env$|\.claude/settings\.local\.json$'
STRAY_HITS=$(echo "$COMMITTED" | grep -E "$STRAY" || true)
if [ -n "$STRAY_HITS" ]; then
  bad "archivos que no deben ir en el PR:"; echo "$STRAY_HITS" | sed 's/^/        /'
else
  ok "sin archivos ajenos en los commits"
fi
if echo "$COMMITTED" | grep -q 'scripts/material-symbols-names.txt'; then
  warn "material-symbols-names.txt cambio: build-icon-subset.py lo reescribe solo. Si no lo pidio la issue: git checkout $BASE -- $FE/scripts/material-symbols-names.txt"
fi
if [ -n "$UNCOMMITTED" ]; then
  warn "cambios sin commit (no van en el PR):"; echo "$UNCOMMITTED" | sed 's/^/        /'
fi
NOTES+=("Compara la lista de archivos con 'In-scope files' de la issue: lo que este fuera, justificalo en el PR o quitalo.")

# Los archivos ajenos (gradlew, .apk…) no cuentan como cambio de codigo.
CODE=$(echo "$CHANGED" | grep -vE "$STRAY" || true)
FE_TOUCHED=$(echo "$CODE" | grep -q "^$FE/" && echo 1 || echo 0)
BE_TOUCHED=$(echo "$CODE" | grep -q "^$BE/\|^micopay/sql/" && echo 1 || echo 0)
stop_if_failed

# Instala dependencias si el lockfile es mas nuevo que lo instalado. Un
# node_modules viejo produce fallos que parecen tuyos y no lo son.
ensure_deps() {
  local pkg=$1
  # Se compara por contenido, no por fecha: cambiar de rama reescribe el
  # lockfile aunque sea identico.
  local want have marker="$pkg/node_modules/.micopay-lock-hash"
  want=$(git hash-object "$pkg/package-lock.json")
  have=$(cat "$marker" 2>/dev/null || true)
  if [ ! -d "$pkg/node_modules" ] || [ "$want" != "$have" ]; then
    echo "  instalando dependencias de $pkg (npm ci)…"
    (cd "$pkg" && npm ci --no-audit --no-fund >"$TMP/ci.log" 2>&1) || { bad "npm ci fallo en $pkg (ver $TMP/ci.log)"; return 1; }
    echo "$want" > "$marker"
  fi
  ok "dependencias de $pkg al dia"
}

# ── 3. Frontend ──────────────────────────────────────────────────────────
if [ "$FE_TOUCHED" -eq 1 ]; then
  section "Frontend ($FE)"
  ensure_deps "$FE"
  if (cd "$FE" && npm run -s build >"$TMP/fe-build.log" 2>&1); then
    ok "build (tsc + vite)"
  else
    bad "build fallo:"; grep -E "error|Error" "$TMP/fe-build.log" | head -15 | sed 's/^/        /'
  fi

  fe_failed() { grep -oE 'FAIL +src/[^ >]+' "$1" | awk '{print $2}' | sort -u; }
  (cd "$FE" && npx vitest run >"$TMP/fe-test1.log" 2>&1)
  FAILED1=$(fe_failed "$TMP/fe-test1.log")
  if [ -z "$FAILED1" ]; then
    ok "tests: $(grep -E '^ +Tests ' "$TMP/fe-test1.log" | sed 's/\x1b\[[0-9;]*m//g' | xargs)"
  else
    echo "  fallaron: $(echo $FAILED1). Repitiendo para separar intermitentes…"
    # shellcheck disable=SC2086
    (cd "$FE" && npx vitest run $FAILED1 >"$TMP/fe-test2.log" 2>&1)
    FAILED2=$(fe_failed "$TMP/fe-test2.log")
    for f in $FAILED1; do
      if ! echo "$FAILED2" | grep -qx "$f"; then
        warn "INTERMITENTE $f (fallo una vez, paso al repetir)"
        NOTES+=("Menciona en el PR que $f fallo de forma intermitente.")
      elif echo "$CHANGED" | grep -qx "$FE/$f"; then
        # Test nuevo o modificado en tu rama: compararlo con main no dice nada.
        bad "ROTO $f (es un test que agregaste o cambiaste)"
      elif ! base_worktree; then
        warn "NO SE PUDO COMPARAR $f con $BASE (git worktree fallo); revisalo a mano"
      elif (cd "$WORKTREE/$FE" && npx vitest run "$f" >"$TMP/fe-base.log" 2>&1); then
        bad "ROTO $f (pasa en $BASE, falla en tu rama)"
        if [ "$(basename "$f")" = "iconSubset.test.ts" ]; then
          echo "        Algun literal en minusculas coincide con un icono de Material Symbols."
          echo "        Arreglo: (cd $FE && python scripts/build-icon-subset.py)  # requiere: pip install fonttools brotli"
          echo "        y luego: git checkout $BASE -- $FE/scripts/material-symbols-names.txt"
        fi
      else
        warn "PREEXISTENTE $f (tambien falla en $BASE)"
        NOTES+=("Menciona en el PR que $f ya fallaba en $BASE.")
      fi
    done
  fi
  NOTES+=("En CI el paso de tests del frontend NO bloquea: despues del push, lee el log (gh run view <id> --log | grep 'Tests ').")
  stop_if_failed
fi

# ── 4. Backend ───────────────────────────────────────────────────────────
if [ "$BE_TOUCHED" -eq 1 ]; then
  section "Backend ($BE)"
  ensure_deps "$BE"
  if (cd "$BE" && npm run -s build >"$TMP/be-build.log" 2>&1); then
    ok "build (tsc)"
  else
    bad "build fallo:"; grep -E "error" "$TMP/be-build.log" | head -15 | sed 's/^/        /'
  fi

  ALL_SCRIPTS=$(cd "$BE" && node -e 'const s=require("./package.json").scripts;for(const k in s)if(k.startsWith("test:"))console.log(k+" "+(s[k].match(/src\/tests\/\S+/)||[""])[0])')
  if [ "$ALL_BACKEND" -eq 1 ]; then
    SELECTED=$(echo "$ALL_SCRIPTS" | awk '{print $1}')
  else
    # Un test cuenta como relacionado si importa o menciona un modulo que
    # cambiaste, o si el propio test cambio.
    SELECTED=""
    for f in $(echo "$CHANGED" | grep -E "^$BE/src/.*\.ts$"); do
      mod=$(basename "$f" .ts)
      while read -r name file; do
        [ -z "$file" ] && continue
        if [ "$BE/$file" = "$f" ] || grep -q "$mod" "$BE/$file" 2>/dev/null; then SELECTED="$SELECTED $name"; fi
      done <<< "$ALL_SCRIPTS"
    done
    SELECTED=$(echo "$SELECTED" | tr ' ' '\n' | sed '/^$/d' | sort -u)
  fi

  if [ -z "$SELECTED" ]; then
    warn "ningun test:* del backend se relaciona con tus cambios. Si tocaste logica, agrega uno (ver micopay-reglas)."
  fi
  for s in $SELECTED; do
    log="$TMP/be-$s.log"
    if (cd "$BE" && $TIMEOUT npm run -s "$s" >"$log" 2>&1); then
      ok "$s"
    elif grep -q "ECONNREFUSED 127.0.0.1:5432" "$log" && ! grep -q "ERR_ASSERTION" "$log"; then
      warn "REQUIERE PG $s (no hay PostgreSQL en 127.0.0.1:5432; no se pudo verificar)"
      NOTES+=("$s no se verifico localmente: necesita PostgreSQL (docker compose up -d postgres).")
    elif echo "$CHANGED" | grep -qx "$BE/$(echo "$ALL_SCRIPTS" | awk -v n="$s" '$1==n{print $2}')"; then
      bad "ROTO $s (es un test que agregaste o cambiaste). Log: $log"
      grep -vE '^\{"level"' "$log" | grep -iE "assert|error" | head -5 | sed 's/^/        /'
    elif ! base_worktree; then
      warn "NO SE PUDO COMPARAR $s con $BASE (git worktree fallo); revisalo a mano. Log: $log"
    elif ! (cd "$WORKTREE/$BE" && $TIMEOUT npm run -s "$s" >"$TMP/be-base.log" 2>&1); then
      warn "PREEXISTENTE $s (tambien falla en $BASE)"
      NOTES+=("Menciona en el PR que $s ya fallaba en $BASE.")
    else
      bad "ROTO $s (pasa en $BASE, falla en tu rama). Log: $log"
      grep -vE '^\{"level"' "$log" | grep -iE "assert|error" | head -5 | sed 's/^/        /'
    fi
  done
  NOTES+=("El CI del backend solo compila: los test:* no corren en CI, por eso se corren aqui.")

  NEW_SQL=$(echo "$COMMITTED" | grep -E '^micopay/sql/migrations/.*\.up\.sql$' || true)
  for up in $NEW_SQL; do
    down="${up%.up.sql}.down.sql"
    [ -f "$down" ] && ok "migracion $(basename "$up") tiene su .down.sql" || bad "migracion $(basename "$up") sin $(basename "$down")"
  done
  if echo "$COMMITTED" | grep -q '^micopay/sql/init.sql$'; then
    warn "cambiaste init.sql: las bases existentes no lo vuelven a aplicar. Usa una migracion nueva en micopay/sql/migrations/."
  fi
  stop_if_failed
fi

if [ "$FE_TOUCHED" -eq 0 ] && [ "$BE_TOUCHED" -eq 0 ]; then
  section "Codigo"
  ok "no hay cambios en $FE ni en $BE; no hay build ni tests que correr"
fi

summary
