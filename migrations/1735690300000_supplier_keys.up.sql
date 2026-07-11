-- Mirrors SubRouter-issued supplier keys separately from reseller_api_keys,
-- which are keys this application issues to its own customers.
CREATE TABLE reseller_supplier_keys (
  id bigserial PRIMARY KEY,
  supplier text NOT NULL,
  external_token_id bigint NOT NULL,
  name text NOT NULL,
  status integer NOT NULL,
  key_ciphertext text NOT NULL,
  key_last4 text NOT NULL,
  user_id bigint,
  created_at_supplier timestamptz,
  accessed_at_supplier timestamptz,
  expires_at_supplier timestamptz,
  remaining_quota_units numeric,
  used_quota_units numeric,
  unlimited_quota boolean NOT NULL DEFAULT false,
  model_limits_enabled boolean NOT NULL DEFAULT false,
  allow_ips text,
  supplier_group text,
  cross_group_retry boolean,
  subrouter_providers text,
  subrouter_sort_mode text,
  present_on_supplier boolean NOT NULL DEFAULT true,
  raw_token jsonb NOT NULL,
  first_synced_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier, external_token_id)
);

CREATE INDEX idx_supplier_keys_supplier_present ON reseller_supplier_keys (supplier, present_on_supplier);

CREATE TABLE reseller_supplier_key_models (
  supplier_key_id bigint NOT NULL REFERENCES reseller_supplier_keys(id) ON DELETE CASCADE,
  model_id text NOT NULL,
  PRIMARY KEY (supplier_key_id, model_id)
);

CREATE INDEX idx_supplier_key_models_model ON reseller_supplier_key_models (model_id);

-- The upstream catalog is retained independently of the local reseller model
-- catalog: importing a supplier model never makes it customer-callable.
CREATE TABLE reseller_supplier_models (
  supplier text NOT NULL,
  model_id text NOT NULL,
  supplier_groups jsonb NOT NULL,
  present_on_supplier boolean NOT NULL DEFAULT true,
  first_synced_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier, model_id)
);

CREATE INDEX idx_supplier_models_supplier_present ON reseller_supplier_models (supplier, present_on_supplier);

CREATE TABLE reseller_supplier_key_sync_state (
  supplier text PRIMARY KEY,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_type text,
  last_error text,
  last_key_count integer NOT NULL DEFAULT 0,
  last_model_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
