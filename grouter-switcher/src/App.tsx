import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage, StatusResult, BalanceResult, VerifyResult } from "./api";

type Screen = "loading" | "welcome" | "recover" | "saveRecovery" | "switcher";

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [error, setError] = useState<string | null>(null);

  // Onboarding form state
  const [username, setUsername] = useState("");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryPasswordConfirm, setRecoveryPasswordConfirm] = useState("");
  const [recoverInput, setRecoverInput] = useState("");
  const [savedRecoveryPassword, setSavedRecoveryPassword] = useState("");
  const [confirmedSaved, setConfirmedSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Switcher screen state
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [balance, setBalance] = useState<BalanceResult | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [anthropicModel, setAnthropicModel] = useState("");
  const [openAiModel, setOpenAiModel] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [togglingClaude, setTogglingClaude] = useState(false);
  const [togglingCodex, setTogglingCodex] = useState(false);
  const [showRestartReminder, setShowRestartReminder] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, []);

  async function bootstrap() {
    try {
      const hasKey = await api.hasLocalKey();
      if (hasKey) {
        await loadSwitcher();
      } else {
        setScreen("welcome");
      }
    } catch (err) {
      setError(errorMessage(err));
      setScreen("welcome");
    }
  }

  async function loadSwitcher() {
    const [statusResult, balanceResult] = await Promise.all([
      api.getStatus(),
      api.getBalance().catch(() => null),
    ]);
    setStatus(statusResult);
    setBalance(balanceResult);
    setBaseUrl(statusResult.baseUrl);
    setAnthropicModel(statusResult.selectedAnthropicModel ?? "");
    setOpenAiModel(statusResult.selectedOpenAiModel ?? "");
    setScreen("switcher");
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
      await loadSwitcher();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleContinueFromSave() {
    setError(null);
    try {
      await loadSwitcher();
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

  async function handleToggleClaude(on: boolean) {
    setError(null);
    setTogglingClaude(true);
    try {
      await persistConfig(anthropicModel, openAiModel);
      await api.toggleClaude(on);
      await loadSwitcher();
      setShowRestartReminder(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setTogglingClaude(false);
    }
  }

  async function handleToggleCodex(on: boolean) {
    setError(null);
    if (on && !openAiModel) {
      setError("Select a Codex model before turning it on");
      return;
    }
    setTogglingCodex(true);
    try {
      await persistConfig(anthropicModel, openAiModel);
      await api.toggleCodex(on);
      await loadSwitcher();
      setShowRestartReminder(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setTogglingCodex(false);
    }
  }

  async function handleSaveAdvanced() {
    setError(null);
    try {
      await persistConfig(anthropicModel, openAiModel);
      await loadSwitcher();
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

  // screen === "switcher"
  return (
    <div className="app">
      <h1>grouter Switcher</h1>
      {error && <div className="error">{error}</div>}

      <div className="account-row">
        <span>{balance?.username ?? ""}</span>
        <span>
          {balance?.unlimited ? "Unlimited" : balance ? `$${((balance.balanceCents ?? 0) / 100).toFixed(2)} left` : "--"}
        </span>
      </div>

      <button onClick={handleVerify} disabled={verifying}>
        {verifying ? "Verifying..." : "Verify key"}
      </button>
      {verifyResult && (
        <p className="hint">
          Key valid -- {verifyResult.anthropicModels.length} Anthropic models, {verifyResult.openAiModels.length} OpenAI
          models
        </p>
      )}

      <div className="tool-row">
        <div className="tool-header">
          <span>Claude Code</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={status?.claude.enabled ?? false}
              disabled={togglingClaude}
              onChange={(e) => handleToggleClaude(e.target.checked)}
            />
            <span>{status?.claude.enabled ? "ON" : "OFF"}</span>
          </label>
        </div>
        {status?.claude.drifted && <div className="drift-banner">Config drifted from what grouter last set -- re-toggle to re-apply.</div>}
        <select value={anthropicModel} onChange={(e) => setAnthropicModel(e.target.value)}>
          <option value="">(optional) default model</option>
          {verifyResult?.anthropicModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
      </div>

      <div className="tool-row">
        <div className="tool-header">
          <span>Codex (CLI + desktop)</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={status?.codex.enabled ?? false}
              disabled={togglingCodex || !openAiModel}
              onChange={(e) => handleToggleCodex(e.target.checked)}
            />
            <span>{status?.codex.enabled ? "ON" : "OFF"}</span>
          </label>
        </div>
        {status?.codex.drifted && <div className="drift-banner">Config drifted from what grouter last set -- re-toggle to re-apply.</div>}
        <select value={openAiModel} onChange={(e) => setOpenAiModel(e.target.value)}>
          <option value="">Select a model (required)</option>
          {verifyResult?.openAiModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
      </div>

      {showRestartReminder && <div className="hint">Restart Claude Code / Codex (or reload the IDE window) to pick up the change.</div>}

      <button className="link" onClick={() => setShowAdvanced(!showAdvanced)}>
        {showAdvanced ? "Hide" : "Show"} Advanced
      </button>
      {showAdvanced && (
        <div className="advanced">
          <label>
            Server URL
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
          <button onClick={handleSaveAdvanced}>Save</button>
          <div className="advanced-actions">
            <button onClick={() => api.openConfigDir("claude")}>Open ~/.claude</button>
            <button onClick={() => api.openConfigDir("codex")}>Open ~/.codex</button>
          </div>
        </div>
      )}
    </div>
  );
}
