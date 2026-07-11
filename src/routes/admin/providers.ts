import type { FastifyPluginAsync } from "fastify";
import { requireAdmin } from "./auth.js";
import { encryptKey, decryptKey } from "../../lib/keyCrypto.js";
import { checkProviderHealth, checkOpenAiEndpoints, checkOpenAiStreaming, checkProviderModel } from "../../lib/upstream.js";

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

interface TestProviderModelBody {
  modelId: string;
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
    source: row.supplier_key_id ? "subrouter" : "manual",
    supplierKeyModelIds: row.supplier_key_id ? row.supplier_key_models : null,
  };
}

const providersSelect = `
  SELECT p.*, k.id AS supplier_key_id,
    COALESCE(json_agg(m.model_id ORDER BY m.model_id) FILTER (WHERE m.model_id IS NOT NULL), '[]'::json) AS supplier_key_models
  FROM reseller_providers p
  LEFT JOIN reseller_supplier_keys k ON k.provider_id = p.id OR k.anthropic_provider_id = p.id
  LEFT JOIN reseller_supplier_key_models m ON m.supplier_key_id = k.id
  GROUP BY p.id, k.id`;

const providersRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", requireAdmin);

  app.get("/admin/api/providers", async () => {
    const { rows } = await app.pg.query(`${providersSelect} ORDER BY p.created_at ASC`);
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

  // Real minimal completions against chat/completions and responses -- spends
  // a handful of upstream tokens, unlike the zero-cost /health check above.
  // Needs an upstream_model_id to call with, so it borrows one from any
  // existing route for this provider rather than asking the admin to type
  // one in separately.
  app.post<{ Params: { id: string } }>("/admin/api/providers/:id/test-openai", async (request, reply) => {
    const { rows } = await app.pg.query("SELECT * FROM reseller_providers WHERE id = $1", [request.params.id]);
    if (rows.length === 0) return reply.code(404).send({ error: "Not found" });

    const provider = rows[0];
    if (provider.standard !== "openai") {
      return reply.code(400).send({ error: "This test only applies to OpenAI-standard providers" });
    }

    const { rows: routeRows } = await app.pg.query(
      "SELECT upstream_model_id FROM reseller_model_routes WHERE provider_id = $1 LIMIT 1",
      [request.params.id],
    );
    if (routeRows.length === 0) {
      return reply.code(400).send({ error: "Add a model route for this provider first, then test chat/responses" });
    }

    return checkOpenAiEndpoints(
      { baseUrl: provider.base_url, apiKey: decryptKey(provider.api_key_encrypted) },
      routeRows[0].upstream_model_id,
    );
  });

  // Verifies the provider actually streams SSE events rather than silently
  // buffering the full completion before responding to stream:true --
  // test-openai above never sets stream:true, so it can't catch that.
  app.post<{ Params: { id: string } }>("/admin/api/providers/:id/test-openai-streaming", async (request, reply) => {
    const { rows } = await app.pg.query("SELECT * FROM reseller_providers WHERE id = $1", [request.params.id]);
    if (rows.length === 0) return reply.code(404).send({ error: "Not found" });

    const provider = rows[0];
    if (provider.standard !== "openai") {
      return reply.code(400).send({ error: "This test only applies to OpenAI-standard providers" });
    }

    const { rows: routeRows } = await app.pg.query(
      "SELECT upstream_model_id FROM reseller_model_routes WHERE provider_id = $1 LIMIT 1",
      [request.params.id],
    );
    if (routeRows.length === 0) {
      return reply.code(400).send({ error: "Add a model route for this provider first, then test streaming" });
    }

    return checkOpenAiStreaming(
      { baseUrl: provider.base_url, apiKey: decryptKey(provider.api_key_encrypted) },
      routeRows[0].upstream_model_id,
    );
  });

  // Runs a real tiny request. Imported SubRouter providers are additionally
  // constrained to the models their individual supplier key reported via
  // GET /v1/models, so the tester never sends a known-incompatible pair.
  app.post<{ Params: { id: string }; Body: TestProviderModelBody }>("/admin/api/providers/:id/test-model", async (request, reply) => {
    const { modelId } = request.body;
    if (!modelId) return reply.code(400).send({ error: "modelId is required" });

    const { rows: providerRows } = await app.pg.query("SELECT * FROM reseller_providers WHERE id = $1", [request.params.id]);
    if (providerRows.length === 0) return reply.code(404).send({ error: "Not found" });
    const provider = providerRows[0];

    const { rows: modelRows } = await app.pg.query("SELECT standard FROM reseller_models WHERE model_id = $1 AND active = true", [modelId]);
    if (modelRows.length === 0) return reply.code(404).send({ error: "Model is not active" });
    if (modelRows[0].standard !== provider.standard) {
      return reply.code(400).send({ error: `Model uses ${modelRows[0].standard}, but provider uses ${provider.standard}` });
    }

    const { rows: supplierRows } = await app.pg.query(
      "SELECT id FROM reseller_supplier_keys WHERE (provider_id = $1 OR anthropic_provider_id = $1) AND present_on_supplier = true",
      [provider.id],
    );
    if (supplierRows.length > 0) {
      const { rows: permittedRows } = await app.pg.query(
        "SELECT 1 FROM reseller_supplier_key_models WHERE supplier_key_id = $1 AND model_id = $2",
        [supplierRows[0].id, modelId],
      );
      if (permittedRows.length === 0) {
        return reply.code(400).send({ error: "This SubRouter key does not list the selected model as available" });
      }
    }

    return checkProviderModel(
      { standard: provider.standard, baseUrl: provider.base_url, apiKey: decryptKey(provider.api_key_encrypted) },
      modelId,
    );
  });
};

export default providersRoutes;
