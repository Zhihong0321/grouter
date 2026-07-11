import type { FastifyPluginAsync } from "fastify";
import { env } from "../../config/env.js";
import { SubRouterClient, SubRouterError } from "../../lib/subrouterClient.js";
import { requireAdmin } from "./auth.js";

function syncStateDto(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  return {
    supplier: row.supplier,
    initialBackfillComplete: row.initial_backfill_complete,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastExternalLogId: row.last_external_log_id,
    lastExternalCreatedAt: row.last_external_created_at,
    lastSyncCutoff: row.last_sync_cutoff,
    lastImportedCount: row.last_imported_count,
    totalImportedCount: row.total_imported_count,
    reconciliationMatched: row.reconciliation_matched,
    reconciliationExpectedQuota: row.reconciliation_expected_quota,
    reconciliationDatabaseQuota: row.reconciliation_database_quota,
    reconciliationExpectedTokens: row.reconciliation_expected_tokens,
    reconciliationDatabaseTokens: row.reconciliation_database_tokens,
    lastErrorType: row.last_error_type,
    lastError: row.last_error,
  };
}

const supplierSyncRoutes: FastifyPluginAsync = async (app) => {
  app.get("/admin/api/supplier-sync/status", { preHandler: requireAdmin }, async (_request, reply) => {
    const { rows } = await app.pg.query(
      "SELECT * FROM reseller_supplier_sync_state WHERE supplier = $1",
      ["subrouter"],
    );
    const sync = syncStateDto(rows[0]);

    if (!env.SUBROUTER_SESSION || !env.SUBROUTER_USER_ID) {
      return reply.code(503).send({
        supplier: "subrouter",
        configured: false,
        connected: false,
        sync,
        errorType: "not_configured",
        error: "SubRouter credentials are not configured",
      });
    }

    const client = new SubRouterClient({
      baseUrl: env.SUBROUTER_BASE_URL,
      session: env.SUBROUTER_SESSION,
      userId: env.SUBROUTER_USER_ID,
      timeoutMs: env.SUBROUTER_REQUEST_TIMEOUT_MS,
    });

    try {
      const result = await client.probeConnection();
      return { configured: true, sync, ...result };
    } catch (error) {
      const known = error instanceof SubRouterError;
      return reply.code(502).send({
        supplier: "subrouter",
        configured: true,
        connected: false,
        sync,
        checkedAt: new Date().toISOString(),
        errorType: known ? error.type : "unknown",
        error: known ? error.message : "SubRouter connection check failed",
      });
    }
  });
};

export default supplierSyncRoutes;
