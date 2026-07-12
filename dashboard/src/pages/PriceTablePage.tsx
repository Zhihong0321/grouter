import { Fragment, useEffect, useState } from "react";
import { api, type ModelPriceDto, type SupplierModelPricingDto, type SupplierPricingDto, type SupplierProviderCostDto } from "../api/client.js";

// Supplier costs arrive in the provider's own unit + currency (subrouter prices
// most providers in CNY per its ratio unit, a few in USD). We do NOT convert --
// we show the raw number + currency so it matches the subrouter.ai page exactly.
function fmtCost(value: number | null): string {
  if (value == null) return "—";
  return value < 1 ? value.toFixed(4) : value.toFixed(2);
}

function ProviderRows({ providers }: { providers: SupplierProviderCostDto[] }) {
  if (providers.length === 0) {
    return <tr><td colSpan={7} style={{ color: "#9aa4b2", paddingLeft: 24 }}>No supplier providers synced for this model yet.</td></tr>;
  }
  return (
    <>
      {providers.map((p) => (
        <tr key={p.providerGroup} style={{ background: p.matchesOurKey ? "rgba(126,231,135,0.08)" : undefined }}>
          <td style={{ paddingLeft: 24, color: "#9aa4b2" }}>
            {p.priceRank === 1 ? "▸ primary" : `backup ${p.priceRank}`}
          </td>
          <td>
            {p.providerName ?? p.providerGroup}
            {p.matchesOurKey && <span title="Matches one of your subrouter keys" style={{ color: "#7ee787" }}> ★ yours</span>}
          </td>
          <td style={{ color: "#9aa4b2" }}>{p.region ?? ""}</td>
          <td>{fmtCost(p.inputPrice)}</td>
          <td>{fmtCost(p.outputPrice)}</td>
          <td>{fmtCost(p.cacheReadPrice)}</td>
          <td style={{ color: "#9aa4b2" }}>{p.currency ?? ""}</td>
        </tr>
      ))}
    </>
  );
}

export default function PriceTablePage() {
  const [prices, setPrices] = useState<ModelPriceDto[]>([]);
  const [pricing, setPricing] = useState<SupplierPricingDto | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Load the retail price table and the supplier-cost data INDEPENDENTLY. The
  // supplier endpoint depends on tables from a later migration, so if it is
  // unavailable it must never blank the whole page -- retail must still render.
  const loadPrices = () => api.listPrices().then(setPrices);
  const loadPricing = () => api.getSupplierPricing().then(setPricing).catch(() => setPricing(null));
  useEffect(() => {
    loadPrices().catch((e) => setError(e.message));
    loadPricing();
  }, []);

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
        `Synced ${result.providerRowCount} provider price(s) across ${result.pricedModelCount} model(s). ` +
        `${result.matchesOurKeyCount} match your keys.` +
        (result.unpricedModelIds.length ? ` No supplier price for: ${result.unpricedModelIds.join(", ")}.` : ""),
      );
      await loadPricing();
    } catch (e: any) {
      setError(e.message ?? "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const modelByPricing = new Map<string, SupplierModelPricingDto>();
  for (const m of pricing?.models ?? []) modelByPricing.set(m.modelId, m);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h2>Price table</h2>
          <p style={{ color: "#9aa4b2", marginTop: 0 }}>
            <strong>Retail</strong> (cents per million tokens) is what you charge customers — editable, applied to new requests
            only. Expand a model to see <strong>every supplier provider</strong> (primary + all backups) and its cost from
            subrouter.ai. A sync never changes your retail price.
          </p>
        </div>
        <button type="button" onClick={sync} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync supplier prices"}
        </button>
      </div>

      {error && <p style={{ color: "#ff8080" }}>{error}</p>}
      {message && <p style={{ color: "#7ee787" }}>{message}</p>}
      {pricing?.sync && (
        <p style={{ color: "#9aa4b2", fontSize: 13 }}>
          {pricing.sync.lastSuccessAt
            ? `Last synced ${new Date(pricing.sync.lastSuccessAt).toLocaleString()} · ${pricing.sync.lastProviderRowCount} providers, ${pricing.sync.lastMatchesOurKeyCount} match your keys`
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
            <th>Providers</th>
          </tr>
        </thead>
        <tbody>
          {prices.map((p) => {
            const sup = modelByPricing.get(p.modelId);
            const providerCount = sup?.providers.length ?? 0;
            const isOpen = !!expanded[p.modelId];
            return (
              <Fragment key={p.modelId}>
                <tr>
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
                  <td>
                    {providerCount > 0 ? (
                      <button type="button" className="secondary" onClick={() => setExpanded((prev) => ({ ...prev, [p.modelId]: !prev[p.modelId] }))}>
                        {isOpen ? "Hide" : "Show"} {providerCount}
                      </button>
                    ) : <span style={{ color: "#9aa4b2" }}>—</span>}
                  </td>
                </tr>
                {isOpen && (
                  <>
                    <tr style={{ fontSize: 12, color: "#9aa4b2" }}>
                      <td style={{ paddingLeft: 24 }}>Route</td>
                      <td>Provider</td>
                      <td>Region</td>
                      <td>In</td>
                      <td>Out</td>
                      <td>Cache read</td>
                      <td>Currency</td>
                    </tr>
                    <ProviderRows providers={sup?.providers ?? []} />
                  </>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
