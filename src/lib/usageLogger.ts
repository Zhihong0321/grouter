import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { CapturedUsage } from "../types/anthropic.js";
import type { PriceCache } from "./pricing.js";
import { computeCostCents } from "./pricing.js";
import { decrementBudget } from "./budget.js";

export interface LogUsageParams {
  keyId: string;
  model: string;
  usage: CapturedUsage;
  latencyMs: number;
  statusCode: number;
  stream: boolean;
  providerId?: string;
  upstreamModelId?: string;
}

/**
 * Runs strictly after the client has already received its response (or, for
 * streaming, after the stream has ended) -- never on the latency-critical
 * path. Computes and stores per-category cost at write time so later admin
 * price edits never retroactively change historical billing figures.
 */
export async function logUsage(
  pg: Pool,
  redis: Redis,
  priceCache: PriceCache,
  params: LogUsageParams,
): Promise<void> {
  const price = await priceCache.get(params.model);
  if (!price) {
    // Should not happen -- the hot path already rejects unknown models
    // before forwarding. Log defensively rather than throwing off-path.
    console.error(`logUsage: no price entry for model "${params.model}", skipping cost computation`);
    return;
  }

  const cost = computeCostCents(params.usage, price);

  await pg.query(
    `INSERT INTO reseller_usage_logs (
      key_id, model,
      input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
      input_cost_cents, output_cost_cents, cache_write_cost_cents, cache_read_cost_cents, cost_cents,
      latency_ms, status_code, stream, provider_id, upstream_model_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      params.keyId,
      params.model,
      params.usage.inputTokens,
      params.usage.outputTokens,
      params.usage.cacheCreationInputTokens,
      params.usage.cacheReadInputTokens,
      cost.inputCostCents,
      cost.outputCostCents,
      cost.cacheWriteCostCents,
      cost.cacheReadCostCents,
      cost.totalCostCents,
      params.latencyMs,
      params.statusCode,
      params.stream,
      params.providerId ?? null,
      params.upstreamModelId ?? null,
    ],
  );

  await pg.query("UPDATE reseller_api_keys SET spent_cents = spent_cents + $1 WHERE id = $2", [cost.totalCostCents, params.keyId]);
  await decrementBudget(redis, params.keyId, cost.totalCostCents);
}
