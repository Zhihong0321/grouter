import type { FastifyPluginAsync } from "fastify";
import { requireAdmin } from "./auth.js";
import { SETTINGS_KEYS } from "../../lib/settings.js";

interface UpdateSettingsBody {
  subrouterApiKey?: string;
  subrouterBaseUrl?: string;
  keyPrefix?: string;
}

function mask(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return "****";
  return `${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", requireAdmin);

  // The subrouter API key is never returned in plaintext once saved -- only
  // a masked form (like the client-key issuance flow) -- so the dashboard
  // can show "configured" state without re-exposing the secret on screen.
  app.get("/admin/api/settings", async () => {
    const apiKey = await app.settingsCache.get(SETTINGS_KEYS.SUBROUTER_API_KEY);
    const baseUrl = await app.settingsCache.get(SETTINGS_KEYS.SUBROUTER_BASE_URL);
    const keyPrefix = await app.settingsCache.getKeyPrefix();
    return {
      subrouterApiKeyMasked: mask(apiKey),
      subrouterConfigured: Boolean(apiKey && baseUrl),
      subrouterBaseUrl: baseUrl ?? null,
      keyPrefix,
    };
  });

  app.patch<{ Body: UpdateSettingsBody }>("/admin/api/settings", async (request) => {
    const { subrouterApiKey, subrouterBaseUrl, keyPrefix } = request.body;

    if (subrouterApiKey) {
      await app.settingsCache.set(app.pg, SETTINGS_KEYS.SUBROUTER_API_KEY, subrouterApiKey);
    }
    if (subrouterBaseUrl) {
      await app.settingsCache.set(app.pg, SETTINGS_KEYS.SUBROUTER_BASE_URL, subrouterBaseUrl);
    }
    if (keyPrefix) {
      await app.settingsCache.set(app.pg, SETTINGS_KEYS.KEY_PREFIX, keyPrefix);
    }

    const apiKey = await app.settingsCache.get(SETTINGS_KEYS.SUBROUTER_API_KEY);
    const baseUrl = await app.settingsCache.get(SETTINGS_KEYS.SUBROUTER_BASE_URL);
    return {
      subrouterApiKeyMasked: mask(apiKey),
      subrouterConfigured: Boolean(apiKey && baseUrl),
      subrouterBaseUrl: baseUrl ?? null,
      keyPrefix: await app.settingsCache.getKeyPrefix(),
    };
  });
};

export default settingsRoutes;
