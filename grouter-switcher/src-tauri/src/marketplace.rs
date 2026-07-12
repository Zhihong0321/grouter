use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use crate::tools::{run_streamed, shell_command, ToolLogDonePayload};

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
    /// `npx skills add -g -a <agent>` places skills at ~/.<agent>/skills/<name>
    /// per the skills CLI's documented global-install convention.
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
        claude: Some(AgentPlan {
            steps: &[
                Step { program: "claude", args: &["plugin", "marketplace", "add", "https://github.com/affaan-m/ECC"] },
                Step { program: "claude", args: &["plugin", "install", "ecc@ecc"] },
            ],
            detect: Detect::ClaudePlugin { marketplace: "ecc", plugin: "ecc" },
        }),
        codex: None,
        codex_note: Some(
            "ECC ships its own multi-harness installer for Codex (`npx ecc-install --profile full`) -- run that yourself; it isn't wired up here.",
        ),
    },
    MarketplaceEntry {
        id: "claude-plugins-official",
        label: "Anthropic Official Marketplace",
        description: "Anthropic's own vetted marketplace: 100+ plugins including partner integrations (GitHub, Linear, Sentry, Stripe, Figma) and flagship community plugins.",
        source_url: "https://github.com/anthropics/claude-plugins-official",
        windows: true,
        mac: true,
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
        claude: Some(AgentPlan {
            steps: &[
                Step { program: "claude", args: &["plugin", "marketplace", "add", "JuliusBrussee/caveman"] },
                Step { program: "claude", args: &["plugin", "install", "caveman@caveman"] },
            ],
            detect: Detect::ClaudePlugin { marketplace: "caveman", plugin: "caveman" },
        }),
        codex: Some(AgentPlan {
            steps: &[Step { program: "npx", args: &["skills", "add", "JuliusBrussee/caveman", "-a", "codex", "--yes"] }],
            detect: Detect::SkillDir { agent: "codex", skill: "caveman" },
        }),
        codex_note: None,
    },
    MarketplaceEntry {
        id: "intent-layer",
        label: "Intent Layer",
        description: "Sets up hierarchical AGENTS.md/CLAUDE.md context files so agents navigate your codebase like a senior engineer.",
        source_url: "https://github.com/crafter-station/skills/tree/main/context-engineering/intent-layer",
        windows: true,
        mac: true,
        claude: Some(AgentPlan {
            steps: &[Step {
                program: "npx",
                args: &["skills", "add", "crafter-station/skills", "--skill", "intent-layer", "-g", "-a", "claude-code", "--yes"],
            }],
            detect: Detect::SkillDir { agent: "claude", skill: "intent-layer" },
        }),
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
            claude_supported: e.claude.is_some(),
            codex_supported: e.codex.is_some(),
            codex_note: e.codex_note.map(|s| s.to_string()),
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
            let claude = e.claude.as_ref().map(|p| detect_state(&p.detect)).unwrap_or(InstallState::Unsupported);
            let codex = e.codex.as_ref().map(|p| detect_state(&p.detect)).unwrap_or(InstallState::Unsupported);
            (e.id.to_string(), MarketplaceStatus { claude, codex })
        })
        .collect()
}

/// Runs an entry's install plan for one agent step by step, streaming output
/// over the same `tool-log`/`tool-log-done` events tools.rs uses (tagged
/// `marketplace:<id>:<agent>` so the frontend can tell the streams apart).
/// Two distinct error-reporting paths, deliberately not both at once:
/// - A step that never got to run (bad id/agent, or the required binary
///   isn't on PATH) reports only through the returned `Err` -- there's no
///   log content yet, so a `tool-log-done` event here would show "see log
///   below" over an empty log. The frontend's install-call catch handler is
///   the single source of truth for this case.
/// - A step that actually ran and failed reports only through the
///   `tool-log-done` event (success: false) with real stdout/stderr already
///   in the log, mirroring tools.rs's install_tool.
#[tauri::command]
pub async fn install_marketplace_entry(app: AppHandle, id: String, agent: String) -> Result<(), AppError> {
    let entry = entry_for(&id)?;
    let plan = plan_for(entry, &agent)?;
    let log_id = format!("marketplace:{id}:{agent}");

    for step in plan.steps {
        if which::which(step.program).is_err() {
            let message = if step.program == "claude" {
                "Claude Code CLI is not installed -- install it from the Tools tab first".to_string()
            } else {
                format!("\"{}\" is not on PATH", step.program)
            };
            return Err(AppError::NotFound(message));
        }
        let cmd = shell_command(step.program, step.args);
        let (success, exit_code) = run_streamed(&app, &log_id, cmd).await?;
        if !success {
            let _ = app.emit("tool-log-done", ToolLogDonePayload { tool: log_id, success: false, exit_code });
            return Ok(());
        }
    }

    let _ = app.emit("tool-log-done", ToolLogDonePayload { tool: log_id, success: true, exit_code: Some(0) });
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
            assert!(entry.claude.is_some() || entry.codex.is_some(), "{} has no automated install path at all", entry.id);
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
        assert!(plan_for(ecc, "codex").is_err()); // ECC has no automated codex plan
        assert!(plan_for(ecc, "claude").is_ok());
    }
}
