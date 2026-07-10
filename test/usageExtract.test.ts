import { describe, it, expect } from "vitest";
import { OpenAiStreamingUsageAccumulator, StreamingUsageAccumulator, extractOpenAiUsage, extractUsage } from "../src/lib/usageExtract.js";

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

describe("OpenAI usage extraction", () => {
  it("maps Chat Completions usage and subtracts cached prompt tokens", () => {
    expect(
      extractOpenAiUsage({
        prompt_tokens: 100,
        completion_tokens: 25,
        prompt_tokens_details: { cached_tokens: 40 },
      }),
    ).toEqual({ inputTokens: 60, outputTokens: 25, cacheCreationInputTokens: 0, cacheReadInputTokens: 40 });
  });

  it("maps Responses usage", () => {
    expect(
      extractOpenAiUsage({
        input_tokens: 80,
        output_tokens: 12,
        input_tokens_details: { cached_tokens: 30 },
      }),
    ).toEqual({ inputTokens: 50, outputTokens: 12, cacheCreationInputTokens: 0, cacheReadInputTokens: 30 });
  });
});

describe("OpenAiStreamingUsageAccumulator", () => {
  it("captures usage from both Chat and Responses final events", () => {
    const chat = new OpenAiStreamingUsageAccumulator();
    chat.onEvent({ usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } } });
    expect(chat.get().inputTokens).toBe(8);
    expect(chat.get().outputTokens).toBe(4);

    const responses = new OpenAiStreamingUsageAccumulator();
    responses.onEvent({ type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 5 } } });
    expect(responses.get().inputTokens).toBe(20);
    expect(responses.get().outputTokens).toBe(5);
  });
});
