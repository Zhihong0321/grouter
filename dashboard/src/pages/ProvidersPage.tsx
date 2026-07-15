import { useEffect, useState } from "react";
import { api, type ProviderDto, type ProviderHealthDto } from "../api/client.js";

interface NewProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  standard: "anthropic" | "openai";
}

const EMPTY: NewProvider = { name: "", baseUrl: "", apiKey: "", standard: "openai" };

// One-click presets fill everything except the key. Base URLs are verified
// against each provider's live endpoints. MiniMax's single account token serves
// M3 + M2.7-highspeed, so one provider covers both. Note: Xiaomi's Anthropic
// endpoint serves /v1/messages but has no /v1/models, so "Discover models"
// only works on its OpenAI preset -- add models manually for the Anthropic one.
const PRESETS: { label: string; value: Omit<NewProvider, "apiKey"> }[] = [
  { label: "MiniMax (Anthropic)", value: { name: "MiniMax Official", baseUrl: "https://api.minimax.io/anthropic", standard: "anthropic" } },
  { label: "MiniMax (OpenAI)", value: { name: "MiniMax Official", baseUrl: "https://api.minimax.io/v1", standard: "openai" } },
  { label: "Xiaomi MiMo (Anthropic)", value: { name: "Xiaomi MiMo", baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic", standard: "anthropic" } },
  { label: "Xiaomi MiMo (OpenAI)", value: { name: "Xiaomi MiMo", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", standard: "openai" } },
];

export default function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [draft, setDraft] = useState<NewProvider>(EMPTY);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, ProviderHealthDto & { error?: string }>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setProviders(await api.listProviders());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load providers");
    }
  };
  useEffect(() => { void load(); }, []);

  const create = async () => {
    if (!draft.name || !draft.baseUrl || !draft.apiKey) {
      setError("Name, base URL, and API key are all required.");
      return;
    }
    setCreating(true); setError(null); setMessage(null);
    try {
      await api.createProvider(draft);
      setMessage(`Added provider "${draft.name}". Click Discover models to auto-detect and route its models.`);
      setDraft(EMPTY);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create provider");
    } finally { setCreating(false); }
  };

  const discover = async (provider: ProviderDto) => {
    setBusy(provider.id); setError(null); setMessage(null);
    try {
      const result = await api.discoverProviderModels(provider.id);
      const skipped = result.skippedStandardMismatch.length
        ? ` Skipped ${result.skippedStandardMismatch.length} model(s) already registered under the other protocol.`
        : "";
      setMessage(`${provider.name}: found ${result.discoveredCount} model(s) — ${result.newModelCount} newly added, ${result.routedCount} newly routed.${skipped}`);
    } catch (err) {
      setError(`${provider.name}: ${err instanceof Error ? err.message : "Discover failed"}`);
    } finally { setBusy(null); }
  };

  const testHealth = async (provider: ProviderDto) => {
    setBusy(provider.id); setError(null);
    try {
      const result = await api.checkProviderHealth(provider.id);
      setHealth((current) => ({ ...current, [provider.id]: result }));
    } catch (err) {
      setHealth((current) => ({ ...current, [provider.id]: { ok: false, latencyMs: 0, message: "", error: err instanceof Error ? err.message : "Health check failed" } }));
    } finally { setBusy(null); }
  };

  const remove = async (provider: ProviderDto) => {
    if (!confirm(`Delete provider "${provider.name}"? Its model routes will be removed; historical usage is preserved.`)) return;
    setBusy(provider.id); setError(null); setMessage(null);
    try {
      await api.deleteProvider(provider.id);
      setMessage(`Deleted "${provider.name}".`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete provider");
    } finally { setBusy(null); }
  };

  return (
    <div>
      <h2>Providers</h2>
      <p style={{ color: "#9aa4b2" }}>
        Add a direct upstream supplier (MiniMax, Xiaomi MiMo, any OpenAI/Anthropic-compatible relay), then
        auto-detect its models. Discover calls GET /v1/models (zero-cost), registers every advertised model,
        and pairs it to this provider. SubRouter-imported providers are managed on the Router page instead.
      </p>
      {error && <p style={{ color: "#ff8080" }}>{error}</p>}
      {message && <p style={{ color: "#7ee787" }}>{message}</p>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Add provider</h3>
        <div className="form-row">
          <label>Quick fill</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {PRESETS.map((preset) => (
              <button key={preset.label} type="button" className="secondary" onClick={() => setDraft((current) => ({ ...preset.value, apiKey: current.apiKey }))}>
                {preset.label}
              </button>
            ))}
          </div>
        </div>
        <div className="form-row">
          <label>Name</label>
          <input value={draft.name} placeholder="MiniMax Official" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="form-row">
          <label>Protocol</label>
          <select value={draft.standard} onChange={(e) => setDraft({ ...draft, standard: e.target.value as "anthropic" | "openai" })}>
            <option value="openai">OpenAI-compatible (/v1/chat/completions)</option>
            <option value="anthropic">Anthropic-compatible (/v1/messages)</option>
          </select>
        </div>
        <div className="form-row">
          <label>Base URL</label>
          <input value={draft.baseUrl} placeholder="https://api.minimax.io/anthropic" onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
        </div>
        <div className="form-row">
          <label>API key</label>
          <input type="password" value={draft.apiKey} placeholder="sk-… or tp-…" onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
        </div>
        <button type="button" onClick={create} disabled={creating}>{creating ? "Adding…" : "Add provider"}</button>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Configured providers</h3>
        <table>
          <thead><tr><th>Name</th><th>Protocol</th><th>Base URL</th><th>Key</th><th>Source</th><th>Health</th><th></th></tr></thead>
          <tbody>
            {providers.map((provider) => {
              const h = health[provider.id];
              return (
                <tr key={provider.id}>
                  <td>{provider.name}{!provider.active && <span className="badge revoked" style={{ marginLeft: 6 }}>Inactive</span>}</td>
                  <td><span className="badge active">{provider.standard}</span></td>
                  <td style={{ maxWidth: 260, overflowWrap: "anywhere" }}>{provider.baseUrl}</td>
                  <td>••••{provider.apiKeyLast4}</td>
                  <td>{provider.source === "subrouter" ? "SubRouter" : "Manual"}</td>
                  <td style={{ color: h ? (h.error || !h.ok ? "#ff8080" : "#7ee787") : "#9aa4b2" }}>
                    {h ? (h.error ? h.error : `${h.ok ? "OK" : "Fail"}${h.modelCount != null ? ` · ${h.modelCount} models` : ""} · ${h.latencyMs}ms`) : "—"}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button type="button" className="secondary" onClick={() => testHealth(provider)} disabled={busy === provider.id} title="Zero-cost GET /v1/models">Health</button>{" "}
                    <button type="button" onClick={() => discover(provider)} disabled={busy === provider.id} title="Auto-detect models via GET /v1/models and route them">
                      {busy === provider.id ? "Working…" : "Discover models"}
                    </button>{" "}
                    {provider.source !== "subrouter" && (
                      <button type="button" className="danger" onClick={() => remove(provider)} disabled={busy === provider.id}>Delete</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {providers.length === 0 && <tr><td colSpan={7} style={{ color: "#9aa4b2" }}>No providers yet. Add one above.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
