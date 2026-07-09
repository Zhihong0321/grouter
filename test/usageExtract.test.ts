import { describe, it, expect } from "vitest";
import { StreamingUsageAccumulator, extractUsage } from "../src/lib/usageExtract.js";

describe("extractUsage", () => {
  it("defaults missing fields to 0 rather than undefined/NaN", () => {
    expect(extractUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it("extracts all four fields when present", () => {
    expect(
      extractUsage({
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40 });
  });
});

describe("StreamingUsageAccumulator", () => {
  it("keeps cache/input fields set by message_start even after message_delta events that omit them", () => {
    const acc = new StreamingUsageAccumulator();
    acc.onMessageStart({
      input_tokens: 500,
      output_tokens: 1,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 100,
    });

    // message_delta only ever carries output_tokens -- must not reset the rest
    acc.onMessageDelta({ output_tokens: 5 });
    acc.onMessageDelta({ output_tokens: 42 });

    expect(acc.get()).toEqual({
      inputTokens: 500,
      outputTokens: 42, // last delta wins (cumulative running total)
      cacheCreationInputTokens: 200, // must NOT have been zeroed by deltas
      cacheReadInputTokens: 100, // must NOT have been zeroed by deltas
    });
  });

  it("ignores message_delta events with no usage field at all", () => {
    const acc = new StreamingUsageAccumulator();
    acc.onMessageStart({ input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    acc.onMessageDelta(undefined);
    expect(acc.get().outputTokens).toBe(1);
  });
});
