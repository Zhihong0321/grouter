// Baked in at build time via the `GROUTER_BOOTSTRAP_SECRET` env var (set it
// wherever `cargo tauri build` runs, e.g. CI secrets) -- must match
// `CLIENT_BOOTSTRAP_SECRET` configured on the grouter backend. Empty in dev
// builds where the var isn't set, which the backend will simply reject.
pub const BOOTSTRAP_SECRET: &str = match option_env!("GROUTER_BOOTSTRAP_SECRET") {
    Some(s) => s,
    None => "",
};

pub const DEFAULT_BASE_URL: &str = "https://grouter-production.up.railway.app";
