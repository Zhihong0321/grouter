import type { Pool } from "pg";
import type { SubRouterClient } from "./subrouterClient.js";
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
  /** Models we resell that got at least one provider price. */
  pricedModelCount: number;
  /** Total provider rows written across all models (primary + every backup). */
  providerRowCount: number;
  /** Provider rows whose group matches one of our own keys. */
  matchesOurKeyCount: number;
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

    // The set of provider groups our own subrouter keys can route to. Every
    // provider row that matches is flagged so the UI can mark "ours".
    const groupRows = await connection.query<{ supplier_group: string | null }>(
      "SELECT DISTINCT supplier_group FROM reseller_supplier_keys WHERE supplier = $1 AND present_on_supplier = true",
      [SUPPLIER],
    );
    const keyGroups = new Set(
      groupRows.rows.map((r) => r.supplier_group).filter((g): g is string => typeof g === "string" && g.length > 0).map(bareGroup),
    );

    // Only record costs for models we actually resell (present in the router
    // catalog), so the Prices page can show every provider beside each retail row.
    const catalogRows = await connection.query<{ model_id: string }>("SELECT model_id FROM reseller_models");
    const catalog = new Set(catalogRows.rows.map((r) => r.model_id));

    const pricing = await options.client.listPricing();

    let providerRowCount = 0;
    let matchesOurKeyCount = 0;
    let pricedModelCount = 0;
    const unpricedModelIds: string[] = [];

    await connection.query("BEGIN");
    try {
      // Refresh is authoritative: clear prior costs so removed providers/models
      // don't linger, then re-insert every provider the supplier reports now.
      await connection.query("DELETE FROM reseller_supplier_model_costs WHERE supplier = $1", [SUPPLIER]);

      const byModel = new Map(pricing.models.map((m) => [m.model, m]));

      for (const modelId of catalog) {
        const model = byModel.get(modelId);
        if (!model || model.providerPrices.length === 0) {
          unpricedModelIds.push(modelId);
          continue;
        }

        // providerPrices is cheapest-first from the client; rank preserves that
        // order so the UI can show primary (cheapest) then every backup.
        let rank = 0;
        for (const price of model.providerPrices) {
          rank += 1;
          const matchesOurKey = !!price.group && keyGroups.has(bareGroup(price.group));
          await connection.query(
            `INSERT INTO reseller_supplier_model_costs
               (supplier, model_id, provider_group, provider_name, price_rank, matches_our_key,
                input_price, output_price, cache_read_price, cache_creation_price,
                currency, region, official_input_price, official_output_price, last_synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
             ON CONFLICT (supplier, model_id, provider_group) DO UPDATE SET
               provider_name = EXCLUDED.provider_name, price_rank = EXCLUDED.price_rank,
               matches_our_key = EXCLUDED.matches_our_key,
               input_price = EXCLUDED.input_price, output_price = EXCLUDED.output_price,
               cache_read_price = EXCLUDED.cache_read_price, cache_creation_price = EXCLUDED.cache_creation_price,
               currency = EXCLUDED.currency, region = EXCLUDED.region,
               official_input_price = EXCLUDED.official_input_price, official_output_price = EXCLUDED.official_output_price,
               last_synced_at = now()`,
            [
              SUPPLIER, modelId, price.group || `unknown-${rank}`, price.providerName || null, rank, matchesOurKey,
              price.inputPrice, price.outputPrice, price.cacheReadPrice, price.cacheCreationPrice,
              price.currency, price.region ?? null, model.officialInputPrice, model.officialOutputPrice,
            ],
          );
          providerRowCount += 1;
          if (matchesOurKey) matchesOurKeyCount += 1;
        }
        pricedModelCount += 1;
      }

      await connection.query(
        `UPDATE reseller_supplier_price_sync_state SET
           last_success_at = now(), last_error_type = NULL, last_error = NULL,
           last_synced_model_count = $2, last_matched_count = $3, last_fallback_count = $4, updated_at = now()
         WHERE supplier = $1`,
        [SUPPLIER, pricedModelCount, matchesOurKeyCount, providerRowCount],
      );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    }

    return {
      supplier: SUPPLIER,
      totalSupplierModels: pricing.models.length,
      pricedModelCount,
      providerRowCount,
      matchesOurKeyCount,
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
