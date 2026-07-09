import type { FastifyPluginAsync } from "fastify";
import { requireAdmin } from "./auth.js";
import { SETTINGS_KEYS } from "../../lib/settings.js";

interface UpdateSettingsBody {
  keyPrefix?: string;
}

const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", requireAdmin);

  // The upstream provider config used to live here (a single subrouter key +
  // base URL); it now lives in reseller_providers, managed from the Router
  // page -- see src/routes/admin/providers.ts. This endpoint is left with
  // just the issued-key prefix.
  app.get("/admin/api/settings", async () => {
    return { keyPrefix: await app.settingsCache.getKeyPrefix() };
  });

  app.patch<{ Body: UpdateSettingsBody }>("/admin/api/settings", async (request) => {
    const { keyPrefix } = request.body;
    if (keyPrefix) {
      await app.settingsCache.set(app.pg, SETTINGS_KEYS.KEY_PREFIX, keyPrefix);
    }
    return { keyPrefix: await app.settingsCache.getKeyPrefix() };
  });
};

export default settingsRoutes;
