-- Retirar a banco (SPEI) · ultimo mensaje del KYC de Etherfuse.
--
-- Cuando un requisito del KYC se rechaza, Etherfuse explica que corregir solo
-- en el webhook kycUpdated (kyc.userMessage); GET /organization/{id}/kyc
-- no lo repite. Se guarda para mostrarlo en la pantalla del retiro.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS etherfuse_kyc_message TEXT;
