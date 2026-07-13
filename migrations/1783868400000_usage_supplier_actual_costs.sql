-- Link a customer-facing usage record to the one authoritative supplier
-- activity record that paid for it. Retail billing remains in
-- reseller_usage_logs.cost_cents; actual supplier cost stays in the supplier
-- activity ledger and is reached through this one-to-one link.
CREATE TABLE IF NOT EXISTS reseller_usage_supplier_matches (
  usage_log_id bigint PRIMARY KEY REFERENCES reseller_usage_logs(id) ON DELETE CASCADE,
  supplier_activity_id bigint NOT NULL UNIQUE REFERENCES reseller_supplier_activity(id) ON DELETE RESTRICT,
  match_method text NOT NULL CHECK (match_method IN ('exact_token_model_usage_time')),
  time_delta_ms integer NOT NULL,
  matched_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_supplier_matches_activity
  ON reseller_usage_supplier_matches (supplier_activity_id);
