import { useEffect, useState, type FormEvent } from "react";
import {
  api,
  errorMessage,
  StatusResult,
  BalanceResult,
  VerifyResult,
  UsageResult,
  InstallStatusResult,
  ToolId,
  ToolMode,
} from "./api";
import { ToolCard } from "./ToolCard";

type Screen = "loading" | "welcome" | "recover" | "saveRecovery" | "main";
type Tab = "tools" | "usage" | "settings";

const TOOLS: { id: ToolId; label: string; description: string; modelKind: "anthropic" | "openai" }[] = [
  { id: "claude", label: "Claude Code CLI", description: "Anthropic's coding agent CLI", modelKind: "anthropic" },
  {
    id: "codex",
    label: "Codex Desktop App + CLI",
    description: "GROUTER BYOK for Codex Desktop, CLI, and IDE (shared config)",
    modelKind: "openai",
  },
  { id: "opencode", label: "OpenCode", description: "Open-source terminal coding agent", modelKind: "openai" },
];

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [activeTab, setActiveTab] = useState<Tab>("tools");
  const [error, setError] = useState<string | null>(null);

  // Onboarding form state
  const [username, setUsername] = useState("");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryPasswordConfirm, setRecoveryPasswordConfirm] = useState("");
  const [recoverInput, setRecoverInput] = useState("");
  const [savedRecoveryPassword, setSavedRecoveryPassword] = useState("");
  const [confirmedSaved, setConfirmedSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Main screen state
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [balance, setBalance] = useState<BalanceResult | null>(null);
  const [installStatus, setInstallStatus] = useState<InstallStatusResult | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [anthropicModel, setAnthropicModel] = useState("");
  const [openAiModel, setOpenAiModel] = useState("");
  const [togglingTool, setTogglingTool] = useState<ToolId | null>(null);
  const [showRestartReminder, setShowRestartReminder] = useState(false);

  // Usage tab state
  const [usage, setUsage] = useState<UsageResult | null>(null);
  const [usageRange, setUsageRange] = useState<"7d" | "30d">("30d");
  const [loadingUsage, setLoadingUsage] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, []);

  async function bootstrap() {
    try {
      const hasKey = await api.hasLocalKey();
      if (hasKey) {
        await loadMain();
      } else {
        setScreen("welcome");
      }
    } catch (err) {
      setError(errorMessage(err));
      setScreen("welcome");
    }
  }

  async function loadMain() {
    const [statusResult, balanceResult] = await Promise.all([
      api.getStatus(),
      api.getBalance().catch(() => null),
    ]);
    setStatus(statusResult);
    setBalance(balanceResult);
    setBaseUrl(statusResult.baseUrl);
    setAnthropicModel(statusResult.selectedAnthropicModel ?? "");
    setOpenAiModel(statusResult.selectedOpenAiModel ?? "");
    setScreen("main");
    void loadInstallStatus();
  }

  async function loadInstallStatus() {
    try {
      setInstallStatus(await api.detectInstallations());
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleApply(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (username.trim().length < 2) {
      setError("Username must be at least 2 characters");
      return;
    }
    if (recoveryPassword.length < 10) {
      setError("Recovery password must be at least 10 characters -- you'll need it to restore your key later");
      return;
    }
    if (recoveryPassword !== recoveryPasswordConfirm) {
      setError("Recovery passwords don't match");
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.applyForKey(username.trim(), recoveryPassword);
      setSavedRecoveryPassword(result.recoveryPassword ?? recoveryPassword);
      setScreen("saveRecovery");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRecover(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (recoverInput.length < 10) {
      setError("Enter your recovery password");
      return;
    }
    setSubmitting(true);
    try {
      await api.recoverAccount(recoverInput);
      await loadMain();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleContinueFromSave() {
    setError(null);
    try {
      await loadMain();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleVerify() {
    setError(null);
    setVerifying(true);
    try {
      const result = await api.verifyStoredKey();
      setVerifyResult(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setVerifying(false);
    }
  }

  async function persistConfig(nextAnthropicModel: string, nextOpenAiModel: string) {
    await api.setConfig(baseUrl, nextAnthropicModel || undefined, nextOpenAiModel || undefined);
  }

  async function handleModelChange(tool: ToolId, value: string) {
    if (tool === "claude") {
      setAnthropicModel(value);
      return;
    }

    setOpenAiModel(value);
    if (tool !== "codex" || !value || !status?.codex.enabled) return;

    setError(null);
    setTogglingTool("codex");
    try {
      await persistConfig(anthropicModel, value);
      await api.toggleCodex(status.codex.smart ? "smart" : "grouter");
      await loadMain();
      setShowRestartReminder(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setTogglingTool(null);
    }
  }

  async function handleModeChange(tool: ToolId, mode: ToolMode) {
    setError(null);
    if (mode !== "official" && tool === "opencode" && !openAiModel) {
      setError("Select a model before turning OpenCode on");
      return;
    }
    setTogglingTool(tool);
    try {
      await persistConfig(anthropicModel, openAiModel);
      if (tool === "claude") await api.toggleClaude(mode);
      else if (tool === "codex") await api.toggleCodex(mode);
      else await api.toggleOpencode(mode);
      await loadMain();
      setShowRestartReminder(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setTogglingTool(null);
    }
  }

  async function loadUsage(range: "7d" | "30d") {
    setError(null);
    setLoadingUsage(true);
    try {
      const result = await api.getUsage(range);
      setUsage(result);
      setUsageRange(range);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingUsage(false);
    }
  }

  function openTab(tab: Tab) {
    setActiveTab(tab);
    if (tab === "usage" && !usage) void loadUsage(usageRange);
  }

  async function handleSaveSettings() {
    setError(null);
    try {
      await persistConfig(anthropicModel, openAiModel);
      await loadMain();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (screen === "loading") {
    return (
      <div className="app centered">
        <p>Loading...</p>
      </div>
    );
  }

  if (screen === "welcome") {
    return (
      <div className="app">
        <h1>grouter Switcher</h1>
        {error && <div className="error">{error}</div>}
        <form onSubmit={handleApply} className="form">
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. alex" />
          </label>
          <label>
            Recovery password
            <input
              type="password"
              value={recoveryPassword}
              onChange={(e) => setRecoveryPassword(e.target.value)}
              placeholder="At least 10 characters"
            />
          </label>
          <label>
            Confirm recovery password
            <input
              type="password"
              value={recoveryPasswordConfirm}
              onChange={(e) => setRecoveryPasswordConfirm(e.target.value)}
            />
          </label>
          <p className="hint">
            This password is the only way to restore your key on a new machine. There's no email recovery -- pick
            something you'll remember.
          </p>
          <button type="submit" disabled={submitting}>
            {submitting ? "Applying..." : "Apply for a KEY"}
          </button>
        </form>
        <button className="link" onClick={() => setScreen("recover")}>
          Already have an account? Recover it
        </button>
      </div>
    );
  }

  if (screen === "recover") {
    return (
      <div className="app">
        <h1>Recover your account</h1>
        {error && <div className="error">{error}</div>}
        <form onSubmit={handleRecover} className="form">
          <label>
            Recovery password
            <input type="password" value={recoverInput} onChange={(e) => setRecoverInput(e.target.value)} />
          </label>
          <button type="submit" disabled={submitting}>
            {submitting ? "Recovering..." : "Recover"}
          </button>
        </form>
        <button className="link" onClick={() => setScreen("welcome")}>
          Back
        </button>
      </div>
    );
  }

  if (screen === "saveRecovery") {
    return (
      <div className="app">
        <h1>Save your recovery password</h1>
        <p className="hint">
          Write this down somewhere safe. It's the only way to restore your key if you reinstall or switch machines.
        </p>
        <code className="recovery-password">{savedRecoveryPassword}</code>
        <label className="checkbox">
          <input type="checkbox" checked={confirmedSaved} onChange={(e) => setConfirmedSaved(e.target.checked)} />
          I saved it
        </label>
        <button disabled={!confirmedSaved} onClick={handleContinueFromSave}>
          Continue
        </button>
      </div>
    );
  }

  // screen === "main"
  const totalTokens =
    (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) + (usage?.cacheCreationInputTokens ?? 0) + (usage?.cacheReadInputTokens ?? 0);

  return (
    <div className="app">
      <div className="app-header">
        <h1>grouter Switcher</h1>
        <div className="account-row">
          <span>{balance?.username ?? ""}</span>
          <span>
            {balance?.unlimited ? "Unlimited" : balance ? `$${((balance.balanceCents ?? 0) / 100).toFixed(2)} left` : "--"}
          </span>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="tabs">
        <button className={activeTab === "tools" ? "tab tab-active" : "tab"} onClick={() => openTab("tools")}>
          Tools
        </button>
        <button className={activeTab === "usage" ? "tab tab-active" : "tab"} onClick={() => openTab("usage")}>
          Usage
        </button>
        <button className={activeTab === "settings" ? "tab tab-active" : "tab"} onClick={() => openTab("settings")}>
          Settings
        </button>
      </div>

      {activeTab === "tools" && (
        <div className="tab-panel">
          <div className="verify-row">
            <button onClick={handleVerify} disabled={verifying}>
              {verifying ? "Verifying..." : "Verify key"}
            </button>
            {verifyResult && (
              <p className="hint">
                Key valid -- {verifyResult.anthropicModels.length} Anthropic models, {verifyResult.openAiModels.length}{" "}
                OpenAI models
              </p>
            )}
          </div>

          {showRestartReminder && (
            <div className="hint">Restart Codex Desktop/CLI (or reload the IDE window) to pick up the GROUTER BYOK change.</div>
          )}

          {TOOLS.map((tool) => (
            <ToolCard
              key={tool.id}
              id={tool.id}
              label={tool.label}
              description={tool.description}
              install={installStatus?.[tool.id]}
              status={status?.[tool.id]}
              models={tool.modelKind === "anthropic" ? verifyResult?.anthropicModels ?? [] : verifyResult?.openAiModels ?? []}
              selectedModel={tool.modelKind === "anthropic" ? anthropicModel : openAiModel}
              onModelChange={(value) => void handleModelChange(tool.id, value)}
              modelRequired={tool.id === "opencode"}
              configurationOnly={tool.id === "codex"}
              toggling={togglingTool === tool.id}
              onModeChange={(mode) => void handleModeChange(tool.id, mode)}
              onInstallOrUpdateFinished={() => void loadInstallStatus()}
            />
          ))}
        </div>
      )}

      {activeTab === "usage" && (
        <div className="tab-panel">
          <div className="usage-range">
            <button className={usageRange === "7d" ? "" : "link"} onClick={() => loadUsage("7d")} disabled={loadingUsage}>
              7 days
            </button>
            <button className={usageRange === "30d" ? "" : "link"} onClick={() => loadUsage("30d")} disabled={loadingUsage}>
              30 days
            </button>
          </div>

          {loadingUsage && <p className="hint">Loading...</p>}

          {usage && !loadingUsage && (
            <>
              <div className="usage-summary">
                <div>
                  <span className="usage-summary-value">{usage.requestCount}</span>
                  <span className="usage-summary-label">requests</span>
                </div>
                <div>
                  <span className="usage-summary-value">${(usage.costCents / 100).toFixed(2)}</span>
                  <span className="usage-summary-label">spent</span>
                </div>
                <div>
                  <span className="usage-summary-value">{totalTokens.toLocaleString()}</span>
                  <span className="usage-summary-label">tokens</span>
                </div>
              </div>

              <div className="usage-table">
                <div className="usage-row usage-row-header">
                  <span>When</span>
                  <span>Model</span>
                  <span>Tokens</span>
                  <span>Cost</span>
                </div>
                {usage.recent.length === 0 && <p className="hint">No usage yet.</p>}
                {usage.recent.map((entry, i) => (
                  <div className="usage-row" key={i}>
                    <span>{new Date(entry.createdAt).toLocaleString()}</span>
                    <span>{entry.model}</span>
                    <span>
                      {(entry.inputTokens + entry.outputTokens + entry.cacheCreationInputTokens + entry.cacheReadInputTokens).toLocaleString()}
                    </span>
                    <span>${(entry.costCents / 100).toFixed(4)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "settings" && (
        <div className="tab-panel">
          <label>
            Server URL
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
          <button onClick={handleSaveSettings}>Save</button>
          <div className="advanced-actions">
            {TOOLS.map((tool) => (
              <button key={tool.id} onClick={() => api.openConfigDir(tool.id)}>
                Open {tool.label} config
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
