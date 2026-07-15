import type { FastifyPluginAsync } from "fastify";
import { requireAdmin } from "./auth.js";
import { encryptKey, decryptKey } from "../../lib/keyCrypto.js";
import { checkProviderHealth, checkOpenAiEndpoints, checkOpenAiStreaming, checkProviderModel, listProviderModels } from "../../lib/upstream.js";

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

  // Auto-detect: GET /v1/models on the provider (zero-cost), then register each
  // advertised model in the catalog and pair it to this provider as a route.
  // This is the direct-provider equivalent of SubRouter's smart sync -- MiniMax,
  // Xiaomi MiMo, and any OpenAI/Anthropic-compatible relay all expose the model
  // list at data[].id, so one flow discovers + wires them all. It never spends
  // tokens and never touches models already served by other providers.
  app.post<{ Params: { id: string } }>("/admin/api/providers/:id/discover-models", async (request, reply) => {
    const { rows } = await app.pg.query("SELECT * FROM reseller_providers WHERE id = $1", [request.params.id]);
    if (rows.length === 0) return reply.code(404).send({ error: "Not found" });
    const provider = rows[0];

    const discovery = await listProviderModels({
      standard: provider.standard,
      baseUrl: provider.base_url,
      apiKey: decryptKey(provider.api_key_encrypted),
    });
    if (!discovery.ok) {
      return reply.code(502).send({ error: discovery.message, statusCode: discovery.statusCode });
    }
    if (discovery.modelIds.length === 0) {
      return reply.code(200).send({ discoveredCount: 0, newModelCount: 0, routedCount: 0, skippedStandardMismatch: [], modelIds: [] });
    }

    const client = await app.pg.connect();
    let newModelCount = 0;
    let routedCount = 0;
    const skippedStandardMismatch: string[] = [];
    try {
      await client.query("BEGIN");

      // A model ID already registered under the OTHER standard can't be served
      // by this provider (routes require matching standards), so leave it be.
      const { rows: existingRows } = await client.query<{ model_id: string; standard: "anthropic" | "openai" }>(
        "SELECT model_id, standard FROM reseller_models WHERE model_id = ANY($1::text[])",
        [discovery.modelIds],
      );
      const existing = new Map(existingRows.map((row) => [row.model_id, row.standard]));

      for (const modelId of discovery.modelIds) {
        const known = existing.get(modelId);
        if (known && known !== provider.standard) {
          skippedStandardMismatch.push(modelId);
          continue;
        }

        if (!known) {
          await client.query(
            `INSERT INTO reseller_models (model_id, brand, standard, display_name)
             VALUES ($1, $2, $3, $1)
             ON CONFLICT (model_id) DO NOTHING`,
            [modelId, provider.name, provider.standard],
          );
          await client.query(
            `INSERT INTO reseller_model_prices
               (model_id, input_price_cents_per_million, output_price_cents_per_million, cache_write_price_cents_per_million, cache_read_price_cents_per_million)
             VALUES ($1, 0, 0, 0, 0)
             ON CONFLICT (model_id) DO NOTHING`,
            [modelId],
          );
          newModelCount += 1;
        }

        // Append this provider as a route if it isn't paired yet; a brand-new
        // model gets priority 1, an existing model gets the next free backup slot.
        const routeExists = await client.query(
          "SELECT 1 FROM reseller_model_routes WHERE model_id = $1 AND provider_id = $2",
          [modelId, provider.id],
        );
        if (routeExists.rowCount === 0) {
          const { rows: maxRows } = await client.query<{ max_priority: number | null }>(
            "SELECT MAX(priority) AS max_priority FROM reseller_model_routes WHERE model_id = $1",
            [modelId],
          );
          const priority = Number(maxRows[0]?.max_priority ?? 0) + 1;
          await client.query(
            `INSERT INTO reseller_model_routes (model_id, provider_id, upstream_model_id, priority, active)
             VALUES ($1, $2, $3, $4, true)`,
            [modelId, provider.id, modelId, priority],
          );
          routedCount += 1;
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    app.routerCache.invalidate();
    app.priceCache.invalidate();
    return {
      discoveredCount: discovery.modelIds.length,
      newModelCount,
      routedCount,
      skippedStandardMismatch,
      modelIds: discovery.modelIds,
    };
  });
};

export default providersRoutes;
