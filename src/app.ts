import Fastify from "fastify";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import fastifyStatic from "@fastify/static";
import postgresPlugin from "./plugins/postgres.js";
import redisPlugin from "./plugins/redis.js";
import { PriceCache } from "./lib/pricing.js";
import { SettingsCache } from "./lib/settings.js";
import { env } from "./config/env.js";

import healthRoutes from "./routes/health.js";
import debugRoutes from "./routes/debug.js";
import proxyRoutes from "./routes/proxy/messages.js";
import authRoutes from "./routes/admin/auth.js";
import keysRoutes from "./routes/admin/keys.js";
import usageRoutes from "./routes/admin/usage.js";
import pricesRoutes from "./routes/admin/prices.js";
import settingsRoutes from "./routes/admin/settings.js";

declare module "fastify" {
  interface FastifyInstance {
    priceCache: PriceCache;
    settingsCache: SettingsCache;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardDist = path.join(__dirname, "..", "dashboard", "dist");

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(postgresPlugin);
  await app.register(redisPlugin);

  app.decorate("priceCache", new PriceCache(app.pg));
  app.decorate("settingsCache", new SettingsCache(app.pg));

  await app.register(cookie);
  await app.register(session, {
    secret: env.SESSION_SECRET,
    cookie: { secure: env.NODE_ENV === "production", maxAge: 1000 * 60 * 60 * 12 },
  });

  await app.register(healthRoutes);
  await app.register(debugRoutes);
  await app.register(proxyRoutes);
  await app.register(authRoutes);
  await app.register(keysRoutes);
  await app.register(usageRoutes);
  await app.register(pricesRoutes);
  await app.register(settingsRoutes);

  // dashboard/dist only exists after `pnpm build:dashboard` has run. Guard so
  // the backend (and tests, and `pnpm dev`) still work standalone before
  // that's been built -- the API is fully functional without the SPA.
  const dashboardBuilt = existsSync(path.join(dashboardDist, "index.html"));
  if (dashboardBuilt) {
    await app.register(fastifyStatic, {
      root: dashboardDist,
      prefix: "/admin/",
      decorateReply: true,
    });
  }

  app.get("/", async (request, reply) => {
    return reply.redirect(dashboardBuilt ? "/admin/" : "/healthz");
  });

  app.setNotFoundHandler((request, reply) => {
    if (dashboardBuilt && request.method === "GET" && request.url.startsWith("/admin") && !request.url.startsWith("/admin/api")) {
      return reply.sendFile("index.html");
    }
    reply.code(404).send({ error: "Not found" });
  });

  return app;
}
