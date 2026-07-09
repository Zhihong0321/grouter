import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";

// Env vars must be set before src/config/env.ts is ever imported (it parses
// process.env eagerly at module load), so all app imports below are dynamic.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:55432/reseller";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters-long";
process.env.NODE_ENV = "test";

describe("RouterCache (requires local Postgres, see docker-compose.yml)", () => {
  let pg: Pool;
  let RouterCache: typeof import("../src/lib/router.js").RouterCache;
  let providerAId: string;
  let providerBId: string;

  const modelId = "router-test-model";
  const inactiveModelId = "router-test-model-inactive";

  beforeAll(async () => {
    ({ RouterCache } = await import("../src/lib/router.js"));
    const { encryptKey } = await import("../src/lib/keyCrypto.js");
    pg = new Pool({ connectionString: process.env.DATABASE_URL });

    await pg.query(
      `INSERT INTO reseller_models (model_id, brand, standard, display_name, active) VALUES ($1,'Test','anthropic','Router Test Model', true)
       ON CONFLICT (model_id) DO UPDATE SET active = true`,
      [modelId],
    );
    await pg.query(
      `INSERT INTO reseller_models (model_id, brand, standard, display_name, active) VALUES ($1,'Test','anthropic','Router Test Model (inactive)', false)
       ON CONFLICT (model_id) DO UPDATE SET active = false`,
      [inactiveModelId],
    );

    const providerA = await pg.query(
      `INSERT INTO reseller_providers (name, standard, base_url, api_key_encrypted) VALUES ($1,'anthropic','https://a.example',$2) RETURNING id`,
      ["Router Test Provider A", encryptKey("secret-a")],
    );
    providerAId = providerA.rows[0].id;

    const providerB = await pg.query(
      `INSERT INTO reseller_providers (name, standard, base_url, api_key_encrypted) VALUES ($1,'anthropic','https://b.example',$2) RETURNING id`,
      ["Router Test Provider B", encryptKey("secret-b")],
    );
    providerBId = providerB.rows[0].id;

    // Insert priority 2 first on purpose -- getRoutes() must still return
    // priority 1 first regardless of insertion order.
    await pg.query(
      `INSERT INTO reseller_model_routes (model_id, provider_id, upstream_model_id, priority) VALUES ($1,$2,$1,2)`,
      [modelId, providerBId],
    );
    await pg.query(
      `INSERT INTO reseller_model_routes (model_id, provider_id, upstream_model_id, priority) VALUES ($1,$2,$1,1)`,
      [modelId, providerAId],
    );
  });

  afterAll(async () => {
    await pg.query("DELETE FROM reseller_model_routes WHERE model_id = $1", [modelId]);
    await pg.query("DELETE FROM reseller_providers WHERE id = $1 OR id = $2", [providerAId, providerBId]);
    await pg.query("DELETE FROM reseller_models WHERE model_id = $1 OR model_id = $2", [modelId, inactiveModelId]);
    await pg.end();
  });

  it("returns the model catalog entry", async () => {
    const cache = new RouterCache(pg);
    const model = await cache.getModel(modelId);
    expect(model?.standard).toBe("anthropic");
    expect(model?.brand).toBe("Test");
  });

  it("returns undefined for an unknown model", async () => {
    const cache = new RouterCache(pg);
    expect(await cache.getModel("does-not-exist")).toBeUndefined();
  });

  it("returns undefined for an inactive model", async () => {
    const cache = new RouterCache(pg);
    expect(await cache.getModel(inactiveModelId)).toBeUndefined();
  });

  it("orders routes by priority with priority 1 first, and decrypts the provider key", async () => {
    const cache = new RouterCache(pg);
    const routes = await cache.getRoutes(modelId);
    expect(routes).toHaveLength(2);
    expect(routes[0].providerId).toBe(providerAId);
    expect(routes[0].apiKey).toBe("secret-a");
    expect(routes[1].providerId).toBe(providerBId);
    expect(routes[1].apiKey).toBe("secret-b");
  });

  it("excludes routes whose provider is inactive", async () => {
    await pg.query("UPDATE reseller_providers SET active = false WHERE id = $1", [providerBId]);
    const cache = new RouterCache(pg);
    const routes = await cache.getRoutes(modelId);
    expect(routes).toHaveLength(1);
    expect(routes[0].providerId).toBe(providerAId);
    await pg.query("UPDATE reseller_providers SET active = true WHERE id = $1", [providerBId]);
  });

  it("invalidate() forces a fresh read on the next call", async () => {
    const cache = new RouterCache(pg);
    await cache.getRoutes(modelId); // warms the cache
    await pg.query("UPDATE reseller_model_routes SET active = false WHERE model_id = $1 AND provider_id = $2", [modelId, providerBId]);
    cache.invalidate();
    const routes = await cache.getRoutes(modelId);
    expect(routes).toHaveLength(1);
    await pg.query("UPDATE reseller_model_routes SET active = true WHERE model_id = $1 AND provider_id = $2", [modelId, providerBId]);
  });
});
