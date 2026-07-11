-- Smart Routing Mode decision log, one row per request that had tier
-- routing evaluated (or was eligible for it). Flags/values are captured as
-- they were AT REQUEST TIME -- never resolved later by joining to the key's
-- current config, since the per-key toggle changes over time and that would
-- silently rewrite history. See smart_routing_buildplan.md section 3.2.
ALTER TABLE reseller_request_logs
  ADD COLUMN client                text,     -- 'claude_code' | 'codex' | 'unknown' | null
  ADD COLUMN smart_routing_enabled boolean,  -- mode ON for this key+client, at request time
  ADD COLUMN routing_mode          text,     -- 'smart' | 'honor_tier'
  ADD COLUMN requested_tier        text,     -- brain | build | routine
  ADD COLUMN chosen_model          text,
  ADD COLUMN rule_id               text,     -- which rule fired, e.g. 'background'
  ADD COLUMN was_overridden        boolean,  -- chosen_model != requested tier default
  ADD COLUMN cost_baseline_cents   numeric,  -- what requested tier would have cost
  ADD COLUMN cost_saved_cents      numeric;
