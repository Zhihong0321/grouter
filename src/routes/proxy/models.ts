import type { FastifyPluginAsync } from "fastify";
import { createHash } from "node:crypto";
import { extractApiKey, lookupKeyByHash } from "../../lib/keyAuth.js";
import { sendAnthropicError } from "../../lib/errors.js";

// Real Anthropic API surface -- clients (Claude Code's provider switcher
// among them) probe this to validate a base URL/key pair before saving a
// profile, or to populate a model picker. It was missing entirely, so a
// freshly-configured client could fail before ever sending a message.
const modelsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/v1/models", async (request, reply) => {
    const apiKeyHeader = extractApiKey(request.headers);
    if (!apiKeyHeader) {
      return sendAnthropicError(reply, "authentication_error", "Missing x-api-key or Authorization header");
    }

    const hash = createHash("sha256").update(apiKeyHeader).digest("hex");
    const keyRecord = await lookupKeyByHash(app.pg, app.redis, hash);
    if (!keyRecord || keyRecord.status !== "active") {
      return sendAnthropicError(reply, "authentication_error", "Invalid or revoked API key");
    }

    const { rows } = await app.pg.query(
      `SELECT model_id, display_name, created_at FROM reseller_models
       WHERE active = true AND standard = 'anthropic'
       ORDER BY model_id ASC`,
    );

    const restrictions = keyRecord.modelRestrictions;
    const visible = restrictions ? rows.filter((r: any) => restrictions.includes(r.model_id)) : rows;

    const data = visible.map((r: any) => ({
      type: "model",
      id: r.model_id,
      display_name: r.display_name,
      created_at: new Date(r.created_at).toISOString(),
    }));

    reply.send({
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data.at(-1)?.id ?? null,
    });
  });
};

export default modelsRoutes;
