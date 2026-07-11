ALTER TABLE reseller_supplier_key_sync_state
  DROP COLUMN IF EXISTS last_available_model_count,
  DROP COLUMN IF EXISTS last_model_sync_error,
  DROP COLUMN IF EXISTS last_model_sync_error_type,
  DROP COLUMN IF EXISTS last_model_sync_success_at,
  DROP COLUMN IF EXISTS last_model_sync_attempt_at;

DROP INDEX IF EXISTS idx_supplier_keys_provider;

ALTER TABLE reseller_supplier_keys DROP COLUMN IF EXISTS provider_id;
