import type { Pool } from "pg";

export const SETTINGS_KEYS = {
  SUBROUTER_API_KEY: "subrouter_api_key",
  SUBROUTER_BASE_URL: "subrouter_base_url",
  KEY_PREFIX: "key_prefix",
} as const;

/**
 * Runtime config the admin manages through the dashboard instead of Railway
 * env vars (the subrouter key, its base URL, and the issued-key prefix).
 * Small and rarely-changed, so it's cached in-process and poll-refreshed,
 * same pattern as PriceCache -- invalidated immediately on admin write.
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

  async getSubrouterConfig(): Promise<{ apiKey: string; baseUrl: string } | undefined> {
    await this.ensureFresh();
    const apiKey = this.cache.get(SETTINGS_KEYS.SUBROUTER_API_KEY);
    const baseUrl = this.cache.get(SETTINGS_KEYS.SUBROUTER_BASE_URL);
    if (!apiKey || !baseUrl) return undefined;
    return { apiKey, baseUrl };
  }

  async getKeyPrefix(): Promise<string> {
    await this.ensureFresh();
    return this.cache.get(SETTINGS_KEYS.KEY_PREFIX) ?? "orbit";
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
