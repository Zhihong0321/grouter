#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod claude;
mod codex;
mod commands;
mod config;
mod error;
mod paths;
mod state;
mod verify;

use state::AppState;

fn main() {
    tauri::Builder::default()
        .manage(AppState::load())
        .invoke_handler(tauri::generate_handler![
            commands::has_local_key,
            commands::apply_for_key,
            commands::recover_account,
            commands::get_balance,
            commands::get_status,
            commands::verify_key,
            commands::verify_stored_key,
            commands::set_config,
            commands::toggle_claude,
            commands::toggle_codex,
            commands::detect_tools,
            commands::open_config_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running grouter-switcher");
}
