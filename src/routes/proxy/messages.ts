import type { FastifyPluginAsync } from "fastify";
import { createHash } from "node:crypto";
import { extractApiKey, lookupKeyByHash } from "../../lib/keyAuth.js";
import { checkRateLimit } from "../../lib/rateLimit.js";
import { getRemainingBudgetCents } from "../../lib/budget.js";
import { forwardResponseHeaders, pipeAndTapUsage, readJsonAndExtractUsage } from "../../lib/upstream.js";
import { callWithFailover, AllProvidersFailedError } from "../../lib/failover.js";
import { logUsage } from "../../lib/usageLogger.js";
import { sendAnthropicError } from "../../lib/errors.js";

const proxyRoutes: FastifyPluginAsync = async (app) => {
  app.post("/v1/messages", async (request, reply) => {
    const apiKeyHeader = extractApiKey(request.headers);
    if (!apiKeyHeader) {
      return sendAnthropicError(reply, "authentication_error", "Missing x-api-key or Authorization header");
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

    const catalogModel = await app.routerCache.getModel(model);
    if (!catalogModel) {
      return sendAnthropicError(reply, "invalid_request_error", `Model "${model}" is not available`);
    }
    if (catalogModel.standard !== "anthropic") {
      return sendAnthropicError(
        reply,
        "invalid_request_error",
        `Model "${model}" uses the OpenAI-compatible API -- call POST /v1/chat/completions instead`,
      );
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

    const routes = await app.routerCache.getRoutes(model);
    if (routes.length === 0) {
      return sendAnthropicError(reply, "billing_error", `No upstream provider is configured for "${model}" yet -- set it up in /admin`);
    }

    const anthropicVersion = request.headers["anthropic-version"];

    let failover;
    try {
      failover = await callWithFailover(
        routes,
        body,
        typeof anthropicVersion === "string" ? anthropicVersion : undefined,
        request.log,
      );
    } catch (err) {
      if (err instanceof AllProvidersFailedError) {
        request.log.error({ model, attempts: err.attempts }, "all upstream providers failed for this model");
        return sendAnthropicError(reply, "overloaded_error", "All upstream providers are currently unavailable for this model");
      }
      throw err;
    }

    const { response, latencyStartMs, providerId, upstreamModelId } = failover;
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
          providerId,
          upstreamModelId,
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
        providerId,
        upstreamModelId,
      }).catch((err) => request.log.error(err, "logUsage failed"));
    }
  });
};

export default proxyRoutes;
