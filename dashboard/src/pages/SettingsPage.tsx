import { useEffect, useState, type FormEvent } from "react";
import { api, type SettingsDto } from "../api/client.js";

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [subrouterApiKey, setSubrouterApiKey] = useState("");
  const [subrouterBaseUrl, setSubrouterBaseUrl] = useState("");
  const [keyPrefix, setKeyPrefix] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api.getSettings().then((s) => {
      setSettings(s);
      setSubrouterBaseUrl(s.subrouterBaseUrl ?? "");
      setKeyPrefix(s.keyPrefix);
    });

  useEffect(() => { load(); }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      const body: { subrouterApiKey?: string; subrouterBaseUrl?: string; keyPrefix?: string } = {
        subrouterBaseUrl,
        keyPrefix,
      };
      if (subrouterApiKey) body.subrouterApiKey = subrouterApiKey;
      const updated = await api.updateSettings(body);
      setSettings(updated);
      setSubrouterApiKey("");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
  };

  if (!settings) return <p>Loading…</p>;

  return (
    <div>
      <h2>Settings</h2>
      <p style={{ color: "#9aa4b2" }}>
        Configure your upstream subrouter key here instead of as a Railway env var. This is the only
        place it lives — never shown again in plaintext after saving.
      </p>

      <form onSubmit={save} className="card">
        <div className="form-row">
          <label>Subrouter API key</label>
          <input
            type="password"
            placeholder={settings.subrouterApiKeyMasked ?? "sk-..."}
            value={subrouterApiKey}
            onChange={(e) => setSubrouterApiKey(e.target.value)}
          />
          <span style={{ color: "#9aa4b2", fontSize: 12 }}>
            {settings.subrouterConfigured ? `Currently set: ${settings.subrouterApiKeyMasked}` : "Not configured yet"}
          </span>
        </div>
        <div className="form-row">
          <label>Subrouter base URL</label>
          <input value={subrouterBaseUrl} onChange={(e) => setSubrouterBaseUrl(e.target.value)} placeholder="https://ai.orbitlink.me" required />
        </div>
        <div className="form-row">
          <label>Issued-key prefix</label>
          <input value={keyPrefix} onChange={(e) => setKeyPrefix(e.target.value)} required />
          <span style={{ color: "#9aa4b2", fontSize: 12 }}>Client keys look like sk-{keyPrefix}-...</span>
        </div>
        {error && <p style={{ color: "#ff8080" }}>{error}</p>}
        {saved && <p style={{ color: "#7ee787" }}>Saved.</p>}
        <button type="submit">Save</button>
      </form>
    </div>
  );
}
