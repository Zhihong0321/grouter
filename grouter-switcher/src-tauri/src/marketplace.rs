use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use include_dir::{include_dir, Dir};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use crate::tools::{emit_tool_log, run_streamed, shell_command, ToolLogDonePayload};

/// Skill files vendored into the repo and compiled straight into the binary.
/// Bundling this way means "install" is a local file copy -- no npx/pip/claude
/// CLI, no network, no PATH, no interactive prompts, no streamed output that can
/// stall. Enable writes the folders, disable removes them; that's the whole
/// mechanism. See `resources/skills/`.
static BUNDLED_SKILLS: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/resources/skills");

/// A marketplace entry whose install is just "drop these skill folders into the
/// agent's skills dir". `dirs` are folder names that must exist under
/// `resources/skills/` (and become `~/.<agent>/skills/<dir>`); `agents` lists
/// which agents can receive them.
struct BundledPlan {
    dirs: &'static [&'static str],
    agents: &'static [&'static str],
}

impl BundledPlan {
    fn supports(&self, agent: &str) -> bool {
        self.agents.contains(&agent)
    }
}

/// Recursively writes an embedded skill dir out under `skills_root`. Each
/// embedded file's path already carries its top-level skill-folder name (e.g.
/// `intent-layer/SKILL.md`), so joining onto `skills_root` reproduces the tree.
fn extract_dir(dir: &Dir, skills_root: &Path) -> std::io::Result<()> {
    for file in dir.files() {
        let dest = skills_root.join(file.path());
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(dest, file.contents())?;
    }
    for sub in dir.dirs() {
        extract_dir(sub, skills_root)?;
    }
    Ok(())
}

/// A single shell step, run via `shell_command` (handles Windows .cmd shims
/// for npm/npx/claude the same way tools.rs does for the CLI installers).
struct Step {
    program: &'static str,
    args: &'static [&'static str],
}

/// What proves an agent's install actually landed. None of these ship a
/// `--version`-style check the way tools.rs's CLIs do, so detection reads
/// the on-disk state the install step is documented to produce.
enum Detect {
    /// Marketplace name/source shows up in ~/.claude/plugins/known_marketplaces.json.
    ClaudeMarketplace(&'static str),
    /// Marketplace registered AND the plugin's cache dir exists. Falls back
    /// to "marketplace only" if the cache layout doesn't match what we
    /// guessed, since the exact schema isn't publicly documented.
    ClaudePlugin { marketplace: &'static str, plugin: &'static str },
    /// A skill folder named `<skill>` exists directly under the agent's skills
    /// dir (`~/.<agent>/skills/<skill>`) -- e.g. ECC's `ecc-install --target
    /// claude` writes its managed skills into `~/.claude/skills/ecc`.
    SkillDir { agent: &'static str, skill: &'static str },
    /// For plain pip-installed CLIs (not a Claude/Codex plugin at all):
    /// a console_scripts entry point landing on PATH is the install signal.
    Binary(&'static str),
}

struct AgentPlan {
    steps: &'static [Step],
    detect: Detect,
}

struct MarketplaceEntry {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    source_url: &'static str,
    windows: bool,
    mac: bool,
    /// When set, this entry installs by copying vendored skill folders rather
    /// than running an installer; `claude`/`codex` are then unused.
    bundle: Option<BundledPlan>,
    claude: Option<AgentPlan>,
    codex: Option<AgentPlan>,
    /// Shown when an agent isn't automated here but the upstream project
    /// documents its own path for it (e.g. ECC's multi-harness installer).
    codex_note: Option<&'static str>,
}

static ENTRIES: &[MarketplaceEntry] = &[
    MarketplaceEntry {
        id: "ecc",
        label: "ECC",
        description: "278+ skills, 67+ agents, hooks and cross-harness config for Claude Code, Codex, Cursor and OpenCode.",
        source_url: "https://github.com/affaan-m/ECC",
        windows: true,
        mac: true,
        bundle: None,
        // Use ECC's own installer rather than `claude plugin install`. The
        // plugin route silently drops rules and hooks (an upstream plugin
        // limitation ECC documents), whereas `ecc-install --target claude`
        // writes the full managed set -- skills, agents, rules/ecc, and
        // hooks/hooks.json. `ecc-install` is a bin of the `ecc-universal`
        // package, so `-p ecc-universal` names it explicitly and `-y` skips
        // npx's "install this package?" prompt so it can't stall.
        claude: Some(AgentPlan {
            steps: &[
                Step {
                    program: "npx",
                    args: &["-y", "-p", "ecc-universal", "ecc-install", "--profile", "full", "--target", "claude"],
                },
            ],
            detect: Detect::SkillDir { agent: "claude", skill: "ecc" },
        }),
        codex: Some(AgentPlan {
            steps: &[
                Step {
                    program: "npx",
                    args: &["-y", "-p", "ecc-universal", "ecc-install", "--profile", "full", "--target", "codex"],
                },
            ],
            detect: Detect::SkillDir { agent: "codex", skill: "ecc" },
        }),
        codex_note: None,
    },
    MarketplaceEntry {
        id: "claude-plugins-official",
        label: "Anthropic Official Marketplace",
        description: "Anthropic's own vetted marketplace: 100+ plugins including partner integrations (GitHub, Linear, Sentry, Stripe, Figma) and flagship community plugins.",
        source_url: "https://github.com/anthropics/claude-plugins-official",
        windows: true,
        mac: true,
        bundle: None,
        claude: Some(AgentPlan {
            steps: &[Step { program: "claude", args: &["plugin", "marketplace", "add", "anthropics/claude-plugins-official"] }],
            detect: Detect::ClaudeMarketplace("claude-plugins-official"),
        }),
        codex: None,
        codex_note: None,
    },
    MarketplaceEntry {
        id: "superpowers",
        label: "Superpowers",
        description: "The most-installed 3rd-party Claude Code plugin (752K installs) -- a TDD/planning/debugging skills methodology.",
        source_url: "https://github.com/obra/superpowers-marketplace",
        windows: true,
        mac: true,
        bundle: None,
        claude: Some(AgentPlan {
            steps: &[
                Step { program: "claude", args: &["plugin", "marketplace", "add", "obra/superpowers-marketplace"] },
                Step { program: "claude", args: &["plugin", "install", "superpowers@superpowers-marketplace"] },
            ],
            detect: Detect::ClaudePlugin { marketplace: "superpowers-marketplace", plugin: "superpowers" },
        }),
        codex: None,
        codex_note: Some(
            "Superpowers documents Codex CLI support through its own per-agent setup -- see obra/superpowers docs; not automated here.",
        ),
    },
    MarketplaceEntry {
        id: "caveman",
        label: "Caveman",
        description: "Compresses agent output ~65% while preserving accuracy -- terse responses, same substance.",
        source_url: "https://github.com/JuliusBrussee/caveman",
        windows: true,
        mac: true,
        // Caveman ships as a set of cooperating skills; bundle the whole set and
        // drop them straight into the agent's skills dir.
        bundle: Some(BundledPlan {
            dirs: &[
                "caveman",
                "caveman-compress",
                "caveman-commit",
                "caveman-review",
                "caveman-stats",
                "caveman-help",
                "cavecrew",
            ],
            agents: &["claude", "codex"],
        }),
        claude: None,
        codex: None,
        codex_note: None,
    },
    MarketplaceEntry {
        id: "intent-layer",
        label: "Intent Layer",
        description: "Sets up hierarchical AGENTS.md/CLAUDE.md context files so agents navigate your codebase like a senior engineer.",
        source_url: "https://github.com/crafter-station/skills/tree/main/context-engineering/intent-layer",
        windows: true,
        mac: true,
        bundle: Some(BundledPlan { dirs: &["intent-layer"], agents: &["claude"] }),
        claude: None,
        codex: None,
        codex_note: Some("This skill targets Claude Code specifically per its own docs; no Codex install path is published."),
    },
    MarketplaceEntry {
        id: "crawl4ai",
        label: "Crawl4AI",
        description: "Python web-crawling library/CLI for feeding live page content to LLM agents. Not a Claude/Codex plugin -- installs the same regardless of which agent you use it from.",
        source_url: "https://github.com/unclecode/crawl4ai",
        windows: true,
        mac: true,
        bundle: None,
        claude: Some(AgentPlan {
            steps: &[
                Step { program: "pip", args: &["install", "-U", "crawl4ai"] },
                Step { program: "crawl4ai-setup", args: &[] },
            ],
            detect: Detect::Binary("crawl4ai-doctor"),
        }),
        codex: None,
        codex_note: Some(
            "Installs the core Python package/CLI only, exactly per its own README -- there's no single official MCP server from this project to auto-wire into Claude/Codex (several unofficial third-party wrappers exist). To actually call it from Claude Code or Codex, register an MCP server yourself once installed.",
        ),
    },
];

fn entry_for(id: &str) -> Result<&'static MarketplaceEntry, AppError> {
    ENTRIES.iter().find(|e| e.id == id).ok_or_else(|| AppError::NotFound(format!("Unknown marketplace entry \"{id}\"")))
}

fn plan_for<'a>(entry: &'a MarketplaceEntry, agent: &str) -> Result<&'a AgentPlan, AppError> {
    match agent {
        "claude" => entry.claude.as_ref(),
        "codex" => entry.codex.as_ref(),
        _ => None,
    }
    .ok_or_else(|| AppError::NotFound(format!("No automated {agent} install for \"{}\"", entry.id)))
}

fn agent_config_dir(agent: &str) -> PathBuf {
    match agent {
        "codex" => crate::paths::codex_config_dir(),
        _ => crate::paths::claude_config_dir(),
    }
}

/// Searches both string values and object keys, since the exact schema of
/// known_marketplaces.json isn't publicly documented -- a marketplace name
/// could plausibly appear as either (e.g. `{"<name>": {...}}` vs
/// `{"entries": [{"name": "<name>"}]}`).
fn json_contains(value: &Value, needle: &str) -> bool {
    let needle = needle.to_lowercase();
    match value {
        Value::String(s) => s.to_lowercase().contains(&needle),
        Value::Array(arr) => arr.iter().any(|v| json_contains(v, &needle)),
        Value::Object(obj) => obj.iter().any(|(k, v)| k.to_lowercase().contains(&needle) || json_contains(v, &needle)),
        _ => false,
    }
}

fn known_marketplaces() -> Option<Value> {
    let path = crate::paths::claude_config_dir().join("plugins").join("known_marketplaces.json");
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn marketplace_registered(name: &str) -> bool {
    known_marketplaces().map(|v| json_contains(&v, name)).unwrap_or(false)
}

/// Best-effort: the plugin cache's exact on-disk layout under
/// ~/.claude/plugins/cache/ isn't publicly documented, so this checks the
/// obvious `<marketplace>/<plugin>` path plus one level of fallback.
fn plugin_cache_dir_exists(marketplace: &str, plugin: &str) -> bool {
    let marketplace_dir = crate::paths::claude_config_dir().join("plugins").join("cache").join(marketplace);
    if marketplace_dir.join(plugin).exists() {
        return true;
    }
    let Ok(entries) = fs::read_dir(&marketplace_dir) else { return false };
    entries.flatten().any(|e| e.path().join(plugin).exists() || e.file_name().to_string_lossy() == plugin)
}

fn skill_dir_exists(agent: &str, skill: &str) -> bool {
    agent_config_dir(agent).join("skills").join(skill).exists()
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InstallState {
    NotInstalled,
    MarketplaceAdded,
    Installed,
    Unsupported,
}

fn detect_state(detect: &Detect) -> InstallState {
    match detect {
        Detect::ClaudeMarketplace(name) => {
            if marketplace_registered(name) {
                InstallState::Installed
            } else {
                InstallState::NotInstalled
            }
        }
        Detect::ClaudePlugin { marketplace, plugin } => {
            if plugin_cache_dir_exists(marketplace, plugin) {
                InstallState::Installed
            } else if marketplace_registered(marketplace) {
                InstallState::MarketplaceAdded
            } else {
                InstallState::NotInstalled
            }
        }
        Detect::SkillDir { agent, skill } => {
            if skill_dir_exists(agent, skill) {
                InstallState::Installed
            } else {
                InstallState::NotInstalled
            }
        }
        Detect::Binary(name) => {
            if which::which(name).is_ok() {
                InstallState::Installed
            } else {
                InstallState::NotInstalled
            }
        }
    }
}

/// A bundled entry counts as installed only when *every* one of its skill
/// folders is present in the agent's skills dir; anything less is treated as
/// not installed so Enable re-writes the full set (the copy is idempotent).
fn bundled_state(plan: &BundledPlan, agent: &str) -> InstallState {
    let root = agent_config_dir(agent).join("skills");
    if plan.dirs.iter().all(|d| root.join(d).exists()) {
        InstallState::Installed
    } else {
        InstallState::NotInstalled
    }
}

/// Resolves an entry's state for one agent, preferring the bundled mechanism
/// when the entry has one for that agent and falling back to the shell plan.
fn agent_state(entry: &MarketplaceEntry, agent: &str) -> InstallState {
    if let Some(plan) = entry.bundle.as_ref().filter(|p| p.supports(agent)) {
        return bundled_state(plan, agent);
    }
    let shell_plan = match agent {
        "claude" => entry.claude.as_ref(),
        "codex" => entry.codex.as_ref(),
        _ => None,
    };
    shell_plan.map(|p| detect_state(&p.detect)).unwrap_or(InstallState::Unsupported)
}

fn bundle_supports(entry: &MarketplaceEntry, agent: &str) -> bool {
    entry.bundle.as_ref().is_some_and(|p| p.supports(agent))
}

#[derive(Serialize)]
pub struct MarketplaceEntryInfo {
    pub id: String,
    pub label: String,
    pub description: String,
    #[serde(rename = "sourceUrl")]
    pub source_url: String,
    pub windows: bool,
    pub mac: bool,
    #[serde(rename = "claudeSupported")]
    pub claude_supported: bool,
    #[serde(rename = "codexSupported")]
    pub codex_supported: bool,
    #[serde(rename = "codexNote")]
    pub codex_note: Option<String>,
    /// True when this entry installs by copying vendored skill files -- the UI
    /// shows an Enable/Disable toggle instead of an installer with a log stream.
    pub bundled: bool,
}

#[tauri::command]
pub fn list_marketplace_entries() -> Vec<MarketplaceEntryInfo> {
    ENTRIES
        .iter()
        .map(|e| MarketplaceEntryInfo {
            id: e.id.to_string(),
            label: e.label.to_string(),
            description: e.description.to_string(),
            source_url: e.source_url.to_string(),
            windows: e.windows,
            mac: e.mac,
            claude_supported: e.claude.is_some() || bundle_supports(e, "claude"),
            codex_supported: e.codex.is_some() || bundle_supports(e, "codex"),
            codex_note: e.codex_note.map(|s| s.to_string()),
            bundled: e.bundle.is_some(),
        })
        .collect()
}

#[derive(Serialize)]
pub struct MarketplaceStatus {
    pub claude: InstallState,
    pub codex: InstallState,
}

#[tauri::command]
pub fn detect_marketplace_status() -> HashMap<String, MarketplaceStatus> {
    ENTRIES
        .iter()
        .map(|e| {
            let claude = agent_state(e, "claude");
            let codex = agent_state(e, "codex");
            (e.id.to_string(), MarketplaceStatus { claude, codex })
        })
        .collect()
}

/// Runs an entry's install plan for one agent step by step, streaming output
/// over the same `tool-log`/`tool-log-done` events tools.rs uses (tagged
/// `marketplace:<id>:<agent>` so the frontend can tell the streams apart).
/// Every outcome writes a visible explanation before sending completion. A
/// successful process exit is not enough: the expected installed artifact
/// must be present before the UI can call the install successful.
#[tauri::command]
pub async fn install_marketplace_entry(app: AppHandle, id: String, agent: String) -> Result<(), AppError> {
    let entry = entry_for(&id)?;
    let plan = plan_for(entry, &agent)?;
    let log_id = format!("marketplace:{id}:{agent}");

    let step_count = plan.steps.len();
    emit_tool_log(&app, &log_id, format!("Preparing {agent} install for {}...", entry.label));

    for (index, step) in plan.steps.iter().enumerate() {
        if which::which(step.program).is_err() {
            let message = match step.program {
                "claude" => "Claude Code CLI is not installed -- install it from the Tools tab first".to_string(),
                "npx" => "Node.js (which provides npx) is not on PATH -- install Node.js first, then retry".to_string(),
                other => format!("\"{other}\" is not on PATH"),
            };
            emit_tool_log(&app, &log_id, format!("Cannot start step {} of {step_count}: {message}", index + 1));
            let _ = app.emit("tool-log-done", ToolLogDonePayload { tool: log_id, success: false, exit_code: None });
            return Ok(());
        }
        let command = std::iter::once(step.program)
            .chain(step.args.iter().copied())
            .collect::<Vec<_>>()
            .join(" ");
        emit_tool_log(&app, &log_id, format!("Step {} of {step_count}: {command}", index + 1));
        let cmd = shell_command(step.program, step.args);
        let (success, exit_code) = run_streamed(&app, &log_id, cmd).await?;
        if !success {
            emit_tool_log(&app, &log_id, format!("Step {} failed (exit code {}).", index + 1, exit_code.map_or("unknown".to_string(), |code| code.to_string())));
            let _ = app.emit("tool-log-done", ToolLogDonePayload { tool: log_id, success: false, exit_code });
            return Ok(());
        }
        emit_tool_log(&app, &log_id, format!("Step {} completed.", index + 1));
    }

    emit_tool_log(&app, &log_id, "Verifying the expected installation files...");
    if detect_state(&plan.detect) != InstallState::Installed {
        emit_tool_log(&app, &log_id, "The installer exited successfully, but the expected files were not found. Installation was not completed.");
        let _ = app.emit("tool-log-done", ToolLogDonePayload { tool: log_id, success: false, exit_code: Some(0) });
        return Ok(());
    }

    emit_tool_log(&app, &log_id, "Verified installed successfully.");
    let _ = app.emit("tool-log-done", ToolLogDonePayload { tool: log_id, success: true, exit_code: Some(0) });
    Ok(())
}

fn bundle_for<'a>(entry: &'a MarketplaceEntry, agent: &str) -> Result<&'a BundledPlan, AppError> {
    entry
        .bundle
        .as_ref()
        .filter(|p| p.supports(agent))
        .ok_or_else(|| AppError::NotFound(format!("No bundled {agent} skill for \"{}\"", entry.id)))
}

/// Installs a bundled entry by writing its vendored skill folders into the
/// agent's skills dir. Synchronous and offline -- returns Ok only when every
/// folder has actually been written, so the UI never shows a false success.
#[tauri::command]
pub fn enable_bundled_skill(id: String, agent: String) -> Result<(), AppError> {
    let entry = entry_for(&id)?;
    let plan = bundle_for(entry, &agent)?;
    let skills_root = agent_config_dir(&agent).join("skills");

    for dir_name in plan.dirs {
        let src = BUNDLED_SKILLS
            .get_dir(dir_name)
            .ok_or_else(|| AppError::NotFound(format!("Bundled skill \"{dir_name}\" is missing from this build")))?;
        // Replace any prior copy so a re-enable can't leave stale files behind.
        let dest = skills_root.join(dir_name);
        if dest.exists() {
            fs::remove_dir_all(&dest).map_err(|e| AppError::Io(e.to_string()))?;
        }
        extract_dir(src, &skills_root).map_err(|e| AppError::Io(e.to_string()))?;
    }

    if bundled_state(plan, &agent) != InstallState::Installed {
        return Err(AppError::Io("Skill files were written but could not be verified on disk".to_string()));
    }
    Ok(())
}

/// Removes a bundled entry's skill folders from the agent's skills dir.
#[tauri::command]
pub fn disable_bundled_skill(id: String, agent: String) -> Result<(), AppError> {
    let entry = entry_for(&id)?;
    let plan = bundle_for(entry, &agent)?;
    let skills_root = agent_config_dir(&agent).join("skills");

    for dir_name in plan.dirs {
        let dest = skills_root.join(dir_name);
        if dest.exists() {
            fs::remove_dir_all(&dest).map_err(|e| AppError::Io(e.to_string()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::lock_env;

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("grouter-switcher-marketplace-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn json_contains_finds_nested_string_case_insensitively() {
        let value: Value = serde_json::from_str(r#"{"marketplaces":[{"name":"Superpowers-Marketplace","source":{"repo":"obra/superpowers-marketplace"}}]}"#).unwrap();
        assert!(json_contains(&value, "superpowers-marketplace"));
        assert!(json_contains(&value, "OBRA/SUPERPOWERS"));
        assert!(!json_contains(&value, "ecc"));
    }

    #[test]
    fn marketplace_registered_reads_known_marketplaces_file() {
        let _guard = lock_env();
        let dir = sandbox("known-marketplaces");
        unsafe {
            std::env::set_var("CLAUDE_CONFIG_DIR", &dir);
        }
        assert!(!marketplace_registered("caveman"));

        fs::create_dir_all(dir.join("plugins")).unwrap();
        fs::write(dir.join("plugins").join("known_marketplaces.json"), r#"{"caveman":{"source":"JuliusBrussee/caveman"}}"#).unwrap();
        assert!(marketplace_registered("caveman"));
        assert!(!marketplace_registered("ecc"));
    }

    #[test]
    fn plugin_cache_dir_exists_checks_direct_and_one_level_fallback() {
        let _guard = lock_env();
        let dir = sandbox("plugin-cache");
        unsafe {
            std::env::set_var("CLAUDE_CONFIG_DIR", &dir);
        }
        assert!(!plugin_cache_dir_exists("ecc", "ecc"));

        fs::create_dir_all(dir.join("plugins").join("cache").join("ecc").join("ecc")).unwrap();
        assert!(plugin_cache_dir_exists("ecc", "ecc"));

        // fallback: plugin nested one level deeper (e.g. under a version dir)
        fs::create_dir_all(dir.join("plugins").join("cache").join("superpowers-marketplace").join("v1").join("superpowers")).unwrap();
        assert!(plugin_cache_dir_exists("superpowers-marketplace", "superpowers"));
    }

    #[test]
    fn skill_dir_exists_honors_claude_config_dir_and_codex_home() {
        let _guard = lock_env();
        let claude_dir = sandbox("skills-claude");
        let codex_dir = sandbox("skills-codex");
        unsafe {
            std::env::set_var("CLAUDE_CONFIG_DIR", &claude_dir);
            std::env::set_var("CODEX_HOME", &codex_dir);
        }

        assert!(!skill_dir_exists("claude", "intent-layer"));
        assert!(!skill_dir_exists("codex", "caveman"));

        fs::create_dir_all(claude_dir.join("skills").join("intent-layer")).unwrap();
        fs::create_dir_all(codex_dir.join("skills").join("caveman")).unwrap();

        assert!(skill_dir_exists("claude", "intent-layer"));
        assert!(skill_dir_exists("codex", "caveman"));
        assert!(!skill_dir_exists("claude", "caveman"));
    }

    #[test]
    fn binary_detect_reflects_path_membership() {
        let _guard = lock_env();
        let dir = sandbox("binary-detect");
        let fake_bin_dir = dir.join("bin");
        fs::create_dir_all(&fake_bin_dir).unwrap();
        fs::write(fake_bin_dir.join("fake-crawl4ai-doctor.cmd"), "@echo off\n").unwrap();

        let original_path = std::env::var("PATH").unwrap_or_default();
        assert!(which::which("fake-crawl4ai-doctor").is_err());
        assert!(matches!(detect_state(&Detect::Binary("fake-crawl4ai-doctor")), InstallState::NotInstalled));

        unsafe {
            std::env::set_var("PATH", format!("{};{}", fake_bin_dir.display(), original_path));
        }
        assert!(matches!(detect_state(&Detect::Binary("fake-crawl4ai-doctor")), InstallState::Installed));
        assert!(matches!(detect_state(&Detect::Binary("definitely-does-not-exist-xyz")), InstallState::NotInstalled));

        unsafe {
            std::env::set_var("PATH", original_path);
        }
    }

    #[test]
    fn detect_state_falls_back_from_installed_to_marketplace_added_to_not_installed() {
        let _guard = lock_env();
        let dir = sandbox("detect-state");
        unsafe {
            std::env::set_var("CLAUDE_CONFIG_DIR", &dir);
        }
        let detect = Detect::ClaudePlugin { marketplace: "caveman", plugin: "caveman" };
        assert!(matches!(detect_state(&detect), InstallState::NotInstalled));

        fs::create_dir_all(dir.join("plugins")).unwrap();
        fs::write(dir.join("plugins").join("known_marketplaces.json"), r#"{"caveman":{}}"#).unwrap();
        assert!(matches!(detect_state(&detect), InstallState::MarketplaceAdded));

        fs::create_dir_all(dir.join("plugins").join("cache").join("caveman").join("caveman")).unwrap();
        assert!(matches!(detect_state(&detect), InstallState::Installed));
    }

    #[test]
    fn every_entry_has_at_least_one_automated_agent_and_well_formed_steps() {
        for entry in ENTRIES {
            assert!(
                entry.claude.is_some() || entry.codex.is_some() || entry.bundle.is_some(),
                "{} has no automated install path at all",
                entry.id
            );
            for plan in [&entry.claude, &entry.codex].into_iter().flatten() {
                assert!(!plan.steps.is_empty(), "{} has an agent plan with zero steps", entry.id);
                for step in plan.steps {
                    assert!(
                        matches!(step.program, "claude" | "npx" | "pip" | "crawl4ai-setup"),
                        "{} uses an unexpected program \"{}\" -- shell_command's Windows .cmd handling has only been verified for these",
                        entry.id,
                        step.program
                    );
                }
            }
        }
    }

    #[test]
    fn entry_for_and_plan_for_report_not_found_instead_of_panicking() {
        assert!(entry_for("does-not-exist").is_err());
        let ecc = entry_for("ecc").unwrap();
        assert!(plan_for(ecc, "claude").is_ok());
        assert!(plan_for(ecc, "opencode").is_err()); // no plan for an unknown agent
        // Crawl4AI is claude-only, so it has no automated codex shell plan.
        let crawl4ai = entry_for("crawl4ai").unwrap();
        assert!(plan_for(crawl4ai, "codex").is_err());
    }

    #[test]
    fn every_bundled_dir_is_vendored_with_a_skill_file() {
        for entry in ENTRIES {
            let Some(plan) = entry.bundle.as_ref() else { continue };
            assert!(!plan.dirs.is_empty(), "{} bundles zero folders", entry.id);
            assert!(!plan.agents.is_empty(), "{} bundles for zero agents", entry.id);
            for dir in plan.dirs {
                let vendored = BUNDLED_SKILLS
                    .get_dir(dir)
                    .unwrap_or_else(|| panic!("{}: bundled folder \"{dir}\" is not in resources/skills/", entry.id));
                assert!(
                    vendored.get_file(format!("{dir}/SKILL.md")).is_some(),
                    "{}: bundled folder \"{dir}\" has no SKILL.md",
                    entry.id
                );
            }
        }
    }

    #[test]
    fn enable_writes_and_disable_removes_every_bundled_folder() {
        let _guard = lock_env();
        let dir = sandbox("bundled-enable");
        unsafe {
            std::env::set_var("CLAUDE_CONFIG_DIR", &dir);
        }

        // Not installed to begin with.
        assert!(matches!(agent_state(entry_for("caveman").unwrap(), "claude"), InstallState::NotInstalled));

        enable_bundled_skill("caveman".to_string(), "claude".to_string()).unwrap();

        // Every folder landed, each with its SKILL.md, and detection agrees.
        let plan = entry_for("caveman").unwrap().bundle.as_ref().unwrap();
        for name in plan.dirs {
            assert!(dir.join("skills").join(name).join("SKILL.md").exists(), "missing {name}/SKILL.md after enable");
        }
        assert!(matches!(agent_state(entry_for("caveman").unwrap(), "claude"), InstallState::Installed));

        // Re-enabling is idempotent (clean overwrite, still Installed).
        enable_bundled_skill("caveman".to_string(), "claude".to_string()).unwrap();
        assert!(matches!(agent_state(entry_for("caveman").unwrap(), "claude"), InstallState::Installed));

        disable_bundled_skill("caveman".to_string(), "claude".to_string()).unwrap();
        for name in plan.dirs {
            assert!(!dir.join("skills").join(name).exists(), "{name} still present after disable");
        }
        assert!(matches!(agent_state(entry_for("caveman").unwrap(), "claude"), InstallState::NotInstalled));
    }

    #[test]
    fn intent_layer_extracts_nested_reference_and_script_files() {
        let _guard = lock_env();
        let dir = sandbox("bundled-nested");
        unsafe {
            std::env::set_var("CLAUDE_CONFIG_DIR", &dir);
        }
        enable_bundled_skill("intent-layer".to_string(), "claude".to_string()).unwrap();
        let base = dir.join("skills").join("intent-layer");
        assert!(base.join("SKILL.md").exists());
        // Nested subdirs must come across too, not just the top-level SKILL.md.
        assert!(base.join("references").join("templates.md").exists());
        assert!(base.join("scripts").join("detect_state.sh").exists());
    }
}
