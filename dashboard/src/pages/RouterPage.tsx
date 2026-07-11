import { useEffect, useMemo, useState } from "react";
import { api, type ProviderModelTestResultDto, type SmartRouteDto, type SmartRoutingModelDto } from "../api/client.js";

type ModelGroup = "anthropic" | "openai" | "china" | "other";

const CHINA_MODEL = /deepseek|qwen|glm|zhipu|kimi|moonshot|minimax|doubao|baichuan|hunyuan|ernie|stepfun|yi-/i;
const OPENAI_MODEL = /(^gpt-|^o[0-9]|openai)/i;

function groupFor(model: SmartRoutingModelDto): ModelGroup {
  if (model.modelId.startsWith("claude-")) return "anthropic";
  if (OPENAI_MODEL.test(model.modelId)) return "openai";
  if (model.brand.toLowerCase() === "anthropic") return "anthropic";
  if (model.brand.toLowerCase() === "openai") return "openai";
  return CHINA_MODEL.test(`${model.brand} ${model.modelId}`) ? "china" : "other";
}

function testSummary(result: ProviderModelTestResultDto | undefined): { text: string; ok: boolean } | undefined {
  if (!result) return undefined;
  const ok = result.results.every((item) => item.ok);
  const latency = Math.max(...result.results.map((item) => item.latencyMs));
  return { ok, text: ok ? `Alive · ${latency}ms` : result.results.find((item) => !item.ok)?.message ?? "Failed" };
}

function Pair({ route, model, result, testing, onTest, onPrimary }: {
  route: SmartRouteDto;
  model: SmartRoutingModelDto;
  result?: ProviderModelTestResultDto;
  testing: boolean;
  onTest: () => void;
  onPrimary: () => void;
}) {
  const summary = testSummary(result);
  return (
    <div className="route-pair">
      <div>
        <strong>{route.priority === 1 ? "Primary" : `Backup #${route.priority - 1}`}</strong>
        <span> {route.providerName}{route.keyLast4 ? ` · ••••${route.keyLast4}` : ""}</span>
        {!route.active && <span className="badge revoked" style={{ marginLeft: 6 }}>Unavailable</span>}
      </div>
      <div className="route-pair-actions">
        <button type="button" className="secondary" onClick={onTest} disabled={testing || !route.active} title="Sends a tiny real request and may use a few upstream tokens">
          {testing ? "Testing…" : "Smoke test"}
        </button>
        <button type="button" className="secondary" onClick={onPrimary} disabled={!route.active || route.priority === 1}>Make primary</button>
      </div>
      {summary && <small style={{ color: summary.ok ? "#7ee787" : "#ff8080" }}>{summary.text}</small>}
      <small className="route-model-id">Upstream: {route.upstreamModelId}</small>
    </div>
  );
}

function ModelSection({ title, description, models, tests, testingPair, onTest, onPrimary }: {
  title: string;
  description: string;
  models: SmartRoutingModelDto[];
  tests: Record<string, ProviderModelTestResultDto>;
  testingPair: string | null;
  onTest: (model: SmartRoutingModelDto, route: SmartRouteDto) => void;
  onPrimary: (model: SmartRoutingModelDto, route: SmartRouteDto) => void;
}) {
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <p style={{ color: "#9aa4b2", marginTop: -6 }}>{description}</p>
      <table className="smart-routing-table">
        <thead><tr><th>Model</th><th>Protocol</th><th>Key pairing and failover order</th></tr></thead>
        <tbody>
          {models.map((model) => (
            <tr key={model.modelId}>
              <td>
                <strong>{model.displayName}</strong>
                <small className="route-model-id">{model.modelId}</small>
                {!model.active && <span className="badge revoked">Disabled</span>}
              </td>
              <td><span className="badge active">{model.standard}</span></td>
              <td>
                {model.routes.length === 0
                  ? <span style={{ color: "#9aa4b2" }}>No compatible active key found. Run Smart sync after adding/syncing keys.</span>
                  : model.routes.map((route) => {
                    const id = `${model.modelId}:${route.providerId}`;
                    return <Pair key={route.routeId} route={route} model={model} result={tests[id]} testing={testingPair === id}
                      onTest={() => onTest(model, route)} onPrimary={() => onPrimary(model, route)} />;
                  })}
              </td>
            </tr>
          ))}
          {models.length === 0 && <tr><td colSpan={3} style={{ color: "#9aa4b2" }}>No models in this group yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

export default function RouterPage() {
  const [models, setModels] = useState<SmartRoutingModelDto[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [testingPair, setTestingPair] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, ProviderModelTestResultDto>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setModels(await api.getSmartRouting());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load smart routing");
    }
  };
  useEffect(() => { void load(); }, []);

  const groups = useMemo(() => ({
    anthropic: models.filter((model) => groupFor(model) === "anthropic"),
    openai: models.filter((model) => groupFor(model) === "openai"),
    china: models.filter((model) => groupFor(model) === "china"),
    other: models.filter((model) => groupFor(model) === "other"),
  }), [models]);

  const smartSync = async () => {
    setSyncing(true); setError(null); setMessage(null);
    try {
      const result = await api.syncSmartRouting();
      setMessage(`Synced ${result.keys.keyCount} keys and ${result.models.availableModelCount} live models. ${result.routes.addedRouteCount} new routes were paired; ${result.routes.deactivatedRouteCount} unavailable routes were disabled.`);
      setTests({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Smart sync failed");
    } finally { setSyncing(false); }
  };

  const smokeTest = async (model: SmartRoutingModelDto, route: SmartRouteDto) => {
    const id = `${model.modelId}:${route.providerId}`;
    setTestingPair(id); setError(null);
    try {
      const result = await api.testProviderModel(route.providerId, model.modelId);
      setTests((current) => ({ ...current, [id]: result }));
    } catch (err) {
      setError(`${model.displayName} on ${route.providerName}: ${err instanceof Error ? err.message : "Smoke test failed"}`);
    } finally { setTestingPair(null); }
  };

  const makePrimary = async (model: SmartRoutingModelDto, route: SmartRouteDto) => {
    setError(null);
    try {
      const ordered = [route, ...model.routes.filter((candidate) => candidate.providerId !== route.providerId)]
        .map((candidate) => candidate.providerId);
      await api.setModelRoutePriority(model.modelId, ordered);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update key priority");
    }
  };

  return (
    <div>
      <div className="smart-routing-header">
        <div>
          <h2>Smart Routing</h2>
          <p>Sync keys once. The dashboard discovers every available model, pairs it to compatible keys, and appends new keys as backups without replacing your chosen primary.</p>
        </div>
        <button type="button" onClick={smartSync} disabled={syncing}>{syncing ? "Syncing keys, models & routes…" : "Smart sync SubRouter"}</button>
      </div>
      <p style={{ color: "#9aa4b2", fontSize: 13 }}>Smoke tests send a tiny real request and show the observed latency. They can use a small number of upstream tokens.</p>
      {error && <p style={{ color: "#ff8080" }}>{error}</p>}
      {message && <p style={{ color: "#7ee787" }}>{message}</p>}

      <ModelSection title="Anthropic models" description="Priority and backup keys for Claude-family models." models={groups.anthropic} tests={tests} testingPair={testingPair} onTest={smokeTest} onPrimary={makePrimary} />
      <ModelSection title="OpenAI models" description="Priority and backup keys for GPT and OpenAI-family models." models={groups.openai} tests={tests} testingPair={testingPair} onTest={smokeTest} onPrimary={makePrimary} />
      <ModelSection title="Other & China models" description="DeepSeek, Qwen, GLM, Kimi, MiniMax and every remaining synced model." models={[...groups.china, ...groups.other]} tests={tests} testingPair={testingPair} onTest={smokeTest} onPrimary={makePrimary} />
    </div>
  );
}
