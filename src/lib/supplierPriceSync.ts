import type { Pool } from "pg";
import type { SubRouterClient, SubRouterModelPrice, SubRouterProviderPrice } from "./subrouterClient.js";
import { SubRouterError } from "./subrouterClient.js";

const SUPPLIER = "subrouter";
const LOCK_NAME = "reseller_supplier_price_sync";

export type SupplierPriceSyncErrorType = "already_running" | "client_error" | "database_error" | "unknown";

export class SupplierPriceSyncError extends Error {
  constructor(
    public readonly type: SupplierPriceSyncErrorType,
    message: string,
  ) {
    super(message);
    this.name = "SupplierPriceSyncError";
  }
}

export interface SupplierPriceSyncResult {
  supplier: string;
  totalSupplierModels: number;
  syncedModelCount: number;
  matchedCount: number;
  fallbackCount: number;
  unpricedModelIds: string[];
  syncedAt: string;
}

/**
 * A key's supplier_group may be stored either as SubRouter's full group id
 * ("provider:mixmix123") or the bare slug ("mixmix123"); provider_prices uses
 * the "provider:" form. Normalise to the bare slug so a match works either way.
 */
function bareGroup(value: string): string {
  return value.startsWith("provider:") ? value.slice("provider:".length) : value;
}

/**
 * Pick the provider row to record as "our cost" for a model:
 *  1. Prefer a provider whose group matches one of our own keys' supplier_group
 *     (what we can actually route to) -- cheapest such match if several.
 *  2. Otherwise fall back to the globally cheapest provider, flagged as such.
 */
function pickProviderPrice(
  model: SubRouterModelPrice,
  keyGroups: Set<string>,
): { price: SubRouterProviderPrice; isFallback: boolean } | null {
  if (model.providerPrices.length === 0) return null;
  const matched = model.providerPrices.filter((p) => p.group && keyGroups.has(bareGroup(p.group)));
  if (matched.length > 0) {
    // providerPrices is already cheapest-first from the client.
    return { price: matched[0], isFallback: false };
  }
  return { price: model.providerPrices[0], isFallback: true };
}

async function recordFailure(pg: Pool, error: unknown): Promise<void> {
  const errorType = error instanceof SubRouterError ? "client_error" : error instanceof SupplierPriceSyncError ? error.type : "unknown";
  const errorMessage = error instanceof Error ? error.message : "Price sync failed";
  await pg.query(
    `INSERT INTO reseller_supplier_price_sync_state (supplier, last_attempt_at, last_error_type, last_error, updated_at)
     VALUES ($1, now(), $2, $3, now())
     ON CONFLICT (supplier) DO UPDATE SET
       last_attempt_at = now(), last_error_type = $2, last_error = $3, updated_at = now()`,
    [SUPPLIER, errorType, errorMessage],
  );
}

export async function syncPricingFromSupplier(options: {
  pg: Pool;
  client: SubRouterClient;
  now?: () => Date;
}): Promise<SupplierPriceSyncResult> {
  const connection = await options.pg.connect();
  let lockAcquired = false;

  try {
    const lockResult = await connection.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [LOCK_NAME],
    );
    lockAcquired = lockResult.rows[0]?.acquired === true;
    if (!lockAcquired) {
      throw new SupplierPriceSyncError("already_running", "A price sync is already in progress");
    }

    await connection.query(
      `INSERT INTO reseller_supplier_price_sync_state (supplier, last_attempt_at, updated_at)
       VALUES ($1, now(), now())
       ON CONFLICT (supplier) DO UPDATE SET last_attempt_at = now(), updated_at = now()`,
      [SUPPLIER],
    );

    // The set of provider groups our own subrouter keys can route to. Used to
    // record the cost we'd actually pay rather than an arbitrary provider's.
    const groupRows = await connection.query<{ supplier_group: string | null }>(
      "SELECT DISTINCT supplier_group FROM reseller_supplier_keys WHERE supplier = $1 AND present_on_supplier = true",
      [SUPPLIER],
    );
    const keyGroups = new Set(
      groupRows.rows.map((r) => r.supplier_group).filter((g): g is string => typeof g === "string" && g.length > 0),
    );

    // Only record costs for models we actually resell (present in the router
    // catalog), so the Prices page can show cost beside every retail row.
    const catalogRows = await connection.query<{ model_id: string }>("SELECT model_id FROM reseller_models");
    const catalog = new Set(catalogRows.rows.map((r) => r.model_id));

    const pricing = await options.client.listPricing();

    let matchedCount = 0;
    let fallbackCount = 0;
    let syncedModelCount = 0;
    const unpricedModelIds: string[] = [];

    await connection.query("BEGIN");
    try {
      // Refresh is authoritative: clear prior costs so removed providers/models
      // don't linger, then re-insert what the supplier reports right now.
      await connection.query("DELETE FROM reseller_supplier_model_costs WHERE supplier = $1", [SUPPLIER]);

      const byModel = new Map(pricing.models.map((m) => [m.model, m]));

      for (const modelId of catalog) {
        const model = byModel.get(modelId);
        if (!model) {
          unpricedModelIds.push(modelId);
          continue;
        }
        const picked = pickProviderPrice(model, keyGroups);
        if (!picked) {
          unpricedModelIds.push(modelId);
          continue;
        }
        const { price, isFallback } = picked;
        await connection.query(
          `INSERT INTO reseller_supplier_model_costs
             (supplier, model_id, matched_group, provider_name, is_fallback,
              input_price, output_price, cache_read_price, cache_creation_price,
              currency, official_input_price, official_output_price, last_synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())`,
          [
            SUPPLIER, modelId, price.group || null, price.providerName || null, isFallback,
            price.inputPrice, price.outputPrice, price.cacheReadPrice, price.cacheCreationPrice,
            price.currency, model.officialInputPrice, model.officialOutputPrice,
          ],
        );
        syncedModelCount += 1;
        if (isFallback) fallbackCount += 1;
        else matchedCount += 1;
      }

      await connection.query(
        `UPDATE reseller_supplier_price_sync_state SET
           last_success_at = now(), last_error_type = NULL, last_error = NULL,
           last_synced_model_count = $2, last_matched_count = $3, last_fallback_count = $4, updated_at = now()
         WHERE supplier = $1`,
        [SUPPLIER, syncedModelCount, matchedCount, fallbackCount],
      );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    }

    return {
      supplier: SUPPLIER,
      totalSupplierModels: pricing.models.length,
      syncedModelCount,
      matchedCount,
      fallbackCount,
      unpricedModelIds,
      syncedAt: (options.now?.() ?? new Date()).toISOString(),
    };
  } catch (error) {
    if (!(error instanceof SupplierPriceSyncError && error.type === "already_running")) {
      await recordFailure(options.pg, error).catch(() => undefined);
    }
    throw error;
  } finally {
    if (lockAcquired) {
      await connection.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(() => undefined);
    }
    connection.release();
  }
}
