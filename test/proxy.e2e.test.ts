import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { createMockUpstream } from "./mockUpstream.js";

// Env vars must be set before src/config/env.ts is ever imported (it parses
// process.env eagerly at module load), so all app imports below are dynamic.
// Note: upstream config is no longer a single subrouter setting -- it's a
// provider row + model route, seeded directly into Postgres below.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:55432/reseller";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters-long";
process.env.NODE_ENV = "test";

function addressToUrl(address: ReturnType<FastifyInstance["server"]["address"]>): string {
  if (typeof address === "object" && address) return `http://127.0.0.1:${address.port}`;
  throw new Error("could not determine server address");
}

describe("proxy e2e (requires local Postgres + Redis, see docker-compose.yml)", () => {
  let mockUpstream: FastifyInstance;
  let app: FastifyInstance;
  let appUrl: string;
  let plaintextKey: string;
  let keyId: string;
  let providerId: string;

  beforeAll(async () => {
    mockUpstream = createMockUpstream();
    await mockUpstream.listen({ port: 0, host: "127.0.0.1" });
    const mockUpstreamUrl = addressToUrl(mockUpstream.server.address());

    const { buildApp } = await import("../src/app.js");
    const { issueKey } = await import("../src/lib/keyIssuance.js");
    const { encryptKey } = await import("../src/lib/keyCrypto.js");

    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    appUrl = addressToUrl(app.server.address());

    const providerResult = await app.pg.query(
      `INSERT INTO reseller_providers (name, standard, base_url, api_key_encrypted) VALUES ($1,'anthropic',$2,$3) RETURNING id`,
      ["e2e-test-provider", mockUpstreamUrl, encryptKey("test-subrouter-key")],
    );
    providerId = providerResult.rows[0].id;

    await app.pg.query(
      `INSERT INTO reseller_model_routes (model_id, provider_id, upstream_model_id, priority) VALUES ('claude-haiku-4-5', $1, 'claude-haiku-4-5', 1)`,
      [providerId],
    );
    app.routerCache.invalidate();

    const issued = issueKey("test");
    plaintextKey = issued.plaintext;
    const { rows } = await app.pg.query(
      `INSERT INTO reseller_api_keys (name, key_hash, key_prefix, rate_limit_rpm, budget_cents) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      ["e2e-test-client", issued.hash, issued.prefix, 1000, 100_000],
    );
    keyId = rows[0].id;
  });

  afterAll(async () => {
    if (keyId) {
      await app.pg.query("DELETE FROM reseller_usage_logs WHERE key_id = $1", [keyId]);
      await app.pg.query("DELETE FROM reseller_api_keys WHERE id = $1", [keyId]);
    }
    if (providerId) {
      await app.pg.query("DELETE FROM reseller_model_routes WHERE provider_id = $1", [providerId]);
      await app.pg.query("DELETE FROM reseller_providers WHERE id = $1", [providerId]);
    }
    await app.close();
    await mockUpstream.close();
  });

  it("rejects requests with no api key", async () => {
    const res = await fetch(`${appUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown model", async () => {
    const res = await fetch(`${appUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": plaintextKey },
      body: JSON.stringify({ model: "not-a-real-model", messages: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a catalog model that has no provider routed to it", async () => {
    const res = await fetch(`${appUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": plaintextKey },
      body: JSON.stringify({ model: "claude-fable-5", messages: [] }),
    });
    expect(res.status).toBe(402);
  });

  it("non-streaming: forwards the call and logs the four token categories with correct cost and provider", async () => {
    const mockUsage = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 500, cache_read_input_tokens: 300 };
    const res = await fetch(`${appUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": plaintextKey },
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }], mock_usage: mockUsage }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.usage.input_tokens).toBe(1000);

    // usage logging is fire-and-forget after the response -- poll briefly
    const row = await pollForUsageLog(app, keyId, mockUsage);
    expect(row.input_tokens).toBe(1000);
    expect(row.output_tokens).toBe(200);
    expect(row.cache_creation_input_tokens).toBe(500);
    expect(row.cache_read_input_tokens).toBe(300);
    expect(Number(row.cache_write_cost_cents)).toBeGreaterThan(0);
    expect(Number(row.cache_read_cost_cents)).toBeGreaterThan(0);
    expect(row.provider_id).toBe(providerId);
    expect(row.upstream_model_id).toBe("claude-haiku-4-5");
  });

  it("streaming: delivers content incrementally and logs cache usage extracted from message_start", async () => {
    const mockUsage = { input_tokens: 50, output_tokens: 999, cache_creation_input_tokens: 777, cache_read_input_tokens: 0 };
    const res = await fetch(`${appUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": plaintextKey },
      body: JSON.stringify({ model: "claude-haiku-4-5", stream: true, messages: [{ role: "user", content: "hi" }], mock_usage: mockUsage }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("message_start");
    expect(text).toContain("message_stop");

    const row = await pollForUsageLog(app, keyId, mockUsage, true);
    expect(row.cache_creation_input_tokens).toBe(777);
    expect(row.output_tokens).toBe(999); // from message_delta, not message_start's placeholder
  });

  it("rejects requests past the per-key rate limit", async () => {
    await app.pg.query("UPDATE reseller_api_keys SET rate_limit_rpm = 2 WHERE id = $1", [keyId]);
    await app.redis.del(`key:${createHash("sha256").update(plaintextKey).digest("hex")}`);

    const call = () =>
      fetch(`${appUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": plaintextKey },
        body: JSON.stringify({ model: "claude-haiku-4-5", messages: [], mock_usage: { input_tokens: 1, output_tokens: 1 } }),
      });

    const results = [await call(), await call(), await call()];
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });

  describe("priority failover", () => {
    let badUpstream: FastifyInstance;
    let goodUpstream: FastifyInstance;
    let badProviderId: string;
    let goodProviderId: string;

    beforeAll(async () => {
      // The rate-limit test above deliberately dropped this key to 2 rpm and
      // burned through it -- undo that (DB, the 45s key-record cache, and the
      // rate-limit counter itself) so it doesn't bleed into these tests.
      await app.pg.query("UPDATE reseller_api_keys SET rate_limit_rpm = 1000 WHERE id = $1", [keyId]);
      await app.redis.del(`key:${createHash("sha256").update(plaintextKey).digest("hex")}`);
      await app.redis.del(`rl:rpm:${keyId}`);

      badUpstream = createMockUpstream({ failMessages: true });
      goodUpstream = createMockUpstream();
      await badUpstream.listen({ port: 0, host: "127.0.0.1" });
      await goodUpstream.listen({ port: 0, host: "127.0.0.1" });

      const { encryptKey } = await import("../src/lib/keyCrypto.js");

      const badResult = await app.pg.query(
        `INSERT INTO reseller_providers (name, standard, base_url, api_key_encrypted) VALUES ('e2e-bad-provider','anthropic',$1,$2) RETURNING id`,
        [addressToUrl(badUpstream.server.address()), encryptKey("test-subrouter-key")],
      );
      badProviderId = badResult.rows[0].id;

      const goodResult = await app.pg.query(
        `INSERT INTO reseller_providers (name, standard, base_url, api_key_encrypted) VALUES ('e2e-good-provider','anthropic',$1,$2) RETURNING id`,
        [addressToUrl(goodUpstream.server.address()), encryptKey("test-subrouter-key")],
      );
      goodProviderId = goodResult.rows[0].id;

      // claude-sonnet-5 is seeded by the router migration but has no routes
      // wired in this test file's beforeAll -- safe to use exclusively here.
      await app.pg.query(
        `INSERT INTO reseller_model_routes (model_id, provider_id, upstream_model_id, priority) VALUES ('claude-sonnet-5', $1, 'claude-sonnet-5', 1)`,
        [badProviderId],
      );
      await app.pg.query(
        `INSERT INTO reseller_model_routes (model_id, provider_id, upstream_model_id, priority) VALUES ('claude-sonnet-5', $1, 'claude-sonnet-5', 2)`,
        [goodProviderId],
      );
      app.routerCache.invalidate();
    });

    afterAll(async () => {
      await app.pg.query("DELETE FROM reseller_usage_logs WHERE model = 'claude-sonnet-5'");
      await app.pg.query("DELETE FROM reseller_model_routes WHERE model_id = 'claude-sonnet-5'");
      await app.pg.query("DELETE FROM reseller_providers WHERE id = $1 OR id = $2", [badProviderId, goodProviderId]);
      app.routerCache.invalidate();
      await badUpstream.close();
      await goodUpstream.close();
    });

    it("falls over to the priority-2 provider when priority-1 fails, and logs the provider that actually served it", async () => {
      const mockUsage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const res = await fetch(`${appUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": plaintextKey },
        body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }], mock_usage: mockUsage }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.usage.input_tokens).toBe(10);

      const row = await pollForUsageLogByModel(app, keyId, "claude-sonnet-5", mockUsage);
      expect(row.provider_id).toBe(goodProviderId);
    });
  });
});

async function pollForUsageLog(app: FastifyInstance, keyId: string, mockUsage: Record<string, number>, stream = false) {
  for (let i = 0; i < 20; i++) {
    const { rows } = await app.pg.query(
      "SELECT * FROM reseller_usage_logs WHERE key_id = $1 AND stream = $2 ORDER BY created_at DESC LIMIT 1",
      [keyId, stream],
    );
    if (rows.length > 0 && rows[0].input_tokens === mockUsage.input_tokens) return rows[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("usage_logs row did not appear in time");
}

async function pollForUsageLogByModel(app: FastifyInstance, keyId: string, model: string, mockUsage: Record<string, number>) {
  for (let i = 0; i < 20; i++) {
    const { rows } = await app.pg.query(
      "SELECT * FROM reseller_usage_logs WHERE key_id = $1 AND model = $2 ORDER BY created_at DESC LIMIT 1",
      [keyId, model],
    );
    if (rows.length > 0 && rows[0].input_tokens === mockUsage.input_tokens) return rows[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("usage_logs row did not appear in time");
}
