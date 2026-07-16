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

  // ----- Tracker integration -----------------------------------------------

  it("skips the resting primary and goes straight to the backup when a tracker is supplied", async () => {
    const { ProviderHealthTracker } = await import("../src/lib/providerHealth.js");
    const tracker = new ProviderHealthTracker(
      { disableProvider() {}, disableRoute() {} },
      { restMs: 5_000, now: () => 1 },
    );

    const primary = makeRoute(1, "primary");
    const backup = makeRoute(2, "backup");

    // Mark primary as resting (at t=0, now=1 means still within 5s window)
    tracker.recordAttempt(primary, { kind: "networkError" });

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    global.fetch = fetchMock as any;

    const result = await callWithFailover([primary, backup], { model: "claude-sonnet-5" }, undefined, noopLog, "messages", tracker);

    // Backup was called first (primary was sinked to the back); backup succeeded.
    expect(result.providerId).toBe(backup.providerId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls over to the backup on 401 and marks primary as resting", async () => {
    const { ProviderHealthTracker } = await import("../src/lib/providerHealth.js");
    const disableProvider = vi.fn();
    const tracker = new ProviderHealthTracker(
      { disableProvider, disableRoute() {} },
      { restMs: 5_000, authRestMs: 3_600_000, authStrikes: 3, now: () => 0 },
    );

    const primary = makeRoute(1, "primary");
    const backup = makeRoute(2, "backup");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    global.fetch = fetchMock as any;

    const result = await callWithFailover([primary, backup], { model: "claude-sonnet-5" }, undefined, noopLog, "messages", tracker);

    expect(result.providerId).toBe(backup.providerId);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].providerName).toBe("primary");
    expect(result.attempts[0].statusCode).toBe(401);
    expect(disableProvider).not.toHaveBeenCalled(); // only 1 strike, not 3
  });

  it("disables the primary provider after 3 consecutive 401s across separate requests", async () => {
    const { ProviderHealthTracker } = await import("../src/lib/providerHealth.js");
    const disableProvider = vi.fn();
    // Use a clock that advances so the 1-hour auth rest never blocks the next
    // simulated request (each "request" happens at t = 0, 3700000, 7400000 --
    // past the 1h window -- but that would clear state; instead use authStrikes=3
    // with a very short authRestMs so consecutive strikes still accumulate).
    const tracker = new ProviderHealthTracker(
      { disableProvider, disableRoute() {} },
      { restMs: 5_000, authRestMs: 10, authStrikes: 3, now: () => 0 },
    );

    // Simulate 3 separate requests where primary is the only route each time
    // (no backup, so order() has nothing to sink primary behind). Each call
    // gets a single 401 response; on the 3rd the tracker fires disableProvider.
    const primary = makeRoute(1, "primary");

    for (let i = 0; i < 3; i++) {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
      global.fetch = fetchMock as any;
      try {
        await callWithFailover([primary], { model: "claude-sonnet-5" }, undefined, noopLog, "messages", tracker);
      } catch {
        // AllProvidersFailedError expected when primary is the only route
      }
    }

    expect(disableProvider).toHaveBeenCalledWith(primary.providerId);
    expect(disableProvider).toHaveBeenCalledTimes(1);
  });

  it("falls over on 402 and calls disableProvider", async () => {
    const { ProviderHealthTracker } = await import("../src/lib/providerHealth.js");
    const disableProvider = vi.fn();
    const tracker = new ProviderHealthTracker(
      { disableProvider, disableRoute() {} },
      { restMs: 5_000, now: () => 0 },
    );

    const primary = makeRoute(1, "primary");
    const backup = makeRoute(2, "backup");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "payment required" }), { status: 402 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    global.fetch = fetchMock as any;

    const result = await callWithFailover([primary, backup], { model: "claude-sonnet-5" }, undefined, noopLog, "messages", tracker);

    expect(result.providerId).toBe(backup.providerId);
    expect(disableProvider).toHaveBeenCalledWith(primary.providerId);
  });

  it("falls over on 404 and calls disableRoute (not disableProvider)", async () => {
    const { ProviderHealthTracker } = await import("../src/lib/providerHealth.js");
    const disableProvider = vi.fn();
    const disableRoute = vi.fn();
    const tracker = new ProviderHealthTracker(
      { disableProvider, disableRoute },
      { restMs: 5_000, now: () => 0 },
    );

    const primary = { ...makeRoute(1, "primary"), routeId: "route-primary-id" };
    const backup = makeRoute(2, "backup");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "not found" }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    global.fetch = fetchMock as any;

    const result = await callWithFailover([primary, backup], { model: "claude-sonnet-5" }, undefined, noopLog, "messages", tracker);

    expect(result.providerId).toBe(backup.providerId);
    expect(disableRoute).toHaveBeenCalledWith("route-primary-id");
    expect(disableProvider).not.toHaveBeenCalled();
  });
});
