import { useEffect, useState, type FormEvent } from "react";
import {
  api,
  errorMessage,
  StatusResult,
  BalanceResult,
  VerifyResult,
  UsageResult,
  InstallStatusResult,
  MarketplaceEntryInfo,
  MarketplaceStatusResult,
  ToolId,
  ToolMode,
} from "./api";
import { ToolCard } from "./ToolCard";
import { MarketplaceCard } from "./MarketplaceCard";

type Screen = "loading" | "welcome" | "recover" | "saveRecovery" | "main";
type Tab = "tools" | "marketplace" | "usage" | "settings";
type Theme = "light" | "dark";

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

const TAB_META: Record<Tab, { label: string; title: string; sub: string }> = {
  tools: { label: "Tools", title: "Tools", sub: "Route Claude Code, Codex, and OpenCode through GROUTER." },
  marketplace: { label: "Marketplace", title: "Marketplace", sub: "Curated skills, agents, and plugins." },
  usage: { label: "Usage", title: "Usage", sub: "Requests, spend, and tokens across your account." },
  settings: { label: "Settings", title: "Settings", sub: "Server endpoint and configuration folders." },
};

const VIZ_VARS = ["--viz-1", "--viz-2", "--viz-3", "--viz-4"];

function fmtMoney(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [activeTab, setActiveTab] = useState<Tab>("tools");
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("grouter-theme") as Theme) || "dark");

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
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [configDirNote, setConfigDirNote] = useState<string | null>(null);

  // Usage tab state
  const [usage, setUsage] = useState<UsageResult | null>(null);
  const [usageRange, setUsageRange] = useState<"7d" | "30d">("30d");
  const [loadingUsage, setLoadingUsage] = useState(false);

  // Marketplace tab state
  const [marketplaceEntries, setMarketplaceEntries] = useState<MarketplaceEntryInfo[]>([]);
  const [marketplaceStatus, setMarketplaceStatus] = useState<MarketplaceStatusResult>({});
  const [loadingMarketplace, setLoadingMarketplace] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("grouter-theme", theme);
  }, [theme]);

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

  async function loadMarketplace() {
    setError(null);
    setLoadingMarketplace(true);
    try {
      const [entries, status] = await Promise.all([api.listMarketplaceEntries(), api.detectMarketplaceStatus()]);
      setMarketplaceEntries(entries);
      setMarketplaceStatus(status);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingMarketplace(false);
    }
  }

  function openTab(tab: Tab) {
    setActiveTab(tab);
    if (tab === "usage" && !usage) void loadUsage(usageRange);
    if (tab === "marketplace" && marketplaceEntries.length === 0) void loadMarketplace();
  }

  async function handleSaveSettings() {
    setError(null);
    try {
      await persistConfig(anthropicModel, openAiModel);
      await loadMain();
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function openConfigDir(tool: ToolId, label: string) {
    await api.openConfigDir(tool);
    setConfigDirNote(`Opened ${label} config folder.`);
    setTimeout(() => setConfigDirNote(null), 2500);
  }

  if (screen === "loading") {
    return (
      <div className="app-root onboard-wrap">
        <p className="hint">Loading...</p>
      </div>
    );
  }

  if (screen === "welcome" || screen === "recover" || screen === "saveRecovery") {
    return (
      <div className="app-root">
        <div className="onboard-wrap">
          <div className="onboard-card">
            {screen === "welcome" && (
              <>
                <div className="onboard-brand">grouter</div>
                <h1 className="onboard-title">Set up your key</h1>
                <p className="onboard-sub">
                  Apply for a GROUTER key to route Claude Code, Codex, and OpenCode through your account.
                </p>
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
                    This password is the only way to restore your key on a new machine. There's no email recovery --
                    pick something you'll remember.
                  </p>
                  <button type="submit" className="btn-primary" disabled={submitting}>
                    {submitting ? "Applying…" : "Apply for a KEY"}
                  </button>
                </form>
                <button className="btn-link" onClick={() => setScreen("recover")}>
                  Already have an account? Recover it
                </button>
              </>
            )}

            {screen === "recover" && (
              <>
                <div className="onboard-brand">grouter</div>
                <h1 className="onboard-title">Recover your account</h1>
                {error && <div className="error">{error}</div>}
                <form onSubmit={handleRecover} className="form">
                  <label>
                    Recovery password
                    <input type="password" value={recoverInput} onChange={(e) => setRecoverInput(e.target.value)} />
                  </label>
                  <button type="submit" className="btn-primary" disabled={submitting}>
                    {submitting ? "Recovering…" : "Recover"}
                  </button>
                </form>
                <button className="btn-link" onClick={() => setScreen("welcome")}>
                  Back
                </button>
              </>
            )}

            {screen === "saveRecovery" && (
              <>
                <div className="onboard-brand">grouter</div>
                <h1 className="onboard-title">Save your recovery password</h1>
                <p className="onboard-sub">
                  Write this down somewhere safe. It's the only way to restore your key if you reinstall or switch
                  machines.
                </p>
                <code className="recovery-password">{savedRecoveryPassword}</code>
                <label className="checkbox">
                  <input type="checkbox" checked={confirmedSaved} onChange={(e) => setConfirmedSaved(e.target.checked)} />
                  I saved it
                </label>
                <button className="btn-primary" disabled={!confirmedSaved} onClick={handleContinueFromSave}>
                  Continue
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // screen === "main"
  const totalTokens =
    (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) + (usage?.cacheCreationInputTokens ?? 0) + (usage?.cacheReadInputTokens ?? 0);

  const tokenParts = usage
    ? [
        { label: "Input", value: usage.inputTokens },
        { label: "Output", value: usage.outputTokens },
        { label: "Cache write", value: usage.cacheCreationInputTokens },
        { label: "Cache read", value: usage.cacheReadInputTokens },
      ]
    : [];

  const headerChipValue = balance
    ? balance.unlimited
      ? "Unlimited"
      : `${fmtMoney(balance.balanceCents ?? 0)} left`
    : "--";

  return (
    <div className="app-root">
      <div className="shell">
        <aside className="sidebar">
          <div>
            <div className="brand-row">
              <div className="brand-mark">
                <div className="brand-mark-inner" />
              </div>
              <div className="brand-text">grouter Switcher</div>
            </div>

            <nav className="nav-list">
              {(Object.keys(TAB_META) as Tab[]).map((tab) => (
                <button
                  key={tab}
                  className={activeTab === tab ? "nav-item active" : "nav-item"}
                  onClick={() => openTab(tab)}
                >
                  <span className="nav-item-bar" />
                  <span>{TAB_META[tab].label}</span>
                </button>
              ))}
            </nav>
          </div>

          <div className="sidebar-footer">
            <div className="seg-row">
              <button className={theme === "light" ? "seg-btn active" : "seg-btn"} onClick={() => setTheme("light")}>
                Light
              </button>
              <button className={theme === "dark" ? "seg-btn active" : "seg-btn"} onClick={() => setTheme("dark")}>
                Dark
              </button>
            </div>
            <div className="account-card">
              <div className="account-name-row">
                <span className="account-dot" />
                <span className="account-name">{balance?.username ?? ""}</span>
              </div>
              <div className="account-balance">
                {balance?.unlimited ? "Unlimited" : balance ? `${fmtMoney(balance.balanceCents ?? 0)} left` : "--"}
              </div>
            </div>
          </div>
        </aside>

        <main className="main">
          <header className="header">
            <div>
              <h1 className="page-title">{TAB_META[activeTab].title}</h1>
              <p className="page-sub">{TAB_META[activeTab].sub}</p>
            </div>
            <div className="header-chip">
              <span className="header-dot" />
              <div className="header-chip-text">
                <span className="header-chip-label">Connected</span>
                <span className="header-chip-value">{headerChipValue}</span>
              </div>
            </div>
          </header>

          {error && <div className="error error-main">{error}</div>}

          <div className="tab-scroll">
            {activeTab === "tools" && (
              <>
                <div className="verify-row">
                  <button className="btn-secondary" onClick={handleVerify} disabled={verifying}>
                    {verifying ? "Verifying…" : "Verify key"}
                  </button>
                  {verifyResult && (
                    <p className="hint verify-hint">
                      Key valid — {verifyResult.anthropicModels.length} Anthropic models,{" "}
                      {verifyResult.openAiModels.length} OpenAI models
                    </p>
                  )}
                </div>

                {showRestartReminder && (
                  <div className="info-banner">
                    Restart Codex Desktop/CLI (or reload the IDE window) to pick up the GROUTER BYOK change.
                  </div>
                )}

                <div className="card-grid">
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
              </>
            )}

            {activeTab === "marketplace" && (
              <>
                <p className="hint">
                  Curated skills, agents and plugins for Claude Code and Codex. Each install runs the project's own
                  documented command -- nothing here is invented.
                </p>
                {loadingMarketplace && <p className="hint">Loading...</p>}
                <div className="card-grid">
                  {marketplaceEntries.map((entry) => (
                    <MarketplaceCard
                      key={entry.id}
                      entry={entry}
                      claudeState={marketplaceStatus[entry.id]?.claude ?? "not_installed"}
                      codexState={marketplaceStatus[entry.id]?.codex ?? "unsupported"}
                      onInstalled={() => void loadMarketplace()}
                    />
                  ))}
                </div>
              </>
            )}

            {activeTab === "usage" && (
              <>
                <div className="usage-stats-row">
                  <div className="stat-card">
                    <div className="stat-value">{usage ? usage.requestCount.toLocaleString() : "--"}</div>
                    <div className="stat-label">requests</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value">{usage ? fmtMoney(usage.costCents) : "--"}</div>
                    <div className="stat-label">spent</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value">{usage ? totalTokens.toLocaleString() : "--"}</div>
                    <div className="stat-label">tokens</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value">{usage ? fmtMoney(usage.savedCents) : "--"}</div>
                    <div className="stat-label">
                      smart-router saved
                      {usage && usage.switchedCount > 0 ? ` (${usage.switchedCount.toLocaleString()} switched)` : ""}
                    </div>
                  </div>
                </div>

                <div className="token-card">
                  <div className="token-card-head">
                    <span className="eyebrow">Token mix</span>
                    <span className="token-total">{totalTokens.toLocaleString()} tokens</span>
                  </div>
                  <div className="token-bar">
                    {tokenParts.map((p, i) => {
                      const pct = totalTokens ? (p.value / totalTokens) * 100 : 0;
                      return (
                        <div
                          key={p.label}
                          className="token-bar-seg"
                          style={{ width: pct + "%", background: `var(${VIZ_VARS[i]})` }}
                        />
                      );
                    })}
                  </div>
                  <div className="token-legend">
                    {tokenParts.map((p, i) => (
                      <div className="legend-item" key={p.label}>
                        <span className="legend-dot" style={{ background: `var(${VIZ_VARS[i]})` }} />
                        <span className="legend-label">{p.label}</span>
                        <span className="legend-val">{p.value.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="seg-row" style={{ alignSelf: "flex-start", width: "auto" }}>
                  <button
                    className={usageRange === "7d" ? "seg-btn seg-btn-auto active" : "seg-btn seg-btn-auto"}
                    onClick={() => loadUsage("7d")}
                    disabled={loadingUsage}
                  >
                    7 days
                  </button>
                  <button
                    className={usageRange === "30d" ? "seg-btn seg-btn-auto active" : "seg-btn seg-btn-auto"}
                    onClick={() => loadUsage("30d")}
                    disabled={loadingUsage}
                  >
                    30 days
                  </button>
                </div>

                <div className="table">
                  <div className="table-row-header">
                    <span>When</span>
                    <span>Model</span>
                    <span>Tokens</span>
                    <span>Cost</span>
                  </div>
                  {usage?.recent.length === 0 && <p className="hint">No usage yet.</p>}
                  {usage?.recent.map((entry, i) => (
                    <div className="table-row" key={i}>
                      <span>{new Date(entry.createdAt).toLocaleString()}</span>
                      <span>{entry.model}</span>
                      <span>
                        {(
                          entry.inputTokens +
                          entry.outputTokens +
                          entry.cacheCreationInputTokens +
                          entry.cacheReadInputTokens
                        ).toLocaleString()}
                      </span>
                      <span>${(entry.costCents / 100).toFixed(4)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {activeTab === "settings" && (
              <>
                <div className="settings-card">
                  <label>
                    Server URL
                    <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                  </label>
                  <button className="btn-primary btn-primary-inline" onClick={handleSaveSettings}>
                    Save
                  </button>
                  {settingsSaved && <p className="hint">Saved.</p>}
                </div>

                <div className="settings-card">
                  <div className="settings-section-title">Configuration folders</div>
                  <div className="advanced-actions">
                    {TOOLS.map((tool) => (
                      <button
                        key={tool.id}
                        className="btn-secondary btn-secondary-full"
                        onClick={() => void openConfigDir(tool.id, tool.label)}
                      >
                        Open {tool.label} config
                      </button>
                    ))}
                  </div>
                  {configDirNote && <p className="hint">{configDirNote}</p>}
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
