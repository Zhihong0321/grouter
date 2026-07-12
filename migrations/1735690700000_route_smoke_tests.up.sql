-- Keep a short operational history for each routed model/key pair. The
-- dashboard reads the five most recent samples; old samples are pruned by the
-- smoke-test endpoint after every new insert.
CREATE TABLE reseller_route_smoke_tests (
  id          bigserial PRIMARY KEY,
  model_id    text NOT NULL REFERENCES reseller_models(model_id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES reseller_providers(id) ON DELETE CASCADE,
  standard    text NOT NULL CHECK (standard IN ('anthropic', 'openai')),
  ok          boolean NOT NULL,
  latency_ms  integer NOT NULL CHECK (latency_ms >= 0),
  status_code integer,
  message     text NOT NULL,
  tested_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_route_smoke_tests_recent
  ON reseller_route_smoke_tests (model_id, provider_id, tested_at DESC);
