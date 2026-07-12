import type { Pool, PoolClient } from "pg";
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

interface SyncPricingResult {
  supplier: string;
  totalModels: number;
  updatedModels: number;
  skippedModels: number;
  syncedAt: string;
}

async function recordFailure(pg: Pool, error: unknown): Promise<void> {
  const errorType = error instanceof SubRouterError ? "client_error" : error instanceof SupplierPriceSyncError ? error.type : "unknown";
  const errorMessage = error instanceof Error ? error.message : "Price sync failed";

  await pg.query(
    `INSERT INTO reseller_supplier_price_sync_state (supplier, last_attempt_at, last_error_type, last_error, updated_at)
     VALUES ($1, now(), $2, $3, now())
     ON CONFLICT (supplier) DO UPDATE SET
       last_attempt_at = now(),
       last_error_type = $2,
       last_error = $3,
       updated_at = now()`,
    [SUPPLIER, errorType, errorMessage],
  );
}

export async function syncPricingFromSupplier(options: {
  pg: Pool;
  client: SubRouterClient;
  now?: () => Date;
}): Promise<SyncPricingResult> {
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

    const pricing = await options.client.listPricing();

    let updatedModels = 0;
    let skippedModels = 0;

    await connection.query("BEGIN");
    try {
      for (const model of pricing.models) {
        // Check if model exists in our catalog
        const { rows } = await connection.query("SELECT model_id FROM reseller_models WHERE model_id = $1", [model.model]);

        if (rows.length === 0) {
          skippedModels++;
          continue;
        }

        // Convert USD per million to cents per million
        const inputPriceCents = model.currency === "USD" ? Math.round(model.inputPricePerMillion * 100) : 0;
        const outputPriceCents = model.currency === "USD" ? Math.round(model.outputPricePerMillion * 100) : 0;

        // Update or insert price
        await connection.query(
          `INSERT INTO reseller_model_prices
             (model_id, input_price_cents_per_million, output_price_cents_per_million,
              cache_write_price_cents_per_million, cache_read_price_cents_per_million, updated_at)
           VALUES ($1, $2, $3, 0, 0, now())
           ON CONFLICT (model_id) DO UPDATE SET
             input_price_cents_per_million = $2,
             output_price_cents_per_million = $3,
             updated_at = now()`,
          [model.model, inputPriceCents, outputPriceCents],
        );

        updatedModels++;
      }

      await connection.query(
        `UPDATE reseller_supplier_price_sync_state SET
           last_success_at = now(),
           last_error_type = NULL,
           last_error = NULL,
           last_synced_model_count = $2,
           updated_at = now()
         WHERE supplier = $1`,
        [SUPPLIER, updatedModels],
      );

      await connection.query("COMMIT");

      return {
        supplier: SUPPLIER,
        totalModels: pricing.models.length,
        updatedModels,
        skippedModels,
        syncedAt: (options.now?.() ?? new Date()).toISOString(),
      };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    }
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
