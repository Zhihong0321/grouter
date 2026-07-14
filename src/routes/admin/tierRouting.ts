import type { FastifyPluginAsync } from "fastify";
import { requireAdmin } from "./auth.js";
import { SETTINGS_KEYS } from "../../lib/settings.js";

// Smart Routing Mode admin config -- tier->model map + thresholds. Deliberately
// NOT under /admin/api/smart-routing, since that path is already the
// provider-failover matrix (src/routes/admin/supplierSync.ts, src/lib/smartRouting.ts).
// See smart_routing_buildplan.md section 0.
interface UpdateTierConfigBody {
  // Legacy fields (now update anthropic map for back-compat)
  brainModel?: string;
  buildModel?: string;
  routineModel?: string;
  // Per-standard tier maps
  anthropicBrainModel?: string;
  anthropicBuildModel?: string;
  anthropicRoutineModel?: string;
  openaiBrainModel?: string;
  openaiBuildModel?: string;
  openaiRoutineModel?: string;
  // Thresholds and settings
  longContextTokens?: number;
  shortTurnTokens?: number;
  smallFastModelName?: string;
  mode?: "smart" | "honor_tier";
  honorExplicitRoutine?: boolean;
  routeUnknownOpenai?: boolean;
}

const tierRoutingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", requireAdmin);

  app.get("/admin/api/tier-routing/config", async () => {
    const tierConfig = await app.settingsCache.getTierConfig();
    return tierConfig;
  });

  app.patch<{ Body: UpdateTierConfigBody }>("/admin/api/tier-routing/config", async (request) => {
    const {
      brainModel,
      buildModel,
      routineModel,
      anthropicBrainModel,
      anthropicBuildModel,
      anthropicRoutineModel,
      openaiBrainModel,
      openaiBuildModel,
      openaiRoutineModel,
      longContextTokens,
      shortTurnTokens,
      smallFastModelName,
      mode,
      honorExplicitRoutine,
      routeUnknownOpenai,
    } = request.body;

    // Legacy fields update anthropic map (back-compat)
    if (brainModel) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_MODEL_ANTHROPIC_BRAIN, brainModel);
    if (buildModel) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_MODEL_ANTHROPIC_BUILD, buildModel);
    if (routineModel) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_MODEL_ANTHROPIC_ROUTINE, routineModel);

    // Per-standard tier maps
    if (anthropicBrainModel) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_MODEL_ANTHROPIC_BRAIN, anthropicBrainModel);
    if (anthropicBuildModel) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_MODEL_ANTHROPIC_BUILD, anthropicBuildModel);
    if (anthropicRoutineModel) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_MODEL_ANTHROPIC_ROUTINE, anthropicRoutineModel);
    if (openaiBrainModel) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_MODEL_OPENAI_BRAIN, openaiBrainModel);
    if (openaiBuildModel) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_MODEL_OPENAI_BUILD, openaiBuildModel);
    if (openaiRoutineModel) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_MODEL_OPENAI_ROUTINE, openaiRoutineModel);

    // Thresholds and settings
    if (longContextTokens !== undefined) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_LONG_CONTEXT_TOKENS, String(longContextTokens));
    if (shortTurnTokens !== undefined) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_SHORT_TURN_TOKENS, String(shortTurnTokens));
    if (smallFastModelName) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_SMALL_FAST_MODEL, smallFastModelName);
    if (mode) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_ROUTING_MODE, mode);
    if (honorExplicitRoutine !== undefined) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_HONOR_EXPLICIT_ROUTINE, String(honorExplicitRoutine));
    if (routeUnknownOpenai !== undefined) await app.settingsCache.set(app.pg, SETTINGS_KEYS.TIER_ROUTE_UNKNOWN_OPENAI, String(routeUnknownOpenai));

    const tierConfig = await app.settingsCache.getTierConfig();
    return tierConfig;
  });

  // Realized savings: SUM(cost_saved_cents) where the engine actually swapped
  // the model, grouped by client. See smart_routing_buildplan.md section 8.
  app.get("/admin/api/tier-routing/savings", async () => {
    const { rows } = await app.pg.query(
      `SELECT
         client,
         requested_model,
         chosen_model,
         count(*) AS overridden_request_count,
         COALESCE(sum(cost_baseline_cents), 0) AS cost_baseline_cents,
         COALESCE(sum(cost_saved_cents), 0) AS cost_saved_cents
       FROM reseller_request_logs
       WHERE smart_routing_enabled = true AND was_overridden = true
       GROUP BY client, requested_model, chosen_model
       ORDER BY sum(cost_saved_cents) DESC NULLS LAST`,
    );
    return rows;
  });
};

export default tierRoutingRoutes;
