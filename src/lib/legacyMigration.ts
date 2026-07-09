import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";
import { encryptKey } from "./keyCrypto.js";
import type { SettingsCache } from "./settings.js";

// Raw keys of the pre-router product's single upstream config. Deliberately
// not exported from settings.ts (SETTINGS_KEYS) -- this migration is the only
// remaining reader/deleter of these two rows, ever.
const LEGACY_SUBROUTER_API_KEY = "subrouter_api_key";
const LEGACY_SUBROUTER_BASE_URL = "subrouter_base_url";

/**
 * One-time boot-time migration: the pre-router product stored a single
 * subrouter key/base URL in reseller_settings. On first boot after the
 * router ships, if that legacy config exists and no providers have been
 * created yet, convert it into a real provider row wired as the priority-1
 * route for every active Anthropic-standard model, then delete the legacy
 * settings rows so this never runs again (providers existing is itself the
 * "already migrated" marker -- no separate flag needed).
 */
export async function migrateLegacySubrouter(pg: Pool, settingsCache: SettingsCache, log: Pick<FastifyBaseLogger, "warn">): Promise<void> {
  const { rows: providerCountRows } = await pg.query("SELECT COUNT(*)::int AS n FROM reseller_providers");
  if (providerCountRows[0].n > 0) return;

  const { rows: settingsRows } = await pg.query(
    "SELECT key, value FROM reseller_settings WHERE key IN ($1, $2)",
    [LEGACY_SUBROUTER_API_KEY, LEGACY_SUBROUTER_BASE_URL],
  );
  const settingsMap = Object.fromEntries(settingsRows.map((r) => [r.key, r.value as string]));
  const apiKey = settingsMap[LEGACY_SUBROUTER_API_KEY];
  const baseUrl = settingsMap[LEGACY_SUBROUTER_BASE_URL];
  if (!apiKey || !baseUrl) return;

  log.warn("Legacy subrouter settings found with no providers configured -- migrating into a provider + routes (one-time)");

  const { rows: providerRows } = await pg.query(
    `INSERT INTO reseller_providers (name, standard, base_url, api_key_encrypted)
     VALUES ('Legacy subrouter', 'anthropic', $1, $2) RETURNING id`,
    [baseUrl, encryptKey(apiKey)],
  );
  const providerId = providerRows[0].id;

  const { rows: models } = await pg.query(
    "SELECT model_id FROM reseller_models WHERE standard = 'anthropic' AND active = true",
  );
  for (const model of models) {
    await pg.query(
      `INSERT INTO reseller_model_routes (model_id, provider_id, upstream_model_id, priority)
       VALUES ($1, $2, $1, 1)
       ON CONFLICT (model_id, provider_id) DO NOTHING`,
      [model.model_id, providerId],
    );
  }

  await pg.query("DELETE FROM reseller_settings WHERE key IN ($1, $2)", [LEGACY_SUBROUTER_API_KEY, LEGACY_SUBROUTER_BASE_URL]);
  settingsCache.invalidate();

  log.warn({ providerId, modelsWired: models.length }, "Legacy subrouter migration complete");
}
