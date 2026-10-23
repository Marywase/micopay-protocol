#!/usr/bin/env bash
# Despliega una instancia del escrow en MAINNET. Cada instancia bloquea un solo
# token (se fija en initialize), asi que hay una por activo:
#
#   PLATFORM_WALLET=G... TOKEN=USDC bash deploy-mainnet.sh   # USDC de Circle (default)
#   PLATFORM_WALLET=G... TOKEN=XLM  bash deploy-mainnet.sh   # XLM nativo
#
# Dos cuentas distintas:
#   - SOURCE (alias del CLI): despliega y queda como admin. Su llave tambien
#     vive en el backend.
#   - PLATFORM_WALLET (solo la direccion publica G...): recibe la comision en
#     cada release. Su llave se crea y se guarda fuera de linea; este script
#     nunca la pide. Ver MAINNET.md para el orden de los pasos.
#
# Requisitos:
#   - Llave de SOURCE en el CLI de stellar, fondeada con XLM real (~10 XLM:
#     despliegues y comisiones de red).
#   - PLATFORM_WALLET ya existe en la red y, para TOKEN=USDC, ya tiene la
#     trustline de USDC (la firma la llave fria).
#   - Ejecutar desde micopay/contracts.
#
# Ensayo en testnet con SOURCE como wallet de plataforma (comportamiento
# anterior): ALLOW_HOT_PLATFORM_WALLET=1, sin PLATFORM_WALLET.
#
# Pasos (cada uno se puede repetir sin romper nada, salvo initialize, que el
# contrato rechaza una segunda vez):
#   1. revisar PLATFORM_WALLET (formato, cuenta en Horizon, trustline de USDC)
#   2. build + deploy del WASM
#   3. initialize(admin = SOURCE, token, platform_wallet = PLATFORM_WALLET)
set -euo pipefail

TOKEN="${TOKEN:-USDC}"
SOURCE="${SOURCE:-micopay-platform-mainnet}"
RPC_URL="${RPC_URL:-https://mainnet.sorobanrpc.com}"
PASSPHRASE="${PASSPHRASE:-Public Global Stellar Network ; September 2015}"
HORIZON="${HORIZON:-https://horizon.stellar.org}"
USDC_ASSET="${USDC_ASSET:-USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN}"
# SACs en mainnet, derivados con Asset(...).contractId(Networks.PUBLIC). El de
# USDC se verifico en cadena el 2026-10-07 (ejecutable = Stellar Asset).
USDC_SAC="${USDC_SAC:-CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75}"
XLM_SAC="${XLM_SAC:-CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA}"
# Las variables de arriba se pueden sobrescribir para ensayar en testnet.

case "$TOKEN" in
  USDC) TOKEN_SAC="$USDC_SAC" ;;
  XLM)  TOKEN_SAC="$XLM_SAC" ;;
  *) echo "TOKEN debe ser USDC o XLM" >&2; exit 1 ;;
esac

NET=(--rpc-url "$RPC_URL" --network-passphrase "$PASSPHRASE")
ADMIN="$(stellar keys address "$SOURCE")"

HOT_WALLET=0
if [ -z "${PLATFORM_WALLET:-}" ]; then
  if [ "${ALLOW_HOT_PLATFORM_WALLET:-}" = "1" ]; then
    HOT_WALLET=1
    PLATFORM_WALLET="$ADMIN"
    echo "AVISO: ALLOW_HOT_PLATFORM_WALLET=1, la comision llega a SOURCE ($ADMIN). Solo para ensayos en testnet." >&2
  else
    cat >&2 <<EOF
Falta PLATFORM_WALLET: la direccion publica (G...) de la cuenta que recibe la
comision. Debe ser una cuenta distinta de SOURCE, creada fuera de linea (ver
MAINNET.md). Para ensayar en testnet con SOURCE como wallet de plataforma:
ALLOW_HOT_PLATFORM_WALLET=1.
EOF
    exit 1
  fi
fi

echo "Admin: $ADMIN · wallet de plataforma: $PLATFORM_WALLET · token: $TOKEN ($TOKEN_SAC)"

echo "1/3 Revisando la wallet de plataforma…"
if ! [[ "$PLATFORM_WALLET" =~ ^G[A-Z2-7]{55}$ ]]; then
  echo "PLATFORM_WALLET no parece una llave publica de Stellar (56 caracteres, empieza con G): $PLATFORM_WALLET" >&2
  exit 1
fi
ACCOUNT_JSON="$(curl -s "$HORIZON/accounts/$PLATFORM_WALLET")"
if ! grep -q '"account_id"' <<<"$ACCOUNT_JSON"; then
  echo "PLATFORM_WALLET no existe en $HORIZON. Hay que crearla y fondearla antes." >&2
  exit 1
fi
echo "    la cuenta existe"

if [ "$TOKEN" = "USDC" ]; then
  # Se busca el CODIGO y el EMISOR juntos: cualquiera puede emitir un "USDC".
  if tr -d ' \n' <<<"$ACCOUNT_JSON" \
      | grep -q "\"asset_code\":\"${USDC_ASSET%%:*}\",\"asset_issuer\":\"${USDC_ASSET#*:}\""; then
    echo "    trustline de $USDC_ASSET: ok"
  elif [ "$HOT_WALLET" = "1" ]; then
    stellar tx new change-trust --source "$SOURCE" --line "$USDC_ASSET" "${NET[@]}"
  else
    cat >&2 <<EOF
PLATFORM_WALLET no tiene trustline a $USDC_ASSET.
La trustline la firma la llave fria de PLATFORM_WALLET, fuera de este script.
Agregala y vuelve a correrlo.
EOF
    exit 1
  fi
fi

echo "2/3 Build y deploy…"
(cd escrow && stellar contract build)
CONTRACT_ID="$(stellar contract deploy \
  --wasm escrow/target/wasm32v1-none/release/micopay_escrow.wasm \
  --source "$SOURCE" "${NET[@]}")"
echo "    contrato: $CONTRACT_ID"

echo "3/3 initialize…"
stellar contract invoke --id "$CONTRACT_ID" --source "$SOURCE" "${NET[@]}" -- \
  initialize --admin "$ADMIN" --token_id "$TOKEN_SAC" --platform_wallet "$PLATFORM_WALLET"

cat <<EOF

Listo. Agrega la instancia a MAINNET.md y a ESCROW_CONTRACTS en la task definition:
  ESCROW_CONTRACTS=...,$TOKEN=$CONTRACT_ID
EOF
