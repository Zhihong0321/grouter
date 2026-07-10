import type { FastifyPluginAsync } from "fastify";
import { createHash } from "node:crypto";
import { extractApiKey, lookupKeyByHash } from "../../lib/keyAuth.js";
import { checkRateLimit } from "../../lib/rateLimit.js";
import { callWithFailover, AllProvidersFailedError } from "../../lib/failover.js";
import { sendAnthropicError } from "../../lib/errors.js";

// Anthropic clients (Claude Code included) call this before essentially every
// turn to size the context window. It was missing entirely -- only
// /v1/messages was registered -- so any client pointed at this proxy failed
// even though completions themselves worked. Mirrors the auth/model-routing
// checks in proxy/messages.ts, but skips the budget check since count_tokens
// is free on the real Anthropic API and carries no usage to log.
const countTokensRoutes: FastifyPluginAsync = async (app) => {
  app.post("/v1/messages/count_tokens", async (request, reply) => {
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
      return sendAnthropicError(reply, "invalid_request_error", `Model "${model}" uses the OpenAI-compatible API`);
    }

    const withinRateLimit = await checkRateLimit(app.redis, keyRecord.id, keyRecord.rateLimitRpm);
    if (!withinRateLimit) {
      return sendAnthropicError(reply, "rate_limit_error", "Rate limit exceeded");
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
        "messages/count_tokens",
      );
    } catch (err) {
      if (err instanceof AllProvidersFailedError) {
        request.log.error({ model, attempts: err.attempts }, "all upstream providers failed for count_tokens");
        return sendAnthropicError(reply, "overloaded_error", "All upstream providers are currently unavailable for this model");
      }
      throw err;
    }

    const json = await failover.response.json();
    reply.code(failover.response.status).send(json);
  });
};

export default countTokensRoutes;
