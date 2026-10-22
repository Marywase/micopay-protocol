-- Revierte 20261021170000_bank_withdraw.up.sql.
ALTER TABLE users
  DROP COLUMN IF EXISTS clabe_last4,
  DROP COLUMN IF EXISTS etherfuse_kyc_updated_at,
  DROP COLUMN IF EXISTS etherfuse_kyc_status,
  DROP COLUMN IF EXISTS etherfuse_wallet_account_id;

DROP INDEX IF EXISTS idx_ramp_orders_status;
ALTER TABLE ramp_orders
  DROP COLUMN IF EXISTS status_updated_at,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS quote_id;

DROP INDEX IF EXISTS idx_ramp_quotes_user;
DROP TABLE IF EXISTS ramp_quotes;
