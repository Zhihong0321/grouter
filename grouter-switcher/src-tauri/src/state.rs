use std::collections::HashMap;
use std::fs;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::config::DEFAULT_BASE_URL;
use crate::paths::app_config_dir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotValue {
    pub existed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ToolState {
    pub enabled: bool,
    /// True when this tool is pointed at grouter's dynamic tier router
    /// (Grouter Smart-Router) rather than a single pinned model (Grouter).
    #[serde(default)]
    pub smart: bool,
    #[serde(default)]
    pub snapshot: HashMap<String, SnapshotValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateFile {
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[serde(rename = "username", skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// Opaque marker that a secret is stored in the OS keychain -- the actual
    /// key/recovery password never lives in this file. See commands.rs.
    #[serde(rename = "keyRef", skip_serializing_if = "Option::is_none")]
    pub key_ref: Option<String>,
    #[serde(rename = "selectedAnthropicModel", skip_serializing_if = "Option::is_none")]
    pub selected_anthropic_model: Option<String>,
    #[serde(rename = "selectedOpenAiModel", skip_serializing_if = "Option::is_none")]
    pub selected_openai_model: Option<String>,
    pub claude: ToolState,
    pub codex: ToolState,
    #[serde(default)]
    pub opencode: ToolState,
}

impl Default for StateFile {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_string(),
            username: None,
            key_ref: None,
            selected_anthropic_model: None,
            selected_openai_model: None,
            claude: ToolState::default(),
            codex: ToolState::default(),
            opencode: ToolState::default(),
        }
    }
}

fn state_file_path() -> std::path::PathBuf {
    app_config_dir().join("state.json")
}

impl StateFile {
    pub fn load() -> Self {
        match fs::read_to_string(state_file_path()) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self) -> std::io::Result<()> {
        let path = state_file_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self).expect("StateFile is always serializable");
        fs::write(path, json)
    }
}

pub struct AppState(pub Mutex<StateFile>);

impl AppState {
    pub fn load() -> Self {
        AppState(Mutex::new(StateFile::load()))
    }
}
