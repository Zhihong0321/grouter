import type { FastifyBaseLogger } from "fastify";
import { callUpstream, type ProviderTarget, type UpstreamCallResult, type UpstreamEndpoint } from "./upstream.js";
import { ProviderHealthTracker } from "./providerHealth.js";
import type { ResolvedRoute } from "../types/router.js";

// Creates a fresh noop tracker per call -- callers that don't supply a shared
// tracker (e.g. legacy unit tests) still get correct per-request failover, but
// without any cross-request state that would bleed between test cases.
function makeNoopTracker(): ProviderHealthTracker {
  return new ProviderHealthTracker({ disableProvider() {}, disableRoute() {} });
}

export interface FailoverAttempt {
  providerName: string;
  statusCode?: number;
  error?: string;
}

export interface FailoverResult extends UpstreamCallResult {
  providerId: string;
  providerName: string;
  upstreamModelId: string;
  attempts: FailoverAttempt[];
}

export class AllProvidersFailedError extends Error {
  constructor(public attempts: FailoverAttempt[]) {
    super("All upstream providers failed");
    this.name = "AllProvidersFailedError";
  }
}

/**
 * Tries each route until one gives a usable answer, consulting a shared
 * ProviderHealthTracker to decide both order and when to advance:
 *
 *  - The tracker sinks currently-"resting" providers to the back, so a key that
 *    dropped a request during a peak is skipped in favour of a healthy backup
 *    (but still used as a last resort if every route is resting).
 *  - It advances to the next route on a network error, a retryable status
 *    (429/5xx/529), or an auth/balance/model failure (401/402/404) -- the last
 *    group also rests or disables the offending provider/route so it stops
 *    getting hammered. Any other status (400/403/422/...) is a request problem
 *    another provider won't fix, so it's returned immediately.
 *
 * Callers must invoke this BEFORE writing any byte to the client -- fetch()
 * resolves once headers arrive, so the retry decision always happens ahead of
 * both the streaming and non-streaming response path.
 */
export async function callWithFailover(
  routes: ResolvedRoute[],
  body: Record<string, unknown>,
  anthropicVersion: string | undefined,
  log: Pick<FastifyBaseLogger, "warn">,
  endpoint: UpstreamEndpoint = "messages",
  tracker?: ProviderHealthTracker,
): Promise<FailoverResult> {
  const t = tracker ?? makeNoopTracker();
  const attempts: FailoverAttempt[] = [];

  for (const route of t.order(routes)) {
    const target: ProviderTarget = {
      standard: route.standard,
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      upstreamModelId: route.upstreamModelId,
    };

    let result: UpstreamCallResult;
    try {
      result = await callUpstream(target, body, anthropicVersion, endpoint);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      attempts.push({ providerName: route.providerName, error: message });
      log.warn({ provider: route.providerName, err: message }, "upstream provider request failed, trying next");
      t.recordAttempt(route, { kind: "networkError" });
      continue;
    }

    const { failover } = t.recordAttempt(
      route,
      result.response.ok ? { kind: "success" } : { kind: "status", status: result.response.status },
    );

    if (failover) {
      attempts.push({ providerName: route.providerName, statusCode: result.response.status });
      log.warn(
        { provider: route.providerName, status: result.response.status },
        "upstream provider returned failover-eligible error, trying next",
      );
      continue;
    }

    return {
      ...result,
      providerId: route.providerId,
      providerName: route.providerName,
      upstreamModelId: route.upstreamModelId,
      attempts,
    };
  }

  throw new AllProvidersFailedError(attempts);
}
