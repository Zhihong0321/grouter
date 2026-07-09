import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { Pool } from "pg";

// Env vars must be set before src/config/env.ts is ever imported (it parses
// process.env eagerly at module load), so all app imports below are dynamic.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:55432/reseller";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters-long";
process.env.NODE_ENV = "test";

const noopLog = { warn: () => {} };

describe("migrateLegacySubrouter (requires local Postgres, see docker-compose.yml)", () => {
  let pg: Pool;
  let migrateLegacySubrouter: typeof import("../src/lib/legacyMigration.js").migrateLegacySubrouter;
  let SettingsCache: typeof import("../src/lib/settings.js").SettingsCache;

  beforeAll(async () => {
    ({ migrateLegacySubrouter } = await import("../src/lib/legacyMigration.js"));
    ({ SettingsCache } = await import("../src/lib/settings.js"));
    pg = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterEach(async () => {
    // Full reset so each test starts from "no providers, no legacy settings".
    await pg.query("DELETE FROM reseller_model_routes");
    await pg.query("DELETE FROM reseller_providers");
    await pg.query("DELETE FROM reseller_settings WHERE key IN ('subrouter_api_key', 'subrouter_base_url')");
  });

  afterAll(async () => {
    await pg.end();
  });

  it("does nothing when no legacy settings are present", async () => {
    const settingsCache = new SettingsCache(pg);
    await migrateLegacySubrouter(pg, settingsCache, noopLog);
    const { rows } = await pg.query("SELECT COUNT(*)::int AS n FROM reseller_providers");
    expect(rows[0].n).toBe(0);
  });

  it("converts legacy subrouter settings into a provider wired to every active anthropic model, then deletes the legacy settings", async () => {
    await pg.query(
      `INSERT INTO reseller_settings (key, value) VALUES ('subrouter_api_key', 'legacy-secret-key'), ('subrouter_base_url', 'https://legacy.example')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );

    const { rows: activeModels } = await pg.query("SELECT model_id FROM reseller_models WHERE standard = 'anthropic' AND active = true");
    expect(activeModels.length).toBeGreaterThan(0); // sanity: the router migration seeded these

    const settingsCache = new SettingsCache(pg);
    await migrateLegacySubrouter(pg, settingsCache, noopLog);

    const { rows: providers } = await pg.query("SELECT * FROM reseller_providers");
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe("Legacy subrouter");
    expect(providers[0].base_url).toBe("https://legacy.example");

    const { rows: routes } = await pg.query("SELECT * FROM reseller_model_routes WHERE provider_id = $1", [providers[0].id]);
    expect(routes).toHaveLength(activeModels.length);
    expect(routes.every((r: any) => r.priority === 1)).toBe(true);

    const { rows: settingsRows } = await pg.query("SELECT * FROM reseller_settings WHERE key IN ('subrouter_api_key', 'subrouter_base_url')");
    expect(settingsRows).toHaveLength(0);
  });

  it("is a no-op if a provider already exists (idempotent across repeated boots)", async () => {
    await pg.query(
      `INSERT INTO reseller_providers (name, standard, base_url, api_key_encrypted) VALUES ('Pre-existing', 'anthropic', 'https://existing.example', 'irrelevant-ciphertext')`,
    );
    await pg.query(
      `INSERT INTO reseller_settings (key, value) VALUES ('subrouter_api_key', 'legacy-secret-key'), ('subrouter_base_url', 'https://legacy.example')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );

    const settingsCache = new SettingsCache(pg);
    await migrateLegacySubrouter(pg, settingsCache, noopLog);

    const { rows: providers } = await pg.query("SELECT * FROM reseller_providers");
    expect(providers).toHaveLength(1); // still just the pre-existing one -- migration skipped
    expect(providers[0].name).toBe("Pre-existing");

    // Legacy settings are left alone since the migration never ran.
    const { rows: settingsRows } = await pg.query("SELECT * FROM reseller_settings WHERE key IN ('subrouter_api_key', 'subrouter_base_url')");
    expect(settingsRows).toHaveLength(2);
  });
});
