-- Up Migration

-- Supplier-side cost per model, imported from SubRouter's /api/pricing.
-- Kept entirely separate from reseller_model_prices (our RETAIL price): a
-- sync must never overwrite what we charge customers. This is reference data
-- shown beside retail so an admin can see the margin at a glance.
CREATE TABLE reseller_supplier_model_costs (
  supplier              text NOT NULL DEFAULT 'subrouter',
  model_id              text NOT NULL,
  -- The provider:xxx group we matched against our own key's supplier_group.
  -- Null when no key-group matched and we fell back to the cheapest provider.
  matched_group         text,
  provider_name         text,
  is_fallback           boolean NOT NULL DEFAULT false,
  -- Costs exactly as SubRouter reports them (per its own unit + currency).
  input_price           numeric,
  output_price          numeric,
  cache_read_price      numeric,
  cache_creation_price  numeric,
  currency              text NOT NULL DEFAULT 'USD',
  -- Vendor list price for reference (e.g. Anthropic official $/M). Not our cost.
  official_input_price  numeric,
  official_output_price numeric,
  last_synced_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier, model_id)
);

-- Tracks the last run of the price sync for status display + concurrency notes.
CREATE TABLE reseller_supplier_price_sync_state (
  supplier                text PRIMARY KEY,
  last_attempt_at         timestamptz,
  last_success_at         timestamptz,
  last_synced_model_count integer NOT NULL DEFAULT 0,
  last_matched_count      integer NOT NULL DEFAULT 0,
  last_fallback_count     integer NOT NULL DEFAULT 0,
  last_error_type         text,
  last_error              text,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS reseller_supplier_price_sync_state;
DROP TABLE IF EXISTS reseller_supplier_model_costs;
