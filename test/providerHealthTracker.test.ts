import { describe, it, expect, vi } from "vitest";
import { ProviderHealthTracker } from "../src/lib/providerHealth.js";
import type { ResolvedRoute } from "../src/types/router.js";

function makeRoute(priority: number, providerId: string, routeId?: string): ResolvedRoute {
  return {
    routeId: routeId ?? `route-${providerId}`,
    providerId,
    providerName: providerId,
    standard: "anthropic",
    baseUrl: `https://${providerId}.example`,
    apiKey: "key",
    upstreamModelId: "claude-sonnet-5",
    priority,
  };
}

function makeTracker(opts?: { now?: () => number }) {
  const disableProvider = vi.fn();
  const disableRoute = vi.fn();
  const tracker = new ProviderHealthTracker(
    { disableProvider, disableRoute },
    { restMs: 5_000, authRestMs: 3_600_000, authStrikes: 3, now: opts?.now ?? (() => 0) },
  );
  return { tracker, disableProvider, disableRoute };
}

// ---------------------------------------------------------------------------
// order()
// ---------------------------------------------------------------------------

describe("ProviderHealthTracker.order()", () => {
  it("returns routes unchanged when none are resting", () => {
    const { tracker } = makeTracker();
    const routes = [makeRoute(1, "a"), makeRoute(2, "b")];
    expect(tracker.order(routes)).toEqual(routes);
  });

  it("sinks a resting provider to the back while keeping priority order in each group", () => {
    let t = 0;
    const { tracker } = makeTracker({ now: () => t });
    const a = makeRoute(1, "a");
    const b = makeRoute(2, "b");
    const c = makeRoute(3, "c");
    tracker.recordAttempt(b, { kind: "networkError" });
    t = 1; // still within 5s rest window
    const ordered = tracker.order([a, b, c]);
    expect(ordered.map((r) => r.providerId)).toEqual(["a", "c", "b"]);
  });

  it("never drops a resting route when it is the only option", () => {
    let t = 0;
    const { tracker } = makeTracker({ now: () => t });
    const a = makeRoute(1, "a");
    tracker.recordAttempt(a, { kind: "networkError" });
    t = 1;
    const ordered = tracker.order([a]);
    expect(ordered).toHaveLength(1);
    expect(ordered[0].providerId).toBe("a");
  });

  it("treats an expired rest as live (auto-expiry, no manual clear needed)", () => {
    let t = 0;
    const { tracker } = makeTracker({ now: () => t });
    const a = makeRoute(1, "a");
    const b = makeRoute(2, "b");
    tracker.recordAttempt(a, { kind: "networkError" }); // rested at t=0 for 5 000 ms
    t = 6_000; // past window
    const ordered = tracker.order([a, b]);
    expect(ordered.map((r) => r.providerId)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Transient rest (network error / 429 / 5xx)
// ---------------------------------------------------------------------------

describe("recordAttempt() — transient rest", () => {
  it("network error → failover=true, provider rested", () => {
    let t = 0;
    const { tracker } = makeTracker({ now: () => t });
    const a = makeRoute(1, "a");
    expect(tracker.recordAttempt(a, { kind: "networkError" }).failover).toBe(true);
    t = 1;
    expect(tracker.order([a, makeRoute(2, "b")])[1].providerId).toBe("a");
  });

  it.each([429, 500, 502, 503, 504, 529])("status %d → failover=true, provider rested", (status) => {
    let t = 0;
    const { tracker } = makeTracker({ now: () => t });
    const a = makeRoute(1, "a");
    expect(tracker.recordAttempt(a, { kind: "status", status }).failover).toBe(true);
    t = 1;
    expect(tracker.order([a, makeRoute(2, "b")])[1].providerId).toBe("a");
  });

  it("success → failover=false, clears rest so provider is live again", () => {
    let t = 0;
    const { tracker } = makeTracker({ now: () => t });
    const a = makeRoute(1, "a");
    tracker.recordAttempt(a, { kind: "networkError" });
    expect(tracker.recordAttempt(a, { kind: "success" }).failover).toBe(false);
    t = 1;
    expect(tracker.order([a, makeRoute(2, "b")])[0].providerId).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// 401 strike logic
// ---------------------------------------------------------------------------

describe("recordAttempt() — 401 strikes", () => {
  it("1st 401 → failover=true, no disable", () => {
    const { tracker, disableProvider } = makeTracker({ now: () => 0 });
    const a = makeRoute(1, "a");
    expect(tracker.recordAttempt(a, { kind: "status", status: 401 }).failover).toBe(true);
    expect(disableProvider).not.toHaveBeenCalled();
  });

  it("2nd consecutive 401 → failover=true, still no disable", () => {
    const { tracker, disableProvider } = makeTracker({ now: () => 0 });
    const a = makeRoute(1, "a");
    tracker.recordAttempt(a, { kind: "status", status: 401 });
    expect(tracker.recordAttempt(a, { kind: "status", status: 401 }).failover).toBe(true);
    expect(disableProvider).not.toHaveBeenCalled();
  });

  it("3rd consecutive 401 → disableProvider called once, failover=true", () => {
    const { tracker, disableProvider } = makeTracker({ now: () => 0 });
    const a = makeRoute(1, "a");
    tracker.recordAttempt(a, { kind: "status", status: 401 });
    tracker.recordAttempt(a, { kind: "status", status: 401 });
    expect(tracker.recordAttempt(a, { kind: "status", status: 401 }).failover).toBe(true);
    expect(disableProvider).toHaveBeenCalledWith("a");
    expect(disableProvider).toHaveBeenCalledTimes(1);
  });

  it("2xx between 401s resets the strike counter (consecutive counting)", () => {
    const { tracker, disableProvider } = makeTracker({ now: () => 0 });
    const a = makeRoute(1, "a");
    tracker.recordAttempt(a, { kind: "status", status: 401 });
    tracker.recordAttempt(a, { kind: "status", status: 401 });
    tracker.recordAttempt(a, { kind: "success" }); // reset
    tracker.recordAttempt(a, { kind: "status", status: 401 });
    tracker.recordAttempt(a, { kind: "status", status: 401 });
    // Only 2 strikes after reset — must NOT disable
    expect(disableProvider).not.toHaveBeenCalled();
  });

  it("does not call disableProvider a second time after state is cleared", () => {
    const { tracker, disableProvider } = makeTracker({ now: () => 0 });
    const a = makeRoute(1, "a");
    tracker.recordAttempt(a, { kind: "status", status: 401 });
    tracker.recordAttempt(a, { kind: "status", status: 401 });
    tracker.recordAttempt(a, { kind: "status", status: 401 }); // fires disable, clears state
    tracker.recordAttempt(a, { kind: "status", status: 401 }); // fresh count = 1
    tracker.recordAttempt(a, { kind: "status", status: 401 }); // fresh count = 2
    expect(disableProvider).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 402 — out of balance
// ---------------------------------------------------------------------------

describe("recordAttempt() — 402", () => {
  it("→ disableProvider immediately, failover=true", () => {
    const { tracker, disableProvider } = makeTracker({ now: () => 0 });
    const a = makeRoute(1, "a");
    expect(tracker.recordAttempt(a, { kind: "status", status: 402 }).failover).toBe(true);
    expect(disableProvider).toHaveBeenCalledWith("a");
    expect(disableProvider).toHaveBeenCalledTimes(1);
  });

  it("does not touch disableRoute", () => {
    const { tracker, disableRoute } = makeTracker({ now: () => 0 });
    tracker.recordAttempt(makeRoute(1, "a"), { kind: "status", status: 402 });
    expect(disableRoute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 404 — model not on this key
// ---------------------------------------------------------------------------

describe("recordAttempt() — 404", () => {
  it("→ disableRoute by routeId (not disableProvider), failover=true", () => {
    const { tracker, disableProvider, disableRoute } = makeTracker({ now: () => 0 });
    const a = makeRoute(1, "a", "route-xyz");
    expect(tracker.recordAttempt(a, { kind: "status", status: 404 }).failover).toBe(true);
    expect(disableRoute).toHaveBeenCalledWith("route-xyz");
    expect(disableProvider).not.toHaveBeenCalled();
  });

  it("does NOT rest the provider so its other models still work", () => {
    let t = 0;
    const { tracker } = makeTracker({ now: () => t });
    const a = makeRoute(1, "a", "route-xyz");
    tracker.recordAttempt(a, { kind: "status", status: 404 });
    t = 1;
    // provider 'a' must not be resting
    expect(tracker.order([a, makeRoute(2, "b")])[0].providerId).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// Pass-through statuses (400, 403, 422) — no failover, nothing persisted
// ---------------------------------------------------------------------------

describe("recordAttempt() — pass-through (400, 403, 422)", () => {
  it.each([400, 403, 422])("status %d → failover=false, nothing disabled, not rested", (status) => {
    let t = 0;
    const { tracker, disableProvider, disableRoute } = makeTracker({ now: () => t });
    const a = makeRoute(1, "a");
    expect(tracker.recordAttempt(a, { kind: "status", status }).failover).toBe(false);
    expect(disableProvider).not.toHaveBeenCalled();
    expect(disableRoute).not.toHaveBeenCalled();
    t = 1;
    expect(tracker.order([a, makeRoute(2, "b")])[0].providerId).toBe("a");
  });
});
