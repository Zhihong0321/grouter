import type { FastifyPluginAsync } from "fastify";
import { requireAdmin } from "./auth.js";
import { SETTINGS_KEYS } from "../../lib/settings.js";

// Smart Routing Mode admin config -- tier->model map + thresholds. Deliberately
// NOT under /admin/api/smart-routing, since that path is already the
// provider-failover matrix (src/routes/admin/supplierSync.ts, src/lib/smartRouting.ts).
// See smart_routing_buildplan.md section 0.
interface UpdateTierConfigBody {
  brainModel?: string;
  buildModel?: string;
  routineModel?: string;
  longContextTokens?: number;
  shortTurnTokens?: number;
  smallFastModelName?: string;
  mode?: "smart" | "honor_tier";
  honorExplicitRoutine?: boolean;
}

const tierRoutingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", requireAdmin);

  app.get("/admin/api/tier-routing/config", async () => {
    const tierConfig = await app.settingsCache.getTierConfig();
    const smallFastModelName = await app.settingsCache.getSmallFastModelName();
    return { ...tierConfig, smallFastModelName };
  });

  app.patch<{ Body: UpdateTierConfigBody }>("/admin/api/tier-routing/config", async (request) => {
    const { brainModel, buildModel, routineModel, longContextTokens, shortTurnTokens, smallFastModelName, mode, honorExplicitRoutine } = request.body;

    if (brainModel) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_MODEL_BRAIN, brainModel);
    if (buildModel) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_MODEL_BUILD, buildModel);
    if (routineModel) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_MODEL_ROUTINE, routineModel);
    if (longContextTokens !== undefined) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_LONG_CONTEXT_TOKENS, String(longContextTokens));
    if (shortTurnTokens !== undefined) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_SHORT_TURN_TOKENS, String(shortTurnTokens));
    if (smallFastModelName) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_SMALL_FAST_MODEL, smallFastModelName);
    if (mode) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_ROUTING_MODE, mode);
    if (honorExplicitRoutine !== undefined) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_HONOR_EXPLICIT_ROUTINE, String(honorExplicitRoutine));

    const tierConfig = await app.settingsCache.getTierConfig();
    return { ...tierConfig, smallFastModelName: await app.settingsCache.getSmallFastModelName() };
  });

  // Realized savings: SUM(cost_saved_cents) where the engine actually swapped
  // the model, grouped by client. See smart_routing_buildplan.md section 8.
  app.get("/admin/api/tier-routing/savings", async () => {
    const { rows } = await app.pg.query(
      `SELECT
         client,
         count(*) AS overridden_request_count,
         COALESCE(sum(cost_baseline_cents), 0) AS cost_baseline_cents,
         COALESCE(sum(cost_saved_cents), 0) AS cost_saved_cents
       FROM reseller_request_logs
       WHERE smart_routing_enabled = true AND was_overridden = true
       GROUP BY client`,
    );
    return rows;
  });
};

export default tierRoutingRoutes;
