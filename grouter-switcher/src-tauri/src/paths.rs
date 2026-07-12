use std::env;
use std::path::PathBuf;

fn home_dir() -> PathBuf {
    dirs::home_dir().expect("could not resolve home directory")
}

/// ~/.claude, honoring a CLAUDE_CONFIG_DIR override.
pub fn claude_config_dir() -> PathBuf {
    match env::var("CLAUDE_CONFIG_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => home_dir().join(".claude"),
    }
}

pub fn claude_settings_path() -> PathBuf {
    claude_config_dir().join("settings.json")
}

/// ~/.codex, honoring a CODEX_HOME override. Shared by the CLI, the IDE
/// extension, and the desktop app -- writing this one file covers all three.
pub fn codex_config_dir() -> PathBuf {
    match env::var("CODEX_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => home_dir().join(".codex"),
    }
}

pub fn codex_config_path() -> PathBuf {
    codex_config_dir().join("config.toml")
}

/// ~/.config/opencode, honoring an XDG_CONFIG_HOME override (opencode uses
/// XDG-style paths on every platform, including Windows -- confirmed via
/// `opencode debug paths`).
pub fn opencode_config_dir() -> PathBuf {
    let config_home = match env::var("XDG_CONFIG_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => home_dir().join(".config"),
    };
    config_home.join("opencode")
}

pub fn opencode_config_path() -> PathBuf {
    opencode_config_dir().join("opencode.json")
}

/// The app's own state dir -- kept separate from the tools' own config dirs
/// so a `grouter-switcher` uninstall never touches ~/.claude or ~/.codex.
pub fn app_config_dir() -> PathBuf {
    dirs::config_dir()
        .expect("could not resolve app config directory")
        .join("grouter-switcher")
}
