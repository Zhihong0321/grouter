-- Every routing decision the proxy makes, not just successfully billed ones.
-- reseller_usage_logs only ever gets a row on response.ok, so anything that
-- goes wrong before or during upstream dispatch (no route configured, every
-- provider failing over, an upstream returning a non-2xx) previously only
-- existed in ephemeral process logs. This table makes that visible from the
-- admin dashboard for debugging routing problems.
CREATE TABLE reseller_request_logs (
  id                bigserial PRIMARY KEY,
  created_at        timestamptz NOT NULL DEFAULT now(),
  key_id            uuid REFERENCES reseller_api_keys(id) ON DELETE SET NULL,
  endpoint          text NOT NULL,
  model             text NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN ('success', 'upstream_error', 'all_providers_failed', 'no_route')),
  status_code       int,
  provider_id       uuid REFERENCES reseller_providers(id) ON DELETE SET NULL,
  provider_name     text,
  upstream_model_id text,
  error_message     text,
  attempts          jsonb,
  latency_ms        int
);
CREATE INDEX idx_reseller_request_logs_created ON reseller_request_logs (created_at DESC);
CREATE INDEX idx_reseller_request_logs_model ON reseller_request_logs (model);
CREATE INDEX idx_reseller_request_logs_outcome ON reseller_request_logs (outcome);
