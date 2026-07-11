-- Customer keys with historical usage cannot be hard-deleted because the
-- usage log is intentionally retained. This marks them removed from the
-- dashboard and wipes their recoverable plaintext instead.
ALTER TABLE reseller_api_keys ADD COLUMN deleted_at timestamptz;
CREATE INDEX idx_reseller_api_keys_visible ON reseller_api_keys (created_at DESC) WHERE deleted_at IS NULL;
