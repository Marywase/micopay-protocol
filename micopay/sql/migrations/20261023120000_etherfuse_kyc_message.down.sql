-- Revierte 20261023120000_etherfuse_kyc_message.up.sql.
ALTER TABLE users
  DROP COLUMN IF EXISTS etherfuse_kyc_message;
