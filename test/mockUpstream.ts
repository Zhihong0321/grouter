import Fastify, { type FastifyInstance } from "fastify";

interface MockUsage {
  input_tokens: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface MockUpstreamOptions {
  /** Defaults to "test-subrouter-key" -- kept as the default so existing tests don't need to pass it. */
  expectedApiKey?: string;
  /** When true, /v1/messages always returns 503 without ever forwarding a real response -- used to drive failover tests. */
  failMessages?: boolean;
}

/**
 * Mimics Anthropic's POST /v1/messages closely enough to drive the proxy end
 * to end: supports both streaming (SSE) and non-streaming, with usage
 * (including cache fields) controllable per-request via an `x-mock-usage`
 * JSON header so tests can assert exact cache-write / cache-read scenarios.
 */
export function createMockUpstream(options: MockUpstreamOptions = {}): FastifyInstance {
  const expectedApiKey = options.expectedApiKey ?? "test-subrouter-key";
  const app = Fastify({ logger: false });

  // Real Anthropic-shaped model list -- used by the zero-cost provider
  // health check (GET /v1/models never creates a message, so it never
  // consumes tokens).
  app.get("/v1/models", async (request, reply) => {
    if (request.headers["x-api-key"] !== expectedApiKey) {
      return reply.code(401).send({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    }
    return reply.send({
      data: [
        { id: "claude-haiku-4-5", type: "model" },
        { id: "claude-sonnet-5", type: "model" },
      ],
      has_more: false,
    });
  });

  app.post("/v1/messages", async (request, reply) => {
    if (options.failMessages) {
      return reply.code(503).send({ type: "error", error: { type: "overloaded_error", message: "mock upstream deliberately failing" } });
    }
    const body = request.body as any;
    // `mock_usage` is not a real Anthropic field -- the proxy forwards the
    // client's JSON body verbatim, so tests can steer this test double's
    // response by including it in the request body sent to the proxy.
    const header = request.headers["x-mock-usage"];
    const usage: MockUsage = body?.mock_usage
      ?? (header ? JSON.parse(header as string) : { input_tokens: 100, output_tokens: 42, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    const outputTokens = usage.output_tokens ?? 42;

    if (body?.stream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const send = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      send("message_start", {
        type: "message_start",
        message: {
          id: "msg_mock",
          model: body.model,
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: 1,
            cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          },
        },
      });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "mock" } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: outputTokens } });
      send("message_stop", { type: "message_stop" });
      reply.raw.end();
      return;
    }

    return reply.send({
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model: body?.model,
      content: [{ type: "text", text: "mock response" }],
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      },
    });
  });

  return app;
}
