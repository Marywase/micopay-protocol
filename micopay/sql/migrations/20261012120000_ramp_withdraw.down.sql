ALTER TABLE ramp_orders
  DROP COLUMN IF EXISTS status_updated_at,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS quote_id;
DROP TABLE IF EXISTS ramp_quotes;
