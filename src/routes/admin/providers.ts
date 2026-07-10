import type { FastifyPluginAsync } from "fastify";
import { requireAdmin } from "./auth.js";
import { encryptKey, decryptKey } from "../../lib/keyCrypto.js";
import { checkProviderHealth } from "../../lib/upstream.js";

interface CreateProviderBody {
  name: string;
  baseUrl: string;
  apiKey: string;
  standard?: "anthropic" | "openai";
}

interface UpdateProviderBody {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  active?: boolean;
}

function last4(ciphertext: string): string {
  try {
    return decryptKey(ciphertext).slice(-4);
  } catch {
    return "????";
  }
}

// The provider's real API key is write-only through this API -- accepted on
// create/update, never returned. The dashboard only ever sees "is a key set"
// plus its last 4 characters, same posture as the old subrouter settings UI.
function rowToDto(row: any) {
  return {
    id: row.id,
    name: row.name,
    standard: row.standard,
    baseUrl: row.base_url,
    apiKeySet: true,
    apiKeyLast4: last4(row.api_key_encrypted),
    active: row.active,
    createdAt: row.created_at,
  };
}

const providersRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", requireAdmin);

  app.get("/admin/api/providers", async () => {
    const { rows } = await app.pg.query("SELECT * FROM reseller_providers ORDER BY created_at ASC");
    return rows.map(rowToDto);
  });

  app.post<{ Body: CreateProviderBody }>("/admin/api/providers", async (request, reply) => {
    const { name, baseUrl, apiKey, standard = "anthropic" } = request.body;
    if (!name || !baseUrl || !apiKey) {
      return reply.code(400).send({ error: "name, baseUrl, and apiKey are required" });
    }
    if (standard !== "anthropic" && standard !== "openai") {
      return reply.code(400).send({ error: "standard must be anthropic or openai" });
    }

    const { rows } = await app.pg.query(
      `INSERT INTO reseller_providers (name, standard, base_url, api_key_encrypted)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, standard, baseUrl, encryptKey(apiKey)],
    );

    app.routerCache.invalidate();
    reply.code(201).send(rowToDto(rows[0]));
  });

  app.patch<{ Params: { id: string }; Body: UpdateProviderBody }>("/admin/api/providers/:id", async (request, reply) => {
    const { rows: existingRows } = await app.pg.query("SELECT * FROM reseller_providers WHERE id = $1", [request.params.id]);
    if (existingRows.length === 0) return reply.code(404).send({ error: "Not found" });

    const current = existingRows[0];
    const { name = current.name, baseUrl = current.base_url, active = current.active, apiKey } = request.body;
    const encryptedKey = apiKey ? encryptKey(apiKey) : current.api_key_encrypted;

    const { rows } = await app.pg.query(
      `UPDATE reseller_providers SET name = $1, base_url = $2, active = $3, api_key_encrypted = $4 WHERE id = $5 RETURNING *`,
      [name, baseUrl, active, encryptedKey, request.params.id],
    );

    app.routerCache.invalidate();
    return rowToDto(rows[0]);
  });

  // Cascades to that provider's routes (reseller_model_routes.provider_id ON
  // DELETE CASCADE); historical usage_logs keep their row with provider_id
  // set to NULL (ON DELETE SET NULL) rather than blocking the delete.
  app.delete<{ Params: { id: string } }>("/admin/api/providers/:id", async (request, reply) => {
    const client = await app.pg.connect();
    try {
      await client.query("BEGIN");
      const { rows: providerRows } = await client.query("SELECT id FROM reseller_providers WHERE id = $1 FOR UPDATE", [request.params.id]);
      if (providerRows.length === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Not found" });
      }

      // Do this explicitly instead of relying on migration-time FK actions:
      // it also works against older production databases created before the
      // ON DELETE CASCADE/SET NULL constraints were installed.
      await client.query("DELETE FROM reseller_model_routes WHERE provider_id = $1", [request.params.id]);
      await client.query("UPDATE reseller_usage_logs SET provider_id = NULL WHERE provider_id = $1", [request.params.id]);
      await client.query("DELETE FROM reseller_providers WHERE id = $1", [request.params.id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    app.routerCache.invalidate();
    reply.code(204).send();
  });

  // Zero-cost health check: GET /v1/models on the provider, never
  // /v1/messages, so testing a key never spends tokens.
  app.post<{ Params: { id: string } }>("/admin/api/providers/:id/health", async (request, reply) => {
    const { rows } = await app.pg.query("SELECT * FROM reseller_providers WHERE id = $1", [request.params.id]);
    if (rows.length === 0) return reply.code(404).send({ error: "Not found" });

    const provider = rows[0];
    return checkProviderHealth({
      standard: provider.standard,
      baseUrl: provider.base_url,
      apiKey: decryptKey(provider.api_key_encrypted),
    });
  });
};

export default providersRoutes;
