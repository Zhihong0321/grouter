import type { Pool } from "pg";
import type { ClientKind, Tier } from "./tierSignals.js";
import type { RuleId } from "./tierRouting.js";

export type RequestLogOutcome = "success" | "upstream_error" | "all_providers_failed" | "no_route";

export interface RequestLogParams {
  keyId?: string;
  endpoint: string;
  model: string;
  outcome: RequestLogOutcome;
  statusCode?: number;
  providerId?: string;
  providerName?: string;
  upstreamModelId?: string;
  errorMessage?: string;
  attempts?: unknown;
  /** Total time from upstream dispatch to full response consumed (ttfb + generation/streaming). */
  latencyMs?: number;
  /** Our own overhead before even dispatching: auth lookup, rate limit, budget check, routing lookup. */
  preDispatchMs?: number;
  /** Time from dispatching the winning attempt to that provider's response headers arriving. */
  upstreamTtfbMs?: number;

  /** Smart Routing Mode decision, captured as it was at request time -- see smart_routing_buildplan.md. */
  client?: ClientKind;
  smartRoutingEnabled?: boolean;
  routingMode?: "smart" | "honor_tier";
  requestedTier?: Tier;
  /** The model the client actually asked for, before any smart-routing swap. */
  requestedModel?: string;
  chosenModel?: string;
  ruleId?: RuleId;
  wasOverridden?: boolean;
  costBaselineCents?: number;
  costSavedCents?: number;
}

/**
 * Fire-and-forget, called after the client already has its response (or
 * error). reseller_usage_logs only ever gets a row when response.ok, so this
 * is the only place routing failures -- no provider configured, every
 * provider failing over, a non-2xx from the provider that was actually used
 * -- become visible anywhere other than ephemeral process logs. The three
 * timing fields exist so a slow request can be attributed to our own
 * overhead, the network/provider connect, or the provider's own generation
 * time, instead of one opaque total.
 */
export async function logRequestEvent(pg: Pool, params: RequestLogParams): Promise<void> {
  await pg.query(
    `INSERT INTO reseller_request_logs (
      key_id, endpoint, model, outcome, status_code, provider_id, provider_name, upstream_model_id, error_message, attempts, latency_ms,
      pre_dispatch_ms, upstream_ttfb_ms,
      client, smart_routing_enabled, routing_mode, requested_tier, requested_model, chosen_model, rule_id, was_overridden, cost_baseline_cents, cost_saved_cents
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
    [
      params.keyId ?? null,
      params.endpoint,
      params.model,
      params.outcome,
      params.statusCode ?? null,
      params.providerId ?? null,
      params.providerName ?? null,
      params.upstreamModelId ?? null,
      params.errorMessage ?? null,
      params.attempts !== undefined ? JSON.stringify(params.attempts) : null,
      params.latencyMs ?? null,
      params.preDispatchMs ?? null,
      params.upstreamTtfbMs ?? null,
      params.client ?? null,
      params.smartRoutingEnabled ?? null,
      params.routingMode ?? null,
      params.requestedTier ?? null,
      params.requestedModel ?? null,
      params.chosenModel ?? null,
      params.ruleId ?? null,
      params.wasOverridden ?? null,
      params.costBaselineCents ?? null,
      params.costSavedCents ?? null,
    ],
  );
}
