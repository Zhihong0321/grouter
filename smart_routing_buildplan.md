# Smart Routing Mode — Build Plan

Automatic per-request model-tier selection for the reseller proxy. When a key has
**Smart Routing Mode** enabled, the proxy picks the cheapest model that clears the
task's quality bar (brain / build / routine) instead of blindly serving the model
the client asked for. Enabled **separately** for Claude Code CLI and Codex, and
every routed request is tagged so usage is queryable per client.

---

## 0. Naming — avoid the existing collision

> ⚠️ `src/lib/smartRouting.ts` already exists and means something **different**:
> it syncs the **provider failover matrix** (`reseller_model_routes` — which
> supplier key serves which model). That is *route selection across providers*.
>
> This feature is **model-tier selection** (brain/build/routine) and must NOT
> reuse that module or its DB tables.

Naming convention for this feature:

| Layer | Name |
| --- | --- |
| User-facing feature | **Smart Routing Mode** |
| Engine module | `src/lib/tierRouting.ts` |
| Signals extractor | `src/lib/tierSignals.ts` |
| DB per-key flags | `reseller_api_keys.smart_routing_*` |
| DB decision log | new columns on `reseller_request_logs` |

---

## 1. Concept recap

```
brain   (best model)   ← thinking on / high effort / long context / opus tier asked
build   (sonnet class) ← default coding turns
routine (cheapest)     ← background/small-fast, short tool-less turns, haiku tier
```

The engine is a pure function: normalized `Signals` → target tier → concrete model.
Two thin adapters feed it (Anthropic wire vs OpenAI/Responses wire). One decision
core, logged per request.

---

## 2. Where it plugs into the existing code

| Concern | Existing file | Change |
| --- | --- | --- |
| Anthropic entry | `src/routes/proxy/messages.ts` (`POST /v1/messages`) | after model resolve, before `callWithFailover`, run tier routing |
| OpenAI/Codex entry | `src/routes/proxy/openai.ts` (`handleOpenAiRequest`, `chat/completions` + `responses`) | same injection point |
| Per-key config | `src/lib/keyAuth.ts` → `keyRecord` | load `smartRouting` flags onto the key record |
| Model catalog / routes | `src/lib/router.ts` (`RouterCache`) | resolve chosen tier → concrete `model_id` in catalog |
| Decision logging | `src/lib/requestLog.ts` + `reseller_request_logs` | add routing-decision columns |
| Config defaults | `src/config/env.ts`, `src/lib/settings.ts` | tier→model map + thresholds as settings |

Injection point in both handlers is **after** `app.routerCache.getModel(model)`
succeeds and **before** `callWithFailover(...)` — swap the resolved model for the
tier-chosen one, then let the existing failover matrix serve it.

---

## 3. Data model

### 3.1 Per-key flags — `migrations/1735690900000_smart_routing_flags.{up,down}.sql`

```sql
ALTER TABLE reseller_api_keys
  ADD COLUMN smart_routing_claude_code boolean NOT NULL DEFAULT false,
  ADD COLUMN smart_routing_codex       boolean NOT NULL DEFAULT false;
```

- [ ] up migration adds two columns
- [ ] down migration drops them
- [ ] `lookupKeyByHash` selects + maps them onto `keyRecord.smartRouting`
- [ ] cache invalidation on key edit already covers new columns (verify)

### 3.2 Decision log — `migrations/1735691000000_request_log_routing.{up,down}.sql`

```sql
ALTER TABLE reseller_request_logs
  ADD COLUMN client                text,     -- 'claude_code' | 'codex' | null
  ADD COLUMN smart_routing_enabled boolean,  -- mode ON for this key+client, at request time
  ADD COLUMN routing_mode          text,     -- 'smart' | 'honor_tier'
  ADD COLUMN requested_tier        text,     -- brain | build | routine
  ADD COLUMN chosen_model          text,
  ADD COLUMN rule_id               text,     -- which rule fired, e.g. 'background'
  ADD COLUMN was_overridden        boolean,  -- chosen_model != requested tier default
  ADD COLUMN cost_baseline_cents   numeric,  -- what requested tier would have cost
  ADD COLUMN cost_saved_cents      numeric;
```

> Log the flag value **per request** (as it was at decision time). Never resolve it
> later by joining to the key's current config — the toggle changes over time.

- [ ] up/down migrations
- [ ] extend `RequestLogParams` + `logRequestEvent` insert with the new fields
- [ ] populate from the tier-routing result in both proxy handlers

---

## 4. Tier signals — `src/lib/tierSignals.ts`

```ts
export type Tier = "brain" | "build" | "routine";
export type ClientKind = "claude_code" | "codex" | "unknown";

export interface Signals {
  client: ClientKind;
  requestedTier: Tier;      // from the model name the client sent
  isBackground: boolean;    // CC small-fast slot; always false for Codex
  thinkingEnabled: boolean;
  inputTokens: number;
  hasTools: boolean;
}

export function detectClient(req): ClientKind        // endpoint path + User-Agent
export function signalsFromAnthropic(req): Signals    // /v1/messages
export function signalsFromOpenAI(req, endpoint): Signals // chat/completions | responses
```

Client detection (both signals, path is primary):

| Client | Path | User-Agent |
| --- | --- | --- |
| claude_code | `/v1/messages` | `claude-cli/*`, `x-stainless-*` |
| codex | `/v1/responses` (or Codex UA on chat/completions) | Codex CLI UA |

- [ ] `detectClient` — path first, UA as confirm/guard
- [ ] `signalsFromAnthropic` — read `thinking.type`, count tokens, tools, small-fast name
- [ ] `signalsFromOpenAI` — map `reasoning.effort` (low/med/high), `input[]` tokens
- [ ] token counting reuses `src/routes/proxy/countTokens.ts` if possible
- [ ] "background"/small-fast detection: match configurable small-fast model name

---

## 5. Routing engine — `src/lib/tierRouting.ts`

```ts
export interface TierConfig {
  tiers: Record<Tier, string>;   // tier -> concrete model_id
  longContextTokens: number;     // default 60_000
  shortTurnTokens: number;       // default 1_500
  mode: "smart" | "honor_tier";
}

export interface RoutingDecision {
  chosenModel: string;
  chosenTier: Tier;
  requestedTier: Tier;
  ruleId: string;         // background | thinking | long_context | explicit_brain | short_turn | default | passthrough
  wasOverridden: boolean;
}

export function decideTier(sig: Signals, cfg: TierConfig): RoutingDecision
```

Ordered rules (first match wins) — from the agreed design:

1. `honor_tier` mode → serve `requestedTier` (off-switch / fallback)
2. `isBackground` → routine
3. `thinkingEnabled` OR `inputTokens > longContextTokens` → brain
4. `requestedTier === brain` → brain (never silently downgrade an explicit Opus)
5. `inputTokens < shortTurnTokens && !hasTools` → routine
6. default → build

- [ ] pure function, no I/O, fully unit-testable
- [ ] `wasOverridden = chosenModel !== tiers[requestedTier]`
- [ ] Codex path: no background rule fires; effort drives tiers (high→brain, med→build, low→routine)
- [ ] guard: if `tiers[chosenTier]` model is not in catalog / has no active route, fall back to requested model and log `ruleId='passthrough_fallback'`

---

## 6. Wire the handlers

For **both** `messages.ts` and `openai.ts`, after model resolves:

```ts
const client = detectClient(request);
const enabled =
  (client === "claude_code" && keyRecord.smartRouting.claudeCode) ||
  (client === "codex"       && keyRecord.smartRouting.codex);

let effectiveModel = model;
let decision: RoutingDecision | undefined;
if (enabled) {
  const sig = signalsFrom{Anthropic|OpenAI}(request /*, endpoint*/);
  decision = decideTier(sig, tierConfig);
  effectiveModel = decision.chosenModel;
}
// resolve route for effectiveModel, then callWithFailover(...)
```

Then feed the decision + `client` + `enabled` into `logRequestEvent(...)`.

- [ ] messages.ts wired
- [ ] openai.ts wired (both endpoints)
- [ ] cost baseline/saved computed via `src/lib/pricing.ts` (requested tier vs chosen)
- [ ] model restrictions still enforced against the **chosen** model
- [ ] error surface unchanged when routing disabled (no behavior change for existing keys)

---

## 7. Config / settings

- [ ] tier→model map as an admin setting (default: opus-4-8 / sonnet-5 / haiku-4-5)
- [ ] `longContextTokens`, `shortTurnTokens`, small-fast model name as settings
- [ ] `.env.example` documents any new env keys
- [ ] settings cache invalidation covers new keys

---

## 8. Dashboard

- [ ] Per-key panel: two toggles — Smart Routing (Claude Code) / Smart Routing (Codex)
- [ ] Admin write endpoint updates the two boolean columns + busts key cache
- [ ] Request-log view surfaces `client`, `requested_tier → chosen_model`, `rule_id`, `was_overridden`
- [ ] Savings summary: `SUM(cost_saved_cents) WHERE smart_routing_enabled AND was_overridden`, grouped by key + client
- [ ] Global tier→model / threshold editor

Reference queries:

```sql
-- CC usage under Smart Routing this month
SELECT * FROM reseller_request_logs
WHERE client='claude_code' AND smart_routing_enabled=true;

-- Realized savings by client
SELECT client, count(*), sum(cost_saved_cents)
FROM reseller_request_logs
WHERE smart_routing_enabled=true AND was_overridden=true
GROUP BY client;
```

---

## 9. Tests (CI / remote only — do not run locally)

- [ ] `decideTier` unit tests: every rule, both clients, honor_tier mode, passthrough fallback
- [ ] `detectClient` tests: path + UA matrix, spoof guard
- [ ] signals adapters: Anthropic thinking flag, Codex effort mapping, token thresholds
- [ ] handler integration: enabled vs disabled key, log row shape, restriction enforcement
- [ ] migration up/down round-trip

---

## 10. Rollout order

1. [ ] Migrations (flags + log columns) — additive, safe on live
2. [ ] `tierSignals.ts` + `tierRouting.ts` + unit tests
3. [ ] `keyAuth` loads flags; `requestLog` extended
4. [ ] Wire `messages.ts`, then `openai.ts`
5. [ ] Dashboard toggles + log/savings views
6. [ ] Enable on internal test key first; verify log tagging + savings math
7. [ ] Document for resellers; expose per-key toggle in product

---

## Open questions

- Small-fast detection for CC: rely on the configured small-fast model **name**, or
  also treat very-short system prompts as background? (start with name only)
- Codex on `chat/completions` vs `responses`: confirm which wire your Codex fleet
  actually uses so `detectClient` + `signalsFromOpenAI` cover the real traffic.
- Do we expose thresholds per-key, or global-only for v1? (recommend global-only)
