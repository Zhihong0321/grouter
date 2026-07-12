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
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (logOpen) logEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [logLines, logOpen]);

  async function run() {
    setRunning(true);
    setLogLines([]);
    setLogOpen(true);
    setResult(null);
    const stop = await listenMarketplaceLog(
      entryId,
      agent,
      (line) => setLogLines((prev) => [...prev, line]),
      ({ success }) => {
        stop();
        setRunning(false);
        setResult({ success, message: success ? "Installed successfully" : "Failed -- see log below" });
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
        <button onClick={() => void run()} disabled={running}>
          {running ? "Working..." : state === "installed" ? "Reinstall / Update" : "Install"}
        </button>
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
  return (
    <div className="tool-card">
      <div className="tool-card-head">
        <div>
          <div className="tool-card-title">{entry.label}</div>
          <div className="tool-card-desc">{entry.description}</div>
          <button className="link marketplace-source-link" onClick={() => void api.openExternal(entry.sourceUrl)}>
            {entry.sourceUrl.replace(/^https:\/\//, "")}
          </button>
        </div>
        <div className="marketplace-platform-badges">
          <span className={`pill ${entry.windows ? "pill-ok" : "pill-off"}`}>{entry.windows ? "Windows" : "No Windows"}</span>
          <span className={`pill ${entry.mac ? "pill-ok" : "pill-off"}`}>{entry.mac ? "Mac" : "No Mac"}</span>
        </div>
      </div>

      <div className="marketplace-agents">
        {entry.claudeSupported && <AgentInstallRow entryId={entry.id} agent="claude" state={claudeState} onInstalled={onInstalled} />}
        {entry.codexSupported && <AgentInstallRow entryId={entry.id} agent="codex" state={codexState} onInstalled={onInstalled} />}
        {!entry.codexSupported && entry.codexNote && <p className="hint">{entry.codexNote}</p>}
      </div>
    </div>
  );
}
