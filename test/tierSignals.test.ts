import { describe, it, expect } from "vitest";
import { detectClient, classifyRequestedTier, signalsFromAnthropic, signalsFromOpenAI } from "../src/lib/tierSignals.js";

const tiers = { brain: "claude-opus-4-8", build: "claude-sonnet-5", routine: "claude-haiku-4-5" };

describe("detectClient", () => {
  it("treats every /v1/messages request as claude_code -- CC is the only client on this path", () => {
    expect(detectClient({}, "messages")).toBe("claude_code");
    expect(detectClient({ "user-agent": "curl/8.0" }, "messages")).toBe("claude_code");
  });

  it("treats every /v1/responses request as codex -- the primary signal is the path itself", () => {
    expect(detectClient({}, "responses")).toBe("codex");
  });

  it("only trusts User-Agent to identify codex on the shared /v1/chat/completions path", () => {
    expect(detectClient({ "user-agent": "codex-cli/1.2.3" }, "chat/completions")).toBe("codex");
    expect(detectClient({ "user-agent": "some-other-openai-client/1.0" }, "chat/completions")).toBe("unknown");
    expect(detectClient({}, "chat/completions")).toBe("unknown");
  });
});

describe("classifyRequestedTier", () => {
  it("matches an exact configured tier model", () => {
    expect(classifyRequestedTier("claude-opus-4-8", tiers)).toBe("brain");
    expect(classifyRequestedTier("claude-sonnet-5", tiers)).toBe("build");
    expect(classifyRequestedTier("claude-haiku-4-5", tiers)).toBe("routine");
  });

  it("falls back to name heuristics for unrecognized models", () => {
    expect(classifyRequestedTier("gpt-5-high", tiers)).toBe("brain");
    expect(classifyRequestedTier("o1-preview", tiers)).toBe("brain");
    expect(classifyRequestedTier("gpt-5-mini", tiers)).toBe("routine");
    expect(classifyRequestedTier("some-unknown-model", tiers)).toBe("build");
  });

  it("classifies the gpt-5.6 sol/terra/luna fleet by tier suffix, not the gpt-5 prefix", () => {
    expect(classifyRequestedTier("gpt-5.6-sol", tiers)).toBe("brain");
    expect(classifyRequestedTier("gpt-5.6-terra", tiers)).toBe("build");
    expect(classifyRequestedTier("gpt-5.6-luna", tiers)).toBe("routine");
  });
});

describe("signalsFromAnthropic", () => {
  const cfg = { tiers, smallFastModelName: "claude-haiku-4-5" };

  it("flags the configured small-fast model as background", () => {
    const sig = signalsFromAnthropic({ model: "claude-haiku-4-5", messages: [] }, cfg);
    expect(sig.isBackground).toBe(true);
    expect(sig.client).toBe("claude_code");
  });

  it("reads thinking.type === 'enabled' as thinkingEnabled", () => {
    const sig = signalsFromAnthropic({ model: "claude-sonnet-5", messages: [], thinking: { type: "enabled" } }, cfg);
    expect(sig.thinkingEnabled).toBe(true);
  });

  it("detects tool use", () => {
    const sig = signalsFromAnthropic({ model: "claude-sonnet-5", messages: [], tools: [{ name: "bash" }] }, cfg);
    expect(sig.hasTools).toBe(true);
  });

  it("estimates larger input token counts for longer message content", () => {
    const short = signalsFromAnthropic({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }, cfg);
    const long = signalsFromAnthropic(
      { model: "claude-sonnet-5", messages: [{ role: "user", content: "x".repeat(10_000) }] },
      cfg,
    );
    expect(long.inputTokens).toBeGreaterThan(short.inputTokens);
  });

  it("counts tool_result content (file reads) toward the token estimate", () => {
    // An investigation turn: the visible user text is tiny, but a tool_result
    // block carries a large file. This must trip long-context routing, so the
    // token count has to reflect the file, not just the prose.
    const fileBody = "y".repeat(40_000);
    const sig = signalsFromAnthropic(
      {
        model: "claude-sonnet-5",
        messages: [
          { role: "user", content: "what does this file do?" },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: fileBody },
            ],
          },
        ],
      },
      cfg,
    );
    expect(sig.inputTokens).toBeGreaterThan(9_000);
  });

  it("counts nested tool_result block arrays and tool_use input", () => {
    const fileBody = "z".repeat(20_000);
    const sig = signalsFromAnthropic(
      {
        model: "claude-sonnet-5",
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "a".repeat(20_000) } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: fileBody }] }],
          },
        ],
      },
      cfg,
    );
    expect(sig.inputTokens).toBeGreaterThan(9_000);
  });
});

describe("signalsFromOpenAI", () => {
  const cfg = { tiers };

  it("maps reasoning.effort=high to brain and sets thinkingEnabled", () => {
    const sig = signalsFromOpenAI({ model: "gpt-5", input: "hi", reasoning: { effort: "high" } }, "responses", cfg);
    expect(sig.requestedTier).toBe("brain");
    expect(sig.thinkingEnabled).toBe(true);
    expect(sig.isBackground).toBe(false);
  });

  it("maps reasoning.effort=low to routine", () => {
    const sig = signalsFromOpenAI({ model: "gpt-5", input: "hi", reasoning: { effort: "low" } }, "responses", cfg);
    expect(sig.requestedTier).toBe("routine");
  });

  it("maps reasoning.effort=medium to build", () => {
    const sig = signalsFromOpenAI({ model: "gpt-5", input: "hi", reasoning: { effort: "medium" } }, "responses", cfg);
    expect(sig.requestedTier).toBe("build");
  });

  it("falls back to name-based classification when no effort is present", () => {
    const sig = signalsFromOpenAI({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] }, "chat/completions", cfg);
    expect(sig.requestedTier).toBe("build");
  });

  it("client is always codex, isBackground is always false", () => {
    const sig = signalsFromOpenAI({ model: "gpt-5", messages: [] }, "chat/completions", cfg);
    expect(sig.client).toBe("codex");
    expect(sig.isBackground).toBe(false);
  });
});
