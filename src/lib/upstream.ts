import type { ServerResponse } from "node:http";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import { OpenAiStreamingUsageAccumulator, StreamingUsageAccumulator, extractOpenAiUsage, extractUsage } from "./usageExtract.js";
import type { CapturedUsage } from "../types/anthropic.js";
import type { ProviderStandard } from "../types/router.js";

/** A single resolved upstream call target: which provider, and which model ID it expects. */
export interface ProviderTarget {
  standard: ProviderStandard;
  baseUrl: string;
  apiKey: string;
  upstreamModelId: string;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
]);

export interface UpstreamCallResult {
  response: Response;
  latencyStartMs: number;
}

export interface ProviderHealthResult {
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  modelCount?: number;
  message: string;
}

// Bounds only the connect + response-headers phase of an upstream call (the
// fetch() promise resolves once headers arrive, before the body streams) --
// long-running streamed generations are never cut short by this.
const UPSTREAM_CONNECT_TIMEOUT_MS = 60_000;

// Admins commonly paste either the provider host or its `/v1` API root. Keep
// one canonical form internally so requests never become `/v1/v1/...`.
function providerBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function authHeaders(target: Pick<ProviderTarget, "standard" | "apiKey">, anthropicVersion?: string): Record<string, string> {
  if (target.standard === "anthropic") {
    return { "x-api-key": target.apiKey, "anthropic-version": anthropicVersion ?? "2023-06-01" };
  }
  return { authorization: `Bearer ${target.apiKey}` };
}

export type UpstreamEndpoint = "messages" | "messages/count_tokens" | "chat/completions" | "responses";

function endpointPath(target: Pick<ProviderTarget, "standard" | "baseUrl">, endpoint: UpstreamEndpoint): string {
  if (target.standard === "anthropic" && (endpoint === "messages" || endpoint === "messages/count_tokens")) {
    return `${providerBaseUrl(target.baseUrl)}/v1/${endpoint}`;
  }
  if (target.standard === "openai" && (endpoint === "chat/completions" || endpoint === "responses")) {
    return `${providerBaseUrl(target.baseUrl)}/v1/${endpoint}`;
  }
  throw new Error(`Endpoint ${endpoint} is not supported by provider standard ${target.standard}`);
}

const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const HEALTH_CHECK_RETRY_DELAY_MS = 500;

async function fetchModels(target: Pick<ProviderTarget, "standard" | "baseUrl" | "apiKey">): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    return await fetch(`${providerBaseUrl(target.baseUrl)}/v1/models`, {
      method: "GET",
      headers: authHeaders(target),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Verifies a provider's key/base URL actually work, without spending any
 * tokens: GET /v1/models is a metadata lookup on the provider's API
 * surface (auth + routing only), never a completion, so it's a true
 * zero-cost smoke test for provider health.
 *
 * A dropped connection to the upstream is retried once before being reported
 * as a failure -- a single blip shouldn't read as "the key is bad" to the
 * admin. A real HTTP error response (401/400/etc, an actual answer from the
 * server) is not retried, since retrying won't change a genuine rejection.
 */
export async function checkProviderHealth(target: { standard: ProviderStandard; baseUrl: string; apiKey: string }): Promise<ProviderHealthResult> {
  const start = Date.now();
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_RETRY_DELAY_MS));

    try {
      const response = await fetchModels(target);
      const latencyMs = Date.now() - start;
      const json = (await response.json().catch(() => undefined)) as { error?: { message?: string }; data?: unknown[] } | undefined;

      if (!response.ok) {
        return {
          ok: false,
          statusCode: response.status,
          latencyMs,
          message: json?.error?.message ?? `Upstream returned ${response.status}`,
        };
      }

      return {
        ok: true,
        statusCode: response.status,
        latencyMs,
        modelCount: Array.isArray(json?.data) ? json.data.length : undefined,
        message: "Provider key is valid",
      };
    } catch (err) {
      lastError = err;
      // A timeout already burned the full budget -- retrying won't help within a single "Test" click.
      if (err instanceof Error && err.name === "AbortError") break;
    }
  }

  const timedOut = lastError instanceof Error && lastError.name === "AbortError";
  return {
    ok: false,
    latencyMs: Date.now() - start,
    message: timedOut ? "Timed out after 10s" : lastError instanceof Error ? lastError.message : "Unknown error",
  };
}

/**
 * Forwards the client's request body to a single resolved provider, rewriting
 * `model` to whatever ID that supplier expects. The client's own issued key
 * is never forwarded -- only the provider's real key.
 */
export async function callUpstream(
  target: ProviderTarget,
  body: Record<string, unknown>,
  anthropicVersion: string | undefined,
  endpoint: UpstreamEndpoint = "messages",
): Promise<UpstreamCallResult> {
  const latencyStartMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_CONNECT_TIMEOUT_MS);

  try {
    const upstreamBody: Record<string, unknown> = { ...body, model: target.upstreamModelId };
    if (target.standard === "openai" && endpoint === "chat/completions" && body.stream === true) {
      const existing = body.stream_options;
      upstreamBody.stream_options = {
        ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}),
        include_usage: true,
      };
    }

    const response = await fetch(endpointPath(target, endpoint), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(target, anthropicVersion) },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
    return { response, latencyStartMs };
  } finally {
    clearTimeout(timeout);
  }
}

export function forwardResponseHeaders(response: Response, rawRes: ServerResponse): void {
  for (const [key, value] of response.headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      rawRes.setHeader(key, value);
    }
  }
}

/**
 * Streams the upstream response body straight to the client with zero added
 * buffering, while passively tapping the same bytes with an SSE parser to
 * extract usage (including cache fields). The tap never gates or delays the
 * client-facing write.
 */
export async function pipeAndTapUsage(
  response: Response,
  rawRes: ServerResponse,
  standard: ProviderStandard = "anthropic",
): Promise<CapturedUsage> {
  const accumulator = new StreamingUsageAccumulator();
  const openAiAccumulator = new OpenAiStreamingUsageAccumulator();

  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      if (!event.data) return;
      let parsed: any;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (standard === "openai") {
        openAiAccumulator.onEvent(parsed);
        return;
      }
      if (parsed.type === "message_start") {
        accumulator.onMessageStart(parsed.message?.usage);
      } else if (parsed.type === "message_delta") {
        accumulator.onMessageDelta(parsed.usage);
      }
    },
  });

  const decoder = new TextDecoder();
  const reader = response.body?.getReader();
  if (!reader) {
    rawRes.end();
    return accumulator.get();
  }

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rawRes.write(value);
    parser.feed(decoder.decode(value, { stream: true }));
  }
  rawRes.end();

  return standard === "openai" ? openAiAccumulator.get() : accumulator.get();
}

/** Non-streaming path: read the full JSON body, return both the parsed body and its usage. */
export async function readJsonAndExtractUsage(
  response: Response,
  standard: ProviderStandard = "anthropic",
): Promise<{ json: any; usage: CapturedUsage }> {
  const json = (await response.json()) as any;
  return { json, usage: standard === "openai" ? extractOpenAiUsage(json?.usage) : extractUsage(json?.usage) };
}
