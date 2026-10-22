-- Retirar a banco (SPEI) · docs/PLAN_RETIRO_BANCO_2026-10-20.md · WP1
--
-- ramp_quotes guarda lo que el backend calculo al cotizar un retiro (activo
-- que vende el usuario, ruta del DEX, lo que llega a Etherfuse y los MXN que
-- recibe la CLABE), para que la orden devuelva instrucciones que el cliente
-- no puede alterar.
--
-- ramp_orders ya existe (20260702090000_ramp_order_ownership) con order_id y
-- user_id; se le anade quote_id, status y status_updated_at para que el
-- webhook order_updated actualice el estado en vez de solo loguearlo.
--
-- users ya tiene etherfuse_customer_id, etherfuse_bank_account_id y
-- kyc_status (20260630220000_etherfuse_ramp). Se anade:
--   - etherfuse_wallet_account_id: la wallet del usuario registrada como
--     cuenta de pago en Etherfuse (v2 API).
--   - etherfuse_kyc_updated_at: ultima vez que el webhook kycUpdated nos
--     avisó. Util para debuggear estados "en revisión" eternos.

CREATE TABLE IF NOT EXISTS ramp_quotes (
  quote_id         UUID PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES users(id),
  asset            VARCHAR(12) NOT NULL,          -- 'XLM' o 'USDC'
  send_code        VARCHAR(12) NOT NULL,
  send_issuer      VARCHAR(56),
  send_max         NUMERIC(20, 7) NOT NULL,       -- maximo que sale del usuario
  dex_path         JSONB NOT NULL DEFAULT '[]'::jsonb,
  pay_code         VARCHAR(12) NOT NULL,
  pay_issuer       VARCHAR(56) NOT NULL,
  pay_amount       NUMERIC(20, 7) NOT NULL,       -- lo que llega a Etherfuse
  destination_mxn  NUMERIC(20, 2) NOT NULL,
  fee_amount       NUMERIC(20, 7),
  address          VARCHAR(56),                   -- destino que Etherfuse pide
  memo             VARCHAR(64),                   -- opcional, segun orden
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ramp_quotes_user ON ramp_quotes (user_id, created_at DESC);

ALTER TABLE ramp_orders
  ADD COLUMN IF NOT EXISTS quote_id          UUID REFERENCES ramp_quotes(quote_id),
  ADD COLUMN IF NOT EXISTS status            VARCHAR(16) NOT NULL DEFAULT 'created',
  ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ramp_orders_status ON ramp_orders (status, status_updated_at DESC);

-- kyc_status existente (20260630220000) sigue siendo el estado de Didit; para
-- Etherfuse se usa una columna aparte, porque un usuario con Didit aprobado
-- todavia puede estar en revision en Etherfuse. Valores:
-- 'not_started' | 'review' | 'approved' | 'action_required' | 'rejected'.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS etherfuse_wallet_account_id UUID,
  ADD COLUMN IF NOT EXISTS etherfuse_kyc_status        VARCHAR(20) NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS etherfuse_kyc_updated_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clabe_last4                 CHAR(4);
