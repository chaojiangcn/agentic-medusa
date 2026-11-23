#!/usr/bin/env bash
# Start the Medusa App Server (build once with: cd server && cargo build).
# No machine-specific paths: works with any standard Rust toolchain.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/server/target/debug/medusa-app-server"
[ -f "$BIN.exe" ] && BIN="$BIN.exe"
if [ ! -f "$BIN" ]; then
  echo "Binary not found. Build it first:" >&2
  echo "  cd server && cargo build" >&2
  exit 1
fi
export MEDUSA_HOME="${MEDUSA_HOME:-$ROOT/.medusa-home}"
cd "$ROOT/server"
exec "$BIN" "$@"
