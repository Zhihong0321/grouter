import type { FastifyPluginAsync } from "fastify";
import { requireAdmin } from "./auth.js";
import { SETTINGS_KEYS } from "../../lib/settings.js";
import { checkSubrouterHealth } from "../../lib/upstream.js";

interface UpdateSettingsBody {
  subrouterApiKey?: string;
  subrouterBaseUrl?: string;
  keyPrefix?: string;
}

interface TestSettingsBody {
  subrouterApiKey?: string;
  subrouterBaseUrl?: string;
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

  // Zero-cost provider health check: GET /v1/models on the subrouter, never
  // /v1/messages, so testing a key (or re-testing the saved one) never
  // spends tokens. Body fields let the dashboard test an unsaved key/URL
  // before committing them; omitted fields fall back to what's stored.
  app.post<{ Body: TestSettingsBody }>("/admin/api/settings/test", async (request) => {
    const storedApiKey = await app.settingsCache.get(SETTINGS_KEYS.SUBROUTER_API_KEY);
    const storedBaseUrl = await app.settingsCache.get(SETTINGS_KEYS.SUBROUTER_BASE_URL);

    const apiKey = request.body?.subrouterApiKey || storedApiKey;
    const baseUrl = request.body?.subrouterBaseUrl || storedBaseUrl;

    if (!apiKey || !baseUrl) {
      return { ok: false, latencyMs: 0, message: "Set an API key and base URL first" };
    }

    return checkSubrouterHealth({ apiKey, baseUrl });
  });
};

export default settingsRoutes;
