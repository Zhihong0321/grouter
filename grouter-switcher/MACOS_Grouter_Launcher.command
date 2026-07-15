#!/bin/bash
# macOS launcher for grouter Switcher — the Mac equivalent of rebuild.bat.
# Double-click this file in Finder (it opens in Terminal) to build the app.
# The first run compiles Rust from scratch and can take several minutes.
set -euo pipefail

# cd to this script's own directory, regardless of where it was launched from.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "grouter Switcher — macOS build"
echo "=============================="
echo

# --- prerequisites ---------------------------------------------------------
missing=0
if ! command -v cargo >/dev/null 2>&1; then
  echo "  [x] Rust toolchain not found. Install it with:"
  echo "        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  missing=1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "  [x] Node.js not found. Install from https://nodejs.org or:  brew install node"
  missing=1
fi
if [ "$missing" -ne 0 ]; then
  echo
  echo "Install the missing tool(s) above, then run this launcher again."
  echo "Press any key to close."
  read -n 1 -s
  exit 1
fi

# --- pick a package manager (match rebuild.bat: prefer pnpm, fall back npm) -
if command -v pnpm >/dev/null 2>&1; then
  PKG=pnpm
else
  PKG=npm
fi
echo "Using $PKG to build grouter Switcher..."
echo

# --- backend secret warning ------------------------------------------------
# Baked in at build time via option_env! — without it, account creation 401s.
if [ -z "${GROUTER_BOOTSTRAP_SECRET:-}" ]; then
  echo "  [!] GROUTER_BOOTSTRAP_SECRET is not set."
  echo "      The app will build, but onboarding (POST /client/accounts) will fail"
  echo "      with 401 until you build with it set, e.g.:"
  echo "        export GROUTER_BOOTSTRAP_SECRET=your-secret-here"
  echo "      (must match CLIENT_BOOTSTRAP_SECRET on the grouter backend)."
  echo
fi

# --- build -----------------------------------------------------------------
"$PKG" install
"$PKG" run tauri build

echo
echo "Build complete."
echo "The .app and .dmg are under:"
echo "  src-tauri/target/release/bundle/macos/    (grouter Switcher.app)"
echo "  src-tauri/target/release/bundle/dmg/       (grouter Switcher_*.dmg)"
echo
echo "Press any key to close."
read -n 1 -s
