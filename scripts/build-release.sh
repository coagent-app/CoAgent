#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$(rustc -vV | grep host | awk '{print $2}')"
BINDIR="$ROOT/apps/desktop/src-tauri/binaries"

echo "=== Building CoAgent Release ==="
echo "Target: $TARGET"

# Step 1: Build the TypeScript packages
echo ""
echo "[1/3] Building TypeScript packages..."
cd "$ROOT"
pnpm build

# Step 2: Compile sidecar binaries with bun
echo ""
echo "[2/3] Compiling sidecar binaries..."
mkdir -p "$BINDIR"

echo "  → coagent-server"
bun build "$ROOT/packages/agent-core/dist/server.js" --compile --outfile "$BINDIR/coagent-server-$TARGET"

echo "  → coagent-memory"
MCP_ENTRY=$(node -e "console.log(require.resolve('@coagent/mcp-memory'))")
bun build "$MCP_ENTRY" --compile --outfile "$BINDIR/coagent-memory-$TARGET"

chmod +x "$BINDIR/"*

# Step 3: Build Tauri app (it auto-bundles the binaries from externalBin)
echo ""
echo "[3/3] Building Tauri app..."
cd "$ROOT/apps/desktop"
pnpm tauri build

echo ""
echo "=== Done ==="
echo "App: $ROOT/apps/desktop/src-tauri/target/release/bundle/macos/Co-Agent.app"
