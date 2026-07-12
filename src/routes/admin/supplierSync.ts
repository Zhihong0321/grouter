import type { FastifyPluginAsync } from "fastify";
import { env } from "../../config/env.js";
import { SubRouterClient, SubRouterError } from "../../lib/subrouterClient.js";
import { SupplierKeySyncError, syncAllSupplierKeys, syncAvailableModelsFromSupplierKeys } from "../../lib/supplierKeySync.js";
import { SupplierSyncError, syncAllSupplierActivity } from "../../lib/supplierSync.js";
import { SupplierPriceSyncError, syncPricingFromSupplier } from "../../lib/supplierPriceSync.js";
import { syncSmartRoutes } from "../../lib/smartRouting.js";
import { decryptKey } from "../../lib/keyCrypto.js";
import { checkProviderModel } from "../../lib/upstream.js";
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

function priceSyncStateDto(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  return {
    supplier: row.supplier,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastSyncedModelCount: Number(row.last_synced_model_count ?? 0),
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

  app.get("/admin/api/supplier-sync/activity", { preHandler: requireAdmin }, async () => {
    const [accountResult, stateResult, summaryResult, activityResult] = await Promise.all([
      app.pg.query("SELECT * FROM reseller_supplier_account_state WHERE supplier = $1", ["subrouter"]),
      app.pg.query("SELECT * FROM reseller_supplier_sync_state WHERE supplier = $1", ["subrouter"]),
      app.pg.query(
        `SELECT
           COUNT(*)::text AS activity_count,
           COALESCE(SUM(wallet_cost_usd), 0)::text AS total_cost_usd,
           COALESCE(SUM(prompt_tokens + completion_tokens), 0)::text AS total_tokens
         FROM reseller_supplier_activity WHERE supplier = $1`,
        ["subrouter"],
      ),
      app.pg.query(
        `SELECT external_created_at, token_name, model_name, prompt_tokens, completion_tokens,
                cache_tokens, wallet_cost_usd, supplier_group, provider_name, channel_name,
                external_request_id, external_log_id
         FROM reseller_supplier_activity
         WHERE supplier = $1
         ORDER BY external_created_at DESC, external_log_id DESC
         LIMIT 200`,
        ["subrouter"],
      ),
    ]);
    const account = accountResult.rows[0];
    const summary = summaryResult.rows[0];
    return {
      supplier: "subrouter",
      sync: syncStateDto(stateResult.rows[0]),
      account: account ? {
        remainingQuotaUnits: account.remaining_quota_units,
        usedQuotaUnits: account.used_quota_units,
        remainingWalletUsd: account.remaining_wallet_usd,
        usedWalletUsd: account.used_wallet_usd,
        requestCount: account.request_count,
        lastFetchedAt: account.last_fetched_at,
      } : null,
      summary: {
        activityCount: summary.activity_count,
        totalCostUsd: summary.total_cost_usd,
        totalTokens: summary.total_tokens,
      },
      activity: activityResult.rows.map((row) => ({
        createdAt: row.external_created_at,
        tokenName: row.token_name,
        modelName: row.model_name,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        cacheTokens: row.cache_tokens,
        costUsd: row.wallet_cost_usd,
        group: row.supplier_group,
        providerName: row.provider_name,
        channelName: row.channel_name,
        requestId: row.external_request_id,
        logId: row.external_log_id,
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
      const result = await syncAllSupplierKeys({
        pg: app.pg,
        client,
        upstreamBaseUrl: env.SUBROUTER_UPSTREAM_BASE_URL,
        anthropicBaseUrl: env.SUBROUTER_ANTHROPIC_BASE_URL,
      });
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

  // The dashboard's normal sync path: import keys, discover every key's live
  // model list, then pair every compatible model/key automatically.
  app.post("/admin/api/supplier-sync/smart-routing", { preHandler: requireAdmin }, async (_request, reply) => {
    if (!env.SUBROUTER_SESSION || !env.SUBROUTER_USER_ID) {
      return reply.code(503).send({ supplier: "subrouter", synchronized: false, errorType: "not_configured", error: "SubRouter credentials are not configured" });
    }
    const client = new SubRouterClient({
      baseUrl: env.SUBROUTER_BASE_URL,
      session: env.SUBROUTER_SESSION,
      userId: env.SUBROUTER_USER_ID,
      timeoutMs: env.SUBROUTER_SYNC_REQUEST_TIMEOUT_MS,
    });
    try {
      const keys = await syncAllSupplierKeys({
        pg: app.pg,
        client,
        upstreamBaseUrl: env.SUBROUTER_UPSTREAM_BASE_URL,
        anthropicBaseUrl: env.SUBROUTER_ANTHROPIC_BASE_URL,
      });
      const models = await syncAvailableModelsFromSupplierKeys({ pg: app.pg, upstreamBaseUrl: env.SUBROUTER_UPSTREAM_BASE_URL });
      const routes = await syncSmartRoutes(app.pg);
      app.routerCache.invalidate();
      app.priceCache.invalidate();
      return { synchronized: true, supplier: "subrouter", keys, models, routes };
    } catch (error) {
      const known = error instanceof SubRouterError || error instanceof SupplierKeySyncError;
      return reply.code(error instanceof SupplierKeySyncError && error.type === "already_running" ? 409 : 502).send({
        supplier: "subrouter", synchronized: false, errorType: known ? error.type : "unknown",
        error: known ? error.message : "SubRouter smart routing synchronization failed",
      });
    }
  });

  app.get("/admin/api/smart-routing", { preHandler: requireAdmin }, async () => {
    const { rows } = await app.pg.query(
      `SELECT m.model_id, m.brand, m.standard, m.display_name, m.active,
              COALESCE(json_agg(json_build_object(
                'routeId', r.id, 'providerId', p.id, 'providerName', p.name,
                'priority', r.priority, 'active', r.active AND p.active, 'routeActive', r.active,
                'upstreamModelId', r.upstream_model_id, 'keyLast4', k.key_last4,
                'smokeHistory', COALESCE((
                  SELECT json_agg(json_build_object(
                    'ok', smoke.ok, 'latencyMs', smoke.latency_ms,
                    'message', smoke.message, 'testedAt', smoke.tested_at
                  ) ORDER BY smoke.tested_at DESC, smoke.id DESC)
                  FROM (
                    SELECT id, ok, latency_ms, message, tested_at
                    FROM reseller_route_smoke_tests
                    WHERE model_id = r.model_id AND provider_id = r.provider_id
                    ORDER BY tested_at DESC, id DESC LIMIT 5
                  ) smoke
                ), '[]'::json)
              ) ORDER BY r.priority) FILTER (WHERE r.id IS NOT NULL), '[]'::json) AS routes
       FROM reseller_models m
       LEFT JOIN reseller_model_routes r ON r.model_id = m.model_id
       LEFT JOIN reseller_providers p ON p.id = r.provider_id
       LEFT JOIN reseller_supplier_keys k ON k.provider_id = p.id OR k.anthropic_provider_id = p.id
       GROUP BY m.model_id
       ORDER BY m.brand, m.model_id`,
    );
    return rows.map((row) => ({
      modelId: row.model_id,
      brand: row.brand,
      standard: row.standard,
      displayName: row.display_name,
      active: row.active,
      routes: row.routes,
    }));
  });

  // A deliberately bounded bulk check for the dashboard. Each test performs
  // a real minimal request, so three run in parallel to keep it reasonably
  // quick without overwhelming the supplier or consuming a burst of quota.
  app.post("/admin/api/smart-routing/smoke-test-all", { preHandler: requireAdmin }, async (_request, reply) => {
    const lock = await app.pg.connect();
    let lockAcquired = false;
    try {
      const result = await lock.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", ["reseller_route_smoke_test_all"]);
      lockAcquired = result.rows[0]?.acquired === true;
      if (!lockAcquired) return reply.code(409).send({ error: "A quick smoke test is already running" });

      const { rows: targets } = await app.pg.query<{
        model_id: string; provider_id: string; standard: "anthropic" | "openai"; base_url: string; api_key_encrypted: string; upstream_model_id: string;
      }>(
        `SELECT r.model_id, r.provider_id, p.standard, p.base_url, p.api_key_encrypted, r.upstream_model_id
         FROM reseller_model_routes r
         JOIN reseller_models m ON m.model_id = r.model_id
         JOIN reseller_providers p ON p.id = r.provider_id
         WHERE r.active = true AND m.active = true AND p.active = true
         ORDER BY r.model_id, r.priority`,
      );

      let next = 0;
      let passed = 0;
      let failed = 0;
      const runOne = async () => {
        for (;;) {
          const target = targets[next++];
          if (!target) return;
          const startedAt = Date.now();
          let ok = false;
          let latencyMs = 0;
          let statusCode: number | undefined;
          let message = "Unknown error";
          try {
            const check = await checkProviderModel(
              { standard: target.standard, baseUrl: target.base_url, apiKey: decryptKey(target.api_key_encrypted) },
              target.upstream_model_id,
            );
            // Some OpenAI-compatible suppliers expose only one of the two
            // OpenAI endpoints. A route is useful when at least one endpoint
            // accepts the model; show the individual endpoint detail in its
            // message instead of marking a working key dead.
            ok = check.results.some((item) => item.ok);
            latencyMs = Math.max(...check.results.map((item) => item.latencyMs));
            const failedEndpoint = check.results.find((item) => !item.ok);
            statusCode = failedEndpoint?.statusCode ?? check.results[0]?.statusCode;
            message = ok
              ? (failedEndpoint ? `Partial: ${failedEndpoint.endpoint} unavailable` : "OK")
              : failedEndpoint?.message ?? "All test endpoints failed";
          } catch (error) {
            latencyMs = Date.now() - startedAt;
            message = error instanceof Error ? error.message : "Smoke test failed";
          }

          await app.pg.query(
            `INSERT INTO reseller_route_smoke_tests (model_id, provider_id, standard, ok, latency_ms, status_code, message)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [target.model_id, target.provider_id, target.standard, ok, latencyMs, statusCode ?? null, message],
          );
          await app.pg.query(
            `DELETE FROM reseller_route_smoke_tests
             WHERE model_id = $1 AND provider_id = $2 AND id NOT IN (
               SELECT id FROM reseller_route_smoke_tests
               WHERE model_id = $1 AND provider_id = $2
               ORDER BY tested_at DESC, id DESC LIMIT 5
             )`,
            [target.model_id, target.provider_id],
          );
          if (ok) passed += 1;
          else failed += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, targets.length) }, runOne));
      return { tested: targets.length, passed, failed };
    } finally {
      if (lockAcquired) await lock.query("SELECT pg_advisory_unlock(hashtext($1))", ["reseller_route_smoke_test_all"]).catch(() => undefined);
      lock.release();
    }
  });

  app.post("/admin/api/supplier-sync/activity", { preHandler: requireAdmin }, async (_request, reply) => {
    if (!env.SUBROUTER_SESSION || !env.SUBROUTER_USER_ID) {
      return reply.code(503).send({ supplier: "subrouter", synchronized: false, errorType: "not_configured", error: "SubRouter credentials are not configured" });
    }
    const client = new SubRouterClient({
      baseUrl: env.SUBROUTER_BASE_URL,
      session: env.SUBROUTER_SESSION,
      userId: env.SUBROUTER_USER_ID,
      timeoutMs: env.SUBROUTER_SYNC_REQUEST_TIMEOUT_MS,
    });
    try {
      const result = await syncAllSupplierActivity({
        pg: app.pg,
        client,
        quotaPerUsd: String(env.SUBROUTER_QUOTA_PER_USD),
      });
      return { synchronized: true, ...result };
    } catch (error) {
      const known = error instanceof SubRouterError || error instanceof SupplierSyncError;
      return reply.code(error instanceof SupplierSyncError && error.type === "already_running" ? 409 : 502).send({
        supplier: "subrouter",
        synchronized: false,
        errorType: known ? error.type : "unknown",
        error: known ? error.message : "SubRouter activity synchronization failed",
      });
    }
  });

  // Sync pricing from SubRouter's pricing API
  app.get("/admin/api/supplier-sync/pricing", { preHandler: requireAdmin }, async () => {
    const { rows } = await app.pg.query(
      "SELECT * FROM reseller_supplier_price_sync_state WHERE supplier = $1",
      ["subrouter"],
    );
    return {
      supplier: "subrouter",
      sync: priceSyncStateDto(rows[0]),
    };
  });

  app.post("/admin/api/supplier-sync/pricing", { preHandler: requireAdmin }, async (_request, reply) => {
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
      const result = await syncPricingFromSupplier({
        pg: app.pg,
        client,
      });
      app.priceCache.invalidate();
      return { synchronized: true, ...result };
    } catch (error) {
      const known = error instanceof SubRouterError || error instanceof SupplierPriceSyncError;
      return reply.code(error instanceof SupplierPriceSyncError && error.type === "already_running" ? 409 : 502).send({
        supplier: "subrouter",
        synchronized: false,
        errorType: known ? error.type : "unknown",
        error: known ? error.message : "SubRouter pricing synchronization failed",
      });
    }
  });
};

export default supplierSyncRoutes;
