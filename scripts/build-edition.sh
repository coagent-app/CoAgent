#!/bin/bash
# Build a specific CoAgent edition.
# Usage: COAGENT_VERTICAL=sales COAGENT_TEAM=false ./scripts/build-edition.sh
set -euo pipefail

VERTICAL="${COAGENT_VERTICAL:-personal}"
TEAM="${COAGENT_TEAM:-false}"
CONF="apps/desktop/src-tauri/tauri.conf.json"

declare -A APP_NAMES=(
  [personal]="CoAgent"
  [real-estate]="CoAgent for Real Estate"
  [sales]="CoAgent for Sales"
  [ecommerce]="CoAgent for E-commerce"
  [agency]="CoAgent for Agencies"
)

declare -A BUNDLE_IDS=(
  [personal]="com.coagent.personal"
  [real-estate]="com.coagent.real-estate"
  [sales]="com.coagent.sales"
  [ecommerce]="com.coagent.ecommerce"
  [agency]="com.coagent.agency"
)

APP_NAME="${APP_NAMES[$VERTICAL]:-CoAgent}"
BUNDLE_ID="${BUNDLE_IDS[$VERTICAL]:-com.coagent.personal}"

if [ "$TEAM" = "true" ]; then
  APP_NAME="$APP_NAME — Team"
  BUNDLE_ID="$BUNDLE_ID-team"
fi

echo "Building: $APP_NAME ($BUNDLE_ID)"
echo "Vertical: $VERTICAL | Team: $TEAM"

# Backup original config
cp "$CONF" "$CONF.bak"

# Patch tauri.conf.json
node -e "
const fs = require('fs');
const conf = JSON.parse(fs.readFileSync('$CONF', 'utf-8'));
conf.productName = '$APP_NAME';
conf.identifier = '$BUNDLE_ID';
conf.app.windows[0].title = '$APP_NAME';
fs.writeFileSync('$CONF', JSON.stringify(conf, null, 2));
"

# Build sidecar with edition env vars
echo "Building sidecar..."
cd packages/agent-core
pnpm build
bun build ./dist/server.js --compile \
  --outfile ../../apps/desktop/src-tauri/binaries/coagent-server-aarch64-apple-darwin \
  --define "process.env.COAGENT_VERTICAL='$VERTICAL'" \
  --define "process.env.COAGENT_TEAM='$TEAM'"
cd ../..

# Build Tauri app with edition env vars
echo "Building Tauri app..."
cd apps/desktop
COAGENT_VERTICAL="$VERTICAL" COAGENT_TEAM="$TEAM" pnpm tauri build
cd ../..

# Restore original config
mv "$CONF.bak" "$CONF"

echo "Done! DMG at apps/desktop/src-tauri/target/release/bundle/dmg/"
