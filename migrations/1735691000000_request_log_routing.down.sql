ALTER TABLE reseller_request_logs
  DROP COLUMN IF EXISTS client,
  DROP COLUMN IF EXISTS smart_routing_enabled,
  DROP COLUMN IF EXISTS routing_mode,
  DROP COLUMN IF EXISTS requested_tier,
  DROP COLUMN IF EXISTS chosen_model,
  DROP COLUMN IF EXISTS rule_id,
  DROP COLUMN IF EXISTS was_overridden,
  DROP COLUMN IF EXISTS cost_baseline_cents,
  DROP COLUMN IF EXISTS cost_saved_cents;
