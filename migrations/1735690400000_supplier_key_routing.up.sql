-- Each mirrored supplier key can be used as a distinct routing provider.
ALTER TABLE reseller_supplier_keys
  ADD COLUMN provider_id uuid REFERENCES reseller_providers(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX idx_supplier_keys_provider ON reseller_supplier_keys (provider_id) WHERE provider_id IS NOT NULL;

ALTER TABLE reseller_supplier_key_sync_state
  ADD COLUMN last_model_sync_attempt_at timestamptz,
  ADD COLUMN last_model_sync_success_at timestamptz,
  ADD COLUMN last_model_sync_error_type text,
  ADD COLUMN last_model_sync_error text,
  ADD COLUMN last_available_model_count integer NOT NULL DEFAULT 0;
