-- Model catalog + provider routing table. Replaces the single hardcoded
-- subrouter (reseller_settings.subrouter_api_key/base_url) with: a catalog of
-- models end-users may call, a set of upstream supplier accounts, and a
-- routing table linking model -> provider with a priority for failover.
-- This build seeds Anthropic-standard models only -- see implemenation_plan_0709.md.

CREATE TABLE reseller_models (
  model_id     text PRIMARY KEY,
  brand        text NOT NULL,
  standard     text NOT NULL CHECK (standard IN ('anthropic', 'openai')),
  display_name text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reseller_providers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  standard          text NOT NULL CHECK (standard IN ('anthropic', 'openai')),
  base_url          text NOT NULL,
  api_key_encrypted text NOT NULL,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reseller_model_routes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id           text NOT NULL REFERENCES reseller_models(model_id) ON DELETE CASCADE,
  provider_id        uuid NOT NULL REFERENCES reseller_providers(id) ON DELETE CASCADE,
  upstream_model_id  text NOT NULL,
  priority           int NOT NULL DEFAULT 1 CHECK (priority >= 1),
  active             boolean NOT NULL DEFAULT true,
  UNIQUE (model_id, provider_id),
  UNIQUE (model_id, priority)
);
CREATE INDEX idx_reseller_model_routes_model ON reseller_model_routes (model_id);

-- SET NULL (not the default RESTRICT) so an admin can delete a provider
-- later without being blocked by its own historical usage logs.
ALTER TABLE reseller_usage_logs ADD COLUMN provider_id uuid REFERENCES reseller_providers(id) ON DELETE SET NULL;
ALTER TABLE reseller_usage_logs ADD COLUMN upstream_model_id text;

INSERT INTO reseller_models (model_id, brand, standard, display_name) VALUES
  ('claude-opus-4-8',   'Anthropic', 'anthropic', 'Claude Opus 4.8'),
  ('claude-sonnet-5',   'Anthropic', 'anthropic', 'Claude Sonnet 5'),
  ('claude-haiku-4-5',  'Anthropic', 'anthropic', 'Claude Haiku 4.5'),
  ('claude-fable-5',    'Anthropic', 'anthropic', 'Claude Fable 5');
