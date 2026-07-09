import type { FastifyPluginAsync } from "fastify";
import { requireAdmin } from "./auth.js";

const RANGE_TO_DAYS: Record<string, number> = { "7d": 7, "30d": 30 };

const usageRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", requireAdmin);

  // Four-category breakdown (tokens + cost) for a key over a date range --
  // the authoritative accounting view; never re-derives cost against the
  // (possibly since-changed) current price table.
  app.get<{ Params: { id: string }; Querystring: { range?: string } }>(
    "/admin/api/keys/:id/usage",
    async (request) => {
      const days = RANGE_TO_DAYS[request.query.range ?? "7d"] ?? 7;

      const { rows: breakdown } = await app.pg.query(
        `SELECT
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
           COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
           COALESCE(SUM(input_cost_cents), 0) AS input_cost_cents,
           COALESCE(SUM(output_cost_cents), 0) AS output_cost_cents,
           COALESCE(SUM(cache_write_cost_cents), 0) AS cache_write_cost_cents,
           COALESCE(SUM(cache_read_cost_cents), 0) AS cache_read_cost_cents,
           COALESCE(SUM(cost_cents), 0) AS cost_cents,
           COUNT(*) AS request_count
         FROM reseller_usage_logs
         WHERE key_id = $1 AND created_at >= now() - ($2 || ' days')::interval`,
        [request.params.id, days],
      );

      const { rows: daily } = await app.pg.query(
        `SELECT date_trunc('day', created_at) AS day,
                COALESCE(SUM(cost_cents), 0) AS cost_cents,
                COALESCE(SUM(input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens), 0) AS total_tokens
         FROM reseller_usage_logs
         WHERE key_id = $1 AND created_at >= now() - ($2 || ' days')::interval
         GROUP BY day ORDER BY day ASC`,
        [request.params.id, days],
      );

      const { rows: recent } = await app.pg.query(
        `SELECT * FROM reseller_usage_logs WHERE key_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [request.params.id],
      );

      return { breakdown: breakdown[0], daily, recent };
    },
  );

  app.get("/admin/api/usage/summary", async () => {
    const { rows } = await app.pg.query(
      `SELECT COUNT(*) AS request_count, COALESCE(SUM(cost_cents), 0) AS cost_cents
       FROM reseller_usage_logs WHERE created_at >= now() - interval '30 days'`,
    );
    return rows[0];
  });
};

export default usageRoutes;
