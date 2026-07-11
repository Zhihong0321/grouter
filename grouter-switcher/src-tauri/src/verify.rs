use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelInfo {
    pub id: String,
}

#[derive(Debug, Serialize)]
pub struct VerifyResult {
    pub valid: bool,
    #[serde(rename = "anthropicModels")]
    pub anthropic_models: Vec<ModelInfo>,
    #[serde(rename = "openAiModels")]
    pub open_ai_models: Vec<ModelInfo>,
}

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelInfo>,
}

async fn fetch_models(base_url: &str, key: &str, header: &str, value_prefix: &str) -> Result<Vec<ModelInfo>, AppError> {
    let client = reqwest::Client::new();
    let url = format!("{}/v1/models", base_url.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .header(header, format!("{value_prefix}{key}"))
        .send()
        .await
        .map_err(|e| AppError::Network(e.to_string()))?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AppError::InvalidKey("Key was rejected by the server".to_string()));
    }
    if !resp.status().is_success() {
        return Err(AppError::Network(format!("Server returned {}", resp.status())));
    }

    let body: ModelsResponse = resp.json().await.map_err(|e| AppError::Network(e.to_string()))?;
    Ok(body.data)
}

/// GET /v1/models twice -- once as x-api-key (Anthropic-shaped models), once
/// as Bearer (OpenAI-shaped) -- doubling as both key validation and the two
/// model pickers the UI needs.
pub async fn verify_key(base_url: &str, key: &str) -> Result<VerifyResult, AppError> {
    let anthropic_models = fetch_models(base_url, key, "x-api-key", "").await?;
    let open_ai_models = fetch_models(base_url, key, "Authorization", "Bearer ").await?;

    Ok(VerifyResult {
        valid: true,
        anthropic_models,
        open_ai_models,
    })
}
