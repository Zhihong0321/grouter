use std::fs;
use std::collections::HashMap;
use toml_edit::{value, DocumentMut, Item, Table};

use crate::error::AppError;
use crate::paths::codex_config_path;
use crate::state::{SnapshotValue, ToolState};

const TOP_KEYS: [&str; 2] = ["model_provider", "model"];
const PROVIDER_ID: &str = "grouter";
const PROVIDER_NAME: &str = "GROUTER API (BYOK)";

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
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1")
    }
}

/// Sets model_provider/model + the [model_providers.grouter] table, snapshotting
/// whatever top-level model_provider/model existed before (e.g. a different
/// custom provider the user already had configured).
pub fn apply(base_url: &str, key: &str, model: &str) -> Result<ToolState, AppError> {
    apply_with_snapshot(base_url, key, model, None)
}

/// Re-applies the GROUTER provider without replacing the original snapshot. This
/// is used when the user changes the default model while the switch is already on.
pub fn apply_with_snapshot(
    base_url: &str,
    key: &str,
    model: &str,
    existing_snapshot: Option<&HashMap<String, SnapshotValue>>,
) -> Result<ToolState, AppError> {
    let mut doc = read_doc()?;

    // Keep the first backup/snapshot as the restore point. Re-applying after a
    // model change must not snapshot our own GROUTER config as the "official" one.
    if existing_snapshot.is_none() {
        fs::write(backup_path(), doc.to_string()).map_err(|e| AppError::Io(e.to_string()))?;
    }

    let snapshot = match existing_snapshot {
        Some(snapshot) => snapshot.clone(),
        None => {
            let mut snapshot = HashMap::new();
            for k in TOP_KEYS {
                let existed = doc.contains_key(k);
                let value = doc.get(k).and_then(|item| item.as_str()).map(|s| s.to_string());
                snapshot.insert(k.to_string(), SnapshotValue { existed, value });
            }
            snapshot
        }
    };

    doc["model_provider"] = value(PROVIDER_ID);
    doc["model"] = value(model);

    let mut provider = Table::new();
    provider.insert("name", value(PROVIDER_NAME));
    provider.insert("base_url", value(normalized_base_url(base_url)));
    provider.insert("wire_api", value("responses"));
    provider.insert("requires_openai_auth", value(false));
    provider.insert("experimental_bearer_token", value(key));

    // Chained-index assignment (doc["model_providers"]["grouter"] = ...) does NOT
    // auto-vivify the intermediate table in toml_edit -- it silently no-ops on a
    // fresh document. Create/fetch the table explicitly instead.
    let providers_item = doc.entry("model_providers").or_insert(Item::Table(Table::new()));
    let providers_table = providers_item
        .as_table_mut()
        .ok_or_else(|| AppError::ParseFailed("`model_providers` in config.toml is not a table".to_string()))?;
    providers_table.insert(PROVIDER_ID, Item::Table(provider));

    write_doc(&doc)?;
    Ok(ToolState { enabled: true, smart: false, snapshot })
}

/// Removes [model_providers.grouter] and replays the snapshot for the
/// top-level keys, restoring any prior custom provider or deleting them.
pub fn restore(tool_state: &ToolState) -> Result<(), AppError> {
    let mut doc = read_doc()?;

    if let Some(providers) = doc.get_mut("model_providers").and_then(|i| i.as_table_mut()) {
        providers.remove(PROVIDER_ID);
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
    if doc.get("model_provider").and_then(|i| i.as_str()) != Some(PROVIDER_ID) {
        return true;
    }
    let grouter = match doc.get("model_providers").and_then(|i| i.get(PROVIDER_ID)) {
        Some(g) => g,
        None => return true,
    };
    let current_base = grouter.get("base_url").and_then(|i| i.as_str());
    let current_token = grouter.get("experimental_bearer_token").and_then(|i| i.as_str());
    current_base != Some(normalized_base_url(base_url).as_str()) || current_token != Some(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn sandbox(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("grouter-switcher-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        unsafe {
            std::env::set_var("CODEX_HOME", &dir);
        }
        dir
    }

    #[test]
    fn base_url_normalization_accepts_root_and_versioned_urls() {
        assert_eq!(normalized_base_url("https://grouter.example"), "https://grouter.example/v1");
        assert_eq!(normalized_base_url("https://grouter.example/"), "https://grouter.example/v1");
        assert_eq!(normalized_base_url("https://grouter.example/v1"), "https://grouter.example/v1");
        assert_eq!(normalized_base_url("https://grouter.example/v1/"), "https://grouter.example/v1");
    }

    #[test]
    fn apply_on_fresh_dir_writes_provider_table() {
        let dir = sandbox("codex-fresh");
        let state = apply("https://grouter.example/", "sk-test-key", "gpt-5.4").unwrap();
        assert!(state.enabled);
        assert!(!state.snapshot["model_provider"].existed);
        assert!(!state.snapshot["model"].existed);

        let written = fs::read_to_string(dir.join("config.toml")).unwrap();
        let doc: DocumentMut = written.parse().unwrap();
        assert_eq!(doc["model_provider"].as_str(), Some("grouter"));
        assert_eq!(doc["model"].as_str(), Some("gpt-5.4"));
        assert_eq!(doc["model_providers"]["grouter"]["name"].as_str(), Some(PROVIDER_NAME));
        // trailing slash on the input base_url must be normalized before /v1 is appended
        assert_eq!(doc["model_providers"]["grouter"]["base_url"].as_str(), Some("https://grouter.example/v1"));
        assert_eq!(doc["model_providers"]["grouter"]["wire_api"].as_str(), Some("responses"));
        assert_eq!(doc["model_providers"]["grouter"]["requires_openai_auth"].as_bool(), Some(false));
        assert_eq!(doc["model_providers"]["grouter"]["experimental_bearer_token"].as_str(), Some("sk-test-key"));
        assert!(dir.join("config.toml.grouter.bak").exists());
    }

    #[test]
    fn apply_preserves_other_providers_and_restore_reverts_prior_custom_provider() {
        let dir = sandbox("codex-preserve");
        fs::write(
            dir.join("config.toml"),
            "model_provider = \"openai\"\nmodel = \"gpt-5\"\n\n[model_providers.openai]\nname = \"openai\"\nbase_url = \"https://api.openai.com/v1\"\n",
        )
        .unwrap();

        let state = apply("https://grouter.example", "sk-test-key", "gpt-5.4").unwrap();
        assert!(state.snapshot["model_provider"].existed);
        assert_eq!(state.snapshot["model_provider"].value.as_deref(), Some("openai"));
        assert!(state.snapshot["model"].existed);
        assert_eq!(state.snapshot["model"].value.as_deref(), Some("gpt-5"));

        let mid = fs::read_to_string(dir.join("config.toml")).unwrap();
        let doc: DocumentMut = mid.parse().unwrap();
        // the pre-existing openai provider table must survive untouched alongside ours
        assert_eq!(doc["model_providers"]["openai"]["base_url"].as_str(), Some("https://api.openai.com/v1"));
        assert_eq!(doc["model_provider"].as_str(), Some("grouter"));

        restore(&state).unwrap();
        let restored = fs::read_to_string(dir.join("config.toml")).unwrap();
        let doc: DocumentMut = restored.parse().unwrap();
        assert_eq!(doc["model_provider"].as_str(), Some("openai"));
        assert_eq!(doc["model"].as_str(), Some("gpt-5"));
        assert_eq!(doc["model_providers"]["openai"]["base_url"].as_str(), Some("https://api.openai.com/v1"));
        assert!(doc.get("model_providers").unwrap().get("grouter").is_none());
    }

    #[test]
    fn reapply_preserves_original_snapshot_for_restore() {
        let dir = sandbox("codex-reapply");
        fs::write(
            dir.join("config.toml"),
            "model_provider = \"openai\"\nmodel = \"gpt-5\"\n",
        )
        .unwrap();

        let initial = apply("https://grouter.example", "sk-test-key", "gpt-5.6-sol").unwrap();
        let reapplied = apply_with_snapshot(
            "https://grouter.example",
            "sk-test-key",
            "gpt-5.6-terra",
            Some(&initial.snapshot),
        )
        .unwrap();
        restore(&reapplied).unwrap();

        let restored = fs::read_to_string(dir.join("config.toml")).unwrap();
        let doc: DocumentMut = restored.parse().unwrap();
        assert_eq!(doc["model_provider"].as_str(), Some("openai"));
        assert_eq!(doc["model"].as_str(), Some("gpt-5"));
        assert!(doc.get("model_providers").unwrap().get("grouter").is_none());
    }

    #[test]
    fn restore_removes_keys_that_did_not_exist_before() {
        let dir = sandbox("codex-remove");
        let state = apply("https://grouter.example", "sk-test-key", "gpt-5.4").unwrap();
        restore(&state).unwrap();

        let restored = fs::read_to_string(dir.join("config.toml")).unwrap();
        let doc: DocumentMut = restored.parse().unwrap();
        assert!(doc.get("model_provider").is_none());
        assert!(doc.get("model").is_none());
        assert!(doc.get("model_providers").and_then(|p| p.get("grouter")).is_none());
    }

    #[test]
    fn drift_detection() {
        sandbox("codex-drift");
        let state = apply("https://grouter.example", "sk-test-key", "gpt-5.4").unwrap();
        assert!(!is_drifted(&state, "https://grouter.example", "sk-test-key"));
        assert!(is_drifted(&state, "https://grouter.example", "sk-different-key"));

        let disabled = ToolState::default();
        assert!(!is_drifted(&disabled, "https://grouter.example", "sk-test-key"));
    }
}
