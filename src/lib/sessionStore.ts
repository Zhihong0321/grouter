import type { Redis } from "ioredis";
import type { Session } from "fastify";

type Callback = (err?: unknown) => void;
type CallbackSession = (err: unknown, result?: Session | null) => void;

const PREFIX = "reseller:sess:";

/**
 * @fastify/session's default store is an in-memory Map -- its own docs say
 * not to use that in production, because it's wiped on every process
 * restart. On Railway that means every deploy silently 401s every logged-in
 * admin on their next click, with no in-app recovery (see git history around
 * 2026-07-09). Backing sessions with Redis instead survives restarts.
 */
export class RedisSessionStore {
  constructor(
    private redis: Redis,
    private ttlSeconds: number,
  ) {}

  set(sessionId: string, session: Session, callback: Callback): void {
    this.redis
      .set(PREFIX + sessionId, JSON.stringify(session), "EX", this.ttlSeconds)
      .then(() => callback())
      .catch(callback);
  }

  get(sessionId: string, callback: CallbackSession): void {
    this.redis
      .get(PREFIX + sessionId)
      .then((raw) => callback(null, raw ? (JSON.parse(raw) as Session) : null))
      .catch((err) => callback(err));
  }

  destroy(sessionId: string, callback: Callback): void {
    this.redis
      .del(PREFIX + sessionId)
      .then(() => callback())
      .catch(callback);
  }
}
