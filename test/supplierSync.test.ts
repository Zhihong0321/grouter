import { describe, expect, it } from "vitest";
import { mapActivityRecord, SupplierSyncError } from "../src/lib/supplierSync.js";
import { parseSupplierJson } from "../src/lib/subrouterClient.js";

describe("mapActivityRecord", () => {
  it("preserves exact integers larger than JavaScript's safe range", () => {
    const record = {
      id: 9007199254740993123n,
      created_at: 1783744872,
      type: 2,
      content: "usage",
      token_name: "supplier-token",
      model_name: "claude-sonnet-5",
      prompt_tokens: 9007199254740993124n,
      completion_tokens: 12,
      quota: 9007199254740993125n,
      use_time: 3,
      is_stream: true,
      channel: 7,
      channel_name: "provider",
      token_id: 8,
      group: "default",
      request_id: "request-id",
      other: '{"cache_tokens":9007199254740993126,"provider_name":"p","billing_source":"supplier"}',
    };

    const mapped = mapActivityRecord(record);

    expect(mapped.externalLogId).toBe("9007199254740993123");
    expect(mapped.promptTokens).toBe("9007199254740993124");
    expect(mapped.quotaUnits).toBe("9007199254740993125");
    expect(mapped.cacheTokens).toBe("9007199254740993126");
    expect(String((parseSupplierJson(mapped.rawRecordJson) as Record<string, unknown>).id)).toBe("9007199254740993123");
  });

  it("keeps different requests distinct even when SubRouter reuses a log ID", () => {
    const base = {
      id: 55,
      created_at: 1783663615,
      type: 2,
      content: "usage",
      token_name: "supplier-token",
      model_name: "claude-sonnet-5",
      prompt_tokens: 1,
      completion_tokens: 1,
      quota: 1,
      use_time: 1,
      is_stream: false,
      channel: 1,
      channel_name: "provider",
      token_id: 1,
      group: "default",
      other: "{}",
    };

    const first = mapActivityRecord({ ...base, request_id: "request-one" });
    const second = mapActivityRecord({ ...base, request_id: "request-two" });

    expect(first.externalLogId).toBe(second.externalLogId);
    expect(first.externalRecordKey).not.toBe(second.externalRecordKey);
  });

  it("accepts the zero-cost non-usage event with nullable request identity", () => {
    const mapped = mapActivityRecord({
      id: 1,
      created_at: 1783316603,
      type: 1,
      content: "event",
      token_name: "",
      model_name: "",
      prompt_tokens: 0,
      completion_tokens: 0,
      quota: 0,
      use_time: 0,
      is_stream: false,
      channel: 0,
      channel_name: "",
      token_id: 0,
      group: "",
      request_id: null,
      other: "{}",
    });

    expect(mapped.logType).toBe("1");
    expect(mapped.externalRequestId).toBeNull();
    expect(mapped.quotaUnits).toBe("0");
    expect(mapped.cacheTokens).toBe("0");
  });

  it("rejects malformed other JSON before any cursor can advance", () => {
    expect(() => mapActivityRecord({
      id: 1,
      created_at: 1783316603,
      type: 2,
      prompt_tokens: 1,
      completion_tokens: 1,
      quota: 1,
      other: "{not-json",
    })).toThrowError(SupplierSyncError);
  });
});
