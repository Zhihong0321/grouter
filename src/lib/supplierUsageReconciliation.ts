import type { Pool } from "pg";

const SUPPLIER = "subrouter";
const MATCH_WINDOW_SECONDS = 5;

export interface SupplierUsageReconciliationResult {
  matchedCount: number;
}

/**
 * SubRouter reports cached input in two observed forms. Anthropic-style logs
 * keep prompt_tokens exclusive of cache_tokens; some OpenAI-style logs include
 * the cache in prompt_tokens as well. Both forms are exact only when the
 * cache and completion fields also agree.
 */
export function supplierPromptMatchesUsage(
  supplierPromptTokens: bigint,
  usageInputTokens: bigint,
  usageCacheReadTokens: bigint,
): boolean {
  return supplierPromptTokens === usageInputTokens
    || supplierPromptTokens === usageInputTokens + usageCacheReadTokens;
}

/**
 * Matches only uniquely-identifiable pairs. A routed provider identifies the
 * hidden SubRouter token that actually served the request; legacy rows that
 * predate provider logging can still match, but only by their otherwise exact
 * model/token/time signature. An ambiguous row remains unmatched for a later
 * run instead of assigning supplier cost to the wrong customer key.
 */
export async function reconcileSupplierUsage(pg: Pool): Promise<SupplierUsageReconciliationResult> {
  const result = await pg.query<{ usage_log_id: string }>(
    `WITH candidates AS (
       SELECT
         u.id AS usage_log_id,
         s.id AS supplier_activity_id,
         ROUND(EXTRACT(EPOCH FROM (s.external_created_at - u.created_at)) * 1000)::integer AS time_delta_ms,
         COUNT(*) OVER (PARTITION BY u.id) AS candidate_count
       FROM reseller_usage_logs u
       JOIN reseller_supplier_activity s
         ON s.supplier = $1
        AND s.log_type = 2
        AND s.model_name = u.upstream_model_id
        AND s.external_created_at BETWEEN u.created_at - ($2 * interval '1 second')
                                      AND u.created_at + ($2 * interval '1 second')
        AND s.cache_tokens = u.cache_read_input_tokens
        AND s.completion_tokens = u.output_tokens
        AND (
          s.prompt_tokens = u.input_tokens
          OR s.prompt_tokens = u.input_tokens + u.cache_read_input_tokens
        )
        AND (
          u.provider_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM reseller_supplier_keys k
            WHERE k.supplier = $1
              AND k.external_token_id = s.external_token_id
              AND (k.provider_id = u.provider_id OR k.anthropic_provider_id = u.provider_id)
          )
        )
       LEFT JOIN reseller_usage_supplier_matches existing_usage
         ON existing_usage.usage_log_id = u.id
       LEFT JOIN reseller_usage_supplier_matches existing_activity
         ON existing_activity.supplier_activity_id = s.id
       WHERE existing_usage.usage_log_id IS NULL
         AND existing_activity.supplier_activity_id IS NULL
     )
     INSERT INTO reseller_usage_supplier_matches
       (usage_log_id, supplier_activity_id, match_method, time_delta_ms)
     SELECT usage_log_id, supplier_activity_id, 'exact_token_model_usage_time', time_delta_ms
     FROM candidates
     WHERE candidate_count = 1
     ON CONFLICT DO NOTHING
     RETURNING usage_log_id`,
    [SUPPLIER, MATCH_WINDOW_SECONDS],
  );

  return { matchedCount: result.rowCount ?? 0 };
}
