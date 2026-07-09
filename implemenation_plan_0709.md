# Implementation Plan — Multi-Provider Model Router (2026-07-09)

**Audience:** implementing agent (Sonnet). This document is self-contained; follow it phase by phase. Do not expand scope beyond what is written here.

**Scope of THIS build: Anthropic-standard only.** The goal is to prove the multi-provider + priority-failover router end-to-end on `/v1/messages` before touching OpenAI/DeepSeek at all. OpenAI-standard support (`/v1/chat/completions`, DeepSeek, GPT) is fully designed in §13 as a **future phase** for reference, but must NOT be built now — no OpenAI routes, no OpenAI usage extraction, no DeepSeek/GPT seed rows. If anything below conflicts with "Anthropic only," the restriction wins.

## 1. Goal & decisions already made

This is an LLM API reseller proxy. Today it has ONE hardcoded upstream ("subrouter": a single API key + base URL stored in `reseller_settings`, see `src/lib/settings.ts`) and only supports the Anthropic API format on `/v1/messages`.

We are upgrading it to a **model catalog + provider routing table**, proven first on Anthropic models only:

- **Model catalog** — the models end-users are allowed to call. Each model belongs to a **brand** and has a **standard** (`anthropic` or `openai`) — the API protocol used to call it. The `standard` column exists now so the schema doesn't need a breaking migration later, but every row seeded in THIS build is `standard = 'anthropic'`.
- **Providers** — upstream supplier accounts (base URL + API key + standard). The admin can add several Anthropic-standard providers (e.g. two different discount suppliers both fronting Claude).
- **Routes** — which provider serves which model, with a **priority** number. Multiple providers can serve the same model; priority 1 is tried first, others are automatic failover backups.

Decisions locked in (do not revisit):

1. **Option A — native standards only, NO protocol translation.** Anthropic-standard models are called via `POST /v1/messages` (Anthropic request/response format). (OpenAI-standard via `/v1/chat/completions` is designed in §13 but deferred — not built now.)
2. **This build's catalog = Anthropic models only**: latest Claude models (Opus/Sonnet/Haiku/Fable as currently priced in `reseller_model_prices`). No OpenAI or DeepSeek rows yet.
3. **Priority failover**: if the priority-1 provider fails (rules in §6), automatically try priority 2, etc. This is the main thing being proven — that a single Claude model can survive one supplier going down.
4. End-users only ever see: model IDs. Providers stay invisible to them.

## 2. Current-state anchors (read these first)

| File | Role today |
|---|---|
| `src/routes/proxy/messages.ts` | The single proxy endpoint (`/v1/messages`): auth → model restriction → price lookup → rate limit → budget → single upstream call → usage logging |
| `src/lib/upstream.ts` | `callUpstream`, header forwarding, SSE tap (`pipeAndTapUsage`), `readJsonAndExtractUsage`, `checkSubrouterHealth` (Anthropic-only: `x-api-key` + `anthropic-version`) |
| `src/lib/usageExtract.ts` | Anthropic usage extraction (4 token counters) + `StreamingUsageAccumulator` for Anthropic SSE (`message_start` / `message_delta`) |
| `src/lib/settings.ts` | `SettingsCache` with `SUBROUTER_API_KEY` / `SUBROUTER_BASE_URL` — the legacy single upstream. To be superseded by provider rows (§8) |
| `src/lib/keyCrypto.ts` | AES-256-GCM `encryptKey`/`decryptKey` — REUSE this for provider API keys at rest |
| `src/lib/pricing.ts`, `reseller_model_prices` table | Per-model retail pricing (4 token classes), cached via `PriceCache` |
| `src/routes/admin/*` | Session-auth'd admin API (keys, prices, settings, usage) |
| `dashboard/src/pages/SettingsPage.tsx` | Current settings UI (subrouter key/URL + key prefix) — this page gets rebuilt in §9 |
| `migrations/` | Timestamped up/down SQL pairs; all tables prefixed `reseller_` (shared DB — keep the prefix) |

Conventions to preserve: Fastify plugins, `reseller_` table prefix, up/down migration pairs, in-process TTL caches invalidated on admin writes (see `SettingsCache` / `PriceCache` pattern), vitest tests in `test/`.

## 3. Phase 1 — Database schema

One new migration pair (`*_router.up.sql` / `.down.sql`):

```sql
CREATE TABLE reseller_models (
  model_id   text PRIMARY KEY,                -- what end-users put in `model`
  brand      text NOT NULL,                   -- 'Anthropic' | 'OpenAI' | 'DeepSeek' (free text, UI groups by it)
  standard   text NOT NULL CHECK (standard IN ('anthropic', 'openai')),
  display_name text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reseller_providers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,                -- admin label, e.g. "SupplierX Anthropic"
  standard      text NOT NULL CHECK (standard IN ('anthropic', 'openai')),
  base_url      text NOT NULL,
  api_key_encrypted text NOT NULL,            -- via keyCrypto.encryptKey
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reseller_model_routes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id         text NOT NULL REFERENCES reseller_models(model_id) ON DELETE CASCADE,
  provider_id      uuid NOT NULL REFERENCES reseller_providers(id) ON DELETE CASCADE,
  upstream_model_id text NOT NULL,            -- the ID the SUPPLIER expects (may differ from model_id)
  priority         int NOT NULL DEFAULT 1 CHECK (priority >= 1),
  active           boolean NOT NULL DEFAULT true,
  UNIQUE (model_id, provider_id),
  UNIQUE (model_id, priority)
);

ALTER TABLE reseller_usage_logs ADD COLUMN provider_id uuid REFERENCES reseller_providers(id);
ALTER TABLE reseller_usage_logs ADD COLUMN upstream_model_id text;
```

Constraint to enforce in the admin API (not SQL): a route may only link a model and provider with the **same standard**. (In this build every row is `anthropic`, so this check is a no-op today but must still be written — it's load-bearing the moment §13 ships.)

Seed catalog (in the same migration; `upstream_model_id` defaults to `model_id`, admin fixes per supplier later) — **Anthropic only, matching the existing `reseller_model_prices` rows**:

| model_id | brand | standard | display_name |
|---|---|---|---|
| `claude-opus-4-8` | Anthropic | anthropic | Claude Opus 4.8 |
| `claude-sonnet-5` | Anthropic | anthropic | Claude Sonnet 5 |
| `claude-haiku-4-5` | Anthropic | anthropic | Claude Haiku 4.5 |
| `claude-fable-5` | Anthropic | anthropic | Claude Fable 5 |

Do not add OpenAI/DeepSeek rows to `reseller_models` or `reseller_model_prices` in this build.

## 4. Phase 2 — Router core (`src/lib/router.ts`, new)

A `RouterCache` (same TTL-cache pattern as `SettingsCache`) exposing:

- `getModel(modelId)` → `{ modelId, brand, standard, active }` or undefined.
- `getRoutes(modelId)` → active routes joined with their active provider, **ordered by priority**, each `{ routeId, providerId, providerName, standard, baseUrl, apiKey (decrypted), upstreamModelId }`. Decrypt with `keyCrypto.decryptKey` at read time; never log or return decrypted keys via API.
- `invalidate()` — called by every admin write to models/providers/routes.

## 5. Phase 3 — Upstream layer generalization (`src/lib/upstream.ts`)

Replace `SubrouterConfig` with a `ProviderTarget` (`standard`, `baseUrl`, `apiKey`, `upstreamModelId`). Only the `anthropic` branch is exercised in this build, but write the `standard` switch now (not an if-Anthropic-only shortcut) so §13 is a pure addition later, not a rewrite.

- **Auth headers per standard**: `anthropic` → `x-api-key` + `anthropic-version` (forward client's version header, default `2023-06-01`).
- **Path per standard**: `anthropic` → `${baseUrl}/v1/messages`.
- **Body rewrite before forwarding**: set `body.model = upstreamModelId`.
- **Health check**: generalize `checkSubrouterHealth` → `checkProviderHealth(target)`, same behavior as today, just parameterized on a `ProviderTarget` instead of the old `SubrouterConfig`.

## 6. Phase 4 — Failover logic (in `router.ts` or `src/lib/failover.ts`)

`callWithFailover(routes, body, ...)` iterates routes in priority order:

- **Try next provider when**: fetch throws (network error / timeout), or response status is `429`, `500`, `502`, `503`, `504`, or `529` (Anthropic overloaded). Each attempt gets its own timeout (reuse the 10s AbortController pattern; make request timeout longer, e.g. 120s for non-streaming first-byte).
- **Do NOT failover on**: `400`, `401`, `403`, `404`, `413`, `422` — these are request/config problems; retrying another provider wastes money or hides misconfiguration. Pass the response through to the client (sanitize any supplier-identifying headers).
- **Streaming safety rule**: failover decisions happen **only before any byte is written to the client**. The upstream `fetch` resolves with status + headers before the body streams, so checking `response.status` before calling `reply.hijack()` is sufficient. Once piping starts, a mid-stream failure ends the stream — no retry.
- **Body reuse**: each attempt re-serializes the (rewritten) body per route — remember `upstream_model_id` differs per provider.
- Cap attempts at the number of routes (no re-tries of the same provider). If all fail, return `529`-style "all upstreams unavailable" in the caller's native error format.
- Log which provider ultimately served (feeds `usage_logs.provider_id`), and `request.log.warn` each failed attempt with provider name + status.

## 7. Phase 5 — Proxy endpoints

### 7a. Rework `/v1/messages` (`src/routes/proxy/messages.ts`)

Keep the existing pipeline (auth → restrictions → price → rate limit → budget) but replace the single-subrouter call:

1. Look up model in `RouterCache`. Unknown/inactive → `invalid_request_error` "Model not available".
2. If `model.standard !== 'anthropic'` → `invalid_request_error`: `"Model X uses the OpenAI-compatible API — call POST /v1/chat/completions instead"`.
3. Get routes; empty → the current "not configured" error.
4. `callWithFailover(...)`, then the existing streaming/non-streaming tap + `logUsage` flow (now passing `providerId`, `upstreamModelId`).

Do not build `/v1/chat/completions` or a user-facing `/v1/models` endpoint in this pass — see §13 for their design when OpenAI-standard support is greenlit.

## 8. Phase 6 — Legacy subrouter migration & removal

- In the Phase 1 migration: if `reseller_settings` has `subrouter_api_key` + `subrouter_base_url`, this cannot be migrated in pure SQL (the key is plaintext in settings but must be encrypted in providers). Instead do it in code: on server boot (one-time check in `src/app.ts`), if legacy settings exist AND `reseller_providers` is empty, create a provider `name='Legacy subrouter', standard='anthropic'` with the encrypted key, create priority-1 routes from it to every active anthropic-standard model, then delete the two legacy settings rows. Log loudly.
- Remove `SUBROUTER_API_KEY`/`SUBROUTER_BASE_URL` from `SETTINGS_KEYS` and `getSubrouterConfig` once nothing references them. Keep `KEY_PREFIX`.

## 9. Phase 7 — Admin API + dashboard

New admin routes (follow the session-auth pattern in `src/routes/admin/settings.ts`). All still take/return `standard`, but the UI (below) only ever presents `anthropic` in this build:

- `GET/POST/PATCH/DELETE /admin/models` — catalog CRUD (brand, standard, display_name, active). Deleting a model with usage history: soft-disable (`active=false`) instead of delete.
- `GET/POST/PATCH/DELETE /admin/providers` — provider CRUD. API key is write-only through the API (accept on create/update, never return it; return `api_key_set: true` + last-4 chars). `POST /admin/providers/:id/health` runs `checkProviderHealth`.
- `GET/PUT /admin/models/:modelId/routes` — replace-all routes for a model: `[{ providerId, upstreamModelId, priority }]`. Validate same-standard, unique priorities.
- Every write invalidates `RouterCache`.

Dashboard — rebuild `SettingsPage.tsx` into a **Router page** (keep key-prefix setting wherever it fits). Since everything is Anthropic-standard right now, keep the UI simple rather than building brand/standard pickers that only ever have one value:

1. **Models section**: list of Claude models (display name, model_id, active toggle). "Add model" form: model_id, display name (standard fixed to `anthropic`, brand fixed to `Anthropic`, hidden from the form for now — just set server-side).
2. **Providers section**: card per provider — name, base URL, masked key, health-check button (shows ok/latency/model-count from the existing health result shape), active toggle, delete.
3. **Routing section** (the core ask): per model, an ordered list of providers — each row: priority, provider name, upstream_model_id (editable text), remove. "Add provider to model" dropdown lists all active providers (all are Anthropic-standard for now). Priority 1 labeled "Primary", others "Backup #n". Keep it simple: reorder via up/down buttons, not drag-and-drop.

## 10. Phase 8 — Tests (vitest, in `test/`)

Follow existing test style. Minimum coverage:

1. **Route resolution**: model → routes ordered by priority; inactive provider/route excluded.
2. **Failover**: priority-1 returns 503 → priority-2 serves; 400 does NOT failover; all-fail returns the aggregate error; correct `provider_id` logged.
3. **Legacy migration**: boot with legacy settings + empty providers → provider & routes created, settings rows removed; boot again → no duplicate.

## 11. Acceptance checklist

- [ ] Admin can add ≥2 providers, assign both to `claude-sonnet-5` with priorities 1 and 2; kill provider 1 (bad key) → requests still succeed via provider 2; `usage_logs.provider_id` shows provider 2.
- [ ] Same failover proof for at least one more Claude model to confirm it's not a one-model fluke.
- [ ] Claude models keep working on `/v1/messages` exactly as before (regression: existing tests still pass).
- [ ] Provider API keys never appear in any API response, log line, or the dashboard after save.
- [ ] Model restrictions and budgets on issued keys apply identically to the routed flow as they did to the old single-subrouter flow.
- [ ] Fresh deploy of current production data migrates the legacy subrouter automatically with zero manual steps.

## 12. Explicitly OUT of scope (this build)

- **All OpenAI-standard work**: `/v1/chat/completions`, OpenAI usage extraction, `stream_options.include_usage` injection, OpenAI error format, DeepSeek/GPT catalog rows, user-facing `/v1/models`. Fully designed in §13 for when this is greenlit — do not start it now.
- Protocol translation (Anthropic model via OpenAI format or vice versa) — Option B, even later than §13.
- Per-provider cost tracking / margin reporting (only `provider_id` logging now, reporting later).
- Load balancing / weighted routing — priority failover only.
- Any change to issued-key auth, budgets, rate limiting, or pricing math.

## 13. Future phase (reference only — do NOT build yet)

Once the Anthropic-only router above is live and proven (acceptance checklist all green), the next phase adds OpenAI-standard support on the same schema:

- **Catalog**: add rows for latest OpenAI model (e.g. `gpt-5.1` — confirm exact ID against supplier) and DeepSeek V4 Pro / DeepSeek Flash (confirm exact IDs), all `standard = 'openai'`.
- **Upstream**: extend `ProviderTarget` handling — `openai` auth is `Authorization: Bearer <key>`, path is `${baseUrl}/v1/chat/completions`. Inject `stream_options: { include_usage: true }` into streaming request bodies (merge, don't clobber) — without it OpenAI-format streams carry no usage data and billing silently records zero.
- **New endpoint** `POST /v1/chat/completions` (`src/routes/proxy/chatCompletions.ts`), mirroring `/v1/messages`'s pipeline. Client auth via `Authorization: Bearer <issued-key>` (also accept `x-api-key`). Errors in OpenAI format — add `sendOpenAiError` to `src/lib/errors.ts` (`{ error: { message, type, code } }`).
- **OpenAI usage extraction** (extend `src/lib/usageExtract.ts`, Anthropic path untouched): non-streaming reads `usage.prompt_tokens` / `usage.completion_tokens` / `usage.prompt_tokens_details.cached_tokens`; map to the existing 4-counter `CapturedUsage` via `inputTokens = prompt_tokens - cached_tokens`, `outputTokens = completion_tokens`, `cacheReadInputTokens = cached_tokens`, `cacheCreationInputTokens = 0`. Streaming: new `OpenAiStreamingUsageAccumulator` captures `chunk.usage` from the final SSE chunk before `[DONE]` (last write wins; every OpenAI SSE event is an untyped `data: {json}` line, unlike Anthropic's named events).
- **User-facing `GET /v1/models`**: return active catalog models the key may use, OpenAI-style list shape (`{ object: "list", data: [{ id, owned_by: brand }] }` plus a non-standard `standard` field so callers know which endpoint to use).
- **Endpoint/standard mismatch guard**: calling an `openai`-standard model on `/v1/messages` (or an `anthropic`-standard model on `/v1/chat/completions`) returns a clear `invalid_request_error` naming the correct endpoint.
- **Admin/dashboard**: un-hide the brand/standard pickers hidden in §9 above; provider "add to model" dropdown filters to same-standard providers only.
- **Tests**: OpenAI usage mapping (incl. cached_tokens subtraction), streaming accumulator, `stream_options.include_usage` injection (added when absent, merged when present), endpoint/standard mismatch on both directions.
