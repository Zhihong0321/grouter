# grouter Switcher

Tauri v2 desktop app (Windows + macOS). See [`../tauri-build-plan.md`](../tauri-build-plan.md)
for the full design. This is the milestone 2-7 scaffold — written but **not
yet compiled or run**; expect a `cargo build` / `pnpm install` pass to be
needed before it runs.

## Setup

```bash
pnpm install
pnpm tauri icon path/to/1024x1024-source.png   # generates src-tauri/icons/* -- required before `tauri build` will bundle
pnpm tauri dev
```

## Required before it can talk to the backend

- **`GROUTER_BOOTSTRAP_SECRET`** must be set in the environment when you run
  `cargo build` / `pnpm tauri build` (baked in via `option_env!` in
  [`src-tauri/src/config.rs`](src-tauri/src/config.rs)). It must be the exact
  same value as `CLIENT_BOOTSTRAP_SECRET` on the grouter backend, or every
  `POST /client/accounts` call will get rejected with 401.
- Rust crates used: `serde`/`serde_json` (settings.json), `toml_edit`
  (config.toml — format-preserving), `reqwest` (rustls, no OpenSSL dep),
  `keyring` (OS keychain for the issued key + recovery password), `dirs`
  (home/config dir resolution), `open` (reveal config dirs in Explorer/Finder).

## What's implemented vs. still open

Implemented per the plan: onboarding (apply/recover, user-typed recovery
password), `GET /v1/models` verify flow, Claude Code `settings.json`
merge/restore + backup, a Codex Desktop/CLI/IDE shared `config.toml` GROUTER
BYOK switch with merge/restore + backup, a `state.json` snapshot model, and a
basic drift check surfaced in `get_status`.

For Codex, the GROUTER provider is shared by every verified OpenAI model. The
model selector sets only the default for the next session; the switcher can be
enabled without choosing one and changing the selector while enabled re-applies
the config safely. Codex still uses one model per thread, so switching models
means starting a new session after the config change.

Not yet done (see plan §9 milestones 9-10): app icons (needs a real source
image), code signing / notarization, the CI matrix build for Windows + macOS,
and the manual test matrix (fresh machine, existing config, drift, recover-on-
new-machine, both tools independently, both OSes). None of this was run
locally per this repo's standing "no local testing" rule — compile and smoke-
test it yourself before shipping.
