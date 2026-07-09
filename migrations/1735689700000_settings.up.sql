-- Key-value store for admin-managed runtime config (subrouter key/base URL,
-- issued-key prefix) so these are set via the dashboard instead of Railway
-- env vars. Values are read/written by the admin Settings page.
CREATE TABLE reseller_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO reseller_settings (key, value) VALUES ('key_prefix', 'orbit');
