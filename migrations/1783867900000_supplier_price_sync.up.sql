-- Track pricing synchronization state from suppliers like SubRouter
CREATE TABLE reseller_supplier_price_sync_state (
  supplier            text PRIMARY KEY,
  last_attempt_at     timestamptz,
  last_success_at     timestamptz,
  last_synced_model_count int,
  last_error_type     text,
  last_error          text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
