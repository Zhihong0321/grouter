# Fix Smart Routing Mode — Remediation Plan

Follow-up to the code scan. Smart Routing's engine (`decideTier`) is correct and
well-tested for the **Anthropic** path, but the always-on redesign left the
feature dead on the **Codex/OpenAI** path and introduced accounting gaps in the
kill switch and the savings math. This plan fixes those, adds the missing
build work (per-standard tier maps), and cleans up the abandoned per-key design.

> Reminder for whoever executes this: **no local build / migrate / run / test**
> in this repo. Write code + tests, commit, and let CI (or the remote env) run
> them. Every change here is committed and pushed immediately.

---

## 0. Summary of findings being addressed

| # | Severity | Problem | Root cause |
| --- | --- | --- | --- |
| 1 | **Critical** | Smart Routing never fires on Codex/OpenAI — every override falls back to `passthrough_fallback` | One global tier map holds `claude-*` (standard `anthropic`); the OpenAI handler rejects any chosen model whose `standard !== "openai"` |
| 2 | High | `honor_tier` "off switch" still swaps the model for non-canonical requested models | `decideTier` returns `tiers[requestedTier]`, and the handler swaps whenever `chosenModel !== requestedModel` |
| 3 | High | `wasOverridden` under-reports real swaps → savings undercounted | Flag is `tiers[chosenTier] !== tiers[requestedTier]`, but the handler swaps on `chosenModel !== requestedModel`; `computeSavings` is gated on the flag |
| 4 | Low | Generic (non-Codex) OpenAI clients get silently routed | `smartRoutingEnabled = true` unconditionally on `chat/completions`, where `detectClient` returns `unknown` |
| 5 | Low | Token estimate inflated by JSON structure (braces/quotes/keys) | `estimateTokens(system + JSON.stringify(messages))` counts non-content characters |
| 6 | Cleanup | Dead per-key schema + stale build-plan doc | Feature shipped always-on/global; the per-key opt-in columns and doc were never removed |

---

## 1. WHAT TO FIX

### 1.1 (Critical) Per-standard tier resolution — Codex path is a no-op today

**Files:** `src/lib/settings.ts`, `src/lib/tierRouting.ts`, `src/routes/proxy/openai.ts`, `src/routes/proxy/messages.ts`

The blocker: a single `tiers: { brain, build, routine }` map cannot serve two
wire protocols. If it holds `claude-*`, the OpenAI guard
(`chosenCatalogModel.standard === "openai"`) rejects every override; if it holds
OpenAI IDs, the Anthropic guard (`standard === "anthropic"`) breaks instead.

**Fix (see §2.1 for the concrete shape):** give each standard its own tier map,
and have each handler resolve the tier against **its own** standard's map. The
Anthropic handler uses the anthropic map, the OpenAI handler uses the openai
map. No cross-standard override is ever attempted, so the passthrough fallback
stops firing for a config reason.

### 1.2 (High) `honor_tier` must pass the exact requested model through

**File:** `src/lib/tierRouting.ts` (+ handler swap condition)

`honor_tier` is the documented global kill switch. Today it returns
`tiers[requestedTier]`, and `classifyRequestedTier` snaps any non-canonical model
to the nearest canonical tier model — so "off" still silently substitutes.

**Fix:** in `honor_tier` mode, return the client's **actual requested model**
(pass it into `decideTier`, or short-circuit in the handler before calling the
engine) so `chosenModel === requestedModel` and the handler performs no swap.
`wasOverridden` stays `false`.

### 1.3 (High) `wasOverridden` should reflect the real model swap

**File:** `src/lib/tierRouting.ts`

Change the override flag to compare the concrete models actually involved:
`chosenModel !== requestedModel`, where `requestedModel` is the model the client
sent — not `tiers[requestedTier]`. This makes the flag agree with the handler's
swap condition and with `computeSavings`, so non-canonical requests that get
swapped are costed. Requires threading the requested model name into the engine
(or computing the flag in the handler where both strings are known).

### 1.4 (Low) Scope routing on the shared `chat/completions` path

**File:** `src/routes/proxy/openai.ts`

`detectClient` returns `unknown` for generic OpenAI-compatible callers on
`chat/completions`. Decide policy and make it explicit:
- **Option A (recommended):** add an admin setting `tier_route_unknown_openai`
  (default `true` to preserve current behavior); gate `smartRoutingEnabled` on
  `client === "codex" || (client === "unknown" && setting)`.
- **Option B:** only route `codex`; leave `unknown` untouched.

Pick A so behavior is unchanged by default but controllable.

---

## 2. WHAT TO BUILD

### 2.1 Per-standard tier config (the core new capability)

**`src/lib/tierRouting.ts` — `TierConfig` shape**

```ts
// before: tiers: TierModelMap
// after:
export interface TierConfig {
  tiers: {
    anthropic: TierModelMap;   // brain/build/routine — Anthropic-standard model IDs
    openai: TierModelMap;      // brain/build/routine — OpenAI-standard model IDs
  };
  longContextTokens: number;
  shortTurnTokens: number;
  mode: "smart" | "honor_tier";
  honorExplicitRoutine: boolean;
}
```

`decideTier` takes the already-selected `TierModelMap` for the request's
standard (keep the engine standard-agnostic — the handler passes the right map),
plus the requested model string for the corrected `wasOverridden`:

```ts
export function decideTier(sig: Signals, tiers: TierModelMap, cfg: DecideOpts, requestedModel: string): RoutingDecision
```

**`src/lib/settings.ts`**

New settings keys (keep the old three as anthropic defaults for a smooth migration):

```
tier_model_anthropic_brain / _build / _routine
tier_model_openai_brain    / _build / _routine
tier_route_unknown_openai            (bool, default true)   // §1.4 option A
```

Defaults:

```
anthropic: { brain: "claude-opus-4-8", build: "claude-sonnet-5", routine: "claude-haiku-4-5" }
openai:    { brain: "gpt-5",           build: "gpt-5",           routine: "gpt-5-mini" }  // confirm real fleet IDs
```

> Confirm the actual OpenAI model IDs your Codex fleet routes to before locking
> defaults — the build-plan open question about `chat/completions` vs
> `responses` traffic still applies.

**`getTierConfig()`** reads both maps; add back-compat fallback so the existing
`tier_model_brain/build/routine` keys feed the anthropic map if the new keys are
unset.

### 2.2 Admin API + dashboard for two maps

**`src/routes/admin/tierRouting.ts`**
- Extend `UpdateTierConfigBody` with `anthropic*`/`openai*` model fields (or a
  nested `{ anthropic, openai }` object) + `routeUnknownOpenai`.
- GET returns both maps.

**`dashboard/src/pages/TierRoutingPage.tsx` + `dashboard/src/api/client.ts`**
- Render two "Tier → model map" cards (Anthropic / OpenAI).
- Add the "route unknown OpenAI clients" toggle.
- Update `TierConfigDto` type.

### 2.3 Tests (CI/remote only)

- `decideTier`: `honor_tier` returns the **exact requested model** (non-canonical
  input stays untouched); `wasOverridden` true when served model differs from
  requested, false when identical.
- `getTierConfig`: back-compat — legacy keys populate the anthropic map; new keys
  populate both; openai defaults present.
- Handler-level (if integration harness exists): OpenAI request with default
  config now produces a real openai-standard override instead of
  `passthrough_fallback`; `unknown` client respects the new setting.

---

## 3. WHAT TO OPTIMIZE

### 3.1 Token estimate — count content, not JSON scaffolding
**`src/lib/tierSignals.ts`** — estimate from concatenated text content of
messages (and system), not `JSON.stringify(...)`, so field names/braces/quotes
don't inflate the count and trip `longContextTokens` early. Keep the 4-char
heuristic; just feed it real text. Low risk, improves threshold accuracy.

### 3.2 Single settings read per request
Both handlers call `getTierConfig()` and (Anthropic) `getSmallFastModelName()`
separately. `SettingsCache` is already in-process/TTL-cached so cost is low, but
fold the small-fast name into the `TierConfig` object so there's one accessor
and one shape to reason about.

### 3.3 Savings query robustness
`/admin/api/tier-routing/savings` groups by `client`, which can be `unknown` or
`null`. Confirm the dashboard's `row.client ?? "unknown"` collapsing is
intended, and consider also grouping by `rule_id` so you can see *which* rule
drives savings (background vs short_turn vs default-down).

---

## 4. CLEANUP

- Delete the dead per-key columns: new migration
  `..._drop_smart_routing_key_flags.{up,down}.sql` dropping
  `smart_routing_claude_code` / `smart_routing_codex` (they're written by
  `1735690900000_smart_routing_flags` but read by nothing). Down migration
  re-adds them. Do **not** edit the already-applied migration in place.
- Update `smart_routing_buildplan.md` (or supersede it) to describe the shipped
  **always-on / global / per-standard** design — the current doc still describes
  per-key opt-in toggles that don't exist.
- Remove the stale per-key comment text if any survives in code/DTOs.

---

## 5. ROLLOUT ORDER

1. Migrations: add nothing schema-critical (settings are rows, not columns); the
   only DDL is the **drop** of dead key columns (§4) — additive/safe.
2. `settings.ts`: per-standard `TierConfig` + back-compat + new keys/defaults.
3. `tierRouting.ts`: engine signature change (`requestedModel`, corrected
   `wasOverridden`, `honor_tier` passthrough).
4. `tierSignals.ts`: content-based token estimate (§3.1).
5. Wire `messages.ts` (anthropic map) and `openai.ts` (openai map + unknown-client
   gate).
6. Admin route + dashboard: two maps + unknown toggle.
7. Tests for all of the above.
8. Update `smart_routing_buildplan.md` and remove dead schema.
9. Verify on an internal key: confirm a Codex request now shows a real openai
   override + non-zero savings in the dashboard.

---

## 6. CHECKLIST

### Fix
- [ ] `TierConfig.tiers` split into `{ anthropic, openai }` maps (§1.1 / §2.1)
- [ ] `messages.ts` resolves tier against the **anthropic** map
- [ ] `openai.ts` resolves tier against the **openai** map
- [ ] OpenAI-path overrides no longer fall to `passthrough_fallback` under default config
- [ ] `honor_tier` returns the exact client-requested model (true off-switch) (§1.2)
- [ ] `wasOverridden` compares `chosenModel !== requestedModel` (§1.3)
- [ ] `requestedModel` threaded into `decideTier` (or flag computed in handler)
- [ ] `chat/completions` unknown-client routing gated by `tier_route_unknown_openai` (§1.4)

### Build
- [ ] New settings keys: `tier_model_{anthropic,openai}_{brain,build,routine}`
- [ ] `tier_route_unknown_openai` setting (default true)
- [ ] `getTierConfig()` reads both maps + legacy back-compat fallback
- [ ] OpenAI tier default model IDs confirmed against real Codex fleet
- [ ] Admin `UpdateTierConfigBody` + GET/PATCH handle both maps + toggle
- [ ] Dashboard: two tier→model cards + unknown-client toggle
- [ ] `TierConfigDto` / api client types updated

### Optimize
- [ ] Token estimate counts message/system **content**, not JSON scaffolding (§3.1)
- [ ] Small-fast model name folded into `TierConfig` (§3.2)
- [ ] Savings query/dashboard reviewed for `null`/`unknown` client + optional `rule_id` grouping (§3.3)

### Cleanup
- [ ] Migration drops dead `smart_routing_claude_code` / `smart_routing_codex` columns (down re-adds)
- [ ] `smart_routing_buildplan.md` rewritten to match shipped always-on/global/per-standard design
- [ ] Stale per-key comments removed

### Tests (CI / remote only)
- [ ] `decideTier`: `honor_tier` passthrough keeps exact requested model
- [ ] `decideTier`: `wasOverridden` true/false against real requested model
- [ ] `getTierConfig`: legacy-key back-compat + both maps + openai defaults
- [ ] Handler: default-config OpenAI request yields a real override (no passthrough)
- [ ] Handler: `unknown` client respects `tier_route_unknown_openai`

### Ship
- [ ] Commit + push each logical step
- [ ] Verify Codex override + non-zero savings on internal key post-deploy
