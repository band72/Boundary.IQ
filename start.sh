#!/usr/bin/env bash
# ─── Boundary.IQ Launcher ────────────────────────────────────────────────────
# Starts both the Node.js API server and the Vite dev client using Node v20.
# Usage:  bash start.sh

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN=""

# ── Find Node v20 via NVM ─────────────────────────────────────────────────────
NVM_NODE="$HOME/.nvm/versions/node/v20.20.2/bin/node"
if [ -x "$NVM_NODE" ]; then
  NODE_BIN="$NVM_NODE"
fi

# Fallback: try sourcing NVM and using nvm-managed node
if [ -z "$NODE_BIN" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  source "$NVM_DIR/nvm.sh"
  nvm use 2>/dev/null || nvm use 20 2>/dev/null || true
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi

# Fallback: system node
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi

if [ -z "$NODE_BIN" ]; then
  echo "❌ ERROR: Node.js not found. Install Node 20+ via NVM: https://github.com/nvm-sh/nvm"
  exit 1
fi

NODE_VER=$("$NODE_BIN" --version 2>/dev/null)
echo "✓ Using Node $NODE_VER at $NODE_BIN"

# ── Derive npm/npx paths ──────────────────────────────────────────────────────
NODE_BINDIR="$(dirname "$NODE_BIN")"
VITE_BIN="$PROJECT_DIR/client/node_modules/.bin/vite"

# ── Start API server ──────────────────────────────────────────────────────────
echo ""
echo "▶ Starting Boundary.IQ API  →  http://localhost:5050"
"$NODE_BIN" --watch "$PROJECT_DIR/server/index.js" &
API_PID=$!
echo "  API PID: $API_PID"

# ── Start Vite client ─────────────────────────────────────────────────────────
sleep 1
echo ""
echo "▶ Starting Vite dev client  →  http://localhost:5174"
(cd "$PROJECT_DIR/client" && "$NODE_BIN" "$VITE_BIN" --port 5174) &
CLIENT_PID=$!
echo "  Client PID: $CLIENT_PID"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Boundary.IQ running!"
echo "  Frontend: http://localhost:5174"
echo "  Backend:  http://localhost:5050"
echo "  Press Ctrl+C to stop both services."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Wait and clean up on exit ─────────────────────────────────────────────────
trap "echo ''; echo '⏹ Stopping services...'; kill $API_PID $CLIENT_PID 2>/dev/null; wait $API_PID $CLIENT_PID 2>/dev/null; echo 'Done.'" INT TERM

wait $API_PID $CLIENT_PID
