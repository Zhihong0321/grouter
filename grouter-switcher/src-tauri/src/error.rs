use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    Io(String),
    ParseFailed(String),
    Network(String),
    InvalidKey(String),
    NotFound(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::Io(m) => write!(f, "IO error: {m}"),
            AppError::ParseFailed(m) => write!(f, "Could not parse {m} -- it may have been hand-edited"),
            AppError::Network(m) => write!(f, "Network error: {m}"),
            AppError::InvalidKey(m) => write!(f, "{m}"),
            AppError::NotFound(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for AppError {}
