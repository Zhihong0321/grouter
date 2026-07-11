CREATE TABLE reseller_supplier_activity (
  id bigserial PRIMARY KEY,
  supplier text NOT NULL,
  external_record_key text NOT NULL,
  external_log_id bigint NOT NULL,
  external_request_id text,
  external_created_at timestamptz NOT NULL,
  log_type integer NOT NULL,
  content text,
  token_name text,
  model_name text,
  prompt_tokens bigint NOT NULL DEFAULT 0,
  completion_tokens bigint NOT NULL DEFAULT 0,
  cache_tokens bigint NOT NULL DEFAULT 0,
  quota_units numeric NOT NULL,
  quota_per_usd numeric NOT NULL CHECK (quota_per_usd > 0),
  wallet_cost_usd numeric GENERATED ALWAYS AS (quota_units / quota_per_usd) STORED NOT NULL,
  use_time_seconds numeric,
  is_stream boolean,
  channel_id bigint,
  channel_name text,
  external_token_id bigint,
  supplier_group text,
  provider_name text,
  billing_source text,
  raw_other jsonb,
  raw_record jsonb NOT NULL,
  supplier_updated_at timestamptz,
  first_synced_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier, external_record_key)
);

CREATE INDEX idx_supplier_activity_log_id ON reseller_supplier_activity (supplier, external_log_id);
CREATE INDEX idx_supplier_activity_created ON reseller_supplier_activity (external_created_at DESC);
CREATE INDEX idx_supplier_activity_request ON reseller_supplier_activity (external_request_id);
CREATE INDEX idx_supplier_activity_model ON reseller_supplier_activity (model_name);
CREATE INDEX idx_supplier_activity_token ON reseller_supplier_activity (token_name);
CREATE INDEX idx_supplier_activity_supplier_created ON reseller_supplier_activity (supplier, external_created_at DESC);

CREATE TABLE reseller_supplier_account_state (
  supplier text PRIMARY KEY,
  remaining_quota_units numeric NOT NULL,
  used_quota_units numeric NOT NULL,
  remaining_wallet_usd numeric GENERATED ALWAYS AS (remaining_quota_units / quota_per_usd) STORED NOT NULL,
  used_wallet_usd numeric GENERATED ALWAYS AS (used_quota_units / quota_per_usd) STORED NOT NULL,
  request_count bigint NOT NULL,
  quota_per_usd numeric NOT NULL CHECK (quota_per_usd > 0),
  supplier_user_id text NOT NULL,
  last_fetched_at timestamptz NOT NULL,
  raw_account_state jsonb NOT NULL
);

CREATE TABLE reseller_supplier_sync_state (
  supplier text PRIMARY KEY,
  initial_backfill_complete boolean NOT NULL DEFAULT false,
  last_external_log_id bigint,
  last_external_created_at timestamptz,
  last_sync_cutoff timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  last_error_type text,
  last_imported_count integer NOT NULL DEFAULT 0,
  total_imported_count bigint NOT NULL DEFAULT 0,
  reconciliation_matched boolean,
  reconciliation_expected_quota numeric,
  reconciliation_database_quota numeric,
  reconciliation_expected_tokens bigint,
  reconciliation_database_tokens bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);
