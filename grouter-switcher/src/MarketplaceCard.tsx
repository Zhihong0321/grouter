import { useEffect, useRef, useState } from "react";
import { api, errorMessage, listenMarketplaceLog, InstallState, MarketplaceAgent, MarketplaceEntryInfo } from "./api";

const AGENT_LABEL: Record<MarketplaceAgent, string> = { claude: "Claude Code", codex: "Codex" };

function StatePill({ state }: { state: InstallState }) {
  switch (state) {
    case "installed":
      return <span className="pill pill-ok">Installed</span>;
    case "marketplace_added":
      return <span className="pill pill-warn">Marketplace added -- plugin unconfirmed</span>;
    case "not_installed":
      return <span className="pill pill-off">Not installed</span>;
    default:
      return null;
  }
}

function AgentInstallRow({
  entryId,
  agent,
  state,
  onInstalled,
}: {
  entryId: string;
  agent: MarketplaceAgent;
  state: InstallState;
  onInstalled: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (logOpen) logEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [logLines, logOpen]);

  useEffect(() => {
    if (!running) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  async function run() {
    setRunning(true);
    setLogLines([]);
    setLogOpen(true);
    setResult(null);
    setElapsedSeconds(0);
    const stop = await listenMarketplaceLog(
      entryId,
      agent,
      (line) => setLogLines((prev) => [...prev, line]),
      ({ success, exitCode }) => {
        stop();
        setRunning(false);
        setResult({
          success,
          message: success
            ? "Installed successfully"
            : exitCode != null
              ? `Failed (exit code ${exitCode}) -- see log below`
              : "Failed -- see log below",
        });
        onInstalled();
      },
    );
    try {
      await api.installMarketplaceEntry(entryId, agent);
    } catch (err) {
      stop();
      setRunning(false);
      setResult({ success: false, message: errorMessage(err) });
    }
  }

  return (
    <div className="marketplace-agent-row">
      <div className="marketplace-agent-head">
        <span className="marketplace-agent-label">{AGENT_LABEL[agent]}</span>
        <StatePill state={state} />
      </div>
      <div className="tool-card-actions">
        <button className="btn-secondary" onClick={() => void run()} disabled={running}>
          {running ? "Installing..." : state === "installed" ? "Reinstall / Update" : "Install"}
        </button>
        {(running || logLines.length > 0) && (
          <button className="btn-link btn-link-inline" onClick={() => setLogOpen((v) => !v)}>
            {logOpen ? "Hide details" : "Show details"}
          </button>
        )}
      </div>
      {running && (
        <div className="marketplace-progress" role="status" aria-live="polite">
          <span className="marketplace-progress-dot" />
          <span>Install in progress ({elapsedSeconds}s)</span>
          <span className="marketplace-progress-detail">{logLines.at(-1) ?? "Starting installer..."}</span>
        </div>
      )}
      {result && <div className={result.success ? "hint" : "error"}>{result.message}</div>}
      {logOpen && (
        <pre className="tool-log">
          {logLines.length > 0 ? logLines.join("\n") : "Waiting for installer output..."}
          <div ref={logEndRef} />
        </pre>
      )}
    </div>
  );
}

interface MarketplaceCardProps {
  entry: MarketplaceEntryInfo;
  claudeState: InstallState;
  codexState: InstallState;
  onInstalled: () => void;
}

export function MarketplaceCard({ entry, claudeState, codexState, onInstalled }: MarketplaceCardProps) {
  const availableAgents: MarketplaceAgent[] = [
    ...(entry.claudeSupported ? (["claude"] as const) : []),
    ...(entry.codexSupported ? (["codex"] as const) : []),
  ];
  const [selectedAgent, setSelectedAgent] = useState<MarketplaceAgent>(availableAgents[0] ?? "claude");
  const showPicker = availableAgents.length > 1;
  const activeState = selectedAgent === "claude" ? claudeState : codexState;

  return (
    <div className="tool-card">
      <div className="tool-card-head">
        <div>
          <div className="tool-card-title">{entry.label}</div>
          <div className="tool-card-desc">{entry.description}</div>
          <button className="btn-link marketplace-source-link" onClick={() => void api.openExternal(entry.sourceUrl)}>
            {entry.sourceUrl.replace(/^https:\/\//, "")}
          </button>
        </div>
        <div className="marketplace-platform-badges">
          <span className={`pill ${entry.windows ? "pill-ok" : "pill-off"}`}>{entry.windows ? "Windows" : "No Windows"}</span>
          <span className={`pill ${entry.mac ? "pill-ok" : "pill-off"}`}>{entry.mac ? "Mac" : "No Mac"}</span>
        </div>
      </div>

      <div className="marketplace-agents">
        {showPicker && (
          <div className="seg-row" style={{ alignSelf: "flex-start", width: "auto" }}>
            {availableAgents.map((a) => (
              <button
                key={a}
                className={selectedAgent === a ? "seg-btn seg-btn-auto active" : "seg-btn seg-btn-auto"}
                onClick={() => setSelectedAgent(a)}
              >
                {AGENT_LABEL[a]}
              </button>
            ))}
          </div>
        )}
        {availableAgents.length > 0 && (
          <AgentInstallRow key={selectedAgent} entryId={entry.id} agent={selectedAgent} state={activeState} onInstalled={onInstalled} />
        )}
        {!entry.codexSupported && entry.codexNote && <p className="hint">{entry.codexNote}</p>}
      </div>
    </div>
  );
}
