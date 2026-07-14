use serde::{Deserialize, Serialize};
use tauri::State;

use crate::config::BOOTSTRAP_SECRET;
use crate::error::AppError;
use crate::state::{AppState, ToolState};
use crate::{claude, codex, opencode, verify};

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
    // balance/spent are derived from `numeric` budget_cents/spent_cents and can
    // be fractional, so keep them as f64 (see UsageEntry::cost_cents).
    #[serde(rename = "balanceCents")]
    pub balance_cents: Option<f64>,
    #[serde(rename = "spentCents")]
    pub spent_cents: f64,
    pub unlimited: bool,
}

#[derive(Deserialize)]
struct MeResponseBody {
    username: String,
    #[serde(rename = "balanceCents")]
    balance_cents: Option<f64>,
    #[serde(rename = "spentCents")]
    spent_cents: f64,
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
    // cost_cents is a Postgres `numeric` and, since per-model pricing landed,
    // carries sub-cent fractions (e.g. 4.0573). It serializes as a JSON float,
    // so this must be f64 -- serde_json refuses to decode a float into an int
    // and reqwest surfaced that as "error decoding response body".
    #[serde(rename = "costCents")]
    pub cost_cents: f64,
    pub stream: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Serialize, Deserialize)]
pub struct UsageResult {
    #[serde(rename = "requestCount")]
    pub request_count: i64,
    // Fractional (numeric) -- see UsageEntry::cost_cents.
    #[serde(rename = "costCents")]
    pub cost_cents: f64,
    // Smart-router savings: what requests would have cost on the requested model
    // minus what the routed (cheaper) model actually cost. Fractional (numeric).
    #[serde(rename = "savedCents", default)]
    pub saved_cents: f64,
    #[serde(rename = "switchedCount", default)]
    pub switched_count: i64,
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
    pub smart: bool,
    pub drifted: bool,
}

#[derive(Serialize)]
pub struct StatusResult {
    pub claude: ToolStatusResult,
    pub codex: ToolStatusResult,
    pub opencode: ToolStatusResult,
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
            smart: s.claude.smart,
            drifted: claude::is_drifted(&s.claude, &s.base_url, &key),
        },
        codex: ToolStatusResult {
            installed: crate::paths::codex_config_dir().exists(),
            enabled: s.codex.enabled,
            smart: s.codex.smart,
            drifted: codex::is_drifted(&s.codex, &s.base_url, &key),
        },
        opencode: ToolStatusResult {
            installed: crate::paths::opencode_config_dir().exists(),
            enabled: s.opencode.enabled,
            smart: s.opencode.smart,
            drifted: opencode::is_drifted(&s.opencode, &s.base_url, &key),
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

/// Three-way mode a tool card can be set to: "official" (grouter untouched),
/// "grouter" (pinned model), or "smart" (grouter's always-on tier router --
/// see src/lib/tierRouting.ts -- picks the model per request, so no pin is
/// sent for Claude Code; Codex/OpenCode still need *a* model value to boot
/// but the server may still override it per request).
#[tauri::command]
pub async fn toggle_claude(state: State<'_, AppState>, mode: String) -> Result<(), AppError> {
    let mut s = state.0.lock().await;
    if mode == "official" {
        claude::restore(&s.claude)?;
        s.claude = ToolState::default();
    } else {
        let key = load_secret(KEYCHAIN_API_KEY_USER)?.ok_or_else(|| AppError::NotFound("No local key -- apply for one first".to_string()))?;
        let base_url = s.base_url.clone();
        let smart = mode == "smart";
        let model = if smart { None } else { s.selected_anthropic_model.clone() };
        let mut tool_state = claude::apply(&base_url, &key, model.as_deref())?;
        tool_state.smart = smart;
        s.claude = tool_state;
    }
    s.save().map_err(|e| AppError::Io(e.to_string()))
}

#[tauri::command]
pub async fn toggle_codex(state: State<'_, AppState>, mode: String) -> Result<(), AppError> {
    if mode == "official" {
        let mut s = state.0.lock().await;
        codex::restore(&s.codex)?;
        s.codex = ToolState::default();
        return s.save().map_err(|e| AppError::Io(e.to_string()));
    }

    let (base_url, selected_model, previous_snapshot) = {
        let s = state.0.lock().await;
        (
            s.base_url.clone(),
            s.selected_openai_model.clone(),
            if s.codex.enabled {
                Some(s.codex.snapshot.clone())
            } else {
                None
            },
        )
    };
    let key = load_secret(KEYCHAIN_API_KEY_USER)?.ok_or_else(|| {
        AppError::NotFound("No local key -- apply for one first".to_string())
    })?;

    // A model is optional in the UI. If the user did not choose a default,
    // use the first currently available GROUTER model so Codex can start.
    let model = match selected_model.filter(|model| !model.is_empty()) {
        Some(model) => model,
        None => verify::verify_key(&base_url, &key)
            .await?
            .open_ai_models
            .into_iter()
            .next()
            .map(|model| model.id)
            .ok_or_else(|| AppError::NotFound("GROUTER returned no OpenAI models".to_string()))?,
    };

    let mut s = state.0.lock().await;
    let mut tool_state = match previous_snapshot.as_ref() {
        Some(snapshot) => codex::apply_with_snapshot(&base_url, &key, &model, Some(snapshot))?,
        None => codex::apply(&base_url, &key, &model)?,
    };
    tool_state.smart = mode == "smart";
    s.selected_openai_model = Some(model);
    s.codex = tool_state;
    s.save().map_err(|e| AppError::Io(e.to_string()))
}

#[tauri::command]
pub async fn toggle_opencode(state: State<'_, AppState>, mode: String) -> Result<(), AppError> {
    let mut s = state.0.lock().await;
    if mode == "official" {
        opencode::restore(&s.opencode)?;
        s.opencode = ToolState::default();
    } else {
        let key = load_secret(KEYCHAIN_API_KEY_USER)?.ok_or_else(|| AppError::NotFound("No local key -- apply for one first".to_string()))?;
        let base_url = s.base_url.clone();
        let model = s
            .selected_openai_model
            .clone()
            .ok_or_else(|| AppError::InvalidKey("OpenCode requires a model to be selected first".to_string()))?;
        let mut tool_state = opencode::apply(&base_url, &key, &model)?;
        tool_state.smart = mode == "smart";
        s.opencode = tool_state;
    }
    s.save().map_err(|e| AppError::Io(e.to_string()))
}

#[derive(Serialize)]
pub struct DetectResult {
    #[serde(rename = "claudeConfigExists")]
    pub claude_config_exists: bool,
    #[serde(rename = "codexConfigExists")]
    pub codex_config_exists: bool,
    #[serde(rename = "opencodeConfigExists")]
    pub opencode_config_exists: bool,
}

#[tauri::command]
pub fn detect_tools() -> DetectResult {
    DetectResult {
        claude_config_exists: crate::paths::claude_config_dir().exists(),
        codex_config_exists: crate::paths::codex_config_dir().exists(),
        opencode_config_exists: crate::paths::opencode_config_dir().exists(),
    }
}

#[tauri::command]
pub fn open_config_dir(tool: String) -> Result<(), AppError> {
    let dir = match tool.as_str() {
        "claude" => crate::paths::claude_config_dir(),
        "codex" => crate::paths::codex_config_dir(),
        "opencode" => crate::paths::opencode_config_dir(),
        other => return Err(AppError::NotFound(format!("Unknown tool \"{other}\""))),
    };
    open::that(dir).map_err(|e| AppError::Io(e.to_string()))
}

/// Opens a marketplace entry's source URL in the user's default browser.
/// Only ever called with the static `sourceUrl` values marketplace.rs ships
/// (never arbitrary user input), but still restricted to http(s) so this
/// can't be repurposed to launch an arbitrary local file or protocol handler.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), AppError> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(AppError::InvalidKey("Only http(s) URLs can be opened".to_string()));
    }
    open::that(url).map_err(|e| AppError::Io(e.to_string()))
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
