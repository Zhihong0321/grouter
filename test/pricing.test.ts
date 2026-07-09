import { describe, it, expect } from "vitest";
import { computeCostCents } from "../src/lib/pricing.js";
import type { ModelPrice } from "../src/types/anthropic.js";

const price: ModelPrice = {
  modelId: "test-model",
  inputPriceCentsPerMillion: 300,
  outputPriceCentsPerMillion: 1500,
  cacheWritePriceCentsPerMillion: 375,
  cacheReadPriceCentsPerMillion: 30,
  active: true,
};

describe("computeCostCents", () => {
  it("prices each of the four token categories independently", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    };
    const cost = computeCostCents(usage, price);
    expect(cost.inputCostCents).toBeCloseTo(300);
    expect(cost.outputCostCents).toBeCloseTo(1500);
    expect(cost.cacheWriteCostCents).toBeCloseTo(375);
    expect(cost.cacheReadCostCents).toBeCloseTo(30);
    expect(cost.totalCostCents).toBeCloseTo(300 + 1500 + 375 + 30);
  });

  it("does not price cache-read tokens at the regular input rate", () => {
    // Large cache-read -- a bug that priced cache reads as regular input
    // would charge ~300c here (the input rate); correct behavior is ~30c
    // (the much cheaper cache-read rate).
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1_000_000,
    };
    const cost = computeCostCents(usage, price);
    expect(cost.cacheReadCostCents).toBeCloseTo(30);
    expect(cost.totalCostCents).toBeCloseTo(30);
    expect(cost.totalCostCents).toBeLessThan(price.inputPriceCentsPerMillion); // must not equal the input-rate mispricing
  });

  it("does not undercharge cache-write tokens at the input rate", () => {
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 0,
    };
    const cost = computeCostCents(usage, price);
    expect(cost.cacheWriteCostCents).toBeCloseTo(375);
    expect(cost.cacheWriteCostCents).not.toBeCloseTo(300); // must not equal the input rate
  });

  it("handles all-zero usage", () => {
    const cost = computeCostCents(
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      price,
    );
    expect(cost.totalCostCents).toBe(0);
  });
});
