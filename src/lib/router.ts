import type { Pool } from "pg";
import { decryptKey } from "./keyCrypto.js";
import type { ModelCatalogEntry, ResolvedRoute } from "../types/router.js";

function rowToModel(row: any): ModelCatalogEntry {
  return {
    modelId: row.model_id,
    brand: row.brand,
    standard: row.standard,
    displayName: row.display_name,
    active: row.active,
  };
}

/**
 * Caches the model catalog and each model's provider routes in-process,
 * refreshed on a TTL and invalidated immediately on admin writes -- same
 * pattern as PriceCache/SettingsCache. Routes are pre-joined with their
 * (decrypted) provider and pre-sorted by priority so the request hot path
 * never touches SQL or re-decrypts a key per request.
 */
export class RouterCache {
  private models = new Map<string, ModelCatalogEntry>();
  private routesByModel = new Map<string, ResolvedRoute[]>();
  private lastRefresh = 0;
  private readonly ttlMs = 30_000;

  constructor(private pg: Pool) {}

  async refresh(): Promise<void> {
    const { rows: modelRows } = await this.pg.query("SELECT * FROM reseller_models");
    this.models = new Map(modelRows.map((r) => [r.model_id, rowToModel(r)]));

    const { rows: routeRows } = await this.pg.query(
      `SELECT r.id AS route_id, r.model_id, r.provider_id, r.upstream_model_id, r.priority,
              p.name AS provider_name, p.standard, p.base_url, p.api_key_encrypted
       FROM reseller_model_routes r
       JOIN reseller_providers p ON p.id = r.provider_id
       WHERE r.active = true AND p.active = true
       ORDER BY r.model_id ASC, r.priority ASC`,
    );

    const byModel = new Map<string, ResolvedRoute[]>();
    for (const row of routeRows) {
      const list = byModel.get(row.model_id) ?? [];
      list.push({
        routeId: row.route_id,
        providerId: row.provider_id,
        providerName: row.provider_name,
        standard: row.standard,
        baseUrl: row.base_url,
        apiKey: decryptKey(row.api_key_encrypted),
        upstreamModelId: row.upstream_model_id,
        priority: row.priority,
      });
      byModel.set(row.model_id, list);
    }
    this.routesByModel = byModel;
    this.lastRefresh = Date.now();
  }

  invalidate(): void {
    this.lastRefresh = 0;
  }

  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.lastRefresh > this.ttlMs) {
      await this.refresh();
    }
  }

  async getModel(modelId: string): Promise<ModelCatalogEntry | undefined> {
    await this.ensureFresh();
    const model = this.models.get(modelId);
    return model && model.active ? model : undefined;
  }

  /** Routes for a model, active providers only, ordered priority 1 (primary) first. */
  async getRoutes(modelId: string): Promise<ResolvedRoute[]> {
    await this.ensureFresh();
    return this.routesByModel.get(modelId) ?? [];
  }
}
