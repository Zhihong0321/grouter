import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { ApiKeyRecord } from "../types/apiKey.js";

/**
 * Claude Code (and Anthropic-compatible clients generally) support two
 * separate env vars for custom gateways: ANTHROPIC_API_KEY (sent as
 * `x-api-key`) and ANTHROPIC_AUTH_TOKEN (sent as `Authorization: Bearer`,
 * meant for enterprise LLM gateways). Tools that manage those env vars don't
 * reliably let a user pick which one to use, so a real client can arrive
 * with either -- accept both rather than forcing one convention.
 */
export function extractApiKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const xApiKey = headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.length > 0) return xApiKey;

  const authorization = headers["authorization"];
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice("bearer ".length).trim();
    if (token.length > 0) return token;
  }

  return undefined;
}

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
    unlimited: row.unlimited,
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

  const { rows } = await pg.query("SELECT * FROM reseller_api_keys WHERE key_hash = $1", [hash]);
  if (rows.length === 0) return null;

  const record = rowToRecord(rows[0]);
  await redis.set(cacheKeyFor(hash), JSON.stringify(record), "EX", CACHE_TTL_SECONDS);
  return record;
}

/** Best-effort immediate invalidation -- called after any admin edit/revoke. */
export async function invalidateKeyCache(redis: Redis, hash: string): Promise<void> {
  await redis.del(cacheKeyFor(hash));
}
