import type { Redis } from "ioredis";

// Atomic INCR+EXPIRE: avoids the classic race where a crash between two
// separate calls leaves a counter key that never expires. Fixed 60s window --
// accepted tolerance is up to ~2x burst across a window boundary; a sliding
// log would be more precise but isn't warranted here.
const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
if count > tonumber(ARGV[2]) then
  return 0
else
  return 1
end
`;

const WINDOW_SECONDS = 60;

export async function checkRateLimit(redis: Redis, keyId: string, limitRpm: number): Promise<boolean> {
  const result = await redis.eval(RATE_LIMIT_SCRIPT, 1, `rl:rpm:${keyId}`, WINDOW_SECONDS, limitRpm);
  return result === 1;
}
