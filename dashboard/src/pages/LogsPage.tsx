import { Fragment, useEffect, useState } from "react";
import { api, type RequestLogDto } from "../api/client.js";

const OUTCOME_LABEL: Record<RequestLogDto["outcome"], string> = {
  success: "Success",
  upstream_error: "Upstream error",
  all_providers_failed: "All providers failed",
  no_route: "No route",
};

const OUTCOME_CLASS: Record<RequestLogDto["outcome"], string> = {
  success: "active",
  upstream_error: "revoked",
  all_providers_failed: "revoked",
  no_route: "revoked",
};

export default function LogsPage() {
  const [logs, setLogs] = useState<RequestLogDto[]>([]);
  const [modelFilter, setModelFilter] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api
      .listRequestLogs({ limit: 200, model: modelFilter || undefined, outcome: outcomeFilter || undefined })
      .then(setLogs)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load logs"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <h2>Request logs</h2>
      <p style={{ color: "#9aa4b2" }}>
        Every dispatched request, plus anything that never made it upstream — no provider configured for the model,
        or every failover provider rejected it. Successful/errored dispatch rows show which provider actually handled
        it; expand a row to see the per-provider failover attempts.
      </p>
      {error && <p style={{ color: "#ff8080" }}>{error}</p>}

      <div className="form-row" style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
        <input placeholder="Filter by model ID" value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} />
        <select value={outcomeFilter} onChange={(e) => setOutcomeFilter(e.target.value)}>
          <option value="">All outcomes</option>
          <option value="success">Success</option>
          <option value="upstream_error">Upstream error</option>
          <option value="all_providers_failed">All providers failed</option>
          <option value="no_route">No route</option>
        </select>
        <button type="button" onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Key</th>
            <th>Endpoint</th>
            <th>Model</th>
            <th>Outcome</th>
            <th>Status</th>
            <th>Provider</th>
            <th>Upstream model ID</th>
            <th>Latency</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <Fragment key={log.id}>
              <tr
                style={{ cursor: log.attempts || log.error_message ? "pointer" : undefined }}
                onClick={() => setExpanded((prev) => (prev === log.id ? null : log.id))}
              >
                <td>{new Date(log.created_at).toLocaleString()}</td>
                <td>{log.key_name ?? "—"}</td>
                <td>{log.endpoint}</td>
                <td>{log.model}</td>
                <td>
                  <span className={`badge ${OUTCOME_CLASS[log.outcome]}`}>{OUTCOME_LABEL[log.outcome]}</span>
                </td>
                <td>{log.status_code ?? "—"}</td>
                <td>{log.provider_name ?? "—"}</td>
                <td>{log.upstream_model_id ?? "—"}</td>
                <td>{log.latency_ms != null ? `${log.latency_ms}ms` : "—"}</td>
              </tr>
              {expanded === log.id && (log.attempts || log.error_message) && (
                <tr>
                  <td colSpan={9} style={{ background: "#1a1d24" }}>
                    {log.error_message && <p style={{ margin: "4px 0" }}>{log.error_message}</p>}
                    {log.attempts && log.attempts.length > 0 && (
                      <table style={{ margin: "4px 0" }}>
                        <thead>
                          <tr>
                            <th>Provider tried</th>
                            <th>Status</th>
                            <th>Error</th>
                          </tr>
                        </thead>
                        <tbody>
                          {log.attempts.map((a, i) => (
                            <tr key={i}>
                              <td>{a.providerName}</td>
                              <td>{a.statusCode ?? "—"}</td>
                              <td>{a.error ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {logs.length === 0 && !loading && <p style={{ color: "#9aa4b2" }}>No logs yet.</p>}
    </div>
  );
}
