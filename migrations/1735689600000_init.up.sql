CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE reseller_admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reseller_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  rate_limit_rpm int NOT NULL DEFAULT 60 CHECK (rate_limit_rpm > 0),
  budget_cents numeric NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
  spent_cents numeric NOT NULL DEFAULT 0 CHECK (spent_cents >= 0),
  model_restrictions jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX idx_reseller_api_keys_key_hash ON reseller_api_keys (key_hash);

CREATE TABLE reseller_model_prices (
  model_id text PRIMARY KEY,
  input_price_cents_per_million numeric NOT NULL CHECK (input_price_cents_per_million >= 0),
  output_price_cents_per_million numeric NOT NULL CHECK (output_price_cents_per_million >= 0),
  cache_write_price_cents_per_million numeric NOT NULL CHECK (cache_write_price_cents_per_million >= 0),
  cache_read_price_cents_per_million numeric NOT NULL CHECK (cache_read_price_cents_per_million >= 0),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reseller_usage_logs (
  id bigserial PRIMARY KEY,
  key_id uuid NOT NULL REFERENCES reseller_api_keys(id),
  model text NOT NULL,

  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  cache_creation_input_tokens int NOT NULL DEFAULT 0,
  cache_read_input_tokens int NOT NULL DEFAULT 0,

  input_cost_cents numeric NOT NULL DEFAULT 0,
  output_cost_cents numeric NOT NULL DEFAULT 0,
  cache_write_cost_cents numeric NOT NULL DEFAULT 0,
  cache_read_cost_cents numeric NOT NULL DEFAULT 0,
  cost_cents numeric NOT NULL DEFAULT 0,

  latency_ms int,
  status_code int,
  stream boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reseller_usage_logs_key_created ON reseller_usage_logs (key_id, created_at);

-- Seed a starting price table: base = public Anthropic list pricing, cache
-- write/read derived at the standard ~1.25x / ~0.1x ratios. All editable via
-- the admin dashboard afterward -- this is just a sane starting point.
INSERT INTO reseller_model_prices (model_id, input_price_cents_per_million, output_price_cents_per_million, cache_write_price_cents_per_million, cache_read_price_cents_per_million) VALUES
  ('claude-opus-4-8',   500, 2500, 625, 50),
  ('claude-sonnet-5',   300, 1500, 375, 30),
  ('claude-haiku-4-5',  100,  500, 125, 10),
  ('claude-fable-5',   1000, 5000, 1250, 100);
