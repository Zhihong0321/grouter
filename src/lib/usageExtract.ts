import type { AnthropicUsage, CapturedUsage } from "../types/anthropic.js";

/**
 * Single source of truth for pulling the four independent token counters out
 * of an Anthropic `usage` object. Used by BOTH the non-streaming response
 * path and the streaming SSE-tap path so the two can never silently diverge.
 */
export function extractUsage(usage: Partial<AnthropicUsage> | undefined | null): CapturedUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0,
  };
}

export function emptyUsage(): CapturedUsage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

/**
 * Accumulator for the streaming path. `message_start` establishes
 * input/cache fields (fixed for the rest of the stream -- prompt processing
 * is complete before generation begins). Every subsequent `message_delta`
 * must ONLY update output_tokens -- it never carries cache/input fields, and
 * must never be allowed to reset them to zero.
 */
export class StreamingUsageAccumulator {
  private captured: CapturedUsage = emptyUsage();

  onMessageStart(usage: Partial<AnthropicUsage> | undefined): void {
    this.captured = extractUsage(usage);
  }

  onMessageDelta(usage: Partial<AnthropicUsage> | undefined): void {
    if (usage?.output_tokens !== undefined) {
      this.captured.outputTokens = usage.output_tokens;
    }
  }

  get(): CapturedUsage {
    return { ...this.captured };
  }
}
