export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

export interface AnthropicMessageResponse {
  id: string;
  model: string;
  usage: AnthropicUsage;
  [key: string]: unknown;
}

// Subset of Messages API streaming event shapes relevant to usage extraction.
// message_start carries the full initial usage (including cache fields, fixed
// for the rest of the stream); message_delta carries a cumulative running
// output_tokens count; message_stop signals the end.
export type AnthropicStreamEvent =
  | { type: "message_start"; message: { usage: AnthropicUsage; model: string; id: string } }
  | { type: "message_delta"; usage: Partial<AnthropicUsage>; delta?: unknown }
  | { type: "message_stop" }
  | { type: "content_block_start" | "content_block_delta" | "content_block_stop" | "ping"; [key: string]: unknown };

export interface ModelPrice {
  modelId: string;
  inputPriceCentsPerMillion: number;
  outputPriceCentsPerMillion: number;
  cacheWritePriceCentsPerMillion: number;
  cacheReadPriceCentsPerMillion: number;
  active: boolean;
}

export interface CapturedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface CostBreakdown {
  inputCostCents: number;
  outputCostCents: number;
  cacheWriteCostCents: number;
  cacheReadCostCents: number;
  totalCostCents: number;
}
