import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { SubRouterClient } from "./subrouterClient.js";
import { syncAllSupplierActivity } from "./supplierSync.js";

/** Starts the supplier import outside proxy requests. */
export function scheduleSupplierActivitySync(app: FastifyInstance): void {
  if (
    env.NODE_ENV === "test"
    || !env.SUBROUTER_ACTIVITY_SYNC_ENABLED
    || !env.SUBROUTER_SESSION
    || !env.SUBROUTER_USER_ID
  ) return;

  const run = async () => {
    try {
      const result = await syncAllSupplierActivity({
        pg: app.pg,
        quotaPerUsd: String(env.SUBROUTER_QUOTA_PER_USD),
        client: new SubRouterClient({
          baseUrl: env.SUBROUTER_BASE_URL,
          session: env.SUBROUTER_SESSION!,
          userId: env.SUBROUTER_USER_ID!,
          timeoutMs: env.SUBROUTER_SYNC_REQUEST_TIMEOUT_MS,
        }),
      });
      app.log.info(
        { supplier: result.supplier, importedCount: result.importedCount, matchedUsageCount: result.matchedUsageCount },
        "Supplier activity and actual-cost reconciliation completed",
      );
    } catch (error) {
      // Sync errors are recorded in reseller_supplier_sync_state by the sync
      // itself and must never affect customer proxy traffic.
      app.log.error({ err: error }, "Supplier activity synchronization failed");
    }
  };

  const timer = setInterval(() => { void run(); }, env.SUBROUTER_ACTIVITY_SYNC_INTERVAL_SECONDS * 1000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
  void run();
}
