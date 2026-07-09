import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { Pool } from "pg";
import { env } from "../config/env.js";

declare module "fastify" {
  interface FastifyInstance {
    pg: Pool;
  }
}

const postgresPlugin: FastifyPluginAsync = async (app) => {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  app.decorate("pg", pool);
  app.addHook("onClose", async () => {
    await pool.end();
  });
};

export default fp(postgresPlugin, { name: "postgres" });
