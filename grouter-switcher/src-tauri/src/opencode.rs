use std::fs;
use std::collections::HashMap;
use serde_json::{Map, Value};

use crate::error::AppError;
use crate::paths::opencode_config_path;
use crate::state::{SnapshotValue, ToolState};

const TOP_KEYS: [&str; 1] = ["model"];
const PROVIDER_ID: &str = "grouter";

fn read_doc() -> Result<Value, AppError> {
    let path = opencode_config_path();
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }
    let contents = fs::read_to_string(&path).map_err(|e| AppError::Io(e.to_string()))?;
    serde_json::from_str(&contents).map_err(|_| AppError::ParseFailed(path.display().to_string()))
}

fn write_doc(root: &Value) -> Result<(), AppError> {
    let path = opencode_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::Io(e.to_string()))?;
    }
    let json = serde_json::to_string_pretty(root).map_err(|e| AppError::Io(e.to_string()))?;
    fs::write(&path, json).map_err(|e| AppError::Io(e.to_string()))
}

fn backup_path() -> std::path::PathBuf {
    let mut path = opencode_config_path();
    path.set_file_name("opencode.json.grouter.bak");
    path
}

fn normalized_base_url(base_url: &str) -> String {
    format!("{}/v1", base_url.trim_end_matches('/'))
}

fn root_object(root: &mut Value) -> Result<&mut Map<String, Value>, AppError> {
    root.as_object_mut()
        .ok_or_else(|| AppError::ParseFailed(opencode_config_path().display().to_string()))
}

/// Adds a distinct `provider.grouter` entry (rather than overriding the
/// built-in `anthropic`/`openai` provider ids) and points top-level `model`
/// at it. A distinct id avoids a known opencode bug where OAuth entries in
/// auth.json can silently override a built-in provider's config.
pub fn apply(base_url: &str, key: &str, model: &str) -> Result<ToolState, AppError> {
    let mut root = read_doc()?;
    if let Some(parent) = backup_path().parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::Io(e.to_string()))?;
    }
    fs::write(backup_path(), serde_json::to_string_pretty(&root).unwrap_or_default())
        .map_err(|e| AppError::Io(e.to_string()))?;

    let mut snapshot: HashMap<String, SnapshotValue> = HashMap::new();
    {
        let obj = root_object(&mut root)?;
        for k in TOP_KEYS {
            let existed = obj.contains_key(k);
            let value = obj.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
            snapshot.insert(k.to_string(), SnapshotValue { existed, value });
        }
    }

    let mut provider = Map::new();
    provider.insert("npm".to_string(), Value::String("@ai-sdk/openai-compatible".to_string()));
    let mut options = Map::new();
    options.insert("baseURL".to_string(), Value::String(normalized_base_url(base_url)));
    options.insert("apiKey".to_string(), Value::String(key.to_string()));
    provider.insert("options".to_string(), Value::Object(options));
    let mut models = Map::new();
    let mut model_entry = Map::new();
    model_entry.insert("name".to_string(), Value::String(model.to_string()));
    models.insert(model.to_string(), Value::Object(model_entry));
    provider.insert("models".to_string(), Value::Object(models));

    let obj = root_object(&mut root)?;
    let providers = obj
        .entry("provider")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| AppError::ParseFailed("`provider` in opencode.json is not an object".to_string()))?;
    providers.insert(PROVIDER_ID.to_string(), Value::Object(provider));

    obj.insert("model".to_string(), Value::String(format!("{PROVIDER_ID}/{model}")));

    write_doc(&root)?;
    Ok(ToolState { enabled: true, smart: false, snapshot })
}

/// Removes `provider.grouter` and replays the snapshot for the top-level
/// `model` key, restoring any prior value or deleting it if it never existed.
pub fn restore(tool_state: &ToolState) -> Result<(), AppError> {
    let mut root = read_doc()?;
    let obj = root_object(&mut root)?;

    if let Some(providers) = obj.get_mut("provider").and_then(|v| v.as_object_mut()) {
        providers.remove(PROVIDER_ID);
    }

    for k in TOP_KEYS {
        if let Some(snap) = tool_state.snapshot.get(k) {
            if snap.existed {
                if let Some(v) = &snap.value {
                    obj.insert(k.to_string(), Value::String(v.clone()));
                }
            } else {
                obj.remove(k);
            }
        }
    }

    write_doc(&root)
}

/// True when the live file no longer matches what we last wrote -- e.g. the
/// user hand-edited opencode.json while the switch was ON.
pub fn is_drifted(tool_state: &ToolState, base_url: &str, key: &str) -> bool {
    if !tool_state.enabled {
        return false;
    }
    let root = match read_doc() {
        Ok(r) => r,
        Err(_) => return true,
    };
    let obj = match root.as_object() {
        Some(o) => o,
        None => return true,
    };
    let current_model = obj.get("model").and_then(|v| v.as_str());
    let expected_model_prefix = format!("{PROVIDER_ID}/");
    if !current_model.map(|m| m.starts_with(&expected_model_prefix)).unwrap_or(false) {
        return true;
    }
    let grouter = match obj.get("provider").and_then(|v| v.get(PROVIDER_ID)) {
        Some(g) => g,
        None => return true,
    };
    let current_base = grouter.get("options").and_then(|o| o.get("baseURL")).and_then(|v| v.as_str());
    let current_key = grouter.get("options").and_then(|o| o.get("apiKey")).and_then(|v| v.as_str());
    current_base != Some(normalized_base_url(base_url).as_str()) || current_key != Some(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::lock_env;
    use std::fs;

    fn sandbox(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("grouter-switcher-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        unsafe {
            std::env::set_var("XDG_CONFIG_HOME", &dir);
        }
        dir.join("opencode")
    }

    #[test]
    fn apply_on_fresh_dir_writes_provider_and_model() {
        let _guard = lock_env();
        let dir = sandbox("opencode-fresh");
        let state = apply("https://grouter.example/", "sk-test-key", "gpt-5.4").unwrap();
        assert!(state.enabled);
        assert!(!state.snapshot["model"].existed);

        let written = fs::read_to_string(dir.join("opencode.json")).unwrap();
        let parsed: Value = serde_json::from_str(&written).unwrap();
        assert_eq!(parsed["model"], "grouter/gpt-5.4");
        assert_eq!(parsed["provider"]["grouter"]["npm"], "@ai-sdk/openai-compatible");
        // trailing slash on the input base_url must be normalized before /v1 is appended
        assert_eq!(parsed["provider"]["grouter"]["options"]["baseURL"], "https://grouter.example/v1");
        assert_eq!(parsed["provider"]["grouter"]["options"]["apiKey"], "sk-test-key");
        assert_eq!(parsed["provider"]["grouter"]["models"]["gpt-5.4"]["name"], "gpt-5.4");
        assert!(dir.join("opencode.json.grouter.bak").exists());
    }

    #[test]
    fn apply_preserves_other_providers_and_restore_reverts_prior_model() {
        let _guard = lock_env();
        let dir = sandbox("opencode-preserve");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("opencode.json"),
            r#"{"model":"anthropic/claude-sonnet-5","provider":{"anthropic":{"options":{"apiKey":"sk-official"}}},"small_model":"anthropic/claude-haiku-4-5"}"#,
        )
        .unwrap();

        let state = apply("https://grouter.example", "sk-test-key", "gpt-5.4").unwrap();
        assert!(state.snapshot["model"].existed);
        assert_eq!(state.snapshot["model"].value.as_deref(), Some("anthropic/claude-sonnet-5"));

        let mid = fs::read_to_string(dir.join("opencode.json")).unwrap();
        let parsed: Value = serde_json::from_str(&mid).unwrap();
        // the pre-existing anthropic provider and unrelated keys must survive untouched
        assert_eq!(parsed["provider"]["anthropic"]["options"]["apiKey"], "sk-official");
        assert_eq!(parsed["small_model"], "anthropic/claude-haiku-4-5");
        assert_eq!(parsed["model"], "grouter/gpt-5.4");

        restore(&state).unwrap();
        let restored = fs::read_to_string(dir.join("opencode.json")).unwrap();
        let parsed: Value = serde_json::from_str(&restored).unwrap();
        assert_eq!(parsed["model"], "anthropic/claude-sonnet-5");
        assert_eq!(parsed["provider"]["anthropic"]["options"]["apiKey"], "sk-official");
        assert!(parsed["provider"].get("grouter").is_none());
    }

    #[test]
    fn restore_removes_model_key_that_did_not_exist_before() {
        let _guard = lock_env();
        let dir = sandbox("opencode-remove");
        let state = apply("https://grouter.example", "sk-test-key", "gpt-5.4").unwrap();
        restore(&state).unwrap();

        let restored = fs::read_to_string(dir.join("opencode.json")).unwrap();
        let parsed: Value = serde_json::from_str(&restored).unwrap();
        assert!(parsed.get("model").is_none());
        assert!(parsed.get("provider").and_then(|p| p.get("grouter")).is_none());
    }

    #[test]
    fn drift_detection() {
        let _guard = lock_env();
        sandbox("opencode-drift");
        let state = apply("https://grouter.example", "sk-test-key", "gpt-5.4").unwrap();
        assert!(!is_drifted(&state, "https://grouter.example", "sk-test-key"));
        assert!(is_drifted(&state, "https://grouter.example", "sk-different-key"));

        let disabled = ToolState::default();
        assert!(!is_drifted(&disabled, "https://grouter.example", "sk-test-key"));
    }
}
