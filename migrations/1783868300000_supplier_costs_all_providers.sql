-- Up Migration

-- Reshape supplier cost storage from "one chosen provider per model" to
-- "every provider per model". reseller_supplier_model_costs is pure reference
-- data, fully rebuilt on each sync, so dropping + recreating loses nothing.
DROP TABLE IF EXISTS reseller_supplier_model_costs;

CREATE TABLE IF NOT EXISTS reseller_supplier_model_costs (
  supplier              text NOT NULL DEFAULT 'subrouter',
  model_id              text NOT NULL,
  -- SubRouter group id for this provider, e.g. "provider:mixmix123".
  provider_group        text NOT NULL,
  provider_name         text,
  -- Rank within the model, cheapest = 1 (SubRouter's own sort order).
  price_rank            integer NOT NULL DEFAULT 0,
  -- True when this provider's group matches one of our own keys' supplier_group
  -- (i.e. a provider we can actually route to). Lets the UI highlight ours.
  matches_our_key       boolean NOT NULL DEFAULT false,
  -- Costs exactly as SubRouter reports them (its own unit + currency).
  input_price           numeric,
  output_price          numeric,
  cache_read_price      numeric,
  cache_creation_price  numeric,
  currency              text NOT NULL DEFAULT 'USD',
  region                text,
  -- Vendor list price for reference (e.g. Anthropic official $/M). Not our cost.
  official_input_price  numeric,
  official_output_price numeric,
  last_synced_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier, model_id, provider_group)
);

CREATE INDEX IF NOT EXISTS idx_supplier_model_costs_model
  ON reseller_supplier_model_costs (supplier, model_id, price_rank);

-- Down Migration
DROP TABLE IF EXISTS reseller_supplier_model_costs;
