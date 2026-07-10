import type { AnthropicUsage, CapturedUsage } from "../types/anthropic.js";

export interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

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

/** Maps both OpenAI Chat Completions and Responses usage shapes into the
 * proxy's four billing counters. Cached input is kept separate from regular
 * input, so it must be subtracted from prompt/input tokens first. */
export function extractOpenAiUsage(usage: OpenAiUsage | undefined | null): CapturedUsage {
  const isChat = usage?.prompt_tokens !== undefined;
  const totalInput = isChat ? usage?.prompt_tokens ?? 0 : usage?.input_tokens ?? 0;
  const cachedInput = isChat
    ? usage?.prompt_tokens_details?.cached_tokens ?? 0
    : usage?.input_tokens_details?.cached_tokens ?? 0;

  return {
    inputTokens: Math.max(0, totalInput - cachedInput),
    outputTokens: isChat ? usage?.completion_tokens ?? 0 : usage?.output_tokens ?? 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cachedInput,
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

/** OpenAI streams are untyped `data: {...}` events. Chat streams expose usage
 * on the final chunk; Responses streams normally expose it as
 * `response.completed.data.response.usage`. */
export class OpenAiStreamingUsageAccumulator {
  private captured: CapturedUsage = emptyUsage();

  onEvent(event: any): void {
    const usage = event?.usage ?? event?.response?.usage;
    if (usage) this.captured = extractOpenAiUsage(usage as OpenAiUsage);
  }

  get(): CapturedUsage {
    return { ...this.captured };
  }
}
