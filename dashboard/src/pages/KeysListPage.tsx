import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, centsToDollars, type ApiKeyDto } from "../api/client.js";

export default function KeysListPage() {
  const [keys, setKeys] = useState<ApiKeyDto[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [plaintextReveal, setPlaintextReveal] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [name, setName] = useState("");
  const [rateLimitRpm, setRateLimitRpm] = useState(60);
  const [budgetCents, setBudgetCents] = useState(1000);

  const load = () => api.listKeys().then(setKeys);
  useEffect(() => { load(); }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const created = await api.createKey({ name, rateLimitRpm, budgetCents });
    setPlaintextReveal(created.plaintextKey);
    setCopied(false);
    setShowCreate(false);
    setName("");
    await load();
  };

  const copyReveal = async () => {
    if (!plaintextReveal) return;
    await navigator.clipboard.writeText(plaintextReveal);
    setCopied(true);
  };

  const revoke = async (id: string) => {
    if (!confirm("Revoke this key? Clients using it will be rejected within ~45s.")) return;
    await api.revokeKey(id);
    await load();
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>API Keys</h2>
        <button onClick={() => setShowCreate(true)}>Create key</button>
      </div>

      {plaintextReveal && (
        <div className="card">
          <strong>Copy this key now — it will not be shown again:</strong>
          <div className="plaintext-reveal-row">
            <input className="plaintext-reveal" readOnly value={plaintextReveal} onFocus={(e) => e.target.select()} />
            <button type="button" onClick={copyReveal}>{copied ? "Copied!" : "Copy"}</button>
          </div>
          <button onClick={() => setPlaintextReveal(null)}>Done</button>
        </div>
      )}

      {showCreate && (
        <form onSubmit={create} className="card">
          <div className="form-row">
            <label>Client name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="form-row">
            <label>Rate limit (requests/min)</label>
            <input type="number" value={rateLimitRpm} onChange={(e) => setRateLimitRpm(Number(e.target.value))} min={1} />
          </div>
          <div className="form-row">
            <label>Budget (cents)</label>
            <input type="number" value={budgetCents} onChange={(e) => setBudgetCents(Number(e.target.value))} min={0} />
          </div>
          <button type="submit">Create</button>{" "}
          <button type="button" className="secondary" onClick={() => setShowCreate(false)}>Cancel</button>
        </form>
      )}

      <table>
        <thead>
          <tr>
            <th>Name</th><th>Key</th><th>Status</th><th>RPM</th><th>Budget</th><th>Spent</th><th></th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id}>
              <td><Link to={`/keys/${k.id}`}>{k.name}</Link></td>
              <td><code>{k.keyPrefix}…</code></td>
              <td><span className={`badge ${k.status}`}>{k.status}</span></td>
              <td>{k.rateLimitRpm}</td>
              <td>{centsToDollars(k.budgetCents)}</td>
              <td>{centsToDollars(k.spentCents)}</td>
              <td>
                {k.status === "active" && <button className="danger" onClick={() => revoke(k.id)}>Revoke</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
