-- Smart Routing Mode: per-key opt-in, separate for each client since a
-- reseller's Claude Code traffic and Codex traffic have very different
-- tolerance for tier substitution. See smart_routing_buildplan.md.
ALTER TABLE reseller_api_keys
  ADD COLUMN smart_routing_claude_code boolean NOT NULL DEFAULT false,
  ADD COLUMN smart_routing_codex       boolean NOT NULL DEFAULT false;
