import type { Pool } from "pg";
import type { CapturedUsage, CostBreakdown, ModelPrice } from "../types/anthropic.js";

/**
 * Four-term cost formula -- the only place cost is ever computed, so every
 * caller (hot path logging, dashboard recompute-free display) gets identical
 * numbers. Cache read/write are priced at their own rates, never folded into
 * input/output.
 */
export function computeCostCents(usage: CapturedUsage, price: ModelPrice): CostBreakdown {
  const inputCostCents = (usage.inputTokens / 1_000_000) * price.inputPriceCentsPerMillion;
  const outputCostCents = (usage.outputTokens / 1_000_000) * price.outputPriceCentsPerMillion;
  const cacheWriteCostCents = (usage.cacheCreationInputTokens / 1_000_000) * price.cacheWritePriceCentsPerMillion;
  const cacheReadCostCents = (usage.cacheReadInputTokens / 1_000_000) * price.cacheReadPriceCentsPerMillion;
  return {
    inputCostCents,
    outputCostCents,
    cacheWriteCostCents,
    cacheReadCostCents,
    totalCostCents: inputCostCents + outputCostCents + cacheWriteCostCents + cacheReadCostCents,
  };
}

function rowToModelPrice(row: any): ModelPrice {
  return {
    modelId: row.model_id,
    inputPriceCentsPerMillion: Number(row.input_price_cents_per_million),
    outputPriceCentsPerMillion: Number(row.output_price_cents_per_million),
    cacheWritePriceCentsPerMillion: Number(row.cache_write_price_cents_per_million),
    cacheReadPriceCentsPerMillion: Number(row.cache_read_price_cents_per_million),
    active: row.active,
  };
}

/**
 * The price table is tiny and changes rarely (admin edits only), so it's
 * cached in-process and poll-refreshed rather than round-tripping to
 * Postgres on every request. Invalidated immediately on admin write via
 * `invalidate()`.
 */
export class PriceCache {
  private cache = new Map<string, ModelPrice>();
  private lastRefresh = 0;
  private readonly ttlMs = 60_000;

  constructor(private pg: Pool) {}

  async refresh(): Promise<void> {
    const { rows } = await this.pg.query("SELECT * FROM reseller_model_prices");
    this.cache = new Map(rows.map((r) => [r.model_id, rowToModelPrice(r)]));
    this.lastRefresh = Date.now();
  }

  invalidate(): void {
    this.lastRefresh = 0;
  }

  async get(modelId: string): Promise<ModelPrice | undefined> {
    if (Date.now() - this.lastRefresh > this.ttlMs) {
      await this.refresh();
    }
    const price = this.cache.get(modelId);
    return price && price.active ? price : undefined;
  }
}
