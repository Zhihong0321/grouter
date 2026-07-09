import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Redis from "ioredis";
import { checkRateLimit } from "../src/lib/rateLimit.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

describe("checkRateLimit", () => {
  let redis: Redis;
  const keyId = "test-key-ratelimit";

  beforeAll(() => {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  });

  afterAll(() => {
    redis.disconnect();
  });

  beforeEach(async () => {
    await redis.del(`rl:rpm:${keyId}`);
  });

  it("allows requests up to the limit and rejects the next one", async () => {
    const limit = 3;
    for (let i = 0; i < limit; i++) {
      expect(await checkRateLimit(redis, keyId, limit)).toBe(true);
    }
    expect(await checkRateLimit(redis, keyId, limit)).toBe(false);
  });

  it("tracks independent keys separately", async () => {
    expect(await checkRateLimit(redis, "other-key", 1)).toBe(true);
    expect(await checkRateLimit(redis, keyId, 1)).toBe(true);
  });
});
