import { useEffect, useMemo, useState } from "react";
import { api, type ModelDto, type ProviderDto, type ProviderModelTestResultDto } from "../api/client.js";

interface TestEntry {
  providerId: string;
  providerName: string;
  modelId: string;
  result?: ProviderModelTestResultDto;
  error?: string;
}

function isCompatible(provider: ProviderDto, model: ModelDto): boolean {
  return provider.active
    && provider.standard === model.standard
    && (!provider.supplierKeyModelIds || provider.supplierKeyModelIds.includes(model.modelId));
}

export default function KeyTesterPage() {
  const [models, setModels] = useState<ModelDto[]>([]);
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [entries, setEntries] = useState<TestEntry[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.listModels(), api.listProviders()])
      .then(([loadedModels, loadedProviders]) => {
        setModels(loadedModels);
        setProviders(loadedProviders);
        const firstCompatible = loadedModels.find((model) => loadedProviders.some((provider) => isCompatible(provider, model)));
        setSelectedModelId(firstCompatible?.modelId ?? loadedModels[0]?.modelId ?? "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load test data"));
  }, []);

  const selectedModel = models.find((model) => model.modelId === selectedModelId);
  const compatibleProviders = useMemo(
    () => selectedModel ? providers.filter((provider) => isCompatible(provider, selectedModel)) : [],
    [providers, selectedModel],
  );
  const allPairs = useMemo(
    () => models.flatMap((model) => providers.filter((provider) => isCompatible(provider, model)).map((provider) => ({ provider, model }))),
    [models, providers],
  );

  const saveEntry = (entry: TestEntry) => {
    setEntries((current) => [entry, ...current.filter((existing) => !(existing.providerId === entry.providerId && existing.modelId === entry.modelId))]);
  };

  const testPair = async (provider: ProviderDto, model: ModelDto) => {
    const testId = `${provider.id}:${model.modelId}`;
    setRunning(testId);
    try {
      const result = await api.testProviderModel(provider.id, model.modelId);
      saveEntry({ providerId: provider.id, providerName: provider.name, modelId: model.modelId, result });
    } catch (err) {
      saveEntry({ providerId: provider.id, providerName: provider.name, modelId: model.modelId, error: err instanceof Error ? err.message : "Test failed" });
    } finally {
      setRunning(null);
    }
  };

  const testSelected = async () => {
    if (!selectedModel) return;
    for (const provider of compatibleProviders) await testPair(provider, selectedModel);
  };

  const testAll = async () => {
    if (!confirm(`Run ${allPairs.length} provider/model tests? Each test sends a small real request and may use upstream tokens.`)) return;
    setRunningAll(true);
    for (const { provider, model } of allPairs) await testPair(provider, model);
    setRunningAll(false);
  };

  return (
    <div>
      <h2>Key Tester</h2>
      <p style={{ color: "#9aa4b2" }}>
        Test encrypted routing-provider keys against compatible models. Tests send small real upstream requests; keys are never exposed to the browser.
      </p>
      {error && <p style={{ color: "#ff8080" }}>{error}</p>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Request configuration</h3>
        <div className="form-row">
          <label>Model</label>
          <select value={selectedModelId} onChange={(event) => setSelectedModelId(event.target.value)}>
            {models.map((model) => (
              <option key={model.modelId} value={model.modelId}>{model.displayName} ({model.modelId}) — {model.standard}</option>
            ))}
          </select>
        </div>
        <p style={{ color: "#9aa4b2", fontSize: 13 }}>
          {selectedModel ? `${compatibleProviders.length} active compatible provider(s).` : "Choose a model."}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={testSelected} disabled={!selectedModel || compatibleProviders.length === 0 || running !== null || runningAll}>
            Test all matching providers
          </button>
          <button type="button" className="secondary" onClick={testAll} disabled={allPairs.length === 0 || running !== null || runningAll}>
            {runningAll ? "Testing all pairs…" : `Test all compatible pairs (${allPairs.length})`}
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Compatible providers</h3>
        <table>
          <thead><tr><th>Provider / key</th><th>Format</th><th>Model</th><th></th></tr></thead>
          <tbody>
            {selectedModel && compatibleProviders.map((provider) => {
              const testId = `${provider.id}:${selectedModel.modelId}`;
              return (
                <tr key={provider.id}>
                  <td>{provider.name}{provider.source === "subrouter" ? " · SubRouter key" : ""}</td>
                  <td>{provider.standard}</td>
                  <td>{selectedModel.modelId}</td>
                  <td><button type="button" className="secondary" onClick={() => testPair(provider, selectedModel)} disabled={running !== null || runningAll}>{running === testId ? "Testing…" : "Test"}</button></td>
                </tr>
              );
            })}
            {compatibleProviders.length === 0 && <tr><td colSpan={4} style={{ color: "#9aa4b2" }}>No active provider/key is compatible with this model.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Test results</h3>
        {entries.length === 0 ? <p style={{ color: "#9aa4b2" }}>No results yet. Choose a model and start a test.</p> : (
          <table>
            <thead><tr><th>Provider</th><th>Model</th><th>Endpoint</th><th>Result</th><th>Latency</th></tr></thead>
            <tbody>
              {entries.flatMap((entry) => entry.error
                ? [<tr key={`${entry.providerId}:${entry.modelId}:error`}><td>{entry.providerName}</td><td>{entry.modelId}</td><td>—</td><td style={{ color: "#ff8080" }}>{entry.error}</td><td>—</td></tr>]
                : (entry.result?.results ?? []).map((result) => (
                  <tr key={`${entry.providerId}:${entry.modelId}:${result.endpoint}`}>
                    <td>{entry.providerName}</td><td>{entry.modelId}</td><td>{result.endpoint}</td>
                    <td style={{ color: result.ok ? "#7ee787" : "#ff8080" }}>{result.ok ? "OK" : result.message}{result.statusCode ? ` (HTTP ${result.statusCode})` : ""}</td>
                    <td>{result.latencyMs}ms</td>
                  </tr>
                ))) }
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
