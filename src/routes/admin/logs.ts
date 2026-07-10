import type { FastifyPluginAsync } from "fastify";
import { requireAdmin } from "./auth.js";

const logsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", requireAdmin);

  app.get<{ Querystring: { limit?: string; model?: string; outcome?: string; keyId?: string } }>(
    "/admin/api/logs",
    async (request) => {
      const limit = Math.min(Math.max(Number(request.query.limit) || 100, 1), 500);
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (request.query.model) {
        params.push(request.query.model);
        conditions.push(`l.model = $${params.length}`);
      }
      if (request.query.outcome) {
        params.push(request.query.outcome);
        conditions.push(`l.outcome = $${params.length}`);
      }
      if (request.query.keyId) {
        params.push(request.query.keyId);
        conditions.push(`l.key_id = $${params.length}`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(limit);

      const { rows } = await app.pg.query(
        `SELECT l.*, k.name AS key_name
         FROM reseller_request_logs l
         LEFT JOIN reseller_api_keys k ON k.id = l.key_id
         ${where}
         ORDER BY l.created_at DESC
         LIMIT $${params.length}`,
        params,
      );

      return rows;
    },
  );
};

export default logsRoutes;
