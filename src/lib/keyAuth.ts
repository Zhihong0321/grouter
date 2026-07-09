import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { ApiKeyRecord } from "../types/apiKey.js";

const CACHE_TTL_SECONDS = 45;

function cacheKeyFor(hash: string): string {
  return `key:${hash}`;
}

function rowToRecord(row: any): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    keyHash: row.key_hash,
    keyPrefix: row.key_prefix,
    status: row.status,
    rateLimitRpm: row.rate_limit_rpm,
    budgetCents: Number(row.budget_cents),
    spentCents: Number(row.spent_cents),
    modelRestrictions: row.model_restrictions,
  };
}

/**
 * Cache-aside lookup by key hash. Accepted staleness: up to CACHE_TTL_SECONDS
 * after a revoke/edit on replicas that didn't receive the invalidation below
 * (no cross-replica pub/sub in v1 -- see plan for rationale).
 */
export async function lookupKeyByHash(pg: Pool, redis: Redis, hash: string): Promise<ApiKeyRecord | null> {
  const cached = await redis.get(cacheKeyFor(hash));
  if (cached) {
    return JSON.parse(cached) as ApiKeyRecord;
  }

  const { rows } = await pg.query("SELECT * FROM api_keys WHERE key_hash = $1", [hash]);
  if (rows.length === 0) return null;

  const record = rowToRecord(rows[0]);
  await redis.set(cacheKeyFor(hash), JSON.stringify(record), "EX", CACHE_TTL_SECONDS);
  return record;
}

/** Best-effort immediate invalidation -- called after any admin edit/revoke. */
export async function invalidateKeyCache(redis: Redis, hash: string): Promise<void> {
  await redis.del(cacheKeyFor(hash));
}
