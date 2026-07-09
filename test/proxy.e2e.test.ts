import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { createMockUpstream } from "./mockUpstream.js";

// Env vars must be set before src/config/env.ts is ever imported (it parses
// process.env eagerly at module load), so all app imports below are dynamic.
process.env.SUBROUTER_API_KEY = "test-subrouter-key";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:55432/reseller";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters-long";
process.env.KEY_PREFIX = "test";
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

  beforeAll(async () => {
    mockUpstream = createMockUpstream();
    await mockUpstream.listen({ port: 0, host: "127.0.0.1" });
    process.env.SUBROUTER_BASE_URL = addressToUrl(mockUpstream.server.address());

    const { buildApp } = await import("../src/app.js");
    const { issueKey } = await import("../src/lib/keyIssuance.js");

    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    appUrl = addressToUrl(app.server.address());

    const issued = issueKey();
    plaintextKey = issued.plaintext;
    const { rows } = await app.pg.query(
      `INSERT INTO api_keys (name, key_hash, key_prefix, rate_limit_rpm, budget_cents) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      ["e2e-test-client", issued.hash, issued.prefix, 1000, 100_000],
    );
    keyId = rows[0].id;
  });

  afterAll(async () => {
    if (keyId) {
      await app.pg.query("DELETE FROM usage_logs WHERE key_id = $1", [keyId]);
      await app.pg.query("DELETE FROM api_keys WHERE id = $1", [keyId]);
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

  it("non-streaming: forwards the call and logs the four token categories with correct cost", async () => {
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
    await app.pg.query("UPDATE api_keys SET rate_limit_rpm = 2 WHERE id = $1", [keyId]);
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
});

async function pollForUsageLog(app: FastifyInstance, keyId: string, mockUsage: Record<string, number>, stream = false) {
  for (let i = 0; i < 20; i++) {
    const { rows } = await app.pg.query(
      "SELECT * FROM usage_logs WHERE key_id = $1 AND stream = $2 ORDER BY created_at DESC LIMIT 1",
      [keyId, stream],
    );
    if (rows.length > 0 && rows[0].input_tokens === mockUsage.input_tokens) return rows[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("usage_logs row did not appear in time");
}
