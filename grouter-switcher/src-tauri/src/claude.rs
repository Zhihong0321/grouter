use std::fs;
use std::collections::HashMap;
use serde_json::{Map, Value};

use crate::error::AppError;
use crate::paths::claude_settings_path;
use crate::state::{SnapshotValue, ToolState};

const KEYS: [&str; 3] = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"];

fn read_settings() -> Result<Value, AppError> {
    let path = claude_settings_path();
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }
    let contents = fs::read_to_string(&path).map_err(|e| AppError::Io(e.to_string()))?;
    serde_json::from_str(&contents).map_err(|_| AppError::ParseFailed(path.display().to_string()))
}

fn write_settings(root: &Value) -> Result<(), AppError> {
    let path = claude_settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::Io(e.to_string()))?;
    }
    let json = serde_json::to_string_pretty(root).map_err(|e| AppError::Io(e.to_string()))?;
    fs::write(&path, json).map_err(|e| AppError::Io(e.to_string()))
}

fn backup_path() -> std::path::PathBuf {
    let mut path = claude_settings_path();
    path.set_file_name("settings.json.grouter.bak");
    path
}

fn env_object(root: &mut Value) -> Result<&mut Map<String, Value>, AppError> {
    let obj = root
        .as_object_mut()
        .ok_or_else(|| AppError::ParseFailed(claude_settings_path().display().to_string()))?;
    let env = obj.entry("env").or_insert_with(|| Value::Object(Map::new()));
    env.as_object_mut()
        .ok_or_else(|| AppError::ParseFailed("`env` in settings.json is not an object".to_string()))
}

/// Merges the grouter env keys into settings.json, snapshotting whatever was
/// there before so `restore` can put it back exactly.
pub fn apply(base_url: &str, key: &str, model: Option<&str>) -> Result<ToolState, AppError> {
    let mut root = read_settings()?;
    fs::write(backup_path(), serde_json::to_string_pretty(&root).unwrap_or_default())
        .map_err(|e| AppError::Io(e.to_string()))?;

    let env_obj = env_object(&mut root)?;
    let mut snapshot: HashMap<String, SnapshotValue> = HashMap::new();
    for k in KEYS {
        let existed = env_obj.contains_key(k);
        let value = env_obj.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
        snapshot.insert(k.to_string(), SnapshotValue { existed, value });
    }

    env_obj.insert("ANTHROPIC_BASE_URL".to_string(), Value::String(base_url.to_string()));
    env_obj.insert("ANTHROPIC_AUTH_TOKEN".to_string(), Value::String(key.to_string()));
    match model {
        Some(m) => {
            env_obj.insert("ANTHROPIC_MODEL".to_string(), Value::String(m.to_string()));
        }
        None => {
            env_obj.remove("ANTHROPIC_MODEL");
        }
    }

    write_settings(&root)?;
    Ok(ToolState { enabled: true, snapshot })
}

/// Replays a snapshot captured by `apply`, restoring or removing each key.
pub fn restore(tool_state: &ToolState) -> Result<(), AppError> {
    let mut root = read_settings()?;
    let env_obj = env_object(&mut root)?;

    for k in KEYS {
        if let Some(snap) = tool_state.snapshot.get(k) {
            if snap.existed {
                if let Some(v) = &snap.value {
                    env_obj.insert(k.to_string(), Value::String(v.clone()));
                }
            } else {
                env_obj.remove(k);
            }
        }
    }

    write_settings(&root)
}

/// True when the live file no longer matches what we last wrote -- e.g. the
/// user hand-edited settings.json while the switch was ON.
pub fn is_drifted(tool_state: &ToolState, base_url: &str, key: &str) -> bool {
    if !tool_state.enabled {
        return false;
    }
    let root = match read_settings() {
        Ok(r) => r,
        Err(_) => return true,
    };
    let env_obj = match root.get("env").and_then(|v| v.as_object()) {
        Some(o) => o,
        None => return true,
    };
    let current_base = env_obj.get("ANTHROPIC_BASE_URL").and_then(|v| v.as_str());
    let current_token = env_obj.get("ANTHROPIC_AUTH_TOKEN").and_then(|v| v.as_str());
    current_base != Some(base_url) || current_token != Some(key)
}
