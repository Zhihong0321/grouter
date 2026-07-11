import { describe, it, expect } from "vitest";
import { decideTier, fallbackDecision } from "../src/lib/tierRouting.js";
import type { TierConfig } from "../src/lib/tierRouting.js";
import type { Signals } from "../src/lib/tierSignals.js";

const tiers = { brain: "claude-opus-4-8", build: "claude-sonnet-5", routine: "claude-haiku-4-5" };

const baseConfig: TierConfig = {
  tiers,
  longContextTokens: 60_000,
  shortTurnTokens: 1_500,
  mode: "smart",
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
  it("honor_tier mode always serves the requested tier, ignoring every other signal", () => {
    const cfg: TierConfig = { ...baseConfig, mode: "honor_tier" };
    const sig: Signals = { ...baseSignals, requestedTier: "brain", isBackground: true, thinkingEnabled: true, inputTokens: 999_999 };
    const decision = decideTier(sig, cfg);
    expect(decision.ruleId).toBe("honor_tier");
    expect(decision.chosenTier).toBe("brain");
    expect(decision.chosenModel).toBe(tiers.brain);
    expect(decision.wasOverridden).toBe(false);
  });

  it("routes Claude Code's background/small-fast slot to routine regardless of other signals", () => {
    const sig: Signals = { ...baseSignals, isBackground: true, thinkingEnabled: true, inputTokens: 999_999 };
    const decision = decideTier(sig, baseConfig);
    expect(decision.ruleId).toBe("background");
    expect(decision.chosenTier).toBe("routine");
    expect(decision.wasOverridden).toBe(true);
  });

  it("routes to brain when thinking is enabled", () => {
    const sig: Signals = { ...baseSignals, thinkingEnabled: true };
    const decision = decideTier(sig, baseConfig);
    expect(decision.ruleId).toBe("thinking");
    expect(decision.chosenTier).toBe("brain");
  });

  it("routes to brain when input exceeds the long-context threshold", () => {
    const sig: Signals = { ...baseSignals, inputTokens: 60_001 };
    const decision = decideTier(sig, baseConfig);
    expect(decision.ruleId).toBe("long_context");
    expect(decision.chosenTier).toBe("brain");
  });

  it("never silently downgrades an explicit brain-tier ask", () => {
    const sig: Signals = { ...baseSignals, requestedTier: "brain", inputTokens: 10, hasTools: false };
    const decision = decideTier(sig, baseConfig);
    expect(decision.ruleId).toBe("explicit_brain");
    expect(decision.chosenTier).toBe("brain");
    expect(decision.wasOverridden).toBe(false);
  });

  it("downgrades a short, tool-less turn to routine", () => {
    const sig: Signals = { ...baseSignals, inputTokens: 100, hasTools: false };
    const decision = decideTier(sig, baseConfig);
    expect(decision.ruleId).toBe("short_turn");
    expect(decision.chosenTier).toBe("routine");
    expect(decision.wasOverridden).toBe(true);
  });

  it("does not downgrade a short turn that uses tools", () => {
    const sig: Signals = { ...baseSignals, inputTokens: 100, hasTools: true };
    const decision = decideTier(sig, baseConfig);
    expect(decision.ruleId).toBe("default");
    expect(decision.chosenTier).toBe("build");
  });

  it("defaults to build when nothing else matches", () => {
    const decision = decideTier(baseSignals, baseConfig);
    expect(decision.ruleId).toBe("default");
    expect(decision.chosenTier).toBe("build");
    expect(decision.wasOverridden).toBe(false);
  });

  it("rule order: background beats thinking/long-context/explicit-brain", () => {
    const sig: Signals = { ...baseSignals, isBackground: true, requestedTier: "brain", thinkingEnabled: true };
    const decision = decideTier(sig, baseConfig);
    expect(decision.ruleId).toBe("background");
  });

  it("rule order: thinking beats explicit-brain/short-turn", () => {
    const sig: Signals = { ...baseSignals, thinkingEnabled: true, requestedTier: "routine", inputTokens: 10, hasTools: false };
    const decision = decideTier(sig, baseConfig);
    expect(decision.ruleId).toBe("thinking");
    expect(decision.chosenTier).toBe("brain");
  });
});

describe("fallbackDecision", () => {
  it("reverts to the requested model and clears the override flag", () => {
    const original = decideTier({ ...baseSignals, isBackground: true }, baseConfig);
    const fallback = fallbackDecision(original, "claude-sonnet-5", "passthrough_fallback");
    expect(fallback.chosenModel).toBe("claude-sonnet-5");
    expect(fallback.chosenTier).toBe(original.requestedTier);
    expect(fallback.wasOverridden).toBe(false);
    expect(fallback.ruleId).toBe("passthrough_fallback");
  });
});
