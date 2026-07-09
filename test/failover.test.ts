import { describe, it, expect, vi, afterEach } from "vitest";
import { callWithFailover, AllProvidersFailedError } from "../src/lib/failover.js";
import type { ResolvedRoute } from "../src/types/router.js";

function makeRoute(priority: number, providerName: string): ResolvedRoute {
  return {
    routeId: `route-${providerName}`,
    providerId: `provider-${providerName}`,
    providerName,
    standard: "anthropic",
    baseUrl: `https://${providerName}.example`,
    apiKey: "key",
    upstreamModelId: "claude-sonnet-5",
    priority,
  };
}

const noopLog = { warn: () => {} };

describe("callWithFailover", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uses the priority-1 provider when it succeeds, without touching the backup", async () => {
    const primary = makeRoute(1, "primary");
    const backup = makeRoute(2, "backup");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    global.fetch = fetchMock as any;

    const result = await callWithFailover([primary, backup], { model: "claude-sonnet-5" }, undefined, noopLog);

    expect(result.providerId).toBe(primary.providerId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls over to the next provider on a network error", async () => {
    const primary = makeRoute(1, "primary");
    const backup = makeRoute(2, "backup");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    global.fetch = fetchMock as any;

    const result = await callWithFailover([primary, backup], { model: "claude-sonnet-5" }, undefined, noopLog);

    expect(result.providerId).toBe(backup.providerId);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].providerName).toBe("primary");
    expect(result.attempts[0].error).toContain("ECONNREFUSED");
  });

  it("falls over to the next provider on a retryable 503", async () => {
    const primary = makeRoute(1, "primary");
    const backup = makeRoute(2, "backup");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "overloaded" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    global.fetch = fetchMock as any;

    const result = await callWithFailover([primary, backup], { model: "claude-sonnet-5" }, undefined, noopLog);

    expect(result.providerId).toBe(backup.providerId);
    expect(result.attempts).toEqual([{ providerName: "primary", statusCode: 503 }]);
  });

  it("does NOT fail over on a 400 -- returns it immediately from the primary", async () => {
    const primary = makeRoute(1, "primary");
    const backup = makeRoute(2, "backup");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "bad request" }), { status: 400 }));
    global.fetch = fetchMock as any;

    const result = await callWithFailover([primary, backup], { model: "claude-sonnet-5" }, undefined, noopLog);

    expect(result.providerId).toBe(primary.providerId);
    expect(result.response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws AllProvidersFailedError, with one attempt per route, when every route fails", async () => {
    const primary = makeRoute(1, "primary");
    const backup = makeRoute(2, "backup");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "down" }), { status: 500 }));
    global.fetch = fetchMock as any;

    await expect(callWithFailover([primary, backup], { model: "claude-sonnet-5" }, undefined, noopLog)).rejects.toThrow(
      AllProvidersFailedError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rewrites the request body's model to each route's upstream model ID", async () => {
    const primary = { ...makeRoute(1, "primary"), upstreamModelId: "supplier-internal-sonnet" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    global.fetch = fetchMock as any;

    await callWithFailover([primary], { model: "claude-sonnet-5", messages: [] }, undefined, noopLog);

    const [, init] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(init.body);
    expect(sentBody.model).toBe("supplier-internal-sonnet");
  });
});
