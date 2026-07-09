import type { FastifyBaseLogger } from "fastify";
import { callUpstream, type ProviderTarget, type UpstreamCallResult } from "./upstream.js";
import type { ResolvedRoute } from "../types/router.js";

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 529]);

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
 * Tries each route in priority order, only advancing to the next on a
 * network error or a retryable status code (429/5xx/529 -- overloaded or
 * transient). Anything else (400/401/403/404/etc, a request/config problem)
 * is returned immediately so retrying another provider never wastes money or
 * hides misconfiguration. Callers must invoke this BEFORE writing any byte to
 * the client -- fetch() resolves once headers arrive, so the retry decision
 * always happens ahead of both the streaming and non-streaming response path.
 */
export async function callWithFailover(
  routes: ResolvedRoute[],
  body: Record<string, unknown>,
  anthropicVersion: string | undefined,
  log: Pick<FastifyBaseLogger, "warn">,
): Promise<FailoverResult> {
  const attempts: FailoverAttempt[] = [];

  for (const route of routes) {
    const target: ProviderTarget = {
      standard: route.standard,
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      upstreamModelId: route.upstreamModelId,
    };

    let result: UpstreamCallResult;
    try {
      result = await callUpstream(target, body, anthropicVersion);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      attempts.push({ providerName: route.providerName, error: message });
      log.warn({ provider: route.providerName, err: message }, "upstream provider request failed, trying next");
      continue;
    }

    if (!result.response.ok && RETRYABLE_STATUS_CODES.has(result.response.status)) {
      attempts.push({ providerName: route.providerName, statusCode: result.response.status });
      log.warn({ provider: route.providerName, status: result.response.status }, "upstream provider returned retryable error, trying next");
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
