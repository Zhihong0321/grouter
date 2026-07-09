import type { FastifyPluginAsync } from "fastify";
import { createHash } from "node:crypto";
import { lookupKeyByHash } from "../../lib/keyAuth.js";
import { checkRateLimit } from "../../lib/rateLimit.js";
import { getRemainingBudgetCents } from "../../lib/budget.js";
import { callUpstream, forwardResponseHeaders, pipeAndTapUsage, readJsonAndExtractUsage } from "../../lib/upstream.js";
import { logUsage } from "../../lib/usageLogger.js";
import { sendAnthropicError } from "../../lib/errors.js";

const proxyRoutes: FastifyPluginAsync = async (app) => {
  app.post("/v1/messages", async (request, reply) => {
    const apiKeyHeader = request.headers["x-api-key"];
    if (typeof apiKeyHeader !== "string" || apiKeyHeader.length === 0) {
      return sendAnthropicError(reply, "authentication_error", "Missing x-api-key header");
    }

    const hash = createHash("sha256").update(apiKeyHeader).digest("hex");
    const keyRecord = await lookupKeyByHash(app.pg, app.redis, hash);
    if (!keyRecord || keyRecord.status !== "active") {
      return sendAnthropicError(reply, "authentication_error", "Invalid or revoked API key");
    }

    const body = request.body as Record<string, unknown>;
    const model = typeof body?.model === "string" ? body.model : undefined;
    if (!model) {
      return sendAnthropicError(reply, "invalid_request_error", "Missing `model` field");
    }

    if (keyRecord.modelRestrictions && !keyRecord.modelRestrictions.includes(model)) {
      return sendAnthropicError(reply, "permission_error", `Key is not permitted to use model "${model}"`);
    }

    const price = await app.priceCache.get(model);
    if (!price) {
      return sendAnthropicError(reply, "invalid_request_error", `Model "${model}" is not available`);
    }

    const withinRateLimit = await checkRateLimit(app.redis, keyRecord.id, keyRecord.rateLimitRpm);
    if (!withinRateLimit) {
      return sendAnthropicError(reply, "rate_limit_error", "Rate limit exceeded");
    }

    const remainingBudget = await getRemainingBudgetCents(app.pg, app.redis, keyRecord.id);
    if (remainingBudget <= 0) {
      return sendAnthropicError(reply, "billing_error", "Budget exhausted for this API key");
    }

    const anthropicVersion = request.headers["anthropic-version"];
    const { response, latencyStartMs } = await callUpstream(
      body,
      typeof anthropicVersion === "string" ? anthropicVersion : undefined,
    );

    const isStreaming = body?.stream === true;

    if (isStreaming) {
      reply.hijack();
      reply.raw.statusCode = response.status;
      forwardResponseHeaders(response, reply.raw);
      const usage = await pipeAndTapUsage(response, reply.raw);
      if (response.ok) {
        void logUsage(app.pg, app.redis, app.priceCache, {
          keyId: keyRecord.id,
          model,
          usage,
          latencyMs: Date.now() - latencyStartMs,
          statusCode: response.status,
          stream: true,
        }).catch((err) => request.log.error(err, "logUsage failed"));
      }
      return;
    }

    const { json, usage } = await readJsonAndExtractUsage(response);
    reply.code(response.status).send(json);
    if (response.ok) {
      void logUsage(app.pg, app.redis, app.priceCache, {
        keyId: keyRecord.id,
        model,
        usage,
        latencyMs: Date.now() - latencyStartMs,
        statusCode: response.status,
        stream: false,
      }).catch((err) => request.log.error(err, "logUsage failed"));
    }
  });
};

export default proxyRoutes;
