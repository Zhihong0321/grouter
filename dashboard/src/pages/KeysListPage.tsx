import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, centsToDollars, type ApiKeyDto } from "../api/client.js";
import ConnectionInfo from "../components/ConnectionInfo.js";

function KeyCell({ prefix, fullKey }: { prefix: string; fullKey: string | null }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!fullKey) {
    return (
      <code title="Created before key recovery was added -- revoke and reissue to get a viewable key">
        {prefix}… (unavailable, reissue to recover)
      </code>
    );
  }

  const copy = async () => {
    await navigator.clipboard.writeText(fullKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <code>{revealed ? fullKey : `${prefix}…`}</code>
      <button type="button" className="secondary" onClick={() => setRevealed((r) => !r)}>
        {revealed ? "Hide" : "Show"}
      </button>
      <button type="button" onClick={copy}>{copied ? "Copied!" : "Copy"}</button>
    </span>
  );
}

export default function KeysListPage() {
  const [keys, setKeys] = useState<ApiKeyDto[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [justCreated, setJustCreated] = useState<ApiKeyDto | null>(null);

  const [name, setName] = useState("");
  const [rateLimitRpm, setRateLimitRpm] = useState(60);
  const [budgetCents, setBudgetCents] = useState(1000);

  const load = () => api.listKeys().then(setKeys);
  useEffect(() => { load(); }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const created = await api.createKey({ name, rateLimitRpm, budgetCents });
    setShowCreate(false);
    setJustCreated(created);
    setName("");
    await load();
  };

  const revoke = async (id: string) => {
    if (!confirm("Revoke this key? Clients using it will be rejected within ~45s.")) return;
    await api.revokeKey(id);
    await load();
  };

  const remove = async (id: string) => {
    if (!confirm("Remove this customer API key from the dashboard? It will be permanently revoked and its recoverable plaintext will be destroyed. Historical usage logs stay intact.")) return;
    await api.removeKey(id);
    await load();
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>API Keys</h2>
        <button onClick={() => setShowCreate(true)}>Create key</button>
      </div>

      {justCreated && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
            <strong>"{justCreated.name}" is ready -- here's how to connect to it:</strong>
            <button type="button" className="secondary" onClick={() => setJustCreated(null)}>Dismiss</button>
          </div>
          <ConnectionInfo apiKey={justCreated.key} keyPrefix={justCreated.keyPrefix} />
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
              <td><KeyCell prefix={k.keyPrefix} fullKey={k.key} /></td>
              <td><span className={`badge ${k.status}`}>{k.status}</span></td>
              <td>{k.rateLimitRpm}</td>
              <td>{centsToDollars(k.budgetCents)}</td>
              <td>{centsToDollars(k.spentCents)}</td>
              <td>
                {k.status === "active" && <button className="danger" onClick={() => revoke(k.id)}>Revoke</button>}
                <button className="danger" style={{ marginLeft: 6 }} onClick={() => remove(k.id)}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
