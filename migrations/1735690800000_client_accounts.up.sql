-- Self-serve accounts for the Tauri client app (no email/KYC). The recovery
-- password is the account credential -- username is display-only. recovery_hash
-- is sha256 (same scheme as reseller_api_keys.key_hash) so recover-by-password
-- is a direct indexed lookup rather than an O(n) bcrypt scan.
CREATE TABLE reseller_client_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL,
  recovery_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_client_accounts_recovery_hash ON reseller_client_accounts (recovery_hash);

ALTER TABLE reseller_api_keys
  ADD COLUMN account_id uuid REFERENCES reseller_client_accounts(id) ON DELETE SET NULL,
  ADD COLUMN unlimited boolean NOT NULL DEFAULT false;

CREATE INDEX idx_reseller_api_keys_account_id ON reseller_api_keys (account_id) WHERE account_id IS NOT NULL;
