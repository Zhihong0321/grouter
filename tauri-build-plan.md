# Tauri Client App — "grouter Switcher" Build Plan

A small cross-platform desktop app (Tauri v2, Windows + macOS). The user pastes
**one key** (`sk-<brand>-<random>`, issued from the grouter reseller dashboard).
The app then acts as an **on/off switcher** that rewires three tools to route
through the grouter proxy instead of the official Anthropic / OpenAI endpoints:

1. **Claude Code CLI** (and the Claude Code VS Code extension / desktop, which
   read the same settings file).
2. **Codex CLI**.
3. **Codex desktop app / IDE extension** (shares the same `~/.codex/` directory
   as the CLI).

Turning the switch **OFF** restores each tool's previous configuration.

---

## 1. Decisions (locked)

| Question | Decision |
| --- | --- |
| Proxy base URL | **Bundled** default: `https://grouter-production.up.railway.app` (editable in an Advanced field, stored per-install). Trailing slash stripped. |
| Switch behavior | **Toggle ON/OFF.** ON applies proxy config; OFF restores the prior config that was captured at ON time. |
| Apply method | **Edit config files** (`~/.claude/settings.json`, `~/.codex/config.toml`) with backup + restore. Persists across terminal sessions and reboots; no shell needed. |
| Platforms | **Windows + macOS.** (`%USERPROFILE%` vs `$HOME`; honor `CODEX_HOME` / a `CLAUDE_CONFIG_DIR` override.) |

> Note: the base URL is bundled, but keep it **editable**. If you ever run a
> second proxy or a staging server you don't want to ship a new binary.

---

## 2. How grouter is wired (verified against this repo)

Client key format: `sk-<brand-prefix>-<random>`. Sent as either `x-api-key`
(Anthropic style) **or** `Authorization: Bearer` (OpenAI / gateway style) —
the proxy accepts both (`src/lib/keyAuth.ts`).

Endpoints the app relies on:

| Purpose | Method + path | Auth header the app sends |
| --- | --- | --- |
| Verify key + list **Anthropic** models | `GET /v1/models` | `x-api-key: <key>` |
| List **OpenAI/Codex** models | `GET /v1/models` | `Authorization: Bearer <key>` |
| (Claude Code runtime) messages | `POST /v1/messages`, `/v1/messages/count_tokens` | set by Claude Code |
| (Codex runtime) responses | `POST /v1/responses` | set by Codex |

`GET /v1/models` **requires a valid, active key** and returns Anthropic-shaped
models for `x-api-key` and OpenAI-shaped models for `Bearer`
(`src/routes/proxy/models.ts`). That single endpoint gives us both key
validation and two model pickers.

**Codex wire API:** Codex dropped Chat Completions; custom providers must use
`wire_api = "responses"` → `POST /v1/responses`, which the proxy implements
(`src/routes/proxy/openai.ts:157`). Do **not** use `wire_api = "chat"`.

---

## 3. Exact config transforms

The app never hand-writes free-form text into user files. It parses, mutates
the specific keys it owns, and re-serializes — preserving everything else.

### 3.1 Claude Code — `~/.claude/settings.json`

Claude Code reads an `env` block from this JSON file at startup and applies it
no matter how `claude` was launched. Windows path: `%USERPROFILE%\.claude\settings.json`.
Respect a `CLAUDE_CONFIG_DIR` env override if set.

**ON** — merge these keys into the existing `env` object:

```jsonc
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://grouter-production.up.railway.app",
    "ANTHROPIC_AUTH_TOKEN": "sk-<brand>-<random>",
    // optional, only if the user picked a default model in the app:
    "ANTHROPIC_MODEL": "<selected-anthropic-model-id>"
  }
}
```

- Use `ANTHROPIC_AUTH_TOKEN` (→ `Authorization: Bearer`), **not**
  `ANTHROPIC_API_KEY`. Bearer is the gateway path and takes precedence.
- Set the URL to the **host root** — Claude Code appends `/v1/messages` itself.

**OFF** — restore the exact prior values of the three keys we touched (see
§4 state model). If a key didn't exist before, remove it; if it had a value,
put that value back. Leave all other `env` entries and settings untouched.

**Gotcha to surface in the UI:** a prior `claude login` (subscription) session
can take precedence over `ANTHROPIC_AUTH_TOKEN` when the base URL is
`api.anthropic.com`. Because we override the base URL to grouter this is
normally fine, but if a user reports "still hitting Anthropic," the fix is
`claude logout`. Also: Claude Code reads config **once at startup** — after
toggling, the user must restart Claude Code / reload the VS Code window.

### 3.2 Codex CLI + desktop — `~/.codex/config.toml`

The CLI, IDE extension, and desktop app **all share** `~/.codex/`
(`%USERPROFILE%\.codex\` on Windows; overridable via `CODEX_HOME`). Custom
providers **must** live in the user-level `config.toml` (project-local
`.codex/` is ignored for provider keys as a security boundary), so writing this
one file covers both the CLI and the desktop app.

**ON** — set top-level `model_provider` (+ optional `model`) and add a provider
table:

```toml
model_provider = "grouter"
model = "<selected-openai-model-id>"   # required by Codex; from GET /v1/models

[model_providers.grouter]
name = "grouter"
base_url = "https://grouter-production.up.railway.app/v1"
wire_api = "responses"
requires_openai_auth = false           # our key prefix is sk-<brand>-, not sk-openai
experimental_bearer_token = "sk-<brand>-<random>"
```

Two ways to supply the key — the app picks based on reliability:

- **`experimental_bearer_token` (recommended for this app).** Puts the key
  directly in `config.toml`. Works identically for the CLI **and** the GUI
  desktop app, because it does not depend on the process inheriting a shell
  env var. Simplest to toggle. Trade-off: key sits in a local plaintext file
  (same exposure as the Claude Code `settings.json` case).
- **`env_key = "GROUTER_API_KEY"` (alternative).** Cleaner secret hygiene, but
  the named env var must be visible to the process. A GUI app launched from the
  Start menu / Dock does **not** inherit shell exports — on Windows you'd have
  to set a user-level env var (persisted, GUI apps see it after relaunch); on
  macOS a plain `export` won't reach the Dock-launched app at all. Because the
  desktop app is an explicit target, default to `experimental_bearer_token`.

Note `base_url` here ends in **`/v1`** (OpenAI convention); the Claude Code URL
does **not**. Codex also only re-reads config at startup — restart Codex /
reload the extension after toggling.

**OFF** — remove the `[model_providers.grouter]` table, and restore the prior
`model_provider` / `model` values (or remove them if they didn't exist before).

---

## 4. State model (what makes OFF safe)

The switch is only trustworthy if OFF restores *exactly* what was there. The app
keeps its own state file in the Tauri app-config dir
(`$APPCONFIG/grouter-switcher/state.json`), never inside the tools' dirs:

```jsonc
{
  "baseUrl": "https://grouter-production.up.railway.app",
  "keyRef": "<opaque handle or the key itself — see §7>",
  "selectedAnthropicModel": "…",
  "selectedOpenAiModel": "…",
  "claude": {
    "enabled": true,
    "snapshot": {            // captured at the moment we turned ON
      "ANTHROPIC_BASE_URL":  { "existed": false },
      "ANTHROPIC_AUTH_TOKEN":{ "existed": false },
      "ANTHROPIC_MODEL":     { "existed": true, "value": "claude-3-5-sonnet" }
    }
  },
  "codex": {
    "enabled": true,
    "snapshot": {
      "model_provider": { "existed": false },
      "model":          { "existed": true, "value": "gpt-5.4" }
    }
  }
}
```

Rules:
- On **ON**: before mutating, snapshot the prior value of every key we touch
  (existed? / value). Also drop a full timestamped file backup:
  `settings.json.grouter.bak` / `config.toml.grouter.bak`.
- On **OFF**: replay the snapshot key-by-key (restore or delete). Then clear
  `enabled`.
- On app start: **reconcile** — re-read the live files and confirm our keys are
  still present/correct. If a user hand-edited the file, show "config drifted"
  rather than a stale toggle. This prevents the classic switcher bug where the
  UI says ON but the file says otherwise.
- Idempotent: turning ON when already ON just refreshes values; OFF when
  already OFF is a no-op.

---

## 5. Tauri architecture

```
grouter-switcher/
├─ src/                      # frontend (React + Vite + TS — matches dashboard stack)
│  ├─ App.tsx                # single-window UI (§6)
│  └─ api.ts                 # thin wrappers over invoke()
├─ src-tauri/
│  ├─ src/
│  │  ├─ main.rs
│  │  ├─ commands.rs         # #[tauri::command] surface (§5.1)
│  │  ├─ paths.rs            # resolve ~/.claude, ~/.codex, CODEX_HOME, etc.
│  │  ├─ claude.rs           # settings.json read / merge / restore
│  │  ├─ codex.rs            # config.toml read / merge / restore
│  │  ├─ verify.rs           # GET /v1/models key check + model lists
│  │  └─ state.rs            # state.json + backups + reconcile
│  ├─ tauri.conf.json
│  └─ Cargo.toml
└─ tauri-build-plan.md
```

Rust crates: `serde` / `serde_json` (settings.json), `toml_edit` (format- and
comment-preserving TOML edits — important, don't use plain `toml`), `reqwest`
(verify calls), `dirs` (home dir), optional `keyring` (§7).

### 5.1 Command surface (Rust ↔ frontend)

| Command | Does |
| --- | --- |
| `get_status()` | Returns per-tool `{ installed, enabled, drifted }` + current base URL + selected models. Runs reconcile. |
| `verify_key(base_url, key)` | `GET {base}/v1/models` with `x-api-key` → `{ valid, anthropicModels }`; and with `Bearer` → `{ openAiModels }`. Distinguish 401 (bad key) from network error. |
| `set_config(base_url, key, anthropicModel?, openAiModel?)` | Persists to state (validates first). |
| `toggle_claude(on)` | Apply/restore §3.1. Backup on ON. |
| `toggle_codex(on)` | Apply/restore §3.2. Backup on ON. |
| `detect_tools()` | Best-effort: does `~/.claude` / `~/.codex` exist? Is `claude` / `codex` on PATH? Purely to guide the UI. |
| `open_config_dir(tool)` | Reveal the file in Explorer/Finder for troubleshooting. |

All commands return a typed `Result<T, AppError>`; surface errors as toasts, not
panics.

---

## 6. UI (single window, ~480×620)

```
┌──────────────────────────────────────────┐
│  grouter Switcher                          │
│                                            │
│  Key  [ sk-••••••••••••••••••••  ] [Verify]│
│  ✓ Key valid · 6 models available          │
│                                            │
│  Claude Code            [  ON  ●———  ]     │
│     model ▾ [ claude-… (optional)     ]    │
│                                            │
│  Codex (CLI + desktop)  [ ●———  OFF  ]     │
│     model ▾ [ gpt-… (required)        ]    │
│                                            │
│  ⚠ Restart Claude Code / Codex after toggle│
│                                            │
│  ▸ Advanced                                │
│     Server URL [ https://grouter-…app  ]   │
│     [Open ~/.claude]  [Open ~/.codex]      │
└──────────────────────────────────────────┘
```

Behavior:
- **Verify** must succeed before toggles enable. Cache the model lists.
- Each toggle is independent (a user may only use Claude Code, or only Codex).
- After any toggle, show the persistent "restart the tool" reminder.
- If `get_status` reports `drifted`, show an amber banner with a "Re-apply" and
  "Adopt current" choice instead of silently flipping the switch.
- Codex model is **required** (Codex needs `model` in config.toml); disable the
  Codex toggle until one is chosen. Claude Code model is optional.

---

## 7. Security & secrets

- The key is a bearer credential. It is written in **plaintext into the tools'
  own config files by design** (that's how the tools authenticate) — so the
  app's own storage can't make the key more secret than the tools already do.
- Still, prefer storing the app's copy in the OS keychain via the `keyring`
  crate (Windows Credential Manager / macOS Keychain) and keep only a reference
  in `state.json`. Fall back to an app-config file if the keychain is
  unavailable. **Never** log the key; mask it in the UI (show last 4).
- `state.json` and `*.grouter.bak` live in the app-config dir with user-only
  perms. Don't write anything to a repo or a synced/temp dir.
- Do not send the key anywhere except the configured grouter base URL. The base
  URL is app-owned/bundled, not derived from any external content.

---

## 8. Edge cases to handle explicitly

- **File doesn't exist yet.** Create `~/.claude/settings.json` as `{"env":{…}}`
  or `~/.codex/config.toml` fresh. Create parent dirs.
- **Malformed existing file.** Don't clobber. Back it up, report "couldn't
  parse — opened it for you," and abort that tool's toggle.
- **`CODEX_HOME` / `CLAUDE_CONFIG_DIR` set.** Resolve those first.
- **Existing custom provider in Codex.** If `model_provider` already points at a
  non-grouter provider, snapshot it and restore on OFF (don't assume default).
- **Concurrent external edit / drift.** Reconcile on focus + on start (§4).
- **Network down during Verify.** Distinguish from invalid key; allow retry.
- **Key revoked later.** Verify returns 401; if currently ON, warn but leave the
  config (user may re-enable the key server-side) — don't auto-OFF silently.
- **Trailing slash / path in base URL.** Normalize: strip trailing `/`; Claude
  URL = root, Codex `base_url` = root + `/v1`.

---

## 9. Milestones

1. **Scaffold** — `create-tauri-app` (React+TS), single window, `get_status`
   stub, Windows + macOS build in CI.
2. **Verify flow** — `verify_key` + model pickers against `GET /v1/models`.
3. **Claude Code toggle** — `settings.json` merge/restore + snapshot + backup;
   reconcile.
4. **Codex toggle** — `config.toml` via `toml_edit`; `wire_api="responses"`,
   `experimental_bearer_token`; snapshot/restore.
5. **State + drift** — `state.json`, reconcile on start/focus, drift banner.
6. **Polish** — keychain storage, masked key, "open config dir", restart
   reminders, icons, signing/notarization for macOS, MSI/NSIS for Windows.
7. **Manual test matrix** — fresh machine (no config files), existing config,
   drift, revoked key, both tools on/off independently, on both OSes.

---

## 10. Open items for later (not blocking build)

- Optional auto-detect of whether Claude Code / Codex is actually installed to
  hide irrelevant toggles.
- Optional "usage" panel if grouter later exposes a per-key usage endpoint.
- Auto-update (Tauri updater) so you can ship base-URL or provider-format
  changes without users reinstalling.

---

### Sources

- [Claude Code environment variables (official docs)](https://code.claude.com/docs/en/env-vars)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference) · [advanced config](https://developers.openai.com/codex/config-advanced)
- [Codex config directory `~/.codex` shared by CLI/IDE/desktop](https://developers.openai.com/codex/config-basic)
- This repo: `src/lib/keyAuth.ts`, `src/routes/proxy/models.ts`, `src/routes/proxy/messages.ts`, `src/routes/proxy/openai.ts`, `src/lib/keyIssuance.ts`, `.env.example`
