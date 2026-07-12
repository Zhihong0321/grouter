use std::collections::HashMap;
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::error::AppError;

struct ToolSpec {
    id: &'static str,
    bin: &'static str,
    npm_package: &'static str,
    update_args: &'static [&'static str],
}

const TOOLS: [ToolSpec; 3] = [
    ToolSpec { id: "claude", bin: "claude", npm_package: "@anthropic-ai/claude-code", update_args: &["update"] },
    ToolSpec { id: "codex", bin: "codex", npm_package: "@openai/codex", update_args: &["update"] },
    ToolSpec { id: "opencode", bin: "opencode", npm_package: "opencode-ai", update_args: &["upgrade"] },
];

fn spec_for(tool: &str) -> Result<&'static ToolSpec, AppError> {
    TOOLS
        .iter()
        .find(|t| t.id == tool)
        .ok_or_else(|| AppError::NotFound(format!("Unknown tool \"{tool}\"")))
}

#[derive(Serialize, Clone)]
pub struct ToolInstallStatus {
    pub installed: bool,
    pub version: Option<String>,
    #[serde(rename = "latestVersion")]
    pub latest_version: Option<String>,
    pub path: Option<String>,
}

/// Each tool formats `--version` output differently, so pull just the version
/// token out of e.g. "2.1.207 (Claude Code)" or "codex-cli 0.142.3".
fn parse_version(tool_id: &str, raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    match tool_id {
        "codex" => trimmed.split_whitespace().last().map(|s| s.to_string()),
        _ => trimmed.split_whitespace().next().map(|s| s.to_string()),
    }
}

async fn fetch_latest_npm_version(package: &str) -> Option<String> {
    let url = format!("https://registry.npmjs.org/{package}/latest");
    let resp = reqwest::get(&url).await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    body.get("version").and_then(|v| v.as_str()).map(|s| s.to_string())
}

async fn detect_one(spec: &ToolSpec) -> ToolInstallStatus {
    let resolved = which::which(spec.bin).ok();
    let (installed, version, path) = match &resolved {
        Some(p) => {
            let version = Command::new(p)
                .arg("--version")
                .output()
                .await
                .ok()
                .and_then(|out| {
                    let combined = if !out.stdout.is_empty() { out.stdout } else { out.stderr };
                    String::from_utf8(combined).ok()
                })
                .and_then(|s| parse_version(spec.id, &s));
            (true, version, Some(p.display().to_string()))
        }
        None => (false, None, None),
    };

    let latest_version = fetch_latest_npm_version(spec.npm_package).await;

    ToolInstallStatus { installed, version, latest_version, path }
}

/// Detects each managed CLI on PATH (via `which`, which correctly handles
/// Windows' .cmd/.exe/PATHEXT resolution unlike a naive Command::new) and
/// checks the npm registry for the latest published version. Best-effort --
/// a registry lookup failure just omits `latestVersion` rather than failing
/// the whole call.
#[tauri::command]
pub async fn detect_installations() -> HashMap<String, ToolInstallStatus> {
    let mut results = HashMap::new();
    for spec in TOOLS.iter() {
        results.insert(spec.id.to_string(), detect_one(spec).await);
    }
    results
}

#[derive(Serialize, Clone)]
struct ToolLogPayload {
    tool: String,
    line: String,
}

#[derive(Serialize, Clone)]
struct ToolLogDonePayload {
    tool: String,
    success: bool,
    #[serde(rename = "exitCode")]
    exit_code: Option<i32>,
}

/// npm (and some of these CLIs' own installers) ship as `.cmd` shims on
/// Windows, which `std::process::Command` cannot exec directly -- it needs
/// cmd.exe to resolve PATHEXT. Elsewhere the resolved binary can run as-is.
fn shell_command(program: &str, args: &[&str]) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(program);
        for a in args {
            c.arg(a);
        }
        c
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut c = Command::new(program);
        for a in args {
            c.arg(a);
        }
        c
    }
}

/// Runs a command to completion, forwarding each stdout/stderr line to the
/// frontend as a `tool-log` event as it arrives.
async fn run_streamed(app: &AppHandle, tool_id: &str, mut cmd: Command) -> Result<(bool, Option<i32>), AppError> {
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| AppError::Io(e.to_string()))?;
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    let tx_out = tx.clone();
    let out_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = tx_out.send(line);
        }
    });
    let tx_err = tx.clone();
    let err_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = tx_err.send(line);
        }
    });
    drop(tx);

    while let Some(line) = rx.recv().await {
        let _ = app.emit("tool-log", ToolLogPayload { tool: tool_id.to_string(), line });
    }
    let _ = out_task.await;
    let _ = err_task.await;

    let status = child.wait().await.map_err(|e| AppError::Io(e.to_string()))?;
    Ok((status.success(), status.code()))
}

#[tauri::command]
pub async fn install_tool(app: AppHandle, tool: String) -> Result<(), AppError> {
    let spec = spec_for(&tool)?;
    let cmd = shell_command("npm", &["install", "-g", spec.npm_package]);
    let (success, exit_code) = run_streamed(&app, spec.id, cmd).await?;
    let _ = app.emit("tool-log-done", ToolLogDonePayload { tool: spec.id.to_string(), success, exit_code });
    Ok(())
}

#[tauri::command]
pub async fn update_tool(app: AppHandle, tool: String) -> Result<(), AppError> {
    let spec = spec_for(&tool)?;
    let bin_path = which::which(spec.bin).map_err(|_| AppError::NotFound(format!("{} is not installed", spec.id)))?;
    let cmd = shell_command(&bin_path.display().to_string(), spec.update_args);
    let (success, exit_code) = run_streamed(&app, spec.id, cmd).await?;
    let _ = app.emit("tool-log-done", ToolLogDonePayload { tool: spec.id.to_string(), success, exit_code });
    Ok(())
}
