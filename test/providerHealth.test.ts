import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { checkSubrouterHealth } from "../src/lib/upstream.js";
import { createMockUpstream } from "./mockUpstream.js";

function addressToUrl(address: ReturnType<FastifyInstance["server"]["address"]>): string {
  if (typeof address === "object" && address) return `http://127.0.0.1:${address.port}`;
  throw new Error("could not determine server address");
}

describe("checkSubrouterHealth", () => {
  let mockUpstream: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    mockUpstream = createMockUpstream();
    await mockUpstream.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = addressToUrl(mockUpstream.server.address());
  });

  afterAll(async () => {
    await mockUpstream.close();
  });

  it("reports ok and a model count for a valid key, without hitting /v1/messages", async () => {
    const result = await checkSubrouterHealth({ apiKey: "test-subrouter-key", baseUrl });
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.modelCount).toBe(2);
  });

  it("reports failure with the upstream status for an invalid key", async () => {
    const result = await checkSubrouterHealth({ apiKey: "wrong-key", baseUrl });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.message).toContain("invalid x-api-key");
  });

  it("reports failure for an unreachable base URL", async () => {
    const result = await checkSubrouterHealth({ apiKey: "test-subrouter-key", baseUrl: "http://127.0.0.1:1" });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBeUndefined();
  });
});
