import { useEffect, useRef, useState } from "react";
import { api, errorMessage, listenToolLog, ModelInfo, ToolId, ToolInstallStatus, ToolMode, ToolStatus } from "./api";

interface ToolCardProps {
  id: ToolId;
  label: string;
  description: string;
  install: ToolInstallStatus | undefined;
  status: ToolStatus | undefined;
  models: ModelInfo[];
  selectedModel: string;
  onModelChange: (value: string) => void;
  modelRequired: boolean;
  configurationOnly?: boolean;
  toggling: boolean;
  onModeChange: (mode: ToolMode) => void;
  onInstallOrUpdateFinished: () => void;
}

export function ToolCard({
  id,
  label,
  description,
  install,
  status,
  models,
  selectedModel,
  onModelChange,
  modelRequired,
  configurationOnly = false,
  toggling,
  onModeChange,
  onInstallOrUpdateFinished,
}: ToolCardProps) {
  const [running, setRunning] = useState<"install" | "update" | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (logOpen) logEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [logLines, logOpen]);

  async function run(kind: "install" | "update") {
    setRunning(kind);
    setLogLines([]);
    setLogOpen(true);
    setResult(null);
    const stop = await listenToolLog(
      id,
      (line) => setLogLines((prev) => [...prev, line]),
      ({ success }) => {
        stop();
        setRunning(null);
        setResult({
          success,
          message: success ? `${kind === "install" ? "Installed" : "Updated"} successfully` : "Failed -- see log below",
        });
        onInstallOrUpdateFinished();
      },
    );
    try {
      if (kind === "install") await api.installTool(id);
      else await api.updateTool(id);
    } catch (err) {
      stop();
      setRunning(null);
      setResult({ success: false, message: errorMessage(err) });
    }
  }

  const cliInstalled = install?.installed ?? false;
  const configurationReady = configurationOnly || cliInstalled;
  const updateAvailable = Boolean(
    cliInstalled && install?.latestVersion && install?.version && install.latestVersion !== install.version,
  );
  const mode: ToolMode = !status?.enabled ? "official" : status.smart ? "smart" : "grouter";

  return (
    <div className="tool-card">
      <div className="tool-card-head">
        <div>
          <div className="tool-card-title">{label}</div>
          <div className="tool-card-desc">{description}</div>
        </div>
        {configurationOnly && !cliInstalled ? (
          <span className="pill pill-ok">Shared config target</span>
        ) : cliInstalled ? (
          <span className={`pill ${updateAvailable ? "pill-warn" : "pill-ok"}`}>
            {updateAvailable ? `Update available: v${install!.version} → v${install!.latestVersion}` : `Installed v${install?.version ?? "?"}`}
          </span>
        ) : (
          <span className="pill pill-off">Not installed</span>
        )}
      </div>

      <div className="tool-card-actions">
        {!cliInstalled && !configurationOnly && (
          <button onClick={() => run("install")} disabled={running !== null}>
            {running === "install" ? "Installing..." : "Install"}
          </button>
        )}
        {cliInstalled && updateAvailable && (
          <button onClick={() => run("update")} disabled={running !== null}>
            {running === "update" ? "Updating..." : "Update"}
          </button>
        )}
        {logLines.length > 0 && (
          <button className="link" onClick={() => setLogOpen((v) => !v)}>
            {logOpen ? "Hide log" : "Show log"}
          </button>
        )}
      </div>

      {result && <div className={result.success ? "hint" : "error"}>{result.message}</div>}
      {logOpen && logLines.length > 0 && (
        <pre className="tool-log">
          {logLines.join("\n")}
          <div ref={logEndRef} />
        </pre>
      )}

      <div className="tool-card-provider">
        <select value={mode} disabled={toggling || !configurationReady} onChange={(e) => onModeChange(e.target.value as ToolMode)}>
          <option value="official">Using official</option>
          <option value="grouter">GROUTER API (BYOK)</option>
          <option value="smart">GROUTER Smart-Router (BYOK)</option>
        </select>
        {configurationOnly && (
          <p className="hint">
            All verified OpenAI models use the same GROUTER provider. This selection only sets the default for the next Codex session; changing it re-applies the config automatically.
          </p>
        )}
        {status?.drifted && (
          <div className="drift-banner">Config drifted from what grouter last set -- re-toggle to re-apply.</div>
        )}
        <select value={selectedModel} onChange={(e) => onModelChange(e.target.value)} disabled={!configurationReady}>
          <option value="">{modelRequired ? "Select a model (required)" : "(optional) default model"}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
        {mode === "smart" && !modelRequired && (
          <p className="hint">Smart-Router picks the model per request -- any pin above is ignored.</p>
        )}
      </div>
    </div>
  );
}
