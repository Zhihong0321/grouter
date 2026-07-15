-- Up Migration
-- Set the Smart Routing tier->model maps to the operator's allowed-model list.
-- These are runtime settings read by SettingsCache.getTierConfig(); the code
-- DEFAULT_TIER_CONFIG is only a fallback for unset keys, so prod already had
-- rows here. Force the values with an upsert so the deployed maps match intent
-- exactly. Constraints baked in: no Sonnet, no Haiku; gpt-5.5i-compact is
-- OpenAI-standard (cannot serve /v1/messages) so Claude Code's non-brain tiers
-- use the near-free Anthropic-standard models MiniMax-M3 / mimo-v2.5-pro.
--
-- Claude Code (Anthropic path):
--   brain   = claude-opus-4-8   (plan/think/investigate)
--   build   = mimo-v2.5-pro     (execute a plan -- near-free)
--   routine = MiniMax-M3        (read/run -- near-free)
-- Codex (OpenAI path):
--   brain   = gpt-5.6-sol
--   build   = gpt-5.5i-compact  (overwrites sonnet/luna-class workhorse)
--   routine = gpt-5.5i-compact
--
-- Model IDs are case-sensitive and must match the catalog exactly
-- (verified live against /v1/models): MiniMax-M3, mimo-v2.5-pro.
INSERT INTO reseller_settings (key, value, updated_at) VALUES
  ('tier_model_anthropic_brain',   'claude-opus-4-8',  now()),
  ('tier_model_anthropic_build',   'mimo-v2.5-pro',    now()),
  ('tier_model_anthropic_routine', 'MiniMax-M3',       now()),
  ('tier_model_openai_brain',      'gpt-5.6-sol',      now()),
  ('tier_model_openai_build',      'gpt-5.5i-compact', now()),
  ('tier_model_openai_routine',    'gpt-5.5i-compact', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- Down Migration
-- Revert to the previous shipped defaults (pre-allowed-list). This is a
-- best-effort restore of the historical values, not a delete, so re-running
-- up/down can't drop the keys entirely and break routing.
INSERT INTO reseller_settings (key, value, updated_at) VALUES
  ('tier_model_anthropic_brain',   'claude-opus-4-8',  now()),
  ('tier_model_anthropic_build',   'claude-sonnet-5',  now()),
  ('tier_model_anthropic_routine', 'claude-haiku-4-5', now()),
  ('tier_model_openai_brain',      'gpt-5',            now()),
  ('tier_model_openai_build',      'gpt-5',            now()),
  ('tier_model_openai_routine',    'gpt-5-mini',       now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
