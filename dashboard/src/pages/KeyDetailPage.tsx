import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, centsToDollars, type ApiKeyDto, type UsageResponse } from "../api/client.js";

export default function KeyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [key, setKey] = useState<ApiKeyDto | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [range, setRange] = useState<"7d" | "30d">("7d");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    if (!id) return;
    const [k, u] = await Promise.all([api.getKey(id), api.getKeyUsage(id, range)]);
    setKey(k);
    setUsage(u);
  };

  useEffect(() => { load(); }, [id, range]);

  if (!key || !usage) return <p>Loading…</p>;

  const b = usage.breakdown;
  const maxDaily = Math.max(1, ...usage.daily.map((d) => Number(d.cost_cents)));

  const save = async (patch: Partial<ApiKeyDto>) => {
    if (!id) return;
    setSaving(true);
    try {
      const updated = await api.updateKey(id, patch as any);
      setKey(updated);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2>{key.name}</h2>
      <div className="card">
        <div className="form-row">
          <label>Rate limit (req/min)</label>
          <input
            type="number"
            defaultValue={key.rateLimitRpm}
            onBlur={(e) => save({ rateLimitRpm: Number(e.target.value) })}
          />
        </div>
        <div className="form-row">
          <label>Budget (cents)</label>
          <input
            type="number"
            defaultValue={key.budgetCents}
            onBlur={(e) => save({ budgetCents: Number(e.target.value) })}
          />
        </div>
        <p>Spent so far: <strong>{centsToDollars(key.spentCents)}</strong> {saving && "(saving…)"}</p>
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <h3>Usage breakdown</h3>
          <div>
            <button className={range === "7d" ? "" : "secondary"} onClick={() => setRange("7d")}>7d</button>{" "}
            <button className={range === "30d" ? "" : "secondary"} onClick={() => setRange("30d")}>30d</button>
          </div>
        </div>
        <div className="breakdown-grid">
          <div className="breakdown-item">
            <div className="label">Input tokens</div>
            <div className="value">{b.input_tokens}</div>
            <div className="label">{centsToDollars(b.input_cost_cents)}</div>
          </div>
          <div className="breakdown-item">
            <div className="label">Output tokens</div>
            <div className="value">{b.output_tokens}</div>
            <div className="label">{centsToDollars(b.output_cost_cents)}</div>
          </div>
          <div className="breakdown-item">
            <div className="label">Cache write tokens</div>
            <div className="value">{b.cache_creation_input_tokens}</div>
            <div className="label">{centsToDollars(b.cache_write_cost_cents)}</div>
          </div>
          <div className="breakdown-item">
            <div className="label">Cache read tokens</div>
            <div className="value">{b.cache_read_input_tokens}</div>
            <div className="label">{centsToDollars(b.cache_read_cost_cents)}</div>
          </div>
        </div>
        <p style={{ marginTop: 12 }}>
          Total: <strong>{centsToDollars(b.cost_cents)}</strong> across {b.request_count} requests
        </p>

        <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 80, marginTop: 12 }}>
          {usage.daily.map((d) => (
            <div key={d.day} title={`${d.day}: ${centsToDollars(d.cost_cents)}`}
              style={{ flex: 1, background: "#3b6fe0", height: `${(Number(d.cost_cents) / maxDaily) * 100}%`, minHeight: 2 }} />
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Recent requests</h3>
        <table>
          <thead>
            <tr>
              <th>Time</th><th>Model</th><th>In</th><th>Out</th><th>Cache W</th><th>Cache R</th><th>Cost</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {usage.recent.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.created_at).toLocaleString()}</td>
                <td>{r.model}</td>
                <td>{r.input_tokens}</td>
                <td>{r.output_tokens}</td>
                <td>{r.cache_creation_input_tokens}</td>
                <td>{r.cache_read_input_tokens}</td>
                <td>{centsToDollars(r.cost_cents)}</td>
                <td>{r.status_code}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
