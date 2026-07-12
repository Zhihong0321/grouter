#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod claude;
mod codex;
mod commands;
mod config;
mod error;
mod marketplace;
mod opencode;
mod paths;
mod state;
#[cfg(test)]
mod test_support;
mod tools;
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
            commands::get_usage,
            commands::get_status,
            commands::verify_key,
            commands::verify_stored_key,
            commands::set_config,
            commands::toggle_claude,
            commands::toggle_codex,
            commands::toggle_opencode,
            commands::detect_tools,
            commands::open_config_dir,
            commands::open_external,
            tools::detect_installations,
            tools::install_tool,
            tools::update_tool,
            marketplace::list_marketplace_entries,
            marketplace::detect_marketplace_status,
            marketplace::install_marketplace_entry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running grouter-switcher");
}
