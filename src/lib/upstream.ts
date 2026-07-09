import type { ServerResponse } from "node:http";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import { StreamingUsageAccumulator, extractUsage } from "./usageExtract.js";
import type { CapturedUsage } from "../types/anthropic.js";

export interface SubrouterConfig {
  apiKey: string;
  baseUrl: string;
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

export interface SubrouterHealthResult {
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  modelCount?: number;
  message: string;
}

/**
 * Verifies a subrouter key/base URL actually work, without spending any
 * tokens: GET /v1/models is a metadata lookup on the real Anthropic API
 * surface (auth + routing only), never a completion, so it's a true
 * zero-cost smoke test for provider health.
 */
export async function checkSubrouterHealth(subrouter: SubrouterConfig): Promise<SubrouterHealthResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(`${subrouter.baseUrl}/v1/models`, {
      method: "GET",
      headers: {
        "x-api-key": subrouter.apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
    });
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
    const timedOut = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      latencyMs: Date.now() - start,
      message: timedOut ? "Timed out after 10s" : err instanceof Error ? err.message : "Unknown error",
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Forwards the client's request body upstream using the real subrouter key. The client's own key is never forwarded. */
export async function callUpstream(
  subrouter: SubrouterConfig,
  body: unknown,
  anthropicVersion: string | undefined,
): Promise<UpstreamCallResult> {
  const latencyStartMs = Date.now();
  const response = await fetch(`${subrouter.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": subrouter.apiKey,
      "anthropic-version": anthropicVersion ?? "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  return { response, latencyStartMs };
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
export async function pipeAndTapUsage(response: Response, rawRes: ServerResponse): Promise<CapturedUsage> {
  const accumulator = new StreamingUsageAccumulator();

  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      if (!event.data) return;
      let parsed: any;
      try {
        parsed = JSON.parse(event.data);
      } catch {
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

  return accumulator.get();
}

/** Non-streaming path: read the full JSON body, return both the parsed body and its usage. */
export async function readJsonAndExtractUsage(response: Response): Promise<{ json: any; usage: CapturedUsage }> {
  const json = (await response.json()) as any;
  return { json, usage: extractUsage(json?.usage) };
}
