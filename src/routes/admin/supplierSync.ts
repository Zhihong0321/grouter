import type { FastifyPluginAsync } from "fastify";
import { env } from "../../config/env.js";
import { SubRouterClient, SubRouterError } from "../../lib/subrouterClient.js";
import { requireAdmin } from "./auth.js";

const supplierSyncRoutes: FastifyPluginAsync = async (app) => {
  app.get("/admin/api/supplier-sync/status", { preHandler: requireAdmin }, async (_request, reply) => {
    if (!env.SUBROUTER_SESSION || !env.SUBROUTER_USER_ID) {
      return reply.code(503).send({
        supplier: "subrouter",
        configured: false,
        connected: false,
        errorType: "not_configured",
        error: "SubRouter credentials are not configured",
      });
    }

    const client = new SubRouterClient({
      baseUrl: env.SUBROUTER_BASE_URL,
      session: env.SUBROUTER_SESSION,
      userId: env.SUBROUTER_USER_ID,
      timeoutMs: env.SUBROUTER_REQUEST_TIMEOUT_MS,
    });

    try {
      const result = await client.probeConnection();
      return { configured: true, ...result };
    } catch (error) {
      const known = error instanceof SubRouterError;
      return reply.code(502).send({
        supplier: "subrouter",
        configured: true,
        connected: false,
        checkedAt: new Date().toISOString(),
        errorType: known ? error.type : "unknown",
        error: known ? error.message : "SubRouter connection check failed",
      });
    }
  });
};

export default supplierSyncRoutes;
