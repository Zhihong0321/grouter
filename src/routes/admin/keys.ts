import type { FastifyPluginAsync } from "fastify";
import { issueKey } from "../../lib/keyIssuance.js";
import { encryptKey, decryptKey } from "../../lib/keyCrypto.js";
import { invalidateKeyCache } from "../../lib/keyAuth.js";
import { invalidateBudgetCache } from "../../lib/budget.js";
import { requireAdmin } from "./auth.js";

interface CreateKeyBody {
  name: string;
  rateLimitRpm?: number;
  budgetCents?: number;
  modelRestrictions?: string[] | null;
}

interface UpdateKeyBody {
  name?: string;
  rateLimitRpm?: number;
  budgetCents?: number;
  modelRestrictions?: string[] | null;
}

function rowToDto(row: any) {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    key: row.key_ciphertext ? decryptKey(row.key_ciphertext) : null,
    status: row.status,
    rateLimitRpm: row.rate_limit_rpm,
    budgetCents: Number(row.budget_cents),
    spentCents: Number(row.spent_cents),
    modelRestrictions: row.model_restrictions,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

const keysRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", requireAdmin);

  app.post<{ Body: CreateKeyBody }>("/admin/api/keys", async (request, reply) => {
    const { name, rateLimitRpm = 60, budgetCents = 0, modelRestrictions = null } = request.body;
    const keyPrefix = await app.settingsCache.getKeyPrefix();
    const issued = issueKey(keyPrefix);
    const ciphertext = encryptKey(issued.plaintext);

    const { rows } = await app.pg.query(
      `INSERT INTO reseller_api_keys (name, key_hash, key_prefix, key_ciphertext, rate_limit_rpm, budget_cents, model_restrictions)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, issued.hash, issued.prefix, ciphertext, rateLimitRpm, budgetCents, modelRestrictions ? JSON.stringify(modelRestrictions) : null],
    );

    reply.code(201).send(rowToDto(rows[0]));
  });

  app.get("/admin/api/keys", async () => {
    const { rows } = await app.pg.query("SELECT * FROM reseller_api_keys ORDER BY created_at DESC");
    return rows.map(rowToDto);
  });

  app.get<{ Params: { id: string } }>("/admin/api/keys/:id", async (request, reply) => {
    const { rows } = await app.pg.query("SELECT * FROM reseller_api_keys WHERE id = $1", [request.params.id]);
    if (rows.length === 0) return reply.code(404).send({ error: "Not found" });
    return rowToDto(rows[0]);
  });

  app.patch<{ Params: { id: string }; Body: UpdateKeyBody }>("/admin/api/keys/:id", async (request, reply) => {
    const { rows: existingRows } = await app.pg.query("SELECT * FROM reseller_api_keys WHERE id = $1", [request.params.id]);
    if (existingRows.length === 0) return reply.code(404).send({ error: "Not found" });

    const current = existingRows[0];
    const { name = current.name, rateLimitRpm = current.rate_limit_rpm, budgetCents = current.budget_cents, modelRestrictions } = request.body;
    const restrictions = modelRestrictions === undefined ? current.model_restrictions : modelRestrictions;

    const { rows } = await app.pg.query(
      `UPDATE reseller_api_keys SET name = $1, rate_limit_rpm = $2, budget_cents = $3, model_restrictions = $4
       WHERE id = $5 RETURNING *`,
      [name, rateLimitRpm, budgetCents, restrictions ? JSON.stringify(restrictions) : null, request.params.id],
    );

    await invalidateKeyCache(app.redis, current.key_hash);
    await invalidateBudgetCache(app.redis, request.params.id);

    return rowToDto(rows[0]);
  });

  app.post<{ Params: { id: string } }>("/admin/api/keys/:id/revoke", async (request, reply) => {
    const { rows } = await app.pg.query(
      "UPDATE reseller_api_keys SET status = 'revoked', revoked_at = now() WHERE id = $1 RETURNING *",
      [request.params.id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: "Not found" });

    await invalidateKeyCache(app.redis, rows[0].key_hash);
    return rowToDto(rows[0]);
  });
};

export default keysRoutes;
