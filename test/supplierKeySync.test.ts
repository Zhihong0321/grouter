import { describe, expect, it } from "vitest";

// keyCrypto reads this eagerly through env.ts, so set the required test config
// before dynamically importing the synchronization module.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:55432/reseller";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters-long";
process.env.NODE_ENV = "test";

describe("mapSupplierToken", () => {
  it("maps allowed models while keeping the plaintext supplier key out of raw JSON", async () => {
    const { mapSupplierToken } = await import("../src/lib/supplierKeySync.js");
    const { decryptKey } = await import("../src/lib/keyCrypto.js");
    const { parseSupplierJson } = await import("../src/lib/subrouterClient.js");

    const mapped = mapSupplierToken({
      id: 7,
      user_id: 42,
      key: "sk-supplier-secret",
      name: "Production supplier key",
      status: 1,
      created_time: 1780000000,
      accessed_time: 0,
      expired_time: -1,
      remain_quota: 500000,
      used_quota: 12,
      unlimited_quota: true,
      model_limits_enabled: true,
      model_limits: "claude-sonnet-5, gpt-5,claude-sonnet-5",
      allow_ips: "",
      group: "default",
      cross_group_retry: false,
      subrouter_providers: "",
      subrouter_sort_mode: "",
    });

    expect(mapped.allowedModels).toEqual(["claude-sonnet-5", "gpt-5"]);
    expect(mapped.accessedAt).toBeNull();
    expect(mapped.expiresAt).toBeNull();
    expect(mapped.keyLast4).toBe("cret");
    expect(decryptKey(mapped.keyCiphertext)).toBe("sk-supplier-secret");
    expect(parseSupplierJson(mapped.rawTokenJson)).not.toHaveProperty("key");
  });
});
