DROP INDEX IF EXISTS idx_reseller_api_keys_account_id;

ALTER TABLE reseller_api_keys
  DROP COLUMN IF EXISTS unlimited,
  DROP COLUMN IF EXISTS account_id;

DROP INDEX IF EXISTS idx_client_accounts_recovery_hash;

DROP TABLE IF EXISTS reseller_client_accounts;
