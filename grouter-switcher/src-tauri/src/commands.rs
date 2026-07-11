use serde::{Deserialize, Serialize};
use tauri::State;

use crate::config::BOOTSTRAP_SECRET;
use crate::error::AppError;
use crate::state::{AppState, ToolState};
use crate::{claude, codex, verify};

const KEYCHAIN_SERVICE: &str = "grouter-switcher";
const KEYCHAIN_API_KEY_USER: &str = "api-key";
const KEYCHAIN_RECOVERY_USER: &str = "recovery-password";

fn store_secret(user: &str, secret: &str) -> Result<(), AppError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, user).map_err(|e| AppError::Io(e.to_string()))?;
    entry.set_password(secret).map_err(|e| AppError::Io(e.to_string()))
}

fn load_secret(user: &str) -> Result<Option<String>, AppError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, user).map_err(|e| AppError::Io(e.to_string()))?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Io(e.to_string())),
    }
}

#[derive(Serialize)]
pub struct AccountResult {
    pub username: String,
    #[serde(rename = "recoveryPassword", skip_serializing_if = "Option::is_none")]
    pub recovery_password: Option<String>,
}

#[derive(Deserialize)]
struct AccountResponseBody {
    username: String,
    key: String,
}

#[tauri::command]
pub async fn has_local_key(state: State<'_, AppState>) -> Result<bool, AppError> {
    let s = state.0.lock().await;
    Ok(s.key_ref.is_some())
}

#[tauri::command]
pub async fn apply_for_key(
    state: State<'_, AppState>,
    username: String,
    recovery_password: String,
) -> Result<AccountResult, AppError> {
    let base_url = state.0.lock().await.base_url.clone();

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/client/accounts", base_url.trim_end_matches('/')))
        .header("x-bootstrap-secret", BOOTSTRAP_SECRET)
        .json(&serde_json::json!({ "username": username, "recoveryPassword": recovery_password }))
        .send()
        .await
        .map_err(|e| AppError::Network(e.to_string()))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Network(format!("Server returned {status}: {body}")));
    }

    let parsed: AccountResponseBody = resp.json().await.map_err(|e| AppError::Network(e.to_string()))?;

    store_secret(KEYCHAIN_API_KEY_USER, &parsed.key)?;
    store_secret(KEYCHAIN_RECOVERY_USER, &recovery_password)?;

    let mut s = state.0.lock().await;
    s.username = Some(parsed.username.clone());
    s.key_ref = Some("keychain".to_string());
    s.save().map_err(|e| AppError::Io(e.to_string()))?;

    Ok(AccountResult {
        username: parsed.username,
        recovery_password: Some(recovery_password),
    })
}

#[tauri::command]
pub async fn recover_account(state: State<'_, AppState>, recovery_password: String) -> Result<AccountResult, AppError> {
    let base_url = state.0.lock().await.base_url.clone();

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/client/accounts/recover", base_url.trim_end_matches('/')))
        .json(&serde_json::json!({ "recoveryPassword": recovery_password }))
        .send()
        .await
        .map_err(|e| AppError::Network(e.to_string()))?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AppError::InvalidKey("Invalid recovery password".to_string()));
    }
    if !resp.status().is_success() {
        return Err(AppError::Network(format!("Server returned {}", resp.status())));
    }

    let parsed: AccountResponseBody = resp.json().await.map_err(|e| AppError::Network(e.to_string()))?;

    store_secret(KEYCHAIN_API_KEY_USER, &parsed.key)?;
    store_secret(KEYCHAIN_RECOVERY_USER, &recovery_password)?;

    let mut s = state.0.lock().await;
    s.username = Some(parsed.username.clone());
    s.key_ref = Some("keychain".to_string());
    s.save().map_err(|e| AppError::Io(e.to_string()))?;

    Ok(AccountResult { username: parsed.username, recovery_password: None })
}

#[derive(Serialize)]
pub struct BalanceResult {
    pub username: String,
    #[serde(rename = "balanceCents")]
    pub balance_cents: Option<i64>,
    #[serde(rename = "spentCents")]
    pub spent_cents: i64,
    pub unlimited: bool,
}

#[derive(Deserialize)]
struct MeResponseBody {
    username: String,
    #[serde(rename = "balanceCents")]
    balance_cents: Option<i64>,
    #[serde(rename = "spentCents")]
    spent_cents: i64,
    unlimited: bool,
}

#[tauri::command]
pub async fn get_balance(state: State<'_, AppState>) -> Result<BalanceResult, AppError> {
    let base_url = state.0.lock().await.base_url.clone();
    let recovery_password =
        load_secret(KEYCHAIN_RECOVERY_USER)?.ok_or_else(|| AppError::NotFound("No local account -- apply for a key first".to_string()))?;

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/client/accounts/me", base_url.trim_end_matches('/')))
        .header("x-recovery-password", recovery_password)
        .send()
        .await
        .map_err(|e| AppError::Network(e.to_string()))?;

    if !resp.status().is_success() {
        return Err(AppError::Network(format!("Server returned {}", resp.status())));
    }

    let parsed: MeResponseBody = resp.json().await.map_err(|e| AppError::Network(e.to_string()))?;

    Ok(BalanceResult {
        username: parsed.username,
        balance_cents: parsed.balance_cents,
        spent_cents: parsed.spent_cents,
        unlimited: parsed.unlimited,
    })
}

#[derive(Serialize, Deserialize)]
pub struct UsageEntry {
    pub model: String,
    #[serde(rename = "inputTokens")]
    pub input_tokens: i64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: i64,
    #[serde(rename = "cacheCreationInputTokens")]
    pub cache_creation_input_tokens: i64,
    #[serde(rename = "cacheReadInputTokens")]
    pub cache_read_input_tokens: i64,
    #[serde(rename = "costCents")]
    pub cost_cents: i64,
    pub stream: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Serialize, Deserialize)]
pub struct UsageResult {
    #[serde(rename = "requestCount")]
    pub request_count: i64,
    #[serde(rename = "costCents")]
    pub cost_cents: i64,
    #[serde(rename = "inputTokens")]
    pub input_tokens: i64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: i64,
    #[serde(rename = "cacheCreationInputTokens")]
    pub cache_creation_input_tokens: i64,
    #[serde(rename = "cacheReadInputTokens")]
    pub cache_read_input_tokens: i64,
    pub recent: Vec<UsageEntry>,
}

#[tauri::command]
pub async fn get_usage(state: State<'_, AppState>, range: Option<String>) -> Result<UsageResult, AppError> {
    let base_url = state.0.lock().await.base_url.clone();
    let recovery_password =
        load_secret(KEYCHAIN_RECOVERY_USER)?.ok_or_else(|| AppError::NotFound("No local account -- apply for a key first".to_string()))?;

    let client = reqwest::Client::new();
    let mut request = client
        .get(format!("{}/client/accounts/me/usage", base_url.trim_end_matches('/')))
        .header("x-recovery-password", recovery_password);
    if let Some(r) = range {
        request = request.query(&[("range", r)]);
    }

    let resp = request.send().await.map_err(|e| AppError::Network(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(AppError::Network(format!("Server returned {}", resp.status())));
    }

    resp.json().await.map_err(|e| AppError::Network(e.to_string()))
}

#[derive(Serialize)]
pub struct ToolStatusResult {
    pub installed: bool,
    pub enabled: bool,
    pub drifted: bool,
}

#[derive(Serialize)]
pub struct StatusResult {
    pub claude: ToolStatusResult,
    pub codex: ToolStatusResult,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[serde(rename = "selectedAnthropicModel")]
    pub selected_anthropic_model: Option<String>,
    #[serde(rename = "selectedOpenAiModel")]
    pub selected_openai_model: Option<String>,
}

#[tauri::command]
pub async fn get_status(state: State<'_, AppState>) -> Result<StatusResult, AppError> {
    let s = state.0.lock().await;
    let key = load_secret(KEYCHAIN_API_KEY_USER)?.unwrap_or_default();

    Ok(StatusResult {
        claude: ToolStatusResult {
            installed: crate::paths::claude_config_dir().exists(),
            enabled: s.claude.enabled,
            drifted: claude::is_drifted(&s.claude, &s.base_url, &key),
        },
        codex: ToolStatusResult {
            installed: crate::paths::codex_config_dir().exists(),
            enabled: s.codex.enabled,
            drifted: codex::is_drifted(&s.codex, &s.base_url, &key),
        },
        base_url: s.base_url.clone(),
        selected_anthropic_model: s.selected_anthropic_model.clone(),
        selected_openai_model: s.selected_openai_model.clone(),
    })
}

#[tauri::command]
pub async fn verify_key(base_url: String, key: String) -> Result<verify::VerifyResult, AppError> {
    verify::verify_key(&base_url, &key).await
}

/// Same as verify_key but uses the key already stored in the OS keychain, so
/// the frontend never has to hold the plaintext key after onboarding.
#[tauri::command]
pub async fn verify_stored_key(state: State<'_, AppState>) -> Result<verify::VerifyResult, AppError> {
    let base_url = state.0.lock().await.base_url.clone();
    let key = load_secret(KEYCHAIN_API_KEY_USER)?.ok_or_else(|| AppError::NotFound("No local key -- apply for one first".to_string()))?;
    verify::verify_key(&base_url, &key).await
}

#[tauri::command]
pub async fn set_config(
    state: State<'_, AppState>,
    base_url: String,
    anthropic_model: Option<String>,
    open_ai_model: Option<String>,
) -> Result<(), AppError> {
    let mut s = state.0.lock().await;
    s.base_url = base_url.trim_end_matches('/').to_string();
    s.selected_anthropic_model = anthropic_model;
    s.selected_openai_model = open_ai_model;
    s.save().map_err(|e| AppError::Io(e.to_string()))
}

#[tauri::command]
pub async fn toggle_claude(state: State<'_, AppState>, on: bool) -> Result<(), AppError> {
    let mut s = state.0.lock().await;
    if on {
        let key = load_secret(KEYCHAIN_API_KEY_USER)?.ok_or_else(|| AppError::NotFound("No local key -- apply for one first".to_string()))?;
        let base_url = s.base_url.clone();
        let model = s.selected_anthropic_model.clone();
        s.claude = claude::apply(&base_url, &key, model.as_deref())?;
    } else {
        claude::restore(&s.claude)?;
        s.claude = ToolState::default();
    }
    s.save().map_err(|e| AppError::Io(e.to_string()))
}

#[tauri::command]
pub async fn toggle_codex(state: State<'_, AppState>, on: bool) -> Result<(), AppError> {
    let mut s = state.0.lock().await;
    if on {
        let key = load_secret(KEYCHAIN_API_KEY_USER)?.ok_or_else(|| AppError::NotFound("No local key -- apply for one first".to_string()))?;
        let base_url = s.base_url.clone();
        let model = s
            .selected_openai_model
            .clone()
            .ok_or_else(|| AppError::InvalidKey("Codex requires a model to be selected first".to_string()))?;
        s.codex = codex::apply(&base_url, &key, &model)?;
    } else {
        codex::restore(&s.codex)?;
        s.codex = ToolState::default();
    }
    s.save().map_err(|e| AppError::Io(e.to_string()))
}

#[derive(Serialize)]
pub struct DetectResult {
    #[serde(rename = "claudeConfigExists")]
    pub claude_config_exists: bool,
    #[serde(rename = "codexConfigExists")]
    pub codex_config_exists: bool,
}

#[tauri::command]
pub fn detect_tools() -> DetectResult {
    DetectResult {
        claude_config_exists: crate::paths::claude_config_dir().exists(),
        codex_config_exists: crate::paths::codex_config_dir().exists(),
    }
}

#[tauri::command]
pub fn open_config_dir(tool: String) -> Result<(), AppError> {
    let dir = match tool.as_str() {
        "claude" => crate::paths::claude_config_dir(),
        "codex" => crate::paths::codex_config_dir(),
        other => return Err(AppError::NotFound(format!("Unknown tool \"{other}\""))),
    };
    open::that(dir).map_err(|e| AppError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exercises the actual Windows Credential Manager (or macOS Keychain on
    /// that platform) round trip -- this is the one part unit tests can't fake,
    /// since it's a real OS API call, not just file I/O.
    #[test]
    fn keychain_round_trip() {
        let test_user = "test-round-trip-do-not-use";
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, test_user).unwrap();
        let _ = entry.delete_password(); // clean slate in case a prior run left it behind

        assert_eq!(load_secret(test_user).unwrap(), None);

        store_secret(test_user, "sk-round-trip-test-value").unwrap();
        assert_eq!(load_secret(test_user).unwrap(), Some("sk-round-trip-test-value".to_string()));

        // overwrite works, not just first-write
        store_secret(test_user, "sk-second-value").unwrap();
        assert_eq!(load_secret(test_user).unwrap(), Some("sk-second-value".to_string()));

        entry.delete_password().unwrap();
        assert_eq!(load_secret(test_user).unwrap(), None);
    }
}
