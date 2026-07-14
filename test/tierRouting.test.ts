import { describe, it, expect } from "vitest";
import { decideTier, fallbackDecision } from "../src/lib/tierRouting.js";
import type { TierConfig } from "../src/lib/tierRouting.js";
import type { Signals, TierModelMap } from "../src/lib/tierSignals.js";

const anthropicTiers: TierModelMap = { brain: "claude-opus-4-8", build: "claude-sonnet-5", routine: "claude-haiku-4-5" };
const openaiTiers: TierModelMap = { brain: "gpt-5", build: "gpt-5", routine: "gpt-5-mini" };

const baseConfig: TierConfig = {
  tiers: {
    anthropic: anthropicTiers,
    openai: openaiTiers,
  },
  longContextTokens: 60_000,
  shortTurnTokens: 1_500,
  mode: "smart",
  honorExplicitRoutine: false,
  smallFastModelName: "claude-haiku-4-5",
  routeUnknownOpenai: true,
};

const baseSignals: Signals = {
  client: "claude_code",
  requestedTier: "build",
  isBackground: false,
  thinkingEnabled: false,
  inputTokens: 5_000,
  hasTools: true,
};

describe("decideTier", () => {
  it("honor_tier mode returns the exact requested model (true off-switch)", () => {
    const cfg = { ...baseConfig, mode: "honor_tier" as const };
    const requestedModel = "claude-opus-4-7"; // Non-canonical model
    const sig: Signals = { ...baseSignals, requestedTier: "brain", isBackground: true, thinkingEnabled: true, inputTokens: 999_999 };
    const decision = decideTier(sig, anthropicTiers, cfg, requestedModel);
    expect(decision.ruleId).toBe("honor_tier");
    expect(decision.chosenTier).toBe("brain");
    expect(decision.chosenModel).toBe(requestedModel); // Exact model, not tiers.brain
    expect(decision.wasOverridden).toBe(false);
  });

  it("wasOverridden compares chosenModel vs requestedModel (not tier models)", () => {
    const requestedModel = "claude-sonnet-5";
    const sig: Signals = { ...baseSignals, requestedTier: "build", isBackground: true };
    const decision = decideTier(sig, anthropicTiers, baseConfig, requestedModel);
    expect(decision.ruleId).toBe("background");
    expect(decision.chosenTier).toBe("routine");
    expect(decision.chosenModel).toBe(anthropicTiers.routine); // claude-haiku-4-5
    expect(decision.wasOverridden).toBe(true); // haiku !== sonnet
  });

  it("wasOverridden false when chosen matches requested model exactly", () => {
    const requestedModel = "claude-sonnet-5";
    const sig: Signals = { ...baseSignals, requestedTier: "build" };
    const decision = decideTier(sig, anthropicTiers, baseConfig, requestedModel);
    expect(decision.ruleId).toBe("default");
    expect(decision.chosenModel).toBe(anthropicTiers.build); // claude-sonnet-5
    expect(decision.wasOverridden).toBe(false); // sonnet === sonnet
  });

  it("routes Claude Code's background/small-fast slot to routine regardless of other signals", () => {
    const sig: Signals = { ...baseSignals, isBackground: true, thinkingEnabled: true, inputTokens: 999_999 };
    const decision = decideTier(sig, anthropicTiers, baseConfig, "claude-opus-4-8");
    expect(decision.ruleId).toBe("background");
    expect(decision.chosenTier).toBe("routine");
    expect(decision.wasOverridden).toBe(true);
  });

  it("routes to brain when thinking is enabled", () => {
    const sig: Signals = { ...baseSignals, thinkingEnabled: true };
    const decision = decideTier(sig, anthropicTiers, baseConfig, "claude-sonnet-5");
    expect(decision.ruleId).toBe("thinking");
    expect(decision.chosenTier).toBe("brain");
  });

  it("routes to brain when input exceeds the long-context threshold", () => {
    const sig: Signals = { ...baseSignals, inputTokens: 60_001 };
    const decision = decideTier(sig, anthropicTiers, baseConfig, "claude-sonnet-5");
    expect(decision.ruleId).toBe("long_context");
    expect(decision.chosenTier).toBe("brain");
  });

  it("downgrades even an explicit brain ask on a short, tool-less turn", () => {
    const sig: Signals = { ...baseSignals, requestedTier: "brain", inputTokens: 10, hasTools: false };
    const decision = decideTier(sig, anthropicTiers, baseConfig, "claude-opus-4-8");
    expect(decision.ruleId).toBe("short_turn");
    expect(decision.chosenTier).toBe("routine");
    expect(decision.wasOverridden).toBe(true);
  });

  it("keeps an explicit brain ask on brain for a normal (tool-using) turn", () => {
    const sig: Signals = { ...baseSignals, requestedTier: "brain", inputTokens: 5_000, hasTools: true };
    const decision = decideTier(sig, anthropicTiers, baseConfig, "claude-opus-4-8");
    expect(decision.ruleId).toBe("explicit_brain");
    expect(decision.chosenTier).toBe("brain");
    expect(decision.wasOverridden).toBe(false);
  });

  it("downgrades a short, tool-less turn to routine", () => {
    const sig: Signals = { ...baseSignals, inputTokens: 100, hasTools: false };
    const decision = decideTier(sig, anthropicTiers, baseConfig, "claude-sonnet-5");
    expect(decision.ruleId).toBe("short_turn");
    expect(decision.chosenTier).toBe("routine");
    expect(decision.wasOverridden).toBe(true);
  });

  it("does not downgrade a short turn that uses tools", () => {
    const sig: Signals = { ...baseSignals, inputTokens: 100, hasTools: true };
    const decision = decideTier(sig, anthropicTiers, baseConfig, "claude-sonnet-5");
    expect(decision.ruleId).toBe("default");
    expect(decision.chosenTier).toBe("build");
  });

  it("honorExplicitRoutine off (default): a long/tool-heavy explicit routine ask is NOT pinned to routine", () => {
    const sig: Signals = { ...baseSignals, requestedTier: "routine", inputTokens: 5_000, hasTools: true };
    const decision = decideTier(sig, anthropicTiers, baseConfig, "claude-haiku-4-5");
    expect(decision.ruleId).toBe("default");
    expect(decision.chosenTier).toBe("build");
  });

  it("honorExplicitRoutine on: pins a long/tool-heavy explicit routine ask to routine", () => {
    const cfg = { ...baseConfig, honorExplicitRoutine: true };
    const sig: Signals = { ...baseSignals, requestedTier: "routine", inputTokens: 5_000, hasTools: true };
    const decision = decideTier(sig, anthropicTiers, cfg, "claude-haiku-4-5");
    expect(decision.ruleId).toBe("explicit_routine");
    expect(decision.chosenTier).toBe("routine");
    expect(decision.wasOverridden).toBe(false);
  });

  it("honorExplicitRoutine on: thinking/long-context signals still override to brain", () => {
    const cfg = { ...baseConfig, honorExplicitRoutine: true };
    const sig: Signals = { ...baseSignals, requestedTier: "routine", thinkingEnabled: true };
    const decision = decideTier(sig, anthropicTiers, cfg, "claude-haiku-4-5");
    expect(decision.ruleId).toBe("thinking");
    expect(decision.chosenTier).toBe("brain");
  });

  it("defaults to build when nothing else matches", () => {
    const decision = decideTier(baseSignals, anthropicTiers, baseConfig, "claude-sonnet-5");
    expect(decision.ruleId).toBe("default");
    expect(decision.chosenTier).toBe("build");
    expect(decision.wasOverridden).toBe(false);
  });

  it("rule order: background beats thinking/long-context/explicit-brain", () => {
    const sig: Signals = { ...baseSignals, isBackground: true, requestedTier: "brain", thinkingEnabled: true };
    const decision = decideTier(sig, anthropicTiers, baseConfig, "claude-opus-4-8");
    expect(decision.ruleId).toBe("background");
  });

  it("rule order: thinking beats explicit-brain/short-turn", () => {
    const sig: Signals = { ...baseSignals, thinkingEnabled: true, requestedTier: "routine", inputTokens: 10, hasTools: false };
    const decision = decideTier(sig, anthropicTiers, baseConfig, "claude-haiku-4-5");
    expect(decision.ruleId).toBe("thinking");
    expect(decision.chosenTier).toBe("brain");
  });

  it("works with OpenAI tier map independently", () => {
    const sig: Signals = { ...baseSignals, client: "codex", inputTokens: 100, hasTools: false };
    const decision = decideTier(sig, openaiTiers, baseConfig, "gpt-5");
    expect(decision.ruleId).toBe("short_turn");
    expect(decision.chosenTier).toBe("routine");
    expect(decision.chosenModel).toBe(openaiTiers.routine); // gpt-5-mini
    expect(decision.wasOverridden).toBe(true);
  });
});

describe("fallbackDecision", () => {
  it("reverts to the requested model and clears the override flag", () => {
    const original = decideTier({ ...baseSignals, isBackground: true }, anthropicTiers, baseConfig, "claude-sonnet-5");
    const fallback = fallbackDecision(original, "claude-sonnet-5", "passthrough_fallback");
    expect(fallback.chosenModel).toBe("claude-sonnet-5");
    expect(fallback.chosenTier).toBe(original.requestedTier);
    expect(fallback.wasOverridden).toBe(false);
    expect(fallback.ruleId).toBe("passthrough_fallback");
  });
});
