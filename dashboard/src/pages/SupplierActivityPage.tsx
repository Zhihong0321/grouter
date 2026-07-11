import { useEffect, useState } from "react";
import { api, type SupplierActivityDashboardDto } from "../api/client.js";

function usd(value: string | number | null | undefined): string {
  return `$${Number(value ?? 0).toFixed(4)}`;
}

function integer(value: string | number | null | undefined): string {
  return Number(value ?? 0).toLocaleString();
}

export default function SupplierActivityPage() {
  const [data, setData] = useState<SupplierActivityDashboardDto | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = () => {
    setError(null);
    return api.getSupplierActivity().then(setData).catch((err) => setError(err instanceof Error ? err.message : "Failed to load supplier activity"));
  };

  useEffect(() => { load(); }, []);

  const sync = async () => {
    setError(null);
    setMessage(null);
    setSyncing(true);
    try {
      const result = await api.syncSupplierActivity();
      setMessage(`Synced ${result.fetchedCount} supplier records; ${result.importedCount} new records stored. Totals reconciled.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Supplier activity sync failed");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ marginBottom: 4 }}>SubRouter activity & cost</h2>
          <p style={{ color: "#9aa4b2", marginTop: 0 }}>Supplier-side usage, wallet cost, and balance. This does not modify customer billing.</p>
        </div>
        <button type="button" onClick={sync} disabled={syncing}>{syncing ? "Syncing activity…" : "Sync SubRouter activity"}</button>
      </div>
      {error && <p style={{ color: "#ff8080" }}>{error}</p>}
      {message && <p style={{ color: "#7ee787" }}>{message}</p>}

      <div className="breakdown-grid">
        <div className="breakdown-item"><div className="label">Supplier wallet remaining</div><div className="value">{usd(data?.account?.remainingWalletUsd)}</div></div>
        <div className="breakdown-item"><div className="label">Supplier wallet used</div><div className="value">{usd(data?.account?.usedWalletUsd)}</div></div>
        <div className="breakdown-item"><div className="label">Synced supplier cost</div><div className="value">{usd(data?.summary.totalCostUsd)}</div></div>
        <div className="breakdown-item"><div className="label">Supplier activity records</div><div className="value">{integer(data?.summary.activityCount)}</div></div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Sync status</h3>
        {data?.sync?.lastError ? (
          <p style={{ color: "#ff8080" }}>Last sync failed: {data.sync.lastError}</p>
        ) : data?.sync?.lastSuccessAt ? (
          <p style={{ color: "#9aa4b2" }}>
            Last successful sync: {new Date(data.sync.lastSuccessAt).toLocaleString()} — {integer(data.sync.totalImportedCount)} records stored
            {data.sync.reconciliationMatched ? ", supplier totals reconciled." : "."}
          </p>
        ) : <p style={{ color: "#9aa4b2" }}>Not synchronized yet.</p>}
        {data?.account && <p style={{ color: "#9aa4b2", fontSize: 13 }}>Supplier requests: {integer(data.account.requestCount)} · account snapshot: {new Date(data.account.lastFetchedAt).toLocaleString()}</p>}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Recent supplier activity</h3>
        <table>
          <thead><tr><th>Time</th><th>Supplier key</th><th>Model</th><th>Input</th><th>Output</th><th>Cache</th><th>Cost</th><th>Provider</th></tr></thead>
          <tbody>
            {(data?.activity ?? []).map((row) => (
              <tr key={`${row.logId}:${row.createdAt}`}>
                <td>{new Date(row.createdAt).toLocaleString()}</td>
                <td>{row.tokenName ?? "—"}</td>
                <td>{row.modelName ?? "—"}</td>
                <td>{integer(row.promptTokens)}</td>
                <td>{integer(row.completionTokens)}</td>
                <td>{integer(row.cacheTokens)}</td>
                <td>{usd(row.costUsd)}</td>
                <td>{row.providerName ?? row.channelName ?? "—"}</td>
              </tr>
            ))}
            {data && data.activity.length === 0 && <tr><td colSpan={8} style={{ color: "#9aa4b2" }}>No supplier activity synchronized yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
