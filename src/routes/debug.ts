import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import { env } from "../config/env.js";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function pgQuery(pg: Pool, sql: string, params?: any[]): Promise<{ rows: any[] }> {
  return withTimeout(
    params ? pg.query(sql, params) : pg.query(sql),
    3000,
    "postgres",
  );
}

const debugRoutes: FastifyPluginAsync = async (app) => {
  app.get("/_debug", async (request, reply) => {
    if (!env.DEBUG_TOKEN) {
      return reply.code(403).send({ error: "Debug endpoint disabled (DEBUG_TOKEN not set)" });
    }
    const token = request.headers["x-debug-token"];
    if (token !== env.DEBUG_TOKEN) {
      return reply.code(401).send({ error: "Invalid debug token" });
    }

    const result: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      node: process.version,
      uptime_s: Math.floor(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      env: {
        NODE_ENV: env.NODE_ENV,
        PORT: env.PORT,
        DATABASE_URL: env.DATABASE_URL ? "set" : "missing",
        REDIS_URL: env.REDIS_URL ? "set" : "missing",
        SESSION_SECRET: env.SESSION_SECRET ? "set" : "missing",
        DEBUG_TOKEN: "set",
      },
    };

    // Postgres check
    const pgStart = Date.now();
    try {
      const { rows } = await pgQuery(app.pg, "SELECT NOW() as now, current_database() as db");
      result.postgres = {
        ok: true,
        latency_ms: Date.now() - pgStart,
        server_time: rows[0].now,
        database: rows[0].db,
      };
    } catch (err: any) {
      result.postgres = { ok: false, error: err?.message };
    }

    // Redis check
    const redisStart = Date.now();
    try {
      const pong = await withTimeout(app.redis.ping(), 3000, "redis");
      result.redis = { ok: pong === "PONG", latency_ms: Date.now() - redisStart };
    } catch (err: any) {
      result.redis = { ok: false, error: err?.message };
    }

    // Settings table
    try {
      const { rows } = await pgQuery(app.pg, "SELECT key, value FROM reseller_settings ORDER BY key");
      const settingsMap = Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
      result.settings = {
        key_prefix: settingsMap.key_prefix ?? "MISSING",
        all_keys: rows.map((r: any) => r.key),
      };
    } catch (err: any) {
      result.settings = { error: err?.message };
    }

    // Router: models / providers / routes counts
    try {
      const { rows: modelRows } = await pgQuery(app.pg, "SELECT COUNT(*) FILTER (WHERE active) AS active, COUNT(*) AS total FROM reseller_models");
      const { rows: providerRows } = await pgQuery(app.pg, "SELECT COUNT(*) FILTER (WHERE active) AS active, COUNT(*) AS total FROM reseller_providers");
      const { rows: routeRows } = await pgQuery(app.pg, "SELECT COUNT(*) FILTER (WHERE active) AS active, COUNT(*) AS total FROM reseller_model_routes");
      result.router = {
        models: { active: Number(modelRows[0].active), total: Number(modelRows[0].total) },
        providers: { active: Number(providerRows[0].active), total: Number(providerRows[0].total) },
        routes: { active: Number(routeRows[0].active), total: Number(routeRows[0].total) },
      };
    } catch (err: any) {
      result.router = { error: err?.message };
    }

    // Tables existence check -- this database is shared with other apps, so
    // only list our own (reseller_-prefixed) tables rather than everything.
    try {
      const { rows } = await pgQuery(
        app.pg,
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name LIKE 'reseller_%' ORDER BY table_name`,
      );
      result.tables = rows.map((r: any) => r.table_name);
    } catch (err: any) {
      result.tables = { error: err?.message };
    }

    // API keys count
    try {
      const { rows } = await pgQuery(app.pg, "SELECT status, COUNT(*) as n FROM reseller_api_keys GROUP BY status");
      result.api_keys = Object.fromEntries(rows.map((r: any) => [r.status, Number(r.n)]));
    } catch (err: any) {
      result.api_keys = { error: err?.message };
    }

    // Registered routes
    result.routes = app.printRoutes
      ? app.printRoutes().split("\n").filter(Boolean)
      : "unavailable";

    return reply.send(result);
  });
};

export default debugRoutes;
