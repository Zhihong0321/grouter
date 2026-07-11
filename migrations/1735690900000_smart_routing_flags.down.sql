ALTER TABLE reseller_api_keys
  DROP COLUMN IF EXISTS smart_routing_claude_code,
  DROP COLUMN IF EXISTS smart_routing_codex;
