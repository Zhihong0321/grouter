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
