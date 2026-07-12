import type { FastifyPluginAsync } from "fastify";
import { createHash } from "node:crypto";
import { extractApiKey, lookupKeyByHash } from "../../lib/keyAuth.js";
import { checkRateLimit } from "../../lib/rateLimit.js";
import { getRemainingBudgetCents } from "../../lib/budget.js";
import { forwardResponseHeaders, pipeAndTapUsage, readJsonAndExtractUsage } from "../../lib/upstream.js";
import { callWithFailover, AllProvidersFailedError } from "../../lib/failover.js";
import { logUsage } from "../../lib/usageLogger.js";
import { logRequestEvent } from "../../lib/requestLog.js";
import { sendOpenAiError } from "../../lib/errors.js";
import { detectClient, signalsFromOpenAI } from "../../lib/tierSignals.js";
import { decideTier, fallbackDecision, type RoutingDecision, type TierConfig } from "../../lib/tierRouting.js";
import { computeCostCents } from "../../lib/pricing.js";
import type { CapturedUsage } from "../../types/anthropic.js";

type OpenAiEndpoint = "chat/completions" | "responses";

async function handleOpenAiRequest(app: Parameters<FastifyPluginAsync>[0], request: any, reply: any, endpoint: OpenAiEndpoint) {
  const requestStartMs = Date.now();
  const apiKeyHeader = extractApiKey(request.headers);
  if (!apiKeyHeader) {
    return sendOpenAiError(reply, "authentication_error", "Missing Authorization header");
  }

  const hash = createHash("sha256").update(apiKeyHeader).digest("hex");
  const keyRecord = await lookupKeyByHash(app.pg, app.redis, hash);
  if (!keyRecord || keyRecord.status !== "active") {
    return sendOpenAiError(reply, "authentication_error", "Invalid or revoked API key");
  }

  const body = (request.body ?? {}) as Record<string, unknown>;
  const requestedModel = typeof body.model === "string" ? body.model : undefined;
  if (!requestedModel) {
    return sendOpenAiError(reply, "invalid_request_error", "Missing `model` field");
  }

  if (keyRecord.modelRestrictions && !keyRecord.modelRestrictions.includes(requestedModel)) {
    return sendOpenAiError(reply, "permission_error", `Key is not permitted to use model "${requestedModel}"`);
  }

  const requestedCatalogModel = await app.routerCache.getModel(requestedModel);
  if (!requestedCatalogModel) {
    return sendOpenAiError(reply, "invalid_request_error", `Model "${requestedModel}" is not available`);
  }
  if (requestedCatalogModel.standard !== "openai") {
    return sendOpenAiError(
      reply,
      "invalid_request_error",
      `Model "${requestedModel}" uses the Anthropic API -- call POST /v1/messages instead`,
    );
  }

  // Smart Routing Mode: swap in a cheaper tier when the request clears the
  // quality bar for it. Not to be confused with src/lib/smartRouting.ts
  // (provider failover matrix sync) -- see smart_routing_buildplan.md.
  // Always on for Codex, and optionally for unknown OpenAI-compatible clients
  // (controlled by tier_route_unknown_openai setting). The global kill switch
  // is the tier_routing_mode admin setting ("smart" vs "honor_tier"), not a
  // per-key/per-client flag; see admin/tierRouting.ts.
  const client = detectClient(request.headers, endpoint);
  const tierConfig = await app.settingsCache.getTierConfig();
  const smartRoutingEnabled =
    client === "codex" || (client === "unknown" && tierConfig.routeUnknownOpenai);
  let model = requestedModel;
  let decision: RoutingDecision | undefined;
  if (smartRoutingEnabled) {
    const sig = signalsFromOpenAI(body, endpoint, { tiers: tierConfig.tiers.openai });
    decision = decideTier(sig, tierConfig.tiers.openai, tierConfig, requestedModel);
    if (decision.chosenModel !== requestedModel) {
      if (keyRecord.modelRestrictions && !keyRecord.modelRestrictions.includes(decision.chosenModel)) {
        decision = fallbackDecision(decision, requestedModel, "restricted_fallback");
      } else {
        const chosenCatalogModel = await app.routerCache.getModel(decision.chosenModel);
        const chosenRoutes = chosenCatalogModel ? await app.routerCache.getRoutes(decision.chosenModel) : [];
        if (chosenCatalogModel && chosenCatalogModel.standard === "openai" && chosenRoutes.length > 0) {
          model = decision.chosenModel;
        } else {
          decision = fallbackDecision(decision, requestedModel, "passthrough_fallback");
        }
      }
    }
  }

  const price = await app.priceCache.get(model);
  if (!price) {
    return sendOpenAiError(reply, "invalid_request_error", `Model "${model}" is not available`);
  }

  if (!(await checkRateLimit(app.redis, keyRecord.id, keyRecord.rateLimitRpm))) {
    return sendOpenAiError(reply, "rate_limit_error", "Rate limit exceeded");
  }

  const remainingBudget = await getRemainingBudgetCents(app.pg, app.redis, keyRecord.id);
  if (!keyRecord.unlimited && remainingBudget <= 0) {
    return sendOpenAiError(reply, "billing_error", "Budget exhausted for this API key", "insufficient_quota");
  }

  const routingLogFields = {
    client,
    smartRoutingEnabled,
    routingMode: tierConfig?.mode,
    requestedTier: decision?.requestedTier,
    chosenModel: model,
    ruleId: decision?.ruleId,
    wasOverridden: decision?.wasOverridden,
  };

  const routes = await app.routerCache.getRoutes(model);
  if (routes.length === 0) {
    void logRequestEvent(app.pg, {
      keyId: keyRecord.id,
      endpoint,
      model,
      outcome: "no_route",
      errorMessage: "No upstream provider is configured for this model",
      preDispatchMs: Date.now() - requestStartMs,
      ...routingLogFields,
    }).catch((err) => request.log.error(err, "logRequestEvent failed"));
    return sendOpenAiError(reply, "billing_error", `No upstream provider is configured for "${model}" yet -- set it up in /admin`);
  }

  const dispatchStartMs = Date.now();
  let failover;
  try {
    failover = await callWithFailover(routes, body, undefined, request.log, endpoint);
  } catch (err) {
    if (err instanceof AllProvidersFailedError) {
      request.log.error({ model, endpoint, attempts: err.attempts }, "all upstream providers failed for this model");
      void logRequestEvent(app.pg, {
        keyId: keyRecord.id,
        endpoint,
        model,
        outcome: "all_providers_failed",
        attempts: err.attempts,
        preDispatchMs: dispatchStartMs - requestStartMs,
        ...routingLogFields,
      }).catch((logErr) => request.log.error(logErr, "logRequestEvent failed"));
      return sendOpenAiError(reply, "overloaded_error", "All upstream providers are currently unavailable for this model");
    }
    throw err;
  }

  const { response, latencyStartMs, headersReceivedMs, providerId, providerName, upstreamModelId, attempts } = failover;
  const isStreaming = body.stream === true;

  const computeSavings = async (usage: CapturedUsage): Promise<{ costBaselineCents?: number; costSavedCents?: number }> => {
    if (!decision?.wasOverridden) return {};
    const baselinePrice = await app.priceCache.get(tierConfig.tiers.openai[decision.requestedTier]);
    if (!baselinePrice) return {};
    const costBaselineCents = computeCostCents(usage, baselinePrice).totalCostCents;
    const costSavedCents = Math.max(0, costBaselineCents - computeCostCents(usage, price).totalCostCents);
    return { costBaselineCents, costSavedCents };
  };

  const logDispatch = (statusCode: number, latencyMs: number, savings: { costBaselineCents?: number; costSavedCents?: number } = {}) =>
    void logRequestEvent(app.pg, {
      keyId: keyRecord.id,
      endpoint,
      model,
      outcome: statusCode >= 200 && statusCode < 300 ? "success" : "upstream_error",
      statusCode,
      providerId,
      providerName,
      upstreamModelId,
      latencyMs,
      preDispatchMs: dispatchStartMs - requestStartMs,
      upstreamTtfbMs: headersReceivedMs - latencyStartMs,
      attempts: attempts.length > 0 ? attempts : undefined,
      ...routingLogFields,
      ...savings,
    }).catch((err) => request.log.error(err, "logRequestEvent failed"));

  if (isStreaming) {
    reply.hijack();
    reply.raw.statusCode = response.status;
    forwardResponseHeaders(response, reply.raw);
    const usage = await pipeAndTapUsage(response, reply.raw, "openai");
    const latencyMs = Date.now() - latencyStartMs;
    const savings = response.ok ? await computeSavings(usage) : {};
    logDispatch(response.status, latencyMs, savings);
    if (response.ok) {
      void logUsage(app.pg, app.redis, app.priceCache, {
        keyId: keyRecord.id,
        model,
        usage,
        latencyMs,
        statusCode: response.status,
        stream: true,
        providerId,
        upstreamModelId,
      }).catch((err) => request.log.error(err, "logUsage failed"));
    }
    return;
  }

  const { json, usage } = await readJsonAndExtractUsage(response, "openai");
  reply.code(response.status).send(json);
  const latencyMs = Date.now() - latencyStartMs;
  const savings = response.ok ? await computeSavings(usage) : {};
  logDispatch(response.status, latencyMs, savings);
  if (response.ok) {
    void logUsage(app.pg, app.redis, app.priceCache, {
      keyId: keyRecord.id,
      model,
      usage,
      latencyMs,
      statusCode: response.status,
      stream: false,
      providerId,
      upstreamModelId,
    }).catch((err) => request.log.error(err, "logUsage failed"));
  }
}

const openAiProxyRoutes: FastifyPluginAsync = async (app) => {
  app.post("/v1/chat/completions", async (request, reply) => handleOpenAiRequest(app, request, reply, "chat/completions"));
  app.post("/v1/responses", async (request, reply) => handleOpenAiRequest(app, request, reply, "responses"));
};

export default openAiProxyRoutes;
