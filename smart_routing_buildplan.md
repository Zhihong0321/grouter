# Smart Routing Mode — Build Plan (As Shipped)

Automatic per-request model-tier selection for the reseller proxy. The proxy picks
the cheapest model that clears the task's quality bar (brain / build / routine)
instead of blindly serving the model the client asked for. **Always on** for all
keys — no per-key opt-in. The global kill switch is the `tier_routing_mode` admin
setting ("smart" vs "honor_tier").

> **Status:** Shipped and live. This document describes the **as-built** design.

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
| DB decision log | columns on `reseller_request_logs` |
| Admin config | `src/routes/admin/tierRouting.ts` |

---

## 1. Concept recap

```
brain   (best model)   ← thinking on / high effort / long context / brain tier asked
build   (sonnet class) ← default coding turns
routine (cheapest)     ← background/small-fast, short tool-less turns
```

The engine is a pure function: normalized `Signals` → target tier → concrete model.
Two thin adapters feed it (Anthropic wire vs OpenAI/Responses wire). One decision
core, logged per request.

**Per-standard tier maps:** Anthropic path uses anthropic tier models; OpenAI path
uses openai tier models. No cross-standard override is attempted.

---

## 2. Where it plugs into the existing code

| Concern | Existing file | Change |
| --- | --- | --- |
| Anthropic entry | `src/routes/proxy/messages.ts` (`POST /v1/messages`) | after model resolve, before `callWithFailover`, run tier routing with anthropic map |
| OpenAI/Codex entry | `src/routes/proxy/openai.ts` (`handleOpenAiRequest`, `chat/completions` + `responses`) | same injection point with openai map |
| Model catalog / routes | `src/lib/router.ts` (`RouterCache`) | resolve chosen tier → concrete `model_id` in catalog |
| Decision logging | `src/lib/requestLog.ts` + `reseller_request_logs` | routing-decision columns (already added) |
| Config | `src/lib/settings.ts` | per-standard tier→model maps + thresholds + toggles |
| Admin API | `src/routes/admin/tierRouting.ts` | GET/PATCH for both tier maps + settings |
| Dashboard | `dashboard/src/pages/TierRoutingPage.tsx` | two tier map cards + thresholds + toggles |

Injection point in both handlers is **after** `app.routerCache.getModel(model)`
succeeds and **before** `callWithFailover(...)` — swap the resolved model for the
tier-chosen one, then let the existing failover matrix serve it.

---

## 3. Data model

### 3.1 Per-key flags — REMOVED (feature shipped always-on)

The original design included `smart_routing_claude_code` and `smart_routing_codex`
columns on `reseller_api_keys` for per-key opt-in. These were never read by the
shipped code and have been dropped via migration
`1783864719000_drop_smart_routing_key_flags.{up,down}.sql`.

**Current behavior:** Smart Routing Mode is **always on** for all keys. The only
controls are:
- Global `tier_routing_mode` setting ("smart" vs "honor_tier")
- `tier_route_unknown_openai` setting (whether to route unknown OpenAI clients)

### 3.2 Decision log — `reseller_request_logs`

Already applied via `migrations/1735691000000_request_log_routing.{up,down}.sql`:

```sql
ALTER TABLE reseller_request_logs
  ADD COLUMN client                text,     -- 'claude_code' | 'codex' | 'unknown' | null
  ADD COLUMN smart_routing_enabled boolean,  -- always true (for now)
  ADD COLUMN routing_mode          text,     -- 'smart' | 'honor_tier'
  ADD COLUMN requested_tier        text,     -- brain | build | routine
  ADD COLUMN chosen_model          text,
  ADD COLUMN rule_id               text,     -- which rule fired, e.g. 'background'
  ADD COLUMN was_overridden        boolean,  -- chosen_model != requested model
  ADD COLUMN cost_baseline_cents   numeric,  -- what requested tier would have cost
  ADD COLUMN cost_saved_cents      numeric;
```

> `was_overridden` is `true` when `chosen_model !== requested_model` (the actual
> model strings), not when tier models differ. This ensures non-canonical requests
> that get swapped are properly costed.

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
  inputTokens: number;       // estimated from content text, not JSON structure
  hasTools: boolean;
}

export function detectClient(headers, path): ClientKind
export function signalsFromAnthropic(body, cfg): Signals
export function signalsFromOpenAI(body, endpoint, cfg): Signals
```

Client detection:

| Client | Path | User-Agent |
| --- | --- | --- |
| claude_code | `/v1/messages` | any (path is definitive) |
| codex | `/v1/responses` or Codex UA on chat/completions | `/codex/i` |
| unknown | `/v1/chat/completions` with non-Codex UA | any |

**Token estimation:** Counts **content text** from messages/system/input, not
`JSON.stringify(messages)`. This avoids inflating the count with JSON scaffolding
(braces, quotes, field names) and improves threshold accuracy.

---

## 5. Routing engine — `src/lib/tierRouting.ts`

```ts
export interface TierConfig {
  tiers: {
    anthropic: TierModelMap;   // brain/build/routine for Anthropic standard
    openai: TierModelMap;      // brain/build/routine for OpenAI standard
  };
  longContextTokens: number;
  shortTurnTokens: number;
  mode: "smart" | "honor_tier";
  honorExplicitRoutine: boolean;
  smallFastModelName: string;
  routeUnknownOpenai: boolean;
}

export interface RoutingDecision {
  chosenModel: string;
  chosenTier: Tier;
  requestedTier: Tier;
  ruleId: string;
  wasOverridden: boolean;
}

export function decideTier(
  sig: Signals,
  tiers: TierModelMap,
  cfg: { mode, longContextTokens, shortTurnTokens, honorExplicitRoutine },
  requestedModel: string
): RoutingDecision
```

**Key change from original design:** `decideTier` takes the **specific tier map**
for the request's standard (anthropic or openai), not the full config. Callers
pass the right map. The engine stays standard-agnostic.

Ordered rules (first match wins):

1. `mode === "honor_tier"` → return **exact requested model** (true off-switch)
2. `isBackground` → routine
3. `thinkingEnabled` → brain
4. `inputTokens > longContextTokens` → brain
5. `honorExplicitRoutine && requestedTier === "routine"` → routine
6. `inputTokens < shortTurnTokens && !hasTools` → routine (short, tool-less turns
   downgrade **even an explicit brain ask** — genuine brain needs already matched
   at rules 3–4)
7. `requestedTier === "brain"` → brain (explicit brain ask on a normal turn)
8. default → build

**Fallback:** If the chosen model isn't in the catalog or has no active route, fall
back to the requested model and log `ruleId='passthrough_fallback'`.

---

## 6. Wire the handlers

### 6.1 Anthropic path — `src/routes/proxy/messages.ts`

```ts
const client = detectClient(request.headers, "messages"); // always "claude_code"
const smartRoutingEnabled = true; // always on
const tierConfig = await app.settingsCache.getTierConfig();
const sig = signalsFromAnthropic(body, {
  tiers: tierConfig.tiers.anthropic,
  smallFastModelName: tierConfig.smallFastModelName,
});
const decision = decideTier(sig, tierConfig.tiers.anthropic, tierConfig, requestedModel);
// resolve route for decision.chosenModel, then callWithFailover(...)
```

### 6.2 OpenAI path — `src/routes/proxy/openai.ts`

```ts
const client = detectClient(request.headers, endpoint);
const tierConfig = await app.settingsCache.getTierConfig();
const smartRoutingEnabled =
  client === "codex" || (client === "unknown" && tierConfig.routeUnknownOpenai);
if (smartRoutingEnabled) {
  const sig = signalsFromOpenAI(body, endpoint, { tiers: tierConfig.tiers.openai });
  const decision = decideTier(sig, tierConfig.tiers.openai, tierConfig, requestedModel);
  // resolve route for decision.chosenModel, then callWithFailover(...)
}
```

**Unknown-client gate:** Codex is always routed. Unknown OpenAI-compatible clients
on `/v1/chat/completions` are routed only if `tier_route_unknown_openai` is true
(default true for backward compatibility).

Cost savings are computed by comparing the chosen model's cost against the
**requested tier's model** cost (using the appropriate standard's tier map).

---

## 7. Config / settings — `src/lib/settings.ts`

### 7.1 Settings keys

```
tier_model_anthropic_brain / _build / _routine
tier_model_openai_brain    / _build / _routine
tier_long_context_tokens
tier_short_turn_tokens
tier_small_fast_model
tier_routing_mode            (smart | honor_tier)
tier_honor_explicit_routine  (boolean)
tier_route_unknown_openai    (boolean)
```

**Legacy keys** (for backward compatibility):
```
tier_model_brain / _build / _routine  → feed anthropic map if new keys unset
```

### 7.2 Defaults

```ts
anthropic: { brain: "claude-opus-4-8", build: "claude-sonnet-5", routine: "claude-haiku-4-5" }
openai:    { brain: "gpt-5",           build: "gpt-5",           routine: "gpt-5-mini" }
longContextTokens: 60_000
shortTurnTokens: 1_500
smallFastModelName: "claude-haiku-4-5"
mode: "smart"
honorExplicitRoutine: false
routeUnknownOpenai: true
```

---

## 8. Dashboard — `dashboard/src/pages/TierRoutingPage.tsx`

Two tier map cards:
- **Anthropic tier → model map** (brain/build/routine)
- **OpenAI tier → model map** (brain/build/routine)

Thresholds and settings:
- Long-context tokens
- Short-turn tokens
- Claude Code small-fast model name
- Mode (smart / honor_tier)
- Honor explicit routine (checkbox)
- Route unknown OpenAI clients (checkbox)

Realized savings table:
```sql
SELECT client, count(*), sum(cost_baseline_cents), sum(cost_saved_cents)
FROM reseller_request_logs
WHERE smart_routing_enabled=true AND was_overridden=true
GROUP BY client;
```

---

## 9. Tests — `test/tierRouting.test.ts`, `test/tierSignals.test.ts`

**Unit tests (vitest):**
- `decideTier`: every rule, both standards, honor_tier passthrough, wasOverridden logic
- `signalsFromAnthropic` / `signalsFromOpenAI`: content token counting, tier classification
- `getTierConfig`: backward compatibility with legacy keys, both maps present

**Integration tests:** Not yet added (handler-level tests for real override + savings).

---

## 10. What was fixed (from fix-smart-router.md remediation)

1. **Critical:** Per-standard tier resolution — Codex/OpenAI path now uses openai map
   instead of falling to `passthrough_fallback`. ✅
2. **High:** `honor_tier` returns exact requested model (true off-switch). ✅
3. **High:** `wasOverridden` compares `chosenModel !== requestedModel`. ✅
4. **Low:** Unknown-client routing gated by `tier_route_unknown_openai`. ✅
5. **Low:** Token estimate counts content, not JSON scaffolding. ✅
6. **Cleanup:** Dead per-key columns dropped. ✅

---

## 11. Open questions (resolved)

- ~~Small-fast detection for CC: rely on the configured small-fast model name~~
  → **Resolved:** Uses `smallFastModelName` from TierConfig.
- ~~Codex on `chat/completions` vs `responses`: confirm which wire~~
  → **Resolved:** Both paths supported; `detectClient` uses UA on chat/completions.
- ~~Expose thresholds per-key, or global-only for v1?~~
  → **Resolved:** Global-only, always-on. No per-key opt-in shipped.
