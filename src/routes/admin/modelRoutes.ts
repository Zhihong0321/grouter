import type { FastifyPluginAsync } from "fastify";
import { requireAdmin } from "./auth.js";

interface RouteInput {
  providerId: string;
  upstreamModelId: string;
  priority: number;
}

interface PriorityBody {
  providerIds: string[];
}

function rowToDto(row: any) {
  return {
    routeId: row.id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    standard: row.standard,
    upstreamModelId: row.upstream_model_id,
    priority: row.priority,
    active: row.active,
  };
}

const ROUTES_QUERY = `
  SELECT r.*, p.name AS provider_name, p.standard
  FROM reseller_model_routes r
  JOIN reseller_providers p ON p.id = r.provider_id
  WHERE r.model_id = $1
  ORDER BY r.priority ASC
`;

// Admin CRUD for which provider(s) serve a given catalog model, in priority
// order (priority 1 = primary, higher = failover backups). Always a
// replace-all write since the dashboard edits the whole ordered list at once.
const modelRoutesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", requireAdmin);

  app.get<{ Params: { modelId: string } }>("/admin/api/models/:modelId/routes", async (request) => {
    const { rows } = await app.pg.query(ROUTES_QUERY, [request.params.modelId]);
    return rows.map(rowToDto);
  });

  app.put<{ Params: { modelId: string }; Body: { routes: RouteInput[] } }>(
    "/admin/api/models/:modelId/routes",
    async (request, reply) => {
      const { modelId } = request.params;
      const routes = request.body.routes ?? [];

      const { rows: modelRows } = await app.pg.query("SELECT * FROM reseller_models WHERE model_id = $1", [modelId]);
      if (modelRows.length === 0) return reply.code(404).send({ error: "Model not found" });
      const model = modelRows[0];

      const priorities = routes.map((r) => r.priority);
      if (new Set(priorities).size !== priorities.length) {
        return reply.code(400).send({ error: "Priorities must be unique" });
      }
      const providerIds = routes.map((r) => r.providerId);
      if (new Set(providerIds).size !== providerIds.length) {
        return reply.code(400).send({ error: "Each provider may only appear once per model" });
      }

      if (routes.length > 0) {
        const { rows: providerRows } = await app.pg.query("SELECT id, standard FROM reseller_providers WHERE id = ANY($1)", [providerIds]);
        if (providerRows.length !== providerIds.length) {
          return reply.code(400).send({ error: "One or more providers not found" });
        }
        // A route may only link a model and provider that speak the same
        // standard -- irrelevant while every row is 'anthropic', but this
        // check becomes load-bearing the moment OpenAI-standard rows exist.
        if (providerRows.some((p) => p.standard !== model.standard)) {
          return reply.code(400).send({ error: `All providers must match the model's standard (${model.standard})` });
        }
      }

      const client = await app.pg.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM reseller_model_routes WHERE model_id = $1", [modelId]);
        for (const r of routes) {
          await client.query(
            `INSERT INTO reseller_model_routes (model_id, provider_id, upstream_model_id, priority)
             VALUES ($1, $2, $3, $4)`,
            [modelId, r.providerId, r.upstreamModelId || modelId, r.priority],
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      app.routerCache.invalidate();

      const { rows } = await app.pg.query(ROUTES_QUERY, [modelId]);
      return rows.map(rowToDto);
    },
  );

  // Reorder an existing route set without recreating it. This is important
  // for smart routing: a route that a sync has temporarily disabled must stay
  // disabled when an admin promotes another key to primary.
  app.put<{ Params: { modelId: string }; Body: PriorityBody }>(
    "/admin/api/models/:modelId/routes/priority",
    async (request, reply) => {
      const { modelId } = request.params;
      const providerIds = request.body.providerIds ?? [];
      const client = await app.pg.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<{ provider_id: string }>(
          "SELECT provider_id FROM reseller_model_routes WHERE model_id = $1 FOR UPDATE",
          [modelId],
        );
        const currentIds = rows.map((row) => row.provider_id);
        if (
          providerIds.length !== currentIds.length ||
          new Set(providerIds).size !== providerIds.length ||
          providerIds.some((id) => !currentIds.includes(id))
        ) {
          await client.query("ROLLBACK");
          return reply.code(400).send({ error: "Priority update must include every current route exactly once" });
        }

        // Avoid the (model_id, priority) uniqueness constraint while moving
        // the current primary down the list.
        await client.query("UPDATE reseller_model_routes SET priority = priority + 10000 WHERE model_id = $1", [modelId]);
        for (const [index, providerId] of providerIds.entries()) {
          await client.query(
            "UPDATE reseller_model_routes SET priority = $1 WHERE model_id = $2 AND provider_id = $3",
            [index + 1, modelId, providerId],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      app.routerCache.invalidate();
      const { rows } = await app.pg.query(ROUTES_QUERY, [modelId]);
      return rows.map(rowToDto);
    },
  );
};

export default modelRoutesRoutes;
