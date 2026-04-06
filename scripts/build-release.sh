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
bun build "$ROOT/packages/mcp-memory/dist/index.js" --compile --outfile "$BINDIR/coagent-memory-$TARGET"

chmod +x "$BINDIR/"*

# Step 3: Build Tauri app (it auto-bundles the binaries from externalBin)
echo ""
echo "[3/3] Building Tauri app..."
cd "$ROOT/apps/desktop"
pnpm tauri build

APP="$ROOT/apps/desktop/src-tauri/target/release/bundle/macos/Co-Agent.app"
VERSION=$(grep '"version"' "$ROOT/apps/desktop/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')
ARCH=$(echo "$TARGET" | cut -d- -f1)
DMG="$ROOT/apps/desktop/src-tauri/target/release/bundle/dmg/Co-Agent_${VERSION}_${ARCH}.dmg"

echo ""
echo "=== Build Complete ==="
echo "App: $APP"

# Step 4: Sign + Notarize (if APPLE_SIGNING_IDENTITY is set)
if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
  echo ""
  echo "=== Code Signing ==="

  ENTITLEMENTS="$ROOT/apps/desktop/src-tauri/Entitlements.plist"

  # Sign sidecars first
  echo "  Signing sidecars..."
  codesign --force --options runtime --entitlements "$ENTITLEMENTS" \
    --sign "$APPLE_SIGNING_IDENTITY" \
    "$APP/Contents/MacOS/coagent-server"
  codesign --force --options runtime --entitlements "$ENTITLEMENTS" \
    --sign "$APPLE_SIGNING_IDENTITY" \
    "$APP/Contents/MacOS/coagent-memory"
  # Sign the main app bundle
  echo "  Signing app bundle..."
  codesign --force --options runtime --entitlements "$ENTITLEMENTS" \
    --sign "$APPLE_SIGNING_IDENTITY" \
    --deep "$APP"

  echo "  Verifying signature..."
  codesign --verify --deep --strict "$APP"
  echo "  ✓ Signature valid"

  # Rebuild DMG with signed app
  if [ -f "$DMG" ]; then
    rm "$DMG"
  fi
  echo "  Creating signed DMG..."
  hdiutil create -volname "Co-Agent" -srcfolder "$APP" -ov -format UDZO "$DMG"
  codesign --sign "$APPLE_SIGNING_IDENTITY" "$DMG"

  # Notarize if credentials are available
  if [ -n "$APPLE_ID" ] && [ -n "$APPLE_PASSWORD" ] && [ -n "$APPLE_TEAM_ID" ]; then
    echo ""
    echo "=== Notarizing ==="
    echo "  Submitting to Apple..."
    xcrun notarytool submit "$DMG" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait

    echo "  Stapling ticket..."
    xcrun stapler staple "$DMG"
    echo "  ✓ Notarization complete"
  else
    echo ""
    echo "  ⚠ Skipping notarization (set APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID)"
  fi
else
  echo ""
  echo "  ⚠ Skipping signing (set APPLE_SIGNING_IDENTITY to enable)"
  echo "  Example: APPLE_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAMID)' ./scripts/build-release.sh"
fi

echo ""
echo "=== Done ==="
[ -f "$DMG" ] && echo "DMG: $DMG"
