#![cfg(test)]

use std::sync::{Mutex, MutexGuard};

/// CLAUDE_CONFIG_DIR / CODEX_HOME / XDG_CONFIG_HOME are process-global, so any
/// test that points one at a sandbox dir must hold this lock for its whole
/// body -- otherwise a concurrently running test (cargo test's default
/// thread-per-test runner) can repoint the same var out from under it.
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Recovers from a poisoned lock instead of propagating the panic, so one
/// failing test doesn't cascade-fail every other sandboxed test after it.
pub fn lock_env() -> MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
