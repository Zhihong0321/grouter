import { useEffect, useState } from "react";
import { api, type ModelPriceDto, type SupplierModelCostDto, type SupplierPricingDto } from "../api/client.js";

// Supplier costs arrive in the supplier's own unit + currency (subrouter prices
// most providers in CNY per some ratio unit, a few in USD). We deliberately do
// NOT convert -- we show the raw number + currency so it always matches what the
// subrouter.ai models page displays, and never implies a false precision.
function fmtCost(value: number | null, currency: string | null): string {
  if (value == null) return "—";
  const n = value < 1 ? value.toFixed(4) : value.toFixed(2);
  return `${n} ${currency ?? ""}`.trim();
}

export default function PriceTablePage() {
  const [prices, setPrices] = useState<ModelPriceDto[]>([]);
  const [pricing, setPricing] = useState<SupplierPricingDto | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => Promise.all([api.listPrices(), api.getSupplierPricing()]).then(([p, sp]) => {
    setPrices(p);
    setPricing(sp);
  });
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  const save = async (modelId: string, field: keyof ModelPriceDto, value: number) => {
    const updated = await api.updatePrice(modelId, { [field]: value } as any);
    setPrices((prev) => prev.map((p) => (p.modelId === modelId ? updated : p)));
  };

  const sync = async () => {
    setSyncing(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.syncSupplierPricing();
      setMessage(
        `Synced supplier cost for ${result.syncedModelCount} model(s): ` +
        `${result.matchedCount} matched your key's provider group, ${result.fallbackCount} used cheapest-provider fallback.` +
        (result.unpricedModelIds.length ? ` No supplier price found for: ${result.unpricedModelIds.join(", ")}.` : ""),
      );
      await load();
    } catch (e: any) {
      setError(e.message ?? "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const costByModel = new Map<string, SupplierModelCostDto>();
  for (const c of pricing?.costs ?? []) costByModel.set(c.modelId, c);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h2>Price table</h2>
          <p style={{ color: "#9aa4b2", marginTop: 0 }}>
            <strong>Retail</strong> columns (cents per million tokens) are what you charge customers — editable, applied to new
            requests only. <strong>Supplier cost</strong> columns are read-only reference, pulled from subrouter.ai; a sync never
            changes your retail price.
          </p>
        </div>
        <button type="button" onClick={sync} disabled={syncing}>
          {syncing ? "Syncing prices…" : "Sync supplier prices"}
        </button>
      </div>

      {error && <p style={{ color: "#ff8080" }}>{error}</p>}
      {message && <p style={{ color: "#7ee787" }}>{message}</p>}

      {pricing?.sync && (
        <p style={{ color: "#9aa4b2", fontSize: 13 }}>
          {pricing.sync.lastSuccessAt
            ? `Last synced ${new Date(pricing.sync.lastSuccessAt).toLocaleString()} · ${pricing.sync.lastMatchedCount} matched, ${pricing.sync.lastFallbackCount} fallback`
            : "Never synced."}
          {pricing.sync.lastError && <span style={{ color: "#ff8080" }}> · Last error: {pricing.sync.lastError}</span>}
        </p>
      )}

      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Retail in</th>
            <th>Retail out</th>
            <th>Cache write</th>
            <th>Cache read</th>
            <th>Active</th>
            <th style={{ borderLeft: "2px solid #2b3444" }}>Supplier in</th>
            <th>Supplier out</th>
            <th>Provider</th>
          </tr>
        </thead>
        <tbody>
          {prices.map((p) => {
            const cost = costByModel.get(p.modelId);
            return (
              <tr key={p.modelId}>
                <td>{p.modelId}</td>
                {(["inputPriceCentsPerMillion", "outputPriceCentsPerMillion", "cacheWritePriceCentsPerMillion", "cacheReadPriceCentsPerMillion"] as const).map((field) => (
                  <td key={field}>
                    <input
                      type="number"
                      defaultValue={p[field] as number}
                      onBlur={(e) => save(p.modelId, field, Number(e.target.value))}
                      style={{ width: 90 }}
                    />
                  </td>
                ))}
                <td>
                  <input type="checkbox" defaultChecked={p.active} onChange={(e) => save(p.modelId, "active", e.target.checked as any)} />
                </td>
                <td style={{ borderLeft: "2px solid #2b3444", color: "#9aa4b2" }}>{fmtCost(cost?.costInputPrice ?? null, cost?.currency ?? null)}</td>
                <td style={{ color: "#9aa4b2" }}>{fmtCost(cost?.costOutputPrice ?? null, cost?.currency ?? null)}</td>
                <td style={{ color: "#9aa4b2", fontSize: 12 }}>
                  {cost?.providerName ?? "—"}
                  {cost?.isFallback && <span title="No key-group match; showing cheapest provider" style={{ color: "#d29922" }}> (fallback)</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
