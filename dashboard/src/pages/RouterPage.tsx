import { useEffect, useState, type FormEvent } from "react";
import { api, type SettingsDto, type ModelDto, type ProviderDto, type ModelRouteDto, type ProviderHealthDto } from "../api/client.js";

export default function RouterPage() {
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [keyPrefix, setKeyPrefix] = useState("");
  const [savedPrefix, setSavedPrefix] = useState(false);

  const [models, setModels] = useState<ModelDto[]>([]);
  const [newModelId, setNewModelId] = useState("");
  const [newModelName, setNewModelName] = useState("");
  const [newModelBrand, setNewModelBrand] = useState("Anthropic");
  const [newModelStandard, setNewModelStandard] = useState<"anthropic" | "openai">("anthropic");

  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [newProviderName, setNewProviderName] = useState("");
  const [newProviderUrl, setNewProviderUrl] = useState("");
  const [newProviderKey, setNewProviderKey] = useState("");
  const [newProviderStandard, setNewProviderStandard] = useState<"anthropic" | "openai">("anthropic");
  const [healthResults, setHealthResults] = useState<Record<string, ProviderHealthDto>>({});
  const [testingProvider, setTestingProvider] = useState<string | null>(null);

  const [selectedModelId, setSelectedModelId] = useState("");
  const [routes, setRoutes] = useState<ModelRouteDto[]>([]);
  const [routesDirty, setRoutesDirty] = useState(false);
  const [addRouteProviderId, setAddRouteProviderId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadSettings = () =>
    api.getSettings().then((s) => {
      setSettings(s);
      setKeyPrefix(s.keyPrefix);
    });
  const loadModels = () =>
    api.listModels().then((ms) => {
      setModels(ms);
      setSelectedModelId((prev) => prev || ms[0]?.modelId || "");
    });
  const loadProviders = () => api.listProviders().then(setProviders);
  const loadRoutes = (modelId: string) => {
    if (!modelId) return;
    api.getModelRoutes(modelId).then((r) => {
      setRoutes(r);
      setRoutesDirty(false);
    });
  };

  useEffect(() => {
    loadSettings();
    loadModels();
    loadProviders();
  }, []);

  useEffect(() => {
    loadRoutes(selectedModelId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModelId]);

  const saveKeyPrefix = async (e: FormEvent) => {
    e.preventDefault();
    setSavedPrefix(false);
    const updated = await api.updateSettings({ keyPrefix });
    setSettings(updated);
    setSavedPrefix(true);
  };

  const addModel = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.createModel({ modelId: newModelId, displayName: newModelName, brand: newModelBrand, standard: newModelStandard });
      setNewModelId("");
      setNewModelName("");
      setNewModelBrand("Anthropic");
      setNewModelStandard("anthropic");
      await loadModels();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add model");
    }
  };

  const toggleModelActive = async (m: ModelDto) => {
    await api.updateModel(m.modelId, { active: !m.active });
    await loadModels();
  };

  const addProvider = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.createProvider({ name: newProviderName, baseUrl: newProviderUrl, apiKey: newProviderKey, standard: newProviderStandard });
      setNewProviderName("");
      setNewProviderUrl("");
      setNewProviderKey("");
      setNewProviderStandard("anthropic");
      await loadProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add provider");
    }
  };

  const toggleProviderActive = async (p: ProviderDto) => {
    await api.updateProvider(p.id, { active: !p.active });
    await loadProviders();
  };

  const deleteProvider = async (p: ProviderDto) => {
    if (!confirm(`Delete provider "${p.name}"? This removes it from any model's routing.`)) return;
    await api.deleteProvider(p.id);
    await loadProviders();
    loadRoutes(selectedModelId);
  };

  const testProvider = async (id: string) => {
    setTestingProvider(id);
    try {
      const result = await api.checkProviderHealth(id);
      setHealthResults((prev) => ({ ...prev, [id]: result }));
    } catch (err) {
      setHealthResults((prev) => ({
        ...prev,
        [id]: { ok: false, latencyMs: 0, message: err instanceof Error ? err.message : "Test failed" },
      }));
    } finally {
      setTestingProvider(null);
    }
  };

  const renumber = (list: ModelRouteDto[]): ModelRouteDto[] => list.map((r, i) => ({ ...r, priority: i + 1 }));

  const addRouteProvider = () => {
    const provider = providers.find((p) => p.id === addRouteProviderId);
    if (!provider) return;
    setRoutes((prev) =>
      renumber([
        ...prev,
        {
          routeId: `new-${provider.id}`,
          providerId: provider.id,
          providerName: provider.name,
          standard: provider.standard,
          upstreamModelId: selectedModelId,
          priority: prev.length + 1,
          active: true,
        },
      ]),
    );
    setRoutesDirty(true);
    setAddRouteProviderId("");
  };

  const removeRoute = (routeId: string) => {
    setRoutes((prev) => renumber(prev.filter((r) => r.routeId !== routeId)));
    setRoutesDirty(true);
  };

  const moveRoute = (index: number, dir: -1 | 1) => {
    setRoutes((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return renumber(next);
    });
    setRoutesDirty(true);
  };

  const updateUpstreamModelId = (routeId: string, value: string) => {
    setRoutes((prev) => prev.map((r) => (r.routeId === routeId ? { ...r, upstreamModelId: value } : r)));
    setRoutesDirty(true);
  };

  const saveRoutes = async () => {
    setError(null);
    try {
      const saved = await api.putModelRoutes(
        selectedModelId,
        routes.map((r) => ({ providerId: r.providerId, upstreamModelId: r.upstreamModelId, priority: r.priority })),
      );
      setRoutes(saved);
      setRoutesDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save routing");
    }
  };

  const selectedModel = models.find((m) => m.modelId === selectedModelId);
  const availableProviders = providers.filter(
    (p) => !routes.some((r) => r.providerId === p.id) && (!selectedModel || p.standard === selectedModel.standard),
  );

  if (!settings) return <p>Loading…</p>;

  return (
    <div>
      <h2>Router</h2>
      <p style={{ color: "#9aa4b2" }}>
        Models are what your users call. Providers are your upstream suppliers. Routing decides which provider serves
        each model, in priority order — priority 1 is tried first, the rest are automatic failover backups.
      </p>
      {error && <p style={{ color: "#ff8080" }}>{error}</p>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Models</h3>
        <table>
          <thead>
            <tr>
              <th>Model ID</th>
              <th>Display name</th>
              <th>Brand</th>
              <th>Standard</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.modelId}>
                <td>{m.modelId}</td>
                <td>{m.displayName}</td>
                <td>{m.brand}</td>
                <td>
                  <span className="badge active">{m.standard}</span>
                </td>
                <td>
                  <input type="checkbox" checked={m.active} onChange={() => toggleModelActive(m)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form onSubmit={addModel} className="form-row" style={{ flexDirection: "row", alignItems: "center", marginTop: 12 }}>
          <input placeholder="model_id (e.g. claude-sonnet-5)" value={newModelId} onChange={(e) => setNewModelId(e.target.value)} required />
          <input placeholder="Display name" value={newModelName} onChange={(e) => setNewModelName(e.target.value)} required />
          <input placeholder="Brand (e.g. OpenAI)" value={newModelBrand} onChange={(e) => setNewModelBrand(e.target.value)} required />
          <select value={newModelStandard} onChange={(e) => setNewModelStandard(e.target.value as "anthropic" | "openai")}>
            <option value="anthropic">Anthropic API</option>
            <option value="openai">OpenAI-compatible API</option>
          </select>
          <button type="submit">Add model</button>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Providers</h3>
        {providers.map((p) => (
          <div key={p.id} className="card" style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong>{p.name}</strong> <span className="badge active">{p.standard}</span>
                <div style={{ color: "#9aa4b2", fontSize: 12 }}>
                  {p.baseUrl} — key ****{p.apiKeyLast4}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <label style={{ fontSize: 12, color: "#9aa4b2" }}>
                  <input type="checkbox" checked={p.active} onChange={() => toggleProviderActive(p)} /> Active
                </label>
                <button type="button" className="secondary" onClick={() => testProvider(p.id)} disabled={testingProvider === p.id}>
                  {testingProvider === p.id ? "Testing…" : "Test"}
                </button>
                <button type="button" className="danger" onClick={() => deleteProvider(p)}>
                  Delete
                </button>
              </div>
            </div>
            {healthResults[p.id] && (
              <p style={{ color: healthResults[p.id].ok ? "#7ee787" : "#ff8080", fontSize: 12, marginBottom: 0 }}>
                {healthResults[p.id].ok
                  ? `Connected — ${healthResults[p.id].modelCount ?? "?"} model(s) available (${healthResults[p.id].latencyMs}ms)`
                  : `Failed: ${healthResults[p.id].message}${healthResults[p.id].statusCode ? ` (HTTP ${healthResults[p.id].statusCode})` : ""}`}
              </p>
            )}
          </div>
        ))}
        <form onSubmit={addProvider} className="form-row" style={{ flexDirection: "row", alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
          <input placeholder="Name (e.g. SupplierX)" value={newProviderName} onChange={(e) => setNewProviderName(e.target.value)} required />
          <input placeholder="Base URL" value={newProviderUrl} onChange={(e) => setNewProviderUrl(e.target.value)} required />
          <input type="password" placeholder="API key" value={newProviderKey} onChange={(e) => setNewProviderKey(e.target.value)} required />
          <select value={newProviderStandard} onChange={(e) => setNewProviderStandard(e.target.value as "anthropic" | "openai")}>
            <option value="anthropic">Anthropic API</option>
            <option value="openai">OpenAI-compatible API</option>
          </select>
          <button type="submit">Add provider</button>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Routing</h3>
        <div className="form-row">
          <label>Model</label>
          <select value={selectedModelId} onChange={(e) => setSelectedModelId(e.target.value)}>
            {models.map((m) => (
              <option key={m.modelId} value={m.modelId}>
                {m.displayName} ({m.modelId})
              </option>
            ))}
          </select>
        </div>

        <table>
          <thead>
            <tr>
              <th>Priority</th>
              <th>Provider</th>
              <th>Upstream model ID</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {routes.map((r, i) => (
              <tr key={r.routeId}>
                <td>{i === 0 ? "Primary" : `Backup #${i}`}</td>
                <td>{r.providerName}</td>
                <td>
                  <input value={r.upstreamModelId} onChange={(e) => updateUpstreamModelId(r.routeId, e.target.value)} style={{ width: 200 }} />
                </td>
                <td style={{ display: "flex", gap: 4 }}>
                  <button type="button" className="secondary" onClick={() => moveRoute(i, -1)} disabled={i === 0}>
                    ↑
                  </button>
                  <button type="button" className="secondary" onClick={() => moveRoute(i, 1)} disabled={i === routes.length - 1}>
                    ↓
                  </button>
                  <button type="button" className="danger" onClick={() => removeRoute(r.routeId)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="form-row" style={{ flexDirection: "row", alignItems: "center", marginTop: 12 }}>
          <select value={addRouteProviderId} onChange={(e) => setAddRouteProviderId(e.target.value)}>
            <option value="">Add provider to this model…</option>
            {availableProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button type="button" className="secondary" onClick={addRouteProvider} disabled={!addRouteProviderId}>
            Add
          </button>
          <button type="button" onClick={saveRoutes} disabled={!routesDirty}>
            Save routing
          </button>
        </div>
      </div>

      <form onSubmit={saveKeyPrefix} className="card">
        <h3 style={{ marginTop: 0 }}>Issued-key prefix</h3>
        <div className="form-row">
          <input value={keyPrefix} onChange={(e) => setKeyPrefix(e.target.value)} required />
          <span style={{ color: "#9aa4b2", fontSize: 12 }}>Client keys look like sk-{keyPrefix}-...</span>
        </div>
        {savedPrefix && <p style={{ color: "#7ee787" }}>Saved.</p>}
        <button type="submit">Save</button>
      </form>
    </div>
  );
}
