import type { Signals, Tier, TierModelMap } from "./tierSignals.js";

export interface TierConfig {
  /** Per-standard tier -> concrete model_id maps. Each handler uses its own standard's map. */
  tiers: {
    anthropic: TierModelMap;
    openai: TierModelMap;
  };
  /** Above this many (estimated) input tokens, always route to brain. */
  longContextTokens: number;
  /** Below this many input tokens with no tools, downgrade to routine. */
  shortTurnTokens: number;
  /** Global kill switch: "honor_tier" makes every enabled key pass through
   * to whatever tier the client's requested model already maps to, without
   * running the rest of the rules. */
  mode: "smart" | "honor_tier";
  /** When true, an explicit routine-tier ask (e.g. Codex reasoning.effort:
   * "low") is never upgraded past routine, even on a long or tool-heavy turn.
   * Off by default: thinking/long-context/short-turn signals still decide,
   * same as any other requested tier. */
  honorExplicitRoutine: boolean;
  /** Small-fast model name for Claude Code background slot. */
  smallFastModelName: string;
  /** When true, route unknown OpenAI-compatible clients on chat/completions. */
  routeUnknownOpenai: boolean;
}

export type RuleId =
  | "honor_tier"
  | "background"
  | "thinking"
  | "long_context"
  | "explicit_brain"
  | "explicit_routine"
  | "short_turn"
  | "default"
  // Handler-level fallbacks -- decideTier() never produces these itself,
  // since it has no I/O and can't know whether the chosen model actually has
  // an active route or passes the key's model restrictions.
  | "passthrough_fallback"
  | "restricted_fallback";

export interface RoutingDecision {
  chosenModel: string;
  chosenTier: Tier;
  requestedTier: Tier;
  ruleId: RuleId;
  wasOverridden: boolean;
}

/**
 * Ordered rules, first match wins -- see smart_routing_buildplan.md section 5.
 * Pure function: no I/O, no catalog/route awareness. Callers must verify the
 * chosen tier's model actually has an active route (and isn't blocked by the
 * key's model restrictions) before using it -- see `fallbackDecision` below
 * and its use in messages.ts / openai.ts.
 *
 * @param sig - Extracted signals from the request
 * @param tiers - The tier map for this request's standard (anthropic or openai)
 * @param cfg - Config options (mode, thresholds, etc.)
 * @param requestedModel - The actual model string the client sent (for wasOverridden)
 */
export function decideTier(
  sig: Signals,
  tiers: TierModelMap,
  cfg: { mode: "smart" | "honor_tier"; longContextTokens: number; shortTurnTokens: number; honorExplicitRoutine: boolean },
  requestedModel: string,
): RoutingDecision {
  const finish = (chosenTier: Tier, ruleId: RuleId): RoutingDecision => ({
    chosenModel: tiers[chosenTier],
    chosenTier,
    requestedTier: sig.requestedTier,
    ruleId,
    wasOverridden: tiers[chosenTier] !== requestedModel,
  });

  // honor_tier mode: return the exact requested model (true off-switch)
  if (cfg.mode === "honor_tier") {
    return {
      chosenModel: requestedModel,
      chosenTier: sig.requestedTier,
      requestedTier: sig.requestedTier,
      ruleId: "honor_tier",
      wasOverridden: false,
    };
  }

  if (sig.isBackground) return finish("routine", "background");
  if (sig.thinkingEnabled) return finish("brain", "thinking");
  if (sig.inputTokens > cfg.longContextTokens) return finish("brain", "long_context");
  if (sig.requestedTier === "brain") return finish("brain", "explicit_brain");
  if (cfg.honorExplicitRoutine && sig.requestedTier === "routine") return finish("routine", "explicit_routine");
  if (sig.inputTokens < cfg.shortTurnTokens && !sig.hasTools) return finish("routine", "short_turn");
  return finish("build", "default");
}

/**
 * Used when the engine's chosen model can't actually be served -- not in the
 * catalog, no active route, or blocked by the key's model restrictions.
 * Falls back to the client's originally requested model rather than erroring,
 * since the request itself was valid; only the tier substitution wasn't.
 */
export function fallbackDecision(decision: RoutingDecision, requestedModel: string, reason: "passthrough_fallback" | "restricted_fallback"): RoutingDecision {
  return {
    ...decision,
    chosenModel: requestedModel,
    chosenTier: decision.requestedTier,
    ruleId: reason,
    wasOverridden: false,
  };
}
