import type { Pool } from "pg";

export interface SmartRouteSyncResult {
  addedRouteCount: number;
  reactivatedRouteCount: number;
  deactivatedRouteCount: number;
  routedModelCount: number;
}

/**
 * Builds the route matrix from the live per-key `/v1/models` results.
 *
 * Existing routes keep their priority: that is the administrator's explicit
 * primary/backup choice.  A newly discovered compatible key is appended as a
 * backup, and a route is disabled when that key no longer advertises the
 * model.  This means a later sync never silently undoes a manual order.
 */
export async function syncSmartRoutes(pg: Pool): Promise<SmartRouteSyncResult> {
  const client = await pg.connect();
  try {
    await client.query("BEGIN");

    const deactivated = await client.query(
      `UPDATE reseller_model_routes r
       SET active = false
       FROM reseller_supplier_keys k
       WHERE k.provider_id = r.provider_id
         AND r.active = true
         AND (
           k.present_on_supplier = false OR k.status <> 1 OR NOT EXISTS (
             SELECT 1 FROM reseller_supplier_key_models km
             WHERE km.supplier_key_id = k.id AND km.model_id = r.model_id
           )
         )`,
    );

    const { rows: eligible } = await client.query<{ model_id: string; provider_id: string }>(
      `SELECT DISTINCT m.model_id, p.id AS provider_id
       FROM reseller_models m
       JOIN reseller_supplier_key_models km ON km.model_id = m.model_id
       JOIN reseller_supplier_keys k ON k.id = km.supplier_key_id
       JOIN reseller_providers p ON p.id = k.provider_id
       WHERE m.active = true
         AND k.present_on_supplier = true AND k.status = 1
         AND p.active = true AND p.standard = m.standard`,
    );

    let addedRouteCount = 0;
    let reactivatedRouteCount = 0;
    const nextPriorityByModel = new Map<string, number>();
    for (const pair of eligible) {
      const existing = await client.query<{ active: boolean }>(
        "SELECT active FROM reseller_model_routes WHERE model_id = $1 AND provider_id = $2 FOR UPDATE",
        [pair.model_id, pair.provider_id],
      );
      if (existing.rows[0]) {
        if (!existing.rows[0].active) {
          await client.query(
            "UPDATE reseller_model_routes SET active = true, upstream_model_id = $1 WHERE model_id = $2 AND provider_id = $3",
            [pair.model_id, pair.model_id, pair.provider_id],
          );
          reactivatedRouteCount += 1;
        }
        continue;
      }

      let priority = nextPriorityByModel.get(pair.model_id);
      if (priority === undefined) {
        const max = await client.query<{ max_priority: number | null }>(
          "SELECT MAX(priority) AS max_priority FROM reseller_model_routes WHERE model_id = $1",
          [pair.model_id],
        );
        priority = Number(max.rows[0]?.max_priority ?? 0) + 1;
      }
      await client.query(
        `INSERT INTO reseller_model_routes (model_id, provider_id, upstream_model_id, priority, active)
         VALUES ($1,$2,$3,$4,true)`,
        [pair.model_id, pair.provider_id, pair.model_id, priority],
      );
      nextPriorityByModel.set(pair.model_id, priority + 1);
      addedRouteCount += 1;
    }

    await client.query("COMMIT");
    return {
      addedRouteCount,
      reactivatedRouteCount,
      deactivatedRouteCount: deactivated.rowCount ?? 0,
      routedModelCount: new Set(eligible.map((pair) => pair.model_id)).size,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
