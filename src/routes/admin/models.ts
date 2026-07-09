import type { FastifyPluginAsync } from "fastify";
import { requireAdmin } from "./auth.js";

interface CreateModelBody {
  modelId: string;
  displayName: string;
  brand?: string;
  standard?: "anthropic" | "openai";
}

interface UpdateModelBody {
  displayName?: string;
  brand?: string;
  active?: boolean;
}

function rowToDto(row: any) {
  return {
    modelId: row.model_id,
    brand: row.brand,
    standard: row.standard,
    displayName: row.display_name,
    active: row.active,
    createdAt: row.created_at,
  };
}

const modelsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", requireAdmin);

  app.get("/admin/api/models", async () => {
    const { rows } = await app.pg.query("SELECT * FROM reseller_models ORDER BY brand ASC, model_id ASC");
    return rows.map(rowToDto);
  });

  // brand/standard default to Anthropic-only for this build -- see
  // implemenation_plan_0709.md §13 for when a picker is needed.
  app.post<{ Body: CreateModelBody }>("/admin/api/models", async (request, reply) => {
    const { modelId, displayName, brand = "Anthropic", standard = "anthropic" } = request.body;
    if (!modelId || !displayName) {
      return reply.code(400).send({ error: "modelId and displayName are required" });
    }

    const { rows } = await app.pg.query(
      `INSERT INTO reseller_models (model_id, brand, standard, display_name)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [modelId, brand, standard, displayName],
    );

    app.routerCache.invalidate();
    reply.code(201).send(rowToDto(rows[0]));
  });

  app.patch<{ Params: { modelId: string }; Body: UpdateModelBody }>("/admin/api/models/:modelId", async (request, reply) => {
    const { rows: existingRows } = await app.pg.query("SELECT * FROM reseller_models WHERE model_id = $1", [request.params.modelId]);
    if (existingRows.length === 0) return reply.code(404).send({ error: "Not found" });

    const current = existingRows[0];
    const { displayName = current.display_name, brand = current.brand, active = current.active } = request.body;

    const { rows } = await app.pg.query(
      `UPDATE reseller_models SET display_name = $1, brand = $2, active = $3 WHERE model_id = $4 RETURNING *`,
      [displayName, brand, active, request.params.modelId],
    );

    app.routerCache.invalidate();
    return rowToDto(rows[0]);
  });

  // Soft-disable rather than a hard delete -- historical usage_logs reference
  // the model by name (not a foreign key), so a model that's been billed
  // against should stay visible in the catalog, just no longer callable.
  app.delete<{ Params: { modelId: string } }>("/admin/api/models/:modelId", async (request, reply) => {
    const { rows } = await app.pg.query(
      "UPDATE reseller_models SET active = false WHERE model_id = $1 RETURNING *",
      [request.params.modelId],
    );
    if (rows.length === 0) return reply.code(404).send({ error: "Not found" });

    app.routerCache.invalidate();
    return rowToDto(rows[0]);
  });
};

export default modelsRoutes;
