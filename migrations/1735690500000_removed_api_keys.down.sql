DROP INDEX IF EXISTS idx_reseller_api_keys_visible;
ALTER TABLE reseller_api_keys DROP COLUMN IF EXISTS deleted_at;
