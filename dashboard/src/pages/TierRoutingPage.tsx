import { useEffect, useState } from "react";
import { api, centsToDollars, type TierConfigDto, type TierRoutingSavingsDto } from "../api/client.js";

// Global config for Smart Routing Mode (tier-based model selection). Not the
// same "Smart Routing" as the Router page -- that one manages provider
// failover, this one manages which tier (brain/build/routine) a request gets.
export default function TierRoutingPage() {
  const [config, setConfig] = useState<TierConfigDto | null>(null);
  const [savings, setSavings] = useState<TierRoutingSavingsDto[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [cfg, sav] = await Promise.all([api.getTierRoutingConfig(), api.getTierRoutingSavings()]);
    setConfig(cfg);
    setSavings(sav);
  };

  useEffect(() => { load(); }, []);

  if (!config) return <p>Loading…</p>;

  const save = async (
    patch: Partial<{
      brainModel: string;
      buildModel: string;
      routineModel: string;
      longContextTokens: number;
      shortTurnTokens: number;
      smallFastModelName: string;
      mode: "smart" | "honor_tier";
      honorExplicitRoutine: boolean;
    }>,
  ) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateTierRoutingConfig(patch);
      setConfig(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2>Smart Routing Mode</h2>
      <p style={{ color: "#9aa4b2" }}>
        Automatic per-request model-tier selection. When enabled on a key (see that key's detail page), the proxy
        picks the cheapest model that clears the task's quality bar instead of always serving the model the client
        asked for. This page controls the global tier→model map and thresholds used by every key with it enabled.
      </p>
      {error && <p style={{ color: "#ff8080" }}>{error}</p>}

      <div className="card">
        <h3>Tier → model map {saving && "(saving…)"}</h3>
        <div className="form-row">
          <label>Brain (best model)</label>
          <input defaultValue={config.tiers.brain} onBlur={(e) => e.target.value !== config.tiers.brain && save({ brainModel: e.target.value })} />
        </div>
        <div className="form-row">
          <label>Build (default coding turns)</label>
          <input defaultValue={config.tiers.build} onBlur={(e) => e.target.value !== config.tiers.build && save({ buildModel: e.target.value })} />
        </div>
        <div className="form-row">
          <label>Routine (cheapest)</label>
          <input defaultValue={config.tiers.routine} onBlur={(e) => e.target.value !== config.tiers.routine && save({ routineModel: e.target.value })} />
        </div>
      </div>

      <div className="card">
        <h3>Thresholds</h3>
        <div className="form-row">
          <label>Long-context tokens (always routes to brain above this)</label>
          <input type="number" defaultValue={config.longContextTokens} onBlur={(e) => save({ longContextTokens: Number(e.target.value) })} />
        </div>
        <div className="form-row">
          <label>Short-turn tokens (downgrades to routine below this, when tool-less)</label>
          <input type="number" defaultValue={config.shortTurnTokens} onBlur={(e) => save({ shortTurnTokens: Number(e.target.value) })} />
        </div>
        <div className="form-row">
          <label>Claude Code small-fast model name (background slot -- always routine)</label>
          <input defaultValue={config.smallFastModelName} onBlur={(e) => save({ smallFastModelName: e.target.value })} />
        </div>
        <div className="form-row">
          <label>Mode</label>
          <select value={config.mode} onChange={(e) => save({ mode: e.target.value as "smart" | "honor_tier" })}>
            <option value="smart">Smart -- run the full rule set</option>
            <option value="honor_tier">Honor tier -- global off-switch, always serve the requested tier</option>
          </select>
        </div>
        <div className="form-row" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            id="honor-explicit-routine"
            checked={config.honorExplicitRoutine}
            onChange={(e) => save({ honorExplicitRoutine: e.target.checked })}
          />
          <label htmlFor="honor-explicit-routine">
            Honor explicit routine tier (e.g. Codex low reasoning effort) even on long or tool-heavy turns
          </label>
        </div>
      </div>

      <div className="card">
        <h3>Realized savings</h3>
        <p style={{ color: "#9aa4b2" }}>Only counts requests where the engine actually swapped the model.</p>
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Overridden requests</th>
              <th>Baseline cost</th>
              <th>Saved</th>
            </tr>
          </thead>
          <tbody>
            {savings.map((row) => (
              <tr key={row.client ?? "unknown"}>
                <td>{row.client ?? "unknown"}</td>
                <td>{row.overridden_request_count}</td>
                <td>{centsToDollars(row.cost_baseline_cents)}</td>
                <td>{centsToDollars(row.cost_saved_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {savings.length === 0 && <p style={{ color: "#9aa4b2" }}>No overridden requests yet.</p>}
      </div>
    </div>
  );
}
