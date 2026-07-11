use std::fs;
use std::collections::HashMap;
use toml_edit::{value, DocumentMut, Item, Table};

use crate::error::AppError;
use crate::paths::codex_config_path;
use crate::state::{SnapshotValue, ToolState};

const TOP_KEYS: [&str; 2] = ["model_provider", "model"];

fn read_doc() -> Result<DocumentMut, AppError> {
    let path = codex_config_path();
    if !path.exists() {
        return Ok(DocumentMut::new());
    }
    let contents = fs::read_to_string(&path).map_err(|e| AppError::Io(e.to_string()))?;
    contents
        .parse::<DocumentMut>()
        .map_err(|_| AppError::ParseFailed(path.display().to_string()))
}

fn write_doc(doc: &DocumentMut) -> Result<(), AppError> {
    let path = codex_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::Io(e.to_string()))?;
    }
    fs::write(&path, doc.to_string()).map_err(|e| AppError::Io(e.to_string()))
}

fn backup_path() -> std::path::PathBuf {
    let mut path = codex_config_path();
    path.set_file_name("config.toml.grouter.bak");
    path
}

fn normalized_base_url(base_url: &str) -> String {
    format!("{}/v1", base_url.trim_end_matches('/'))
}

/// Sets model_provider/model + the [model_providers.grouter] table, snapshotting
/// whatever top-level model_provider/model existed before (e.g. a different
/// custom provider the user already had configured).
pub fn apply(base_url: &str, key: &str, model: &str) -> Result<ToolState, AppError> {
    let mut doc = read_doc()?;
    fs::write(backup_path(), doc.to_string()).map_err(|e| AppError::Io(e.to_string()))?;

    let mut snapshot: HashMap<String, SnapshotValue> = HashMap::new();
    for k in TOP_KEYS {
        let existed = doc.contains_key(k);
        let value = doc.get(k).and_then(|item| item.as_str()).map(|s| s.to_string());
        snapshot.insert(k.to_string(), SnapshotValue { existed, value });
    }

    doc["model_provider"] = value("grouter");
    doc["model"] = value(model);

    let mut provider = Table::new();
    provider.insert("name", value("grouter"));
    provider.insert("base_url", value(normalized_base_url(base_url)));
    provider.insert("wire_api", value("responses"));
    provider.insert("requires_openai_auth", value(false));
    provider.insert("experimental_bearer_token", value(key));

    doc["model_providers"]["grouter"] = Item::Table(provider);

    write_doc(&doc)?;
    Ok(ToolState { enabled: true, snapshot })
}

/// Removes [model_providers.grouter] and replays the snapshot for the
/// top-level keys, restoring any prior custom provider or deleting them.
pub fn restore(tool_state: &ToolState) -> Result<(), AppError> {
    let mut doc = read_doc()?;

    if let Some(providers) = doc.get_mut("model_providers").and_then(|i| i.as_table_mut()) {
        providers.remove("grouter");
    }

    for k in TOP_KEYS {
        if let Some(snap) = tool_state.snapshot.get(k) {
            if snap.existed {
                if let Some(v) = &snap.value {
                    doc[k] = value(v.as_str());
                }
            } else {
                doc.remove(k);
            }
        }
    }

    write_doc(&doc)
}

pub fn is_drifted(tool_state: &ToolState, base_url: &str, key: &str) -> bool {
    if !tool_state.enabled {
        return false;
    }
    let doc = match read_doc() {
        Ok(d) => d,
        Err(_) => return true,
    };
    if doc.get("model_provider").and_then(|i| i.as_str()) != Some("grouter") {
        return true;
    }
    let grouter = match doc.get("model_providers").and_then(|i| i.get("grouter")) {
        Some(g) => g,
        None => return true,
    };
    let current_base = grouter.get("base_url").and_then(|i| i.as_str());
    let current_token = grouter.get("experimental_bearer_token").and_then(|i| i.as_str());
    current_base != Some(normalized_base_url(base_url).as_str()) || current_token != Some(key)
}
