import { describe, expect, it } from "vitest";
import { supplierPromptMatchesUsage } from "../src/lib/supplierUsageReconciliation.js";

describe("supplierPromptMatchesUsage", () => {
  it("accepts the Anthropic-style prompt count that excludes cached input", () => {
    expect(supplierPromptMatchesUsage(70n, 70n, 6235n)).toBe(true);
  });

  it("accepts the OpenAI-style prompt count that includes cached input", () => {
    expect(supplierPromptMatchesUsage(53200n, 2640n, 50560n)).toBe(true);
  });

  it("rejects a prompt count that is neither exact convention", () => {
    expect(supplierPromptMatchesUsage(71n, 70n, 6235n)).toBe(false);
  });
});
