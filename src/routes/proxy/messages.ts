import type { FastifyPluginAsync } from "fastify";
import { createHash } from "node:crypto";
import { extractApiKey, lookupKeyByHash } from "../../lib/keyAuth.js";
import { checkRateLimit } from "../../lib/rateLimit.js";
import { getRemainingBudgetCents } from "../../lib/budget.js";
import { forwardResponseHeaders, pipeAndTapUsage, readJsonAndExtractUsage } from "../../lib/upstream.js";
import { callWithFailover, AllProvidersFailedError } from "../../lib/failover.js";
import { logUsage } from "../../lib/usageLogger.js";
import { logRequestEvent } from "../../lib/requestLog.js";
import { sendAnthropicError } from "../../lib/errors.js";
import { detectClient, signalsFromAnthropic } from "../../lib/tierSignals.js";
import { decideTier, fallbackDecision, type RoutingDecision, type TierConfig } from "../../lib/tierRouting.js";
import { computeCostCents } from "../../lib/pricing.js";
import type { CapturedUsage } from "../../types/anthropic.js";

const proxyRoutes: FastifyPluginAsync = async (app) => {
  app.post("/v1/messages", async (request, reply) => {
    const requestStartMs = Date.now();
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
    const requestedModel = typeof body?.model === "string" ? body.model : undefined;
    if (!requestedModel) {
      return sendAnthropicError(reply, "invalid_request_error", "Missing `model` field");
    }

    if (keyRecord.modelRestrictions && !keyRecord.modelRestrictions.includes(requestedModel)) {
      return sendAnthropicError(reply, "permission_error", `Key is not permitted to use model "${requestedModel}"`);
    }

    const requestedCatalogModel = await app.routerCache.getModel(requestedModel);
    if (!requestedCatalogModel) {
      return sendAnthropicError(reply, "invalid_request_error", `Model "${requestedModel}" is not available`);
    }
    if (requestedCatalogModel.standard !== "anthropic") {
      return sendAnthropicError(
        reply,
        "invalid_request_error",
        `Model "${requestedModel}" uses the OpenAI-compatible API -- call POST /v1/chat/completions instead`,
      );
    }

    // Smart Routing Mode: swap in a cheaper tier when the request clears the
    // quality bar for it. Not to be confused with src/lib/smartRouting.ts
    // (provider failover matrix sync) -- see smart_routing_buildplan.md.
    // Always on -- no per-key opt-in. The global kill switch is the
    // tier_routing_mode admin setting ("smart" vs "honor_tier"), not a per-key
    // flag; see src/routes/admin/tierRouting.ts.
    const client = detectClient(request.headers, "messages");
    const smartRoutingEnabled = true;
    let model = requestedModel;
    let decision: RoutingDecision | undefined;
    let tierConfig: TierConfig | undefined;
    if (smartRoutingEnabled) {
      tierConfig = await app.settingsCache.getTierConfig();
      const sig = signalsFromAnthropic(body, {
        tiers: tierConfig.tiers.anthropic,
        smallFastModelName: tierConfig.smallFastModelName,
      });
      decision = decideTier(sig, tierConfig.tiers.anthropic, tierConfig, requestedModel);
      if (decision.chosenModel !== requestedModel) {
        if (keyRecord.modelRestrictions && !keyRecord.modelRestrictions.includes(decision.chosenModel)) {
          decision = fallbackDecision(decision, requestedModel, "restricted_fallback");
        } else {
          const chosenCatalogModel = await app.routerCache.getModel(decision.chosenModel);
          const chosenRoutes = chosenCatalogModel ? await app.routerCache.getRoutes(decision.chosenModel) : [];
          if (chosenCatalogModel && chosenCatalogModel.standard === "anthropic" && chosenRoutes.length > 0) {
            model = decision.chosenModel;
          } else {
            decision = fallbackDecision(decision, requestedModel, "passthrough_fallback");
          }
        }
      }
      if (decision.wasOverridden) {
        request.log.info(
          { client, requestedModel, chosenModel: model, requestedTier: decision.requestedTier, chosenTier: decision.chosenTier, rule: decision.ruleId },
          `[Smart Route] ${client}: ${requestedModel} -> ${model} (${decision.requestedTier} -> ${decision.chosenTier}, rule=${decision.ruleId})`,
        );
      }
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
    if (!keyRecord.unlimited && remainingBudget <= 0) {
      return sendAnthropicError(reply, "billing_error", "Budget exhausted for this API key");
    }

    const routingLogFields = {
      client,
      smartRoutingEnabled,
      routingMode: tierConfig?.mode,
      requestedTier: decision?.requestedTier,
      requestedModel,
      chosenModel: model,
      ruleId: decision?.ruleId,
      wasOverridden: decision?.wasOverridden,
    };

    const routes = await app.routerCache.getRoutes(model);
    if (routes.length === 0) {
      void logRequestEvent(app.pg, {
        keyId: keyRecord.id,
        endpoint: "messages",
        model,
        outcome: "no_route",
        errorMessage: "No upstream provider is configured for this model",
        preDispatchMs: Date.now() - requestStartMs,
        ...routingLogFields,
      }).catch((err) => request.log.error(err, "logRequestEvent failed"));
      return sendAnthropicError(reply, "billing_error", `No upstream provider is configured for "${model}" yet -- set it up in /admin`);
    }

    const anthropicVersion = request.headers["anthropic-version"];
    const dispatchStartMs = Date.now();

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
        void logRequestEvent(app.pg, {
          keyId: keyRecord.id,
          endpoint: "messages",
          model,
          outcome: "all_providers_failed",
          attempts: err.attempts,
          preDispatchMs: dispatchStartMs - requestStartMs,
          ...routingLogFields,
        }).catch((logErr) => request.log.error(logErr, "logRequestEvent failed"));
        return sendAnthropicError(reply, "overloaded_error", "All upstream providers are currently unavailable for this model");
      }
      throw err;
    }

    const { response, latencyStartMs, headersReceivedMs, providerId, providerName, upstreamModelId, attempts } = failover;
    const isStreaming = body?.stream === true;

    // Only meaningful when the engine actually swapped models: what the
    // client's originally requested tier would have cost for the same usage,
    // vs what was actually billed.
    const computeSavings = async (usage: CapturedUsage): Promise<{ costBaselineCents?: number; costSavedCents?: number }> => {
      if (!decision?.wasOverridden || !tierConfig) return {};
      // Baseline = what the client's *actual requested model* would have cost for
      // the same usage (smart routing off), not the requested tier's model, so a
      // swap whose requested tier already equals the served tier still reports the
      // real requested-vs-routed price difference.
      const baselinePrice = await app.priceCache.get(requestedModel);
      if (!baselinePrice) return {};
      const costBaselineCents = computeCostCents(usage, baselinePrice).totalCostCents;
      const costSavedCents = Math.max(0, costBaselineCents - computeCostCents(usage, price).totalCostCents);
      return { costBaselineCents, costSavedCents };
    };

    const logDispatch = (statusCode: number, latencyMs: number, savings: { costBaselineCents?: number; costSavedCents?: number } = {}) =>
      void logRequestEvent(app.pg, {
        keyId: keyRecord.id,
        endpoint: "messages",
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
      const usage = await pipeAndTapUsage(response, reply.raw);
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

    const { json, usage } = await readJsonAndExtractUsage(response);
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
  });
};

export default proxyRoutes;
