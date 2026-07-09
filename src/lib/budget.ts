import type { Pool } from "pg";
import type { Redis } from "ioredis";

const CACHE_TTL_SECONDS = 60;

function remainingKeyFor(keyId: string): string {
  return `remaining:${keyId}`;
}

async function loadRemainingFromPg(pg: Pool, keyId: string): Promise<number> {
  const { rows } = await pg.query("SELECT budget_cents - spent_cents AS remaining FROM api_keys WHERE id = $1", [keyId]);
  return rows.length > 0 ? Number(rows[0].remaining) : 0;
}

/** Fast pre-flight check on the hot path -- cache-aside, refreshed from Postgres on miss. */
export async function getRemainingBudgetCents(pg: Pool, redis: Redis, keyId: string): Promise<number> {
  const cached = await redis.get(remainingKeyFor(keyId));
  if (cached !== null) return Number(cached);

  const remaining = await loadRemainingFromPg(pg, keyId);
  await redis.set(remainingKeyFor(keyId), remaining, "EX", CACHE_TTL_SECONDS);
  return remaining;
}

/**
 * Called after a request completes with its real cost. Accepted tolerance:
 * concurrent in-flight requests on the same key can all pass the pre-flight
 * check before any of their costs land here, so a key can overspend by
 * roughly (concurrent requests) x (max plausible cost per request). Not
 * bank-grade -- explicitly fine for a reseller product per plan.
 */
export async function decrementBudget(redis: Redis, keyId: string, costCents: number): Promise<void> {
  await redis.incrbyfloat(remainingKeyFor(keyId), -costCents);
}

/** Called on admin edit of a key's budget so the cache reflects the new limit immediately. */
export async function invalidateBudgetCache(redis: Redis, keyId: string): Promise<void> {
  await redis.del(remainingKeyFor(keyId));
}
