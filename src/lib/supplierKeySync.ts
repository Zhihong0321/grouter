import type { Pool, PoolClient } from "pg";
import { decryptKey, encryptKey } from "./keyCrypto.js";
import { integerString, isRecord, stringifySupplierJson, SubRouterClient, SubRouterError, type SubRouterModelCatalog } from "./subrouterClient.js";

const SUPPLIER = "subrouter";
const PAGE_SIZE = 100;
const LOCK_NAME = "reseller_supplier_key_sync:subrouter";

export type SupplierKeySyncErrorType = "already_running" | "invalid_token" | "sync_failed";

export class SupplierKeySyncError extends Error {
  constructor(public readonly type: SupplierKeySyncErrorType, message: string) {
    super(message);
    this.name = "SupplierKeySyncError";
  }
}

export interface SupplierKeySyncOptions {
  pg: Pool;
  client: SubRouterClient;
  upstreamBaseUrl?: string;
  anthropicBaseUrl?: string;
  now?: () => Date;
}

export interface SupplierKeySyncResult {
  supplier: typeof SUPPLIER;
  keyCount: number;
  modelCount: number;
  restrictedKeyCount: number;
  routingProviderCount: number;
  syncedAt: string;
}

interface MappedSupplierKey {
  externalTokenId: string;
  name: string;
  status: number;
  keyCiphertext: string;
  keyLast4: string;
  userId: string | null;
  createdAt: string | null;
  accessedAt: string | null;
  expiresAt: string | null;
  remainingQuota: string | null;
  usedQuota: string | null;
  unlimitedQuota: boolean;
  modelLimitsEnabled: boolean;
  allowedModels: string[];
  allowIps: string | null;
  supplierGroup: string | null;
  crossGroupRetry: boolean | null;
  subrouterProviders: string | null;
  subrouterSortMode: string | null;
  rawTokenJson: string;
}

function fail(field: string, detail: string): never {
  throw new SupplierKeySyncError("invalid_token", `SubRouter token ${field} ${detail}`);
}

function requiredInteger(value: unknown, field: string): string {
  try {
    return integerString(value, field);
  } catch {
    return fail(field, "must be an exact integer");
  }
}

function requiredSafeInteger(value: unknown, field: string): number {
  const parsed = Number(requiredInteger(value, field));
  if (!Number.isSafeInteger(parsed)) return fail(field, "was outside the supported range");
  return parsed;
}

function optionalInteger(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredInteger(value, field);
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return fail(field, "must be a string or null");
  return value;
}

function optionalScalarString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fail(field, "must be a scalar or null");
}

function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return Boolean(value);
  return fail(field, "must be a boolean, 0, 1, or null");
}

function requiredBoolean(value: unknown, field: string): boolean {
  const result = optionalBoolean(value, field);
  if (result === null) return fail(field, "is required");
  return result;
}

function optionalSupplierTime(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  const seconds = Number(requiredInteger(value, field));
  if (!Number.isSafeInteger(seconds)) return fail(field, "was outside the supported range");
  // SubRouter uses zero/-1 to represent a missing access/expiry timestamp.
  if (seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return fail(field, "was invalid");
  return date.toISOString();
}

function parseAllowedModels(value: unknown, enabled: boolean): string[] {
  if (!enabled) return [];
  if (typeof value === "string") {
    return [...new Set(value.split(",").map((model) => model.trim()).filter(Boolean))];
  }
  if (Array.isArray(value) && value.every((model) => typeof model === "string")) {
    return [...new Set(value.map((model) => model.trim()).filter(Boolean))];
  }
  return fail("model_limits", "must be a comma-separated string or a string array when limits are enabled");
}

/** Maps a supplier token without ever persisting its plaintext in raw_token. */
export function mapSupplierToken(token: Record<string, unknown>): MappedSupplierKey {
  const plaintextKey = token.key;
  if (typeof plaintextKey !== "string" || plaintextKey.length === 0) {
    return fail("key", "must be a non-empty string");
  }
  const name = token.name;
  if (typeof name !== "string") return fail("name", "must be a string");

  const modelLimitsEnabled = requiredBoolean(token.model_limits_enabled, "model_limits_enabled");
  const { key: _key, ...safeRawToken } = token;
  return {
    externalTokenId: requiredInteger(token.id, "id"),
    name,
    status: requiredSafeInteger(token.status, "status"),
    keyCiphertext: encryptKey(plaintextKey),
    keyLast4: plaintextKey.slice(-4),
    userId: optionalInteger(token.user_id, "user_id"),
    createdAt: optionalSupplierTime(token.created_time, "created_time"),
    accessedAt: optionalSupplierTime(token.accessed_time, "accessed_time"),
    expiresAt: optionalSupplierTime(token.expired_time, "expired_time"),
    remainingQuota: optionalInteger(token.remain_quota, "remain_quota"),
    usedQuota: optionalInteger(token.used_quota, "used_quota"),
    unlimitedQuota: requiredBoolean(token.unlimited_quota, "unlimited_quota"),
    modelLimitsEnabled,
    allowedModels: parseAllowedModels(token.model_limits, modelLimitsEnabled),
    allowIps: optionalString(token.allow_ips, "allow_ips"),
    supplierGroup: optionalString(token.group, "group"),
    crossGroupRetry: optionalBoolean(token.cross_group_retry, "cross_group_retry"),
    subrouterProviders: optionalScalarString(token.subrouter_providers, "subrouter_providers"),
    subrouterSortMode: optionalScalarString(token.subrouter_sort_mode, "subrouter_sort_mode"),
    rawTokenJson: stringifySupplierJson(safeRawToken),
  };
}

function catalogModels(catalog: SubRouterModelCatalog): Map<string, string[]> {
  const grouped = new Map<string, Set<string>>();
  for (const [group, models] of Object.entries(catalog.groups)) {
    for (const candidate of models) {
      const modelId = candidate.trim();
      if (!modelId) throw new SupplierKeySyncError("sync_failed", `SubRouter model group ${group} contained an empty model ID`);
      const groups = grouped.get(modelId) ?? new Set<string>();
      groups.add(group);
      grouped.set(modelId, groups);
    }
  }
  return new Map([...grouped].map(([modelId, groups]) => [modelId, [...groups].sort()]));
}

async function fetchAllTokens(client: SubRouterClient): Promise<Record<string, unknown>[]> {
  const tokens: Record<string, unknown>[] = [];
  let expectedTotal: number | undefined;
  let page = 1;
  for (;;) {
    const result = await client.listTokens({ page, pageSize: PAGE_SIZE });
    if (expectedTotal === undefined) expectedTotal = result.total;
    if (result.total !== expectedTotal) {
      throw new SupplierKeySyncError("sync_failed", "SubRouter changed the token count during pagination");
    }
    tokens.push(...result.items);
    if (tokens.length >= expectedTotal) break;
    if (result.items.length === 0) {
      throw new SupplierKeySyncError("sync_failed", "SubRouter token pagination ended before its reported total");
    }
    page += 1;
  }
  if (tokens.length !== expectedTotal) {
    throw new SupplierKeySyncError("sync_failed", "SubRouter returned more token records than its reported total");
  }
  return tokens;
}

async function upsertToken(connection: PoolClient, key: MappedSupplierKey): Promise<{ id: string; providerId: string | null; anthropicProviderId: string | null }> {
  const { rows } = await connection.query<{ id: string; provider_id: string | null; anthropic_provider_id: string | null }>(
    `INSERT INTO reseller_supplier_keys (
       supplier, external_token_id, name, status, key_ciphertext, key_last4, user_id,
       created_at_supplier, accessed_at_supplier, expires_at_supplier, remaining_quota_units,
       used_quota_units, unlimited_quota, model_limits_enabled, allow_ips, supplier_group,
       cross_group_retry, subrouter_providers, subrouter_sort_mode, present_on_supplier, raw_token
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,$10::timestamptz,$11,$12,
       $13,$14,$15,$16,$17,$18,$19,true,$20::jsonb
     ) ON CONFLICT (supplier, external_token_id) DO UPDATE SET
       name = EXCLUDED.name,
       status = EXCLUDED.status,
       key_ciphertext = EXCLUDED.key_ciphertext,
       key_last4 = EXCLUDED.key_last4,
       user_id = EXCLUDED.user_id,
       created_at_supplier = EXCLUDED.created_at_supplier,
       accessed_at_supplier = EXCLUDED.accessed_at_supplier,
       expires_at_supplier = EXCLUDED.expires_at_supplier,
       remaining_quota_units = EXCLUDED.remaining_quota_units,
       used_quota_units = EXCLUDED.used_quota_units,
       unlimited_quota = EXCLUDED.unlimited_quota,
       model_limits_enabled = EXCLUDED.model_limits_enabled,
       allow_ips = EXCLUDED.allow_ips,
       supplier_group = EXCLUDED.supplier_group,
       cross_group_retry = EXCLUDED.cross_group_retry,
       subrouter_providers = EXCLUDED.subrouter_providers,
       subrouter_sort_mode = EXCLUDED.subrouter_sort_mode,
       present_on_supplier = true,
       raw_token = EXCLUDED.raw_token,
       last_synced_at = now()
     RETURNING id, provider_id, anthropic_provider_id`,
    [
      SUPPLIER, key.externalTokenId, key.name, key.status, key.keyCiphertext, key.keyLast4, key.userId,
      key.createdAt, key.accessedAt, key.expiresAt, key.remainingQuota, key.usedQuota,
      key.unlimitedQuota, key.modelLimitsEnabled, key.allowIps, key.supplierGroup,
      key.crossGroupRetry, key.subrouterProviders, key.subrouterSortMode, key.rawTokenJson,
    ],
  );
  return { id: rows[0].id, providerId: rows[0].provider_id, anthropicProviderId: rows[0].anthropic_provider_id };
}

async function ensureRoutingProvider(
  connection: PoolClient,
  params: {
    supplierKeyId: string;
    providerId: string | null;
    providerColumn: "provider_id" | "anthropic_provider_id";
    standard: "openai" | "anthropic";
    key: MappedSupplierKey;
    baseUrl: string;
  },
): Promise<void> {
  const name = `SubRouter · ${params.key.name} · ${params.standard === "anthropic" ? "Anthropic" : "OpenAI"}`;
  const active = params.key.status === 1;

  if (params.providerId) {
    const updated = await connection.query(
      `UPDATE reseller_providers
       SET name = $2, standard = $3, base_url = $4, api_key_encrypted = $5, active = $6
       WHERE id = $1`,
      [params.providerId, name, params.standard, params.baseUrl, params.key.keyCiphertext, active],
    );
    if (updated.rowCount === 1) return;
  }

  const created = await connection.query<{ id: string }>(
    `INSERT INTO reseller_providers (name, standard, base_url, api_key_encrypted, active)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, params.standard, params.baseUrl, params.key.keyCiphertext, active],
  );
  await connection.query(`UPDATE reseller_supplier_keys SET ${params.providerColumn} = $1 WHERE id = $2`, [created.rows[0].id, params.supplierKeyId]);
}

async function replaceKeyModels(connection: PoolClient, supplierKeyId: string, modelIds: string[]): Promise<void> {
  await connection.query("DELETE FROM reseller_supplier_key_models WHERE supplier_key_id = $1", [supplierKeyId]);
  for (const modelId of modelIds) {
    await connection.query(
      "INSERT INTO reseller_supplier_key_models (supplier_key_id, model_id) VALUES ($1, $2)",
      [supplierKeyId, modelId],
    );
  }
}

async function syncCatalog(connection: PoolClient, models: Map<string, string[]>): Promise<void> {
  await connection.query("UPDATE reseller_supplier_models SET present_on_supplier = false WHERE supplier = $1", [SUPPLIER]);
  for (const [modelId, groups] of models) {
    await connection.query(
      `INSERT INTO reseller_supplier_models (supplier, model_id, supplier_groups, present_on_supplier)
       VALUES ($1,$2,$3::jsonb,true)
       ON CONFLICT (supplier, model_id) DO UPDATE SET
         supplier_groups = EXCLUDED.supplier_groups,
         present_on_supplier = true,
         last_synced_at = now()`,
      [SUPPLIER, modelId, JSON.stringify(groups)],
    );
  }
}

async function recordFailure(pg: Pool, error: unknown): Promise<void> {
  const errorType = error instanceof SubRouterError || error instanceof SupplierKeySyncError ? error.type : "sync_failed";
  const message = error instanceof Error ? error.message : "SubRouter key synchronization failed";
  await pg.query(
    `INSERT INTO reseller_supplier_key_sync_state (supplier, last_attempt_at, last_error_type, last_error, updated_at)
     VALUES ($1,now(),$2,$3,now())
     ON CONFLICT (supplier) DO UPDATE SET
       last_attempt_at = now(), last_error_type = EXCLUDED.last_error_type,
       last_error = EXCLUDED.last_error, updated_at = now()`,
    [SUPPLIER, errorType, message],
  );
}

/** Fetches every SubRouter key and its allowed models, then atomically mirrors them locally. */
export async function syncAllSupplierKeys(options: SupplierKeySyncOptions): Promise<SupplierKeySyncResult> {
  const connection = await options.pg.connect();
  let lockAcquired = false;
  try {
    const lock = await connection.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [LOCK_NAME]);
    lockAcquired = lock.rows[0]?.acquired === true;
    if (!lockAcquired) throw new SupplierKeySyncError("already_running", "Another SubRouter key synchronization is already running");

    await connection.query(
      `INSERT INTO reseller_supplier_key_sync_state (supplier, last_attempt_at, updated_at)
       VALUES ($1,now(),now())
       ON CONFLICT (supplier) DO UPDATE SET last_attempt_at = now(), last_error_type = NULL, last_error = NULL, updated_at = now()`,
      [SUPPLIER],
    );

    const [tokens, catalog] = await Promise.all([fetchAllTokens(options.client), options.client.listModels()]);
    const keys = tokens.map(mapSupplierToken);
    const models = catalogModels(catalog);

    await connection.query("BEGIN");
    try {
      await connection.query("UPDATE reseller_supplier_keys SET present_on_supplier = false WHERE supplier = $1", [SUPPLIER]);
      await connection.query(
        `UPDATE reseller_providers p SET active = false
         FROM reseller_supplier_keys k
         WHERE k.supplier = $1 AND (k.provider_id = p.id OR k.anthropic_provider_id = p.id)`,
        [SUPPLIER],
      );
      for (const key of keys) {
        const localKey = await upsertToken(connection, key);
        await ensureRoutingProvider(connection, {
          supplierKeyId: localKey.id,
          providerId: localKey.providerId,
          providerColumn: "provider_id",
          standard: "openai",
          key,
          baseUrl: options.upstreamBaseUrl ?? "https://subrouter.ai",
        });
        await ensureRoutingProvider(connection, {
          supplierKeyId: localKey.id,
          providerId: localKey.anthropicProviderId,
          providerColumn: "anthropic_provider_id",
          standard: "anthropic",
          key,
          baseUrl: options.anthropicBaseUrl ?? options.upstreamBaseUrl ?? "https://subrouter.ai",
        });
      }
      await syncCatalog(connection, models);
      await connection.query(
        `UPDATE reseller_supplier_key_sync_state SET
           last_success_at = now(), last_error_type = NULL, last_error = NULL,
           last_key_count = $2, last_model_count = $3, updated_at = now()
         WHERE supplier = $1`,
        [SUPPLIER, keys.length, models.size],
      );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    }

    return {
      supplier: SUPPLIER,
      keyCount: keys.length,
      modelCount: models.size,
      restrictedKeyCount: keys.filter((key) => key.modelLimitsEnabled).length,
      routingProviderCount: keys.length * 2,
      syncedAt: (options.now?.() ?? new Date()).toISOString(),
    };
  } catch (error) {
    if (!(error instanceof SupplierKeySyncError && error.type === "already_running")) {
      await recordFailure(options.pg, error).catch(() => undefined);
    }
    throw error;
  } finally {
    if (lockAcquired) await connection.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(() => undefined);
    connection.release();
  }
}

export interface SupplierAvailableModelSyncOptions {
  pg: Pool;
  upstreamBaseUrl?: string;
  now?: () => Date;
}

export interface SupplierAvailableModelSyncResult {
  supplier: typeof SUPPLIER;
  keyCount: number;
  availableModelCount: number;
  addedToRoutingCatalog: number;
  alreadyInRoutingCatalog: number;
  conflictingModelIds: string[];
  syncedAt: string;
}

interface StoredSupplierKey {
  id: string;
  keyCiphertext: string;
}

function upstreamUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "")}/v1/models`;
}

async function fetchAvailableModels(key: StoredSupplierKey, upstreamBaseUrl: string): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(upstreamUrl(upstreamBaseUrl), {
      headers: { Accept: "application/json", Authorization: `Bearer ${decryptKey(key.keyCiphertext)}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new SupplierKeySyncError("sync_failed", `SubRouter key ${key.id} returned HTTP ${response.status} while listing models`);
    }
    const body = await response.json().catch(() => undefined) as { data?: unknown } | undefined;
    if (!Array.isArray(body?.data)) {
      throw new SupplierKeySyncError("sync_failed", `SubRouter key ${key.id} returned an invalid model list`);
    }
    const modelIds: string[] = [];
    for (const model of body.data) {
      const modelId = isRecord(model) ? model.id : undefined;
      if (typeof modelId !== "string" || modelId.trim().length === 0) {
        throw new SupplierKeySyncError("sync_failed", `SubRouter key ${key.id} returned a model without an ID`);
      }
      modelIds.push(modelId.trim());
    }
    return [...new Set(modelIds)].sort();
  } catch (error) {
    if (error instanceof SupplierKeySyncError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new SupplierKeySyncError("sync_failed", `SubRouter key ${key.id} timed out while listing models`);
    }
    throw new SupplierKeySyncError("sync_failed", `SubRouter key ${key.id} could not list models`);
  } finally {
    clearTimeout(timeout);
  }
}

async function recordModelFailure(pg: Pool, error: unknown): Promise<void> {
  const errorType = error instanceof SupplierKeySyncError ? error.type : "sync_failed";
  const message = error instanceof Error ? error.message : "SubRouter available-model synchronization failed";
  await pg.query(
    `INSERT INTO reseller_supplier_key_sync_state (
       supplier, last_model_sync_attempt_at, last_model_sync_error_type, last_model_sync_error, updated_at
     ) VALUES ($1,now(),$2,$3,now())
     ON CONFLICT (supplier) DO UPDATE SET
       last_model_sync_attempt_at = now(), last_model_sync_error_type = EXCLUDED.last_model_sync_error_type,
       last_model_sync_error = EXCLUDED.last_model_sync_error, updated_at = now()`,
    [SUPPLIER, errorType, message],
  );
}

/**
 * Calls `/v1/models` with every active mirrored supplier key. The resulting
 * per-key lists drive routing eligibility and their union is added to the
 * local OpenAI model catalog without changing pre-existing model standards.
 */
export async function syncAvailableModelsFromSupplierKeys(
  options: SupplierAvailableModelSyncOptions,
): Promise<SupplierAvailableModelSyncResult> {
  const connection = await options.pg.connect();
  let lockAcquired = false;
  try {
    const lock = await connection.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [LOCK_NAME]);
    lockAcquired = lock.rows[0]?.acquired === true;
    if (!lockAcquired) throw new SupplierKeySyncError("already_running", "Another SubRouter key synchronization is already running");

    await connection.query(
      `INSERT INTO reseller_supplier_key_sync_state (supplier, last_model_sync_attempt_at, updated_at)
       VALUES ($1,now(),now())
       ON CONFLICT (supplier) DO UPDATE SET
         last_model_sync_attempt_at = now(), last_model_sync_error_type = NULL, last_model_sync_error = NULL, updated_at = now()`,
      [SUPPLIER],
    );
    const { rows } = await connection.query<{ id: string; key_ciphertext: string }>(
      `SELECT id, key_ciphertext FROM reseller_supplier_keys
       WHERE supplier = $1 AND present_on_supplier = true AND status = 1
       ORDER BY id`,
      [SUPPLIER],
    );
    const keys: StoredSupplierKey[] = rows.map((row) => ({ id: row.id, keyCiphertext: row.key_ciphertext }));
    if (keys.length === 0) throw new SupplierKeySyncError("sync_failed", "No active SubRouter keys have been synchronized yet");

    const perKeyModels = await Promise.all(keys.map(async (key) => ({
      keyId: key.id,
      modelIds: await fetchAvailableModels(key, options.upstreamBaseUrl ?? "https://subrouter.ai"),
    })));
    const allModelIds = [...new Set(perKeyModels.flatMap((result) => result.modelIds))].sort();

    await connection.query("BEGIN");
    try {
      for (const result of perKeyModels) await replaceKeyModels(connection, result.keyId, result.modelIds);

      const { rows: existingRows } = await connection.query<{ model_id: string; standard: "anthropic" | "openai" }>(
        "SELECT model_id, standard FROM reseller_models WHERE model_id = ANY($1::text[])",
        [allModelIds],
      );
      const existing = new Map(existingRows.map((row) => [row.model_id, row.standard]));
      const newModelIds = allModelIds.filter((modelId) => !existing.has(modelId));
      const conflictingModelIds = allModelIds.filter((modelId) => existing.get(modelId) && existing.get(modelId) !== "openai");

      for (const modelId of newModelIds) {
        await connection.query(
          `INSERT INTO reseller_models (model_id, brand, standard, display_name)
           VALUES ($1, 'SubRouter', 'openai', $1)`,
          [modelId],
        );
        await connection.query(
          `INSERT INTO reseller_model_prices
             (model_id, input_price_cents_per_million, output_price_cents_per_million, cache_write_price_cents_per_million, cache_read_price_cents_per_million)
           VALUES ($1,0,0,0,0)`,
          [modelId],
        );
      }
      await connection.query(
        `UPDATE reseller_supplier_key_sync_state SET
           last_model_sync_success_at = now(), last_model_sync_error_type = NULL, last_model_sync_error = NULL,
           last_available_model_count = $2, updated_at = now()
         WHERE supplier = $1`,
        [SUPPLIER, allModelIds.length],
      );
      await connection.query("COMMIT");

      return {
        supplier: SUPPLIER,
        keyCount: keys.length,
        availableModelCount: allModelIds.length,
        addedToRoutingCatalog: newModelIds.length,
        alreadyInRoutingCatalog: allModelIds.length - newModelIds.length - conflictingModelIds.length,
        conflictingModelIds,
        syncedAt: (options.now?.() ?? new Date()).toISOString(),
      };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if (!(error instanceof SupplierKeySyncError && error.type === "already_running")) {
      await recordModelFailure(options.pg, error).catch(() => undefined);
    }
    throw error;
  } finally {
    if (lockAcquired) await connection.query("SELECT pg_advisory_unlock(hashtext($1)) AS acquired", [LOCK_NAME]).catch(() => undefined);
    connection.release();
  }
}
