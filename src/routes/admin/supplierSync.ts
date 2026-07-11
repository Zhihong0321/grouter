import type { FastifyPluginAsync } from "fastify";
import { env } from "../../config/env.js";
import { SubRouterClient, SubRouterError } from "../../lib/subrouterClient.js";
import { SupplierKeySyncError, syncAllSupplierKeys, syncAvailableModelsFromSupplierKeys } from "../../lib/supplierKeySync.js";
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

function keySyncStateDto(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  return {
    supplier: row.supplier,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastErrorType: row.last_error_type,
    lastError: row.last_error,
    lastKeyCount: Number(row.last_key_count ?? 0),
    lastModelCount: Number(row.last_model_count ?? 0),
    lastModelSyncAttemptAt: row.last_model_sync_attempt_at,
    lastModelSyncSuccessAt: row.last_model_sync_success_at,
    lastModelSyncErrorType: row.last_model_sync_error_type,
    lastModelSyncError: row.last_model_sync_error,
    lastAvailableModelCount: Number(row.last_available_model_count ?? 0),
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

  app.get("/admin/api/supplier-sync/keys", { preHandler: requireAdmin }, async () => {
    const [keysResult, stateResult, catalogResult] = await Promise.all([
      app.pg.query(
        `SELECT
           k.id, k.external_token_id, k.name, k.status, k.key_last4,
           k.remaining_quota_units, k.used_quota_units, k.unlimited_quota,
           k.model_limits_enabled, k.supplier_group, k.expires_at_supplier,
           k.accessed_at_supplier, k.present_on_supplier, k.last_synced_at,
           COALESCE(json_agg(m.model_id ORDER BY m.model_id) FILTER (WHERE m.model_id IS NOT NULL), '[]'::json) AS allowed_models
         FROM reseller_supplier_keys k
         LEFT JOIN reseller_supplier_key_models m ON m.supplier_key_id = k.id
         WHERE k.supplier = $1
         GROUP BY k.id
         ORDER BY k.present_on_supplier DESC, k.name ASC`,
        ["subrouter"],
      ),
      app.pg.query("SELECT * FROM reseller_supplier_key_sync_state WHERE supplier = $1", ["subrouter"]),
      app.pg.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM reseller_supplier_models WHERE supplier = $1 AND present_on_supplier = true",
        ["subrouter"],
      ),
    ]);

    return {
      supplier: "subrouter",
      sync: keySyncStateDto(stateResult.rows[0]),
      catalogModelCount: Number(catalogResult.rows[0]?.count ?? 0),
      keys: keysResult.rows.map((row) => ({
        id: row.id,
        externalTokenId: String(row.external_token_id),
        name: row.name,
        status: row.status,
        keyLast4: row.key_last4,
        remainingQuotaUnits: row.remaining_quota_units,
        usedQuotaUnits: row.used_quota_units,
        unlimitedQuota: row.unlimited_quota,
        modelLimitsEnabled: row.model_limits_enabled,
        allowedModels: row.allowed_models,
        supplierGroup: row.supplier_group,
        expiresAt: row.expires_at_supplier,
        accessedAt: row.accessed_at_supplier,
        presentOnSupplier: row.present_on_supplier,
        lastSyncedAt: row.last_synced_at,
      })),
    };
  });

  // This is deliberately a one-way import: it never creates, edits, or
  // revokes any supplier key on SubRouter.
  app.post("/admin/api/supplier-sync/keys", { preHandler: requireAdmin }, async (_request, reply) => {
    if (!env.SUBROUTER_SESSION || !env.SUBROUTER_USER_ID) {
      return reply.code(503).send({
        supplier: "subrouter",
        synchronized: false,
        errorType: "not_configured",
        error: "SubRouter credentials are not configured",
      });
    }

    const client = new SubRouterClient({
      baseUrl: env.SUBROUTER_BASE_URL,
      session: env.SUBROUTER_SESSION,
      userId: env.SUBROUTER_USER_ID,
      timeoutMs: env.SUBROUTER_SYNC_REQUEST_TIMEOUT_MS,
    });

    try {
      const result = await syncAllSupplierKeys({ pg: app.pg, client, upstreamBaseUrl: env.SUBROUTER_UPSTREAM_BASE_URL });
      return { synchronized: true, ...result };
    } catch (error) {
      const known = error instanceof SubRouterError || error instanceof SupplierKeySyncError;
      return reply.code(error instanceof SupplierKeySyncError && error.type === "already_running" ? 409 : 502).send({
        supplier: "subrouter",
        synchronized: false,
        errorType: known ? error.type : "unknown",
        error: known ? error.message : "SubRouter key synchronization failed",
      });
    }
  });

  app.post("/admin/api/supplier-sync/available-models", { preHandler: requireAdmin }, async (_request, reply) => {
    try {
      const result = await syncAvailableModelsFromSupplierKeys({
        pg: app.pg,
        upstreamBaseUrl: env.SUBROUTER_UPSTREAM_BASE_URL,
      });
      app.routerCache.invalidate();
      app.priceCache.invalidate();
      return { synchronized: true, ...result };
    } catch (error) {
      const known = error instanceof SupplierKeySyncError;
      return reply.code(error instanceof SupplierKeySyncError && error.type === "already_running" ? 409 : 502).send({
        supplier: "subrouter",
        synchronized: false,
        errorType: known ? error.type : "unknown",
        error: known ? error.message : "SubRouter available-model synchronization failed",
      });
    }
  });
};

export default supplierSyncRoutes;
