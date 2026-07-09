import type { FastifyPluginAsync } from "fastify";
import { requireAdmin } from "./auth.js";

interface UpdatePriceBody {
  inputPriceCentsPerMillion?: number;
  outputPriceCentsPerMillion?: number;
  cacheWritePriceCentsPerMillion?: number;
  cacheReadPriceCentsPerMillion?: number;
  active?: boolean;
}

function rowToDto(row: any) {
  return {
    modelId: row.model_id,
    inputPriceCentsPerMillion: Number(row.input_price_cents_per_million),
    outputPriceCentsPerMillion: Number(row.output_price_cents_per_million),
    cacheWritePriceCentsPerMillion: Number(row.cache_write_price_cents_per_million),
    cacheReadPriceCentsPerMillion: Number(row.cache_read_price_cents_per_million),
    active: row.active,
    updatedAt: row.updated_at,
  };
}

const pricesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", requireAdmin);

  app.get("/admin/api/prices", async () => {
    const { rows } = await app.pg.query("SELECT * FROM model_prices ORDER BY model_id ASC");
    return rows.map(rowToDto);
  });

  app.patch<{ Params: { modelId: string }; Body: UpdatePriceBody }>(
    "/admin/api/prices/:modelId",
    async (request, reply) => {
      const { rows: existingRows } = await app.pg.query("SELECT * FROM model_prices WHERE model_id = $1", [request.params.modelId]);
      if (existingRows.length === 0) return reply.code(404).send({ error: "Not found" });

      const current = existingRows[0];
      const {
        inputPriceCentsPerMillion = current.input_price_cents_per_million,
        outputPriceCentsPerMillion = current.output_price_cents_per_million,
        cacheWritePriceCentsPerMillion = current.cache_write_price_cents_per_million,
        cacheReadPriceCentsPerMillion = current.cache_read_price_cents_per_million,
        active = current.active,
      } = request.body;

      const { rows } = await app.pg.query(
        `UPDATE model_prices SET
           input_price_cents_per_million = $1,
           output_price_cents_per_million = $2,
           cache_write_price_cents_per_million = $3,
           cache_read_price_cents_per_million = $4,
           active = $5,
           updated_at = now()
         WHERE model_id = $6 RETURNING *`,
        [inputPriceCentsPerMillion, outputPriceCentsPerMillion, cacheWritePriceCentsPerMillion, cacheReadPriceCentsPerMillion, active, request.params.modelId],
      );

      app.priceCache.invalidate();
      return rowToDto(rows[0]);
    },
  );
};

export default pricesRoutes;
