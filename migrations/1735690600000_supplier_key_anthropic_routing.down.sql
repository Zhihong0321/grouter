DROP INDEX IF EXISTS idx_supplier_keys_anthropic_provider;

ALTER TABLE reseller_supplier_keys
  DROP COLUMN IF EXISTS anthropic_provider_id;
