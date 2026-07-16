import type { ResolvedRoute } from "../types/router.js";

/**
 * Persistent "turn this provider/route off" effects. Kept as an injected
 * interface so this module never imports pg -- app.ts wires the real DB writes
 * (which flip the existing reseller_providers.active / reseller_model_routes.active
 * flags and invalidate RouterCache), and tests inject spies.
 */
export interface ProviderHealthEffects {
  /** Flip reseller_providers.active = false (stays off until an admin re-enables). */
  disableProvider(providerId: string): void | Promise<void>;
  /** Flip a single reseller_model_routes.active = false by route id. */
  disableRoute(routeId: string): void | Promise<void>;
}

export interface ProviderHealthOptions {
  /** Transient rest after a network error or 429/5xx (default 5s). */
  restMs?: number;
  /** Rest after a 401 before the provider is tried again (default 1h). */
  authRestMs?: number;
  /** Consecutive 401s (no 2xx in between) before the provider is turned off (default 3). */
  authStrikes?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

interface ProviderState {
  restUntil: number;
  strikes: number;
}

/** The single upstream call result the tracker classifies. */
export type ProviderOutcome =
  | { kind: "success" }
  | { kind: "networkError" }
  | { kind: "status"; status: number };

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 529]);

/**
 * In-process health memory shared across every request, so a supplier key that
 * dropped a request during a peak is *skipped* on the next request (rested)
 * rather than retried-then-failed-over every single time. Escalates by status:
 * transient overload (429/5xx) rests briefly; auth failure (401) rests an hour
 * and turns the provider off after N consecutive strikes; out-of-balance (402)
 * turns it off at once; a missing model (404) turns off just that one route.
 *
 * Per-replica by design -- same posture as RouterCache/PriceCache. Only the
 * "off" decision is persisted (via effects), because that must survive deploys;
 * the short rest window and strike count are cheap to relearn.
 */
export class ProviderHealthTracker {
  private state = new Map<string, ProviderState>();
  private readonly restMs: number;
  private readonly authRestMs: number;
  private readonly authStrikes: number;
  private readonly now: () => number;

  constructor(private effects: ProviderHealthEffects, options: ProviderHealthOptions = {}) {
    this.restMs = options.restMs ?? 5_000;
    this.authRestMs = options.authRestMs ?? 3_600_000;
    this.authStrikes = options.authStrikes ?? 3;
    this.now = options.now ?? Date.now;
  }

  private isResting(providerId: string): boolean {
    const s = this.state.get(providerId);
    return s !== undefined && s.restUntil > this.now();
  }

  private rest(providerId: string, ms: number): void {
    const s = this.state.get(providerId) ?? { restUntil: 0, strikes: 0 };
    s.restUntil = this.now() + ms;
    this.state.set(providerId, s);
  }

  /**
   * Reorders routes so currently-resting providers sink to the back while
   * keeping each group in its original priority order. A resting provider is
   * never dropped -- if every route is resting it's still returned, so a lone
   * degraded key is used as a last resort rather than failing the request.
   */
  order(routes: ResolvedRoute[]): ResolvedRoute[] {
    const live: ResolvedRoute[] = [];
    const resting: ResolvedRoute[] = [];
    for (const route of routes) {
      (this.isResting(route.providerId) ? resting : live).push(route);
    }
    return resting.length === 0 ? routes : [...live, ...resting];
  }

  /**
   * Records one upstream attempt's outcome and returns whether failover should
   * advance to the next route. `false` means stop: either a 2xx success or a
   * genuine client-side error (400/403/etc) that another provider won't fix.
   */
  recordAttempt(route: ResolvedRoute, outcome: ProviderOutcome): { failover: boolean } {
    const { providerId, routeId } = route;

    if (outcome.kind === "success") {
      this.state.delete(providerId);
      return { failover: false };
    }

    if (outcome.kind === "networkError") {
      this.rest(providerId, this.restMs);
      return { failover: true };
    }

    const { status } = outcome;

    if (RETRYABLE_STATUS_CODES.has(status)) {
      this.rest(providerId, this.restMs);
      return { failover: true };
    }

    if (status === 401) {
      const s = this.state.get(providerId) ?? { restUntil: 0, strikes: 0 };
      s.restUntil = this.now() + this.authRestMs;
      s.strikes += 1;
      this.state.set(providerId, s);
      if (s.strikes >= this.authStrikes) {
        this.state.delete(providerId);
        this.fire(this.effects.disableProvider(providerId));
      }
      return { failover: true };
    }

    if (status === 402) {
      this.state.delete(providerId);
      this.fire(this.effects.disableProvider(providerId));
      return { failover: true };
    }

    if (status === 404) {
      this.fire(this.effects.disableRoute(routeId));
      return { failover: true };
    }

    // Any other non-2xx (400/403/422/...) is a request/config problem another
    // provider won't fix -- return it to the client, don't rest, don't strike.
    return { failover: false };
  }

  private fire(result: void | Promise<void>): void {
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch(() => {});
    }
  }
}
