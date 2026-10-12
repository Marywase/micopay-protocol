-- Retirar a banco (SPEI) · docs/PLAN_RETIRO_SPEI_2026-10-12.md
--
-- ramp_quotes guarda lo que el backend calculo al cotizar un retiro (activo que
-- vende el usuario, ruta del DEX y el pago exacto a Etherfuse), para que la
-- orden devuelva instrucciones que el cliente no puede alterar.
-- ramp_orders gana el estado de la orden, que actualiza el webhook
-- order_updated de Etherfuse (antes solo se escribia en el log).
CREATE TABLE IF NOT EXISTS ramp_quotes (
  quote_id          UUID PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES users(id),
  asset             VARCHAR(12) NOT NULL,
  send_code         VARCHAR(12) NOT NULL,
  send_issuer       VARCHAR(56),
  send_max          NUMERIC(20, 7) NOT NULL,
  dex_path          JSONB NOT NULL DEFAULT '[]'::jsonb,
  pay_code          VARCHAR(12) NOT NULL,
  pay_issuer        VARCHAR(56) NOT NULL,
  pay_amount        NUMERIC(20, 7) NOT NULL,
  destination_mxn   NUMERIC(20, 2) NOT NULL,
  fee_amount        NUMERIC(20, 7),
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ramp_quotes_user ON ramp_quotes (user_id, created_at DESC);

ALTER TABLE ramp_orders
  ADD COLUMN IF NOT EXISTS quote_id          UUID REFERENCES ramp_quotes(quote_id),
  ADD COLUMN IF NOT EXISTS status            VARCHAR(16) NOT NULL DEFAULT 'created',
  ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ;
