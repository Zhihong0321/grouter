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
        `SELECT
           usage.*,
           activity.wallet_cost_usd::text AS actual_subrouter_cost_usd
         FROM reseller_usage_logs usage
         LEFT JOIN reseller_usage_supplier_matches usage_match
           ON usage_match.usage_log_id = usage.id
         LEFT JOIN reseller_supplier_activity activity
           ON activity.id = usage_match.supplier_activity_id
         WHERE usage.key_id = $1
         ORDER BY usage.created_at DESC
         LIMIT 50`,
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

  // Cost of goods sold is based only on the activity record SubRouter charged
  // us for. Retail cost_cents is intentionally kept separate as revenue.
  app.get("/admin/api/profit/by-key", async () => {
    const { rows } = await app.pg.query(
      `SELECT
         k.id AS key_id,
         k.name AS key_name,
         k.key_prefix,
         ca.username,
         COUNT(usage_match.usage_log_id)::text AS matched_request_count,
         COALESCE(SUM(activity.quota_units), 0)::text AS actual_quota_units,
         COALESCE(SUM(activity.wallet_cost_usd), 0)::text AS actual_cost_usd,
         (COALESCE(SUM(usage.cost_cents), 0) / 100)::text AS customer_revenue_usd,
         ((COALESCE(SUM(usage.cost_cents), 0) / 100) - COALESCE(SUM(activity.wallet_cost_usd), 0))::text AS gross_profit_usd,
         (
           SELECT COUNT(*)::text
           FROM reseller_usage_logs pending
           LEFT JOIN reseller_usage_supplier_matches pending_match ON pending_match.usage_log_id = pending.id
           WHERE pending.key_id = k.id AND pending_match.usage_log_id IS NULL
         ) AS pending_match_count
       FROM reseller_api_keys k
       LEFT JOIN reseller_client_accounts ca ON ca.id = k.account_id
       LEFT JOIN (
         reseller_usage_supplier_matches usage_match
         JOIN reseller_usage_logs usage ON usage.id = usage_match.usage_log_id
         JOIN reseller_supplier_activity activity ON activity.id = usage_match.supplier_activity_id
       ) ON usage.key_id = k.id
       WHERE k.deleted_at IS NULL
       GROUP BY k.id, ca.username
       ORDER BY COALESCE(SUM(activity.wallet_cost_usd), 0) DESC, k.created_at ASC`,
    );

    return rows.map((row) => ({
      keyId: row.key_id,
      keyName: row.key_name,
      keyPrefix: row.key_prefix,
      username: row.username,
      matchedRequestCount: row.matched_request_count,
      pendingMatchCount: row.pending_match_count,
      actualQuotaUnits: row.actual_quota_units,
      actualCostUsd: row.actual_cost_usd,
      customerRevenueUsd: row.customer_revenue_usd,
      grossProfitUsd: row.gross_profit_usd,
    }));
  });
};

export default usageRoutes;
