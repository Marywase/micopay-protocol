# syntax=docker/dockerfile:1
#
# Imagen de producción de micopay-backend.
#
# IMPORTANTE — el contexto de build es `micopay/`, NO `micopay/backend/`:
#
#     docker build -f micopay/backend/Dockerfile -t micopay-backend micopay
#
# El runner de migraciones (src/db/migrate.ts) resuelve `../../../sql` desde
# su propia ubicación en `dist/db/`, o sea `/app/sql`. Ese directorio vive
# fuera de `backend/`, así que un contexto acotado a `backend/` no podría
# copiarlo y el arranque quedaría sin esquema (el error se loguea pero NO
# tumba el proceso — ver index.ts, boot migrations —, así que la falla sería
# silenciosa hasta la primera query real).

# ── Etapa 1: compilar TypeScript ──────────────────────────────────────────
FROM node:22.23.4-bookworm-slim AS build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

# ── Etapa 2: dependencias de runtime ──────────────────────────────────────
# Nota: package.json declara typescript/tsx/@types en `dependencies`, así que
# --omit=dev no los elimina (solo saca pino-pretty). No se toca package.json
# aquí para no alterar el build de otros entornos; el costo es ~50 MB de imagen.
FROM node:22.23.4-bookworm-slim AS deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# ── Etapa 3: imagen final ─────────────────────────────────────────────────
FROM node:22.23.4-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/backend

COPY --from=deps  /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist         ./dist

# package.json es obligatorio en runtime: su `"type": "module"` es lo que hace
# que Node interprete dist/*.js como ESM.
COPY backend/package.json ./

# assetlinks.json para App Links de Android (servido desde /.well-known/).
COPY backend/public ./public

# Migraciones SQL — ver la nota del encabezado sobre el contexto de build.
COPY sql /app/sql

# CA bundle global de RDS — necesario para sslmode=verify-full. La versión de
# pg-connection-string en uso ya trata sslmode=require como alias de
# verify-full (advertencia en boot), así que sin este bundle la conexión se
# rechaza como "self-signed certificate in certificate chain". Bundle global
# cubre la rotación automática de la CA de RDS, por eso es un COPY de una vez.
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem
RUN chmod 644 /app/rds-global-bundle.pem

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
