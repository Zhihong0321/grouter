import type { Pool, PoolClient } from "pg";
import {
  integerString,
  isRecord,
  parseSupplierJson,
  stringifySupplierJson,
  SubRouterClient,
  SubRouterError,
} from "./subrouterClient.js";

const SUPPLIER = "subrouter";
const PAGE_SIZE = 100;
const LOCK_NAME = "reseller_supplier_sync:subrouter";

export type SupplierSyncErrorType =
  | "already_running"
  | "invalid_record"
  | "reconciliation_failed"
  | "sync_failed";

export class SupplierSyncError extends Error {
  constructor(public readonly type: SupplierSyncErrorType, message: string) {
    super(message);
    this.name = "SupplierSyncError";
  }
}

export interface SupplierSyncOptions {
  pg: Pool;
  client: SubRouterClient;
  quotaPerUsd: string;
  now?: () => Date;
}

export interface SupplierSyncResult {
  supplier: typeof SUPPLIER;
  cutoff: string;
  fetchedCount: number;
  importedCount: number;
  totalStoredCount: number;
  reconciliationMatched: true;
  quotaUnits: string;
  tokenCount: string;
}

export interface MappedActivity {
  externalRecordKey: string;
  externalLogId: string;
  externalRequestId: string | null;
  externalCreatedAt: string;
  logType: string;
  content: string | null;
  tokenName: string | null;
  modelName: string | null;
  promptTokens: string;
  completionTokens: string;
  cacheTokens: string;
  quotaUnits: string;
  useTimeSeconds: string | null;
  isStream: boolean | null;
  channelId: string | null;
  channelName: string | null;
  externalTokenId: string | null;
  supplierGroup: string | null;
  providerName: string | null;
  billingSource: string | null;
  rawOtherJson: string | null;
  rawRecordJson: string;
  supplierUpdatedAt: string | null;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new SupplierSyncError("invalid_record", `${field} must be a string or null`);
  return value;
}

function requiredBooleanOrNull(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw new SupplierSyncError("invalid_record", `${field} must be a boolean or null`);
  return value;
}

function optionalInteger(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  try {
    return integerString(value, field);
  } catch {
    throw new SupplierSyncError("invalid_record", `${field} must be an exact integer or null`);
  }
}

function requiredInteger(value: unknown, field: string): string {
  try {
    return integerString(value, field);
  } catch {
    throw new SupplierSyncError("invalid_record", `${field} must be an exact integer`);
  }
}

function timestampFromSeconds(value: unknown, field: string): string {
  const exact = requiredInteger(value, field);
  const seconds = Number(exact);
  if (!Number.isSafeInteger(seconds)) throw new SupplierSyncError("invalid_record", `${field} is outside the timestamp range`);
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) throw new SupplierSyncError("invalid_record", `${field} is invalid`);
  return date.toISOString();
}

function optionalTimestampFromSeconds(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return timestampFromSeconds(value, field);
}

export function mapActivityRecord(record: Record<string, unknown>): MappedActivity {
  let rawOther: unknown = null;
  if (record.other !== null && record.other !== undefined && record.other !== "") {
    try {
      rawOther = typeof record.other === "string" ? parseSupplierJson(record.other) : record.other;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown parser error";
      throw new SupplierSyncError("invalid_record", `other must contain valid JSON: ${detail}`);
    }
    if (rawOther !== null && !isRecord(rawOther)) {
      throw new SupplierSyncError("invalid_record", "other must contain a JSON object or null");
    }
  }

  const other = isRecord(rawOther) ? rawOther : {};
  const externalLogId = requiredInteger(record.id, "id");
  const externalRequestId = optionalString(record.request_id, "request_id");
  const externalCreatedAt = timestampFromSeconds(record.created_at, "created_at");
  const logType = requiredInteger(record.type, "type");
  return {
    externalRecordKey: externalRequestId
      ? `request:${externalRequestId}`
      : `log:${externalLogId}:${externalCreatedAt}:${logType}`,
    externalLogId,
    externalRequestId,
    externalCreatedAt,
    logType,
    content: optionalString(record.content, "content"),
    tokenName: optionalString(record.token_name, "token_name"),
    modelName: optionalString(record.model_name, "model_name"),
    promptTokens: requiredInteger(record.prompt_tokens, "prompt_tokens"),
    completionTokens: requiredInteger(record.completion_tokens, "completion_tokens"),
    cacheTokens: optionalInteger(other.cache_tokens, "other.cache_tokens") ?? "0",
    quotaUnits: requiredInteger(record.quota, "quota"),
    useTimeSeconds: optionalInteger(record.use_time, "use_time"),
    isStream: requiredBooleanOrNull(record.is_stream, "is_stream"),
    channelId: optionalInteger(record.channel, "channel"),
    channelName: optionalString(record.channel_name, "channel_name"),
    externalTokenId: optionalInteger(record.token_id, "token_id"),
    supplierGroup: optionalString(record.group, "group"),
    providerName: optionalString(other.provider_name, "other.provider_name"),
    billingSource: optionalString(other.billing_source, "other.billing_source"),
    rawOtherJson: rawOther === null ? null : stringifySupplierJson(rawOther),
    rawRecordJson: stringifySupplierJson(record),
    supplierUpdatedAt: optionalTimestampFromSeconds(record.updated_at, "updated_at"),
  };
}

async function upsertActivityBatch(pg: PoolClient, records: MappedActivity[], quotaPerUsd: string): Promise<void> {
  if (records.length === 0) return;

  const values: unknown[] = [];
  const rows = records.map((record) => {
    const offset = values.length;
    values.push(
      SUPPLIER,
      record.externalRecordKey,
      record.externalLogId,
      record.externalRequestId,
      record.externalCreatedAt,
      record.logType,
      record.content,
      record.tokenName,
      record.modelName,
      record.promptTokens,
      record.completionTokens,
      record.cacheTokens,
      record.quotaUnits,
      quotaPerUsd,
      record.useTimeSeconds,
      record.isStream,
      record.channelId,
      record.channelName,
      record.externalTokenId,
      record.supplierGroup,
      record.providerName,
      record.billingSource,
      record.rawOtherJson,
      record.rawRecordJson,
      record.supplierUpdatedAt,
    );
    const p = (index: number) => `$${offset + index}`;
    return `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)}::timestamptz,${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},${p(11)},${p(12)},${p(13)},${p(14)},${p(15)},${p(16)},${p(17)},${p(18)},${p(19)},${p(20)},${p(21)},${p(22)},${p(23)}::jsonb,${p(24)}::jsonb,${p(25)}::timestamptz)`;
  });

  await pg.query(
    `INSERT INTO reseller_supplier_activity (
       supplier, external_record_key, external_log_id, external_request_id, external_created_at, log_type,
       content, token_name, model_name, prompt_tokens, completion_tokens, cache_tokens,
       quota_units, quota_per_usd, use_time_seconds, is_stream, channel_id, channel_name,
       external_token_id, supplier_group, provider_name, billing_source, raw_other,
       raw_record, supplier_updated_at
     ) VALUES ${rows.join(",")}
     ON CONFLICT (supplier, external_record_key) DO UPDATE SET
       external_log_id = EXCLUDED.external_log_id,
       external_request_id = EXCLUDED.external_request_id,
       external_created_at = EXCLUDED.external_created_at,
       log_type = EXCLUDED.log_type,
       content = EXCLUDED.content,
       token_name = EXCLUDED.token_name,
       model_name = EXCLUDED.model_name,
       prompt_tokens = EXCLUDED.prompt_tokens,
       completion_tokens = EXCLUDED.completion_tokens,
       cache_tokens = EXCLUDED.cache_tokens,
       quota_units = EXCLUDED.quota_units,
       quota_per_usd = EXCLUDED.quota_per_usd,
       use_time_seconds = EXCLUDED.use_time_seconds,
       is_stream = EXCLUDED.is_stream,
       channel_id = EXCLUDED.channel_id,
       channel_name = EXCLUDED.channel_name,
       external_token_id = EXCLUDED.external_token_id,
       supplier_group = EXCLUDED.supplier_group,
       provider_name = EXCLUDED.provider_name,
       billing_source = EXCLUDED.billing_source,
       raw_other = EXCLUDED.raw_other,
       raw_record = EXCLUDED.raw_record,
       supplier_updated_at = EXCLUDED.supplier_updated_at,
       last_synced_at = now()`,
    values,
  );
}

function maxCursor(records: MappedActivity[]): MappedActivity | undefined {
  return records.reduce<MappedActivity | undefined>((current, record) => {
    if (!current) return record;
    const timeComparison = record.externalCreatedAt.localeCompare(current.externalCreatedAt);
    if (timeComparison > 0) return record;
    if (timeComparison === 0 && BigInt(record.externalLogId) > BigInt(current.externalLogId)) return record;
    return current;
  }, undefined);
}

async function recordFailure(pg: Pool, error: unknown): Promise<void> {
  const errorType =
    error instanceof SubRouterError ? error.type :
    error instanceof SupplierSyncError ? error.type :
    "sync_failed";
  const message = error instanceof Error ? error.message : "Supplier synchronization failed";
  await pg.query(
    `INSERT INTO reseller_supplier_sync_state (supplier, last_attempt_at, last_error, last_error_type, updated_at)
     VALUES ($1, now(), $2, $3, now())
     ON CONFLICT (supplier) DO UPDATE SET
       last_attempt_at = now(),
       last_error = EXCLUDED.last_error,
       last_error_type = EXCLUDED.last_error_type,
       updated_at = now()`,
    [SUPPLIER, message, errorType],
  );
}

export async function syncAllSupplierActivity(options: SupplierSyncOptions): Promise<SupplierSyncResult> {
  const connection = await options.pg.connect();
  let lockAcquired = false;

  try {
    const lockResult = await connection.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [LOCK_NAME],
    );
    lockAcquired = lockResult.rows[0]?.acquired === true;
    if (!lockAcquired) throw new SupplierSyncError("already_running", "Another supplier synchronization is already running");

    await connection.query(
      `INSERT INTO reseller_supplier_sync_state (supplier, last_attempt_at, updated_at)
       VALUES ($1, now(), now())
       ON CONFLICT (supplier) DO UPDATE SET last_attempt_at = now(), last_error = NULL, last_error_type = NULL, updated_at = now()`,
      [SUPPLIER],
    );

    const beforeResult = await connection.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM reseller_supplier_activity WHERE supplier = $1",
      [SUPPLIER],
    );
    const beforeCount = BigInt(beforeResult.rows[0].count);

    const cutoffSeconds = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
    const cutoff = new Date(cutoffSeconds * 1000).toISOString();
    const allRecords: MappedActivity[] = [];
    let page = 1;
    let expectedTotal: number | undefined;

    for (;;) {
      const result = await options.client.listActivity({
        page,
        pageSize: PAGE_SIZE,
        startTimestamp: 0,
        endTimestamp: cutoffSeconds,
      });
      if (expectedTotal === undefined) expectedTotal = result.total;
      if (result.total !== expectedTotal) {
        throw new SupplierSyncError("sync_failed", "SubRouter changed the fixed-cutoff result count during pagination");
      }

      const mapped = result.items.map(mapActivityRecord);
      await upsertActivityBatch(connection, mapped, options.quotaPerUsd);
      allRecords.push(...mapped);

      if (allRecords.length >= expectedTotal) break;
      if (mapped.length === 0) throw new SupplierSyncError("sync_failed", "SubRouter pagination ended before the reported total");
      page += 1;
    }

    if (allRecords.length !== expectedTotal) {
      throw new SupplierSyncError("sync_failed", "SubRouter returned more activity records than its reported total");
    }

    const cursor = maxCursor(allRecords);
    const reconciliationStart = allRecords.length === 0
      ? 0
      : Math.max(0, Math.floor(new Date(allRecords.reduce((a, b) =>
        a.externalCreatedAt < b.externalCreatedAt ? a : b,
      ).externalCreatedAt).getTime() / 1000) - 1);

    const [account, stats] = await Promise.all([
      options.client.getAccount(),
      options.client.getStats(reconciliationStart, cutoffSeconds),
    ]);

    const totalsResult = await connection.query<{ quota: string; tokens: string }>(
      `SELECT
         COALESCE(SUM(quota_units), 0)::text AS quota,
         COALESCE(SUM(prompt_tokens + completion_tokens), 0)::text AS tokens
       FROM reseller_supplier_activity
       WHERE supplier = $1
         AND external_created_at >= to_timestamp($2)
         AND external_created_at <= to_timestamp($3)`,
      [SUPPLIER, reconciliationStart, cutoffSeconds],
    );
    const databaseQuota = totalsResult.rows[0].quota;
    const databaseTokens = totalsResult.rows[0].tokens;
    const reconciliationMatched =
      BigInt(stats.quota) === BigInt(databaseQuota) &&
      BigInt(stats.token) === BigInt(databaseTokens);

    if (!reconciliationMatched) {
      await connection.query(
        `UPDATE reseller_supplier_sync_state SET
           reconciliation_matched = false,
           reconciliation_expected_quota = $2,
           reconciliation_database_quota = $3,
           reconciliation_expected_tokens = $4,
           reconciliation_database_tokens = $5,
           updated_at = now()
         WHERE supplier = $1`,
        [SUPPLIER, stats.quota, databaseQuota, stats.token, databaseTokens],
      );
      throw new SupplierSyncError("reconciliation_failed", "Supplier activity totals did not reconcile");
    }

    const remainingQuota = integerString(account.quota, "account.quota");
    const usedQuota = integerString(account.used_quota, "account.used_quota");
    const requestCount = integerString(account.request_count, "account.request_count");
    const afterResult = await connection.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM reseller_supplier_activity WHERE supplier = $1",
      [SUPPLIER],
    );
    const afterCount = BigInt(afterResult.rows[0].count);
    const importedCount = Number(afterCount - beforeCount);

    await connection.query("BEGIN");
    try {
      await connection.query(
        `INSERT INTO reseller_supplier_account_state (
           supplier, remaining_quota_units, used_quota_units, request_count, quota_per_usd,
           supplier_user_id, last_fetched_at, raw_account_state
         ) VALUES ($1,$2,$3,$4,$5,$6,now(),$7::jsonb)
         ON CONFLICT (supplier) DO UPDATE SET
           remaining_quota_units = EXCLUDED.remaining_quota_units,
           used_quota_units = EXCLUDED.used_quota_units,
           request_count = EXCLUDED.request_count,
           quota_per_usd = EXCLUDED.quota_per_usd,
           supplier_user_id = EXCLUDED.supplier_user_id,
           last_fetched_at = EXCLUDED.last_fetched_at,
           raw_account_state = EXCLUDED.raw_account_state`,
        [SUPPLIER, remainingQuota, usedQuota, requestCount, options.quotaPerUsd, String(account.id), stringifySupplierJson(account)],
      );

      await connection.query(
        `UPDATE reseller_supplier_sync_state SET
           initial_backfill_complete = true,
           last_external_log_id = $2,
           last_external_created_at = $3::timestamptz,
           last_sync_cutoff = $4::timestamptz,
           last_success_at = now(),
           last_error = NULL,
           last_error_type = NULL,
           last_imported_count = $5,
           total_imported_count = $6,
           reconciliation_matched = true,
           reconciliation_expected_quota = $7,
           reconciliation_database_quota = $7,
           reconciliation_expected_tokens = $8,
           reconciliation_database_tokens = $8,
           updated_at = now()
         WHERE supplier = $1`,
        [
          SUPPLIER,
          cursor?.externalLogId ?? null,
          cursor?.externalCreatedAt ?? null,
          cutoff,
          importedCount,
          afterCount.toString(),
          stats.quota,
          stats.token,
        ],
      );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    }

    return {
      supplier: SUPPLIER,
      cutoff,
      fetchedCount: allRecords.length,
      importedCount,
      totalStoredCount: Number(afterCount),
      reconciliationMatched: true,
      quotaUnits: stats.quota,
      tokenCount: stats.token,
    };
  } catch (error) {
    if (!(error instanceof SupplierSyncError && error.type === "already_running")) {
      await recordFailure(options.pg, error).catch(() => undefined);
    }
    throw error;
  } finally {
    if (lockAcquired) await connection.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]).catch(() => undefined);
    connection.release();
  }
}
