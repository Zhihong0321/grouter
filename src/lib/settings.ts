import type { Pool } from "pg";
import type { TierConfig } from "./tierRouting.js";

export const SETTINGS_KEYS = {
  KEY_PREFIX: "key_prefix",
  // Smart Routing Mode (tier-based model selection -- see src/lib/tierRouting.ts).
  // Not to be confused with the provider-failover "smart routing" sync (src/lib/smartRouting.ts).
  TIER_MODEL_BRAIN: "tier_model_brain",
  TIER_MODEL_BUILD: "tier_model_build",
  TIER_MODEL_ROUTINE: "tier_model_routine",
  TIER_LONG_CONTEXT_TOKENS: "tier_long_context_tokens",
  TIER_SHORT_TURN_TOKENS: "tier_short_turn_tokens",
  TIER_SMALL_FAST_MODEL: "tier_small_fast_model",
  TIER_ROUTING_MODE: "tier_routing_mode",
  TIER_HONOR_EXPLICIT_ROUTINE: "tier_honor_explicit_routine",
} as const;

const DEFAULT_TIER_CONFIG: TierConfig = {
  tiers: {
    brain: "claude-opus-4-8",
    build: "claude-sonnet-5",
    routine: "claude-haiku-4-5",
  },
  longContextTokens: 60_000,
  shortTurnTokens: 1_500,
  mode: "smart",
  honorExplicitRoutine: false,
};

const DEFAULT_SMALL_FAST_MODEL = "claude-haiku-4-5";

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
    return {
      tiers: {
        brain: this.cache.get(SETTINGS_KEYS.TIER_MODEL_BRAIN) ?? DEFAULT_TIER_CONFIG.tiers.brain,
        build: this.cache.get(SETTINGS_KEYS.TIER_MODEL_BUILD) ?? DEFAULT_TIER_CONFIG.tiers.build,
        routine: this.cache.get(SETTINGS_KEYS.TIER_MODEL_ROUTINE) ?? DEFAULT_TIER_CONFIG.tiers.routine,
      },
      longContextTokens: Number(this.cache.get(SETTINGS_KEYS.TIER_LONG_CONTEXT_TOKENS) ?? DEFAULT_TIER_CONFIG.longContextTokens),
      shortTurnTokens: Number(this.cache.get(SETTINGS_KEYS.TIER_SHORT_TURN_TOKENS) ?? DEFAULT_TIER_CONFIG.shortTurnTokens),
      mode: mode === "honor_tier" ? "honor_tier" : "smart",
      honorExplicitRoutine: (this.cache.get(SETTINGS_KEYS.TIER_HONOR_EXPLICIT_ROUTINE) ?? String(DEFAULT_TIER_CONFIG.honorExplicitRoutine)) === "true",
    };
  }

  async getSmallFastModelName(): Promise<string> {
    await this.ensureFresh();
    return this.cache.get(SETTINGS_KEYS.TIER_SMALL_FAST_MODEL) ?? DEFAULT_SMALL_FAST_MODEL;
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
