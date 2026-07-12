-- Re-add per-key smart routing flags for rollback.
ALTER TABLE reseller_api_keys
  ADD COLUMN smart_routing_claude_code boolean NOT NULL DEFAULT false,
  ADD COLUMN smart_routing_codex       boolean NOT NULL DEFAULT false;
