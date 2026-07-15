import type { Pool } from "pg";
import type { TierConfig } from "./tierRouting.js";

export const SETTINGS_KEYS = {
  KEY_PREFIX: "key_prefix",
  // Smart Routing Mode (tier-based model selection -- see src/lib/tierRouting.ts).
  // Not to be confused with the provider-failover "smart routing" sync (src/lib/smartRouting.ts).
  // Legacy keys (now feed anthropic map for back-compat):
  TIER_MODEL_BRAIN: "tier_model_brain",
  TIER_MODEL_BUILD: "tier_model_build",
  TIER_MODEL_ROUTINE: "tier_model_routine",
  // Per-standard tier maps:
  TIER_MODEL_ANTHROPIC_BRAIN: "tier_model_anthropic_brain",
  TIER_MODEL_ANTHROPIC_BUILD: "tier_model_anthropic_build",
  TIER_MODEL_ANTHROPIC_ROUTINE: "tier_model_anthropic_routine",
  TIER_MODEL_OPENAI_BRAIN: "tier_model_openai_brain",
  TIER_MODEL_OPENAI_BUILD: "tier_model_openai_build",
  TIER_MODEL_OPENAI_ROUTINE: "tier_model_openai_routine",
  TIER_LONG_CONTEXT_TOKENS: "tier_long_context_tokens",
  TIER_SHORT_TURN_TOKENS: "tier_short_turn_tokens",
  TIER_SMALL_FAST_MODEL: "tier_small_fast_model",
  TIER_ROUTING_MODE: "tier_routing_mode",
  TIER_HONOR_EXPLICIT_ROUTINE: "tier_honor_explicit_routine",
  TIER_ROUTE_UNKNOWN_OPENAI: "tier_route_unknown_openai",
} as const;

const DEFAULT_TIER_CONFIG: TierConfig = {
  tiers: {
    // Operator's allowed-model list (no Sonnet, no Haiku). Claude Code's
    // non-brain tiers use near-free Anthropic-standard models, since
    // gpt-5.5i-compact is OpenAI-standard and can't serve /v1/messages.
    // Kept in sync with migration 1784120600000_tier_maps_allowed_models.sql,
    // which forces these into prod (these are only unset-key fallbacks).
    anthropic: {
      brain: "claude-opus-4-8", // plan/think/investigate
      build: "mimo-v2.5-pro",   // execute a plan -- near-free
      routine: "MiniMax-M3",    // read/run -- near-free
    },
    openai: {
      brain: "gpt-5.6-sol",
      build: "gpt-5.5i-compact",   // workhorse; overwrites sonnet/luna-class
      routine: "gpt-5.5i-compact",
    },
  },
  longContextTokens: 60_000,
  shortTurnTokens: 1_500,
  mode: "smart",
  honorExplicitRoutine: false,
  smallFastModelName: "claude-haiku-4-5",
  routeUnknownOpenai: true,
};

/**
 * Runtime config the admin manages through the dashboard instead of Railway
 * env vars (currently just the issued-key prefix -- the upstream provider
 * config that used to live here now lives in reseller_providers, see
 * src/lib/router.ts). Small and rarely-changed, so it's cached in-process and
 * poll-refreshed, same pattern as PriceCache -- invalidated immediately on
 * admin write.
 */
export class SettingsCache {
  private cache = new Map<string, string>();
  private lastRefresh = 0;
  private readonly ttlMs = 30_000;

  constructor(private pg: Pool) {}

  async refresh(): Promise<void> {
    const { rows } = await this.pg.query("SELECT key, value FROM reseller_settings");
    this.cache = new Map(rows.map((r) => [r.key, r.value]));
    this.lastRefresh = Date.now();
  }

  invalidate(): void {
    this.lastRefresh = 0;
  }

  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.lastRefresh > this.ttlMs) {
      await this.refresh();
    }
  }

  async get(key: string): Promise<string | undefined> {
    await this.ensureFresh();
    return this.cache.get(key);
  }

  async getKeyPrefix(): Promise<string> {
    await this.ensureFresh();
    return this.cache.get(SETTINGS_KEYS.KEY_PREFIX) ?? "orbit";
  }

  async getTierConfig(): Promise<TierConfig> {
    await this.ensureFresh();
    const mode = this.cache.get(SETTINGS_KEYS.TIER_ROUTING_MODE);

    // Back-compat: legacy keys populate anthropic map if new keys unset
    const anthropicBrain = this.cache.get(SETTINGS_KEYS.TIER_MODEL_ANTHROPIC_BRAIN)
      ?? this.cache.get(SETTINGS_KEYS.TIER_MODEL_BRAIN)
      ?? DEFAULT_TIER_CONFIG.tiers.anthropic.brain;
    const anthropicBuild = this.cache.get(SETTINGS_KEYS.TIER_MODEL_ANTHROPIC_BUILD)
      ?? this.cache.get(SETTINGS_KEYS.TIER_MODEL_BUILD)
      ?? DEFAULT_TIER_CONFIG.tiers.anthropic.build;
    const anthropicRoutine = this.cache.get(SETTINGS_KEYS.TIER_MODEL_ANTHROPIC_ROUTINE)
      ?? this.cache.get(SETTINGS_KEYS.TIER_MODEL_ROUTINE)
      ?? DEFAULT_TIER_CONFIG.tiers.anthropic.routine;

    return {
      tiers: {
        anthropic: {
          brain: anthropicBrain,
          build: anthropicBuild,
          routine: anthropicRoutine,
        },
        openai: {
          brain: this.cache.get(SETTINGS_KEYS.TIER_MODEL_OPENAI_BRAIN) ?? DEFAULT_TIER_CONFIG.tiers.openai.brain,
          build: this.cache.get(SETTINGS_KEYS.TIER_MODEL_OPENAI_BUILD) ?? DEFAULT_TIER_CONFIG.tiers.openai.build,
          routine: this.cache.get(SETTINGS_KEYS.TIER_MODEL_OPENAI_ROUTINE) ?? DEFAULT_TIER_CONFIG.tiers.openai.routine,
        },
      },
      longContextTokens: Number(this.cache.get(SETTINGS_KEYS.TIER_LONG_CONTEXT_TOKENS) ?? DEFAULT_TIER_CONFIG.longContextTokens),
      shortTurnTokens: Number(this.cache.get(SETTINGS_KEYS.TIER_SHORT_TURN_TOKENS) ?? DEFAULT_TIER_CONFIG.shortTurnTokens),
      mode: mode === "honor_tier" ? "honor_tier" : "smart",
      honorExplicitRoutine: (this.cache.get(SETTINGS_KEYS.TIER_HONOR_EXPLICIT_ROUTINE) ?? String(DEFAULT_TIER_CONFIG.honorExplicitRoutine)) === "true",
      smallFastModelName: this.cache.get(SETTINGS_KEYS.TIER_SMALL_FAST_MODEL) ?? DEFAULT_TIER_CONFIG.smallFastModelName,
      routeUnknownOpenai: (this.cache.get(SETTINGS_KEYS.TIER_ROUTE_UNKNOWN_OPENAI) ?? String(DEFAULT_TIER_CONFIG.routeUnknownOpenai)) === "true",
    };
  }

  async set(pg: Pool, key: string, value: string): Promise<void> {
    await pg.query(
      `INSERT INTO reseller_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [key, value],
    );
    this.invalidate();
  }
}
