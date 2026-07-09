import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { Redis } from "ioredis";
import { env } from "../config/env.js";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

const redisPlugin: FastifyPluginAsync = async (app) => {
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, connectTimeout: 5000 });
  app.decorate("redis", redis);
  app.addHook("onClose", async () => {
    redis.disconnect();
  });
};

export default fp(redisPlugin, { name: "redis" });
