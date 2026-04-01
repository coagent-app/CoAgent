# CoAgent Editions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support multiple CoAgent editions (vertical + team flag) from a single codebase using two build-time env vars.

**Architecture:** `COAGENT_VERTICAL` and `COAGENT_TEAM` env vars control what gets included per build. A shared `presets.ts` defines per-vertical configuration (app name, default settings, system prompt flavor, suggested integrations). Frontend reads flags via Vite `define`, backend reads from `process.env`. A build script patches `tauri.conf.json` before `tauri build`.

**Tech Stack:** TypeScript, Vite, Tauri, Node.js

---

### Task 1: Create presets.ts with vertical definitions

**Files:**
- Create: `packages/agent-core/src/presets.ts`

**Step 1: Create the presets file**

```typescript
import type { Autonomy, DayName } from '@coagent/shared'

export interface VerticalPreset {
  id: string
  appName: string
  bundleId: string
  defaultRole: string
  defaultAutonomy: Autonomy
  activeHours: { start: number; end: number }
  activeDays: DayName[]
  suggestedIntegrations: string[]
  systemPromptFlavor: string
}

export const PRESETS: Record<string, VerticalPreset> = {
  personal: {
    id: 'personal',
    appName: 'CoAgent',
    bundleId: 'com.coagent.personal',
    defaultRole: '',
    defaultAutonomy: 'ask_first',
    activeHours: { start: 7, end: 24 },
    activeDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    suggestedIntegrations: ['GMAIL', 'GOOGLECALENDAR', 'GOOGLEDRIVE'],
    systemPromptFlavor: '',
  },
  'real-estate': {
    id: 'real-estate',
    appName: 'CoAgent for Real Estate',
    bundleId: 'com.coagent.real-estate',
    defaultRole: 'Real Estate Agent',
    defaultAutonomy: 'balanced',
    activeHours: { start: 8, end: 19 },
    activeDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
    suggestedIntegrations: ['GMAIL', 'GOOGLECALENDAR', 'DOCUSIGN', 'GOOGLEDRIVE'],
    systemPromptFlavor: `You specialize in real estate. Prioritize: tracking leads, scheduling showings, drafting offer summaries, monitoring closing timelines, following up with buyers and sellers, and preparing market comparisons. When you see new contacts, think about whether they're buyers, sellers, or agents.`,
  },
  sales: {
    id: 'sales',
    appName: 'CoAgent for Sales',
    bundleId: 'com.coagent.sales',
    defaultRole: 'Sales Professional',
    defaultAutonomy: 'balanced',
    activeHours: { start: 8, end: 19 },
    activeDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    suggestedIntegrations: ['GMAIL', 'GOOGLECALENDAR', 'HUBSPOT', 'LINKEDIN'],
    systemPromptFlavor: `You specialize in sales. Prioritize: monitoring deal stages, preparing meeting briefs, researching prospects, drafting follow-up emails, tracking pipeline metrics, and managing proposal deadlines. Think in terms of pipeline, close rates, and next actions.`,
  },
  ecommerce: {
    id: 'ecommerce',
    appName: 'CoAgent for E-commerce',
    bundleId: 'com.coagent.ecommerce',
    defaultRole: 'E-commerce Manager',
    defaultAutonomy: 'autonomous',
    activeHours: { start: 7, end: 24 },
    activeDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    suggestedIntegrations: ['GMAIL', 'SHOPIFY', 'STRIPE', 'SLACK', 'GOOGLESHEETS'],
    systemPromptFlavor: `You specialize in e-commerce. Prioritize: monitoring orders, handling customer emails, flagging refund requests, tracking inventory levels, and analyzing sales trends. Be proactive about customer satisfaction and order fulfillment issues.`,
  },
  agency: {
    id: 'agency',
    appName: 'CoAgent for Agencies',
    bundleId: 'com.coagent.agency',
    defaultRole: 'Agency Professional',
    defaultAutonomy: 'ask_first',
    activeHours: { start: 9, end: 18 },
    activeDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    suggestedIntegrations: ['GMAIL', 'SLACK', 'GOOGLEDRIVE', 'NOTION'],
    systemPromptFlavor: `You specialize in agency/marketing work. Prioritize: tracking project updates, drafting creative briefs, managing client approvals, summarizing meeting notes, monitoring deadlines, and coordinating across teams. Think in terms of deliverables, clients, and timelines.`,
  },
}

export function getPreset(vertical?: string): VerticalPreset {
  return PRESETS[vertical || 'personal'] || PRESETS.personal
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && pnpm --filter agent-core build`
Expected: PASS (no errors)

**Step 3: Commit**

```bash
git add packages/agent-core/src/presets.ts
git commit -m "feat: add vertical preset definitions"
```

---

### Task 2: Create edition.ts for backend

**Files:**
- Create: `packages/agent-core/src/edition.ts`

**Step 1: Create the backend edition module**

```typescript
import { getPreset, type VerticalPreset } from './presets.js'

export type { VerticalPreset }
export { getPreset, PRESETS } from './presets.js'

let _edition: { vertical: string; team: boolean; preset: VerticalPreset } | null = null

export function getEdition() {
  if (!_edition) {
    const vertical = process.env.COAGENT_VERTICAL || 'personal'
    const team = process.env.COAGENT_TEAM === 'true'
    const preset = getPreset(vertical)
    _edition = { vertical, team, preset }
  }
  return _edition
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && pnpm --filter agent-core build`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/agent-core/src/edition.ts
git commit -m "feat: add backend edition module"
```

---

### Task 3: Create frontend edition module + wire Vite define

**Files:**
- Create: `apps/desktop/src/lib/edition.ts`
- Modify: `apps/desktop/vite.config.ts`

**Step 1: Add Vite define for build flags**

In `apps/desktop/vite.config.ts`, add a `define` block inside `defineConfig`:

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  define: {
    __COAGENT_VERTICAL__: JSON.stringify(process.env.COAGENT_VERTICAL || 'personal'),
    __COAGENT_TEAM__: JSON.stringify(process.env.COAGENT_TEAM === 'true'),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        overlay: path.resolve(__dirname, 'overlay.html'),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
})
```

**Step 2: Create the frontend edition module**

```typescript
// apps/desktop/src/lib/edition.ts

declare const __COAGENT_VERTICAL__: string
declare const __COAGENT_TEAM__: boolean

export const VERTICAL: string = typeof __COAGENT_VERTICAL__ !== 'undefined' ? __COAGENT_VERTICAL__ : 'personal'
export const HAS_TEAM: boolean = typeof __COAGENT_TEAM__ !== 'undefined' ? __COAGENT_TEAM__ : false

interface EditionInfo {
  vertical: string
  hasTeam: boolean
  appName: string
}

const APP_NAMES: Record<string, string> = {
  personal: 'CoAgent',
  'real-estate': 'CoAgent for Real Estate',
  sales: 'CoAgent for Sales',
  ecommerce: 'CoAgent for E-commerce',
  agency: 'CoAgent for Agencies',
}

export function getEditionInfo(): EditionInfo {
  const baseName = APP_NAMES[VERTICAL] || 'CoAgent'
  return {
    vertical: VERTICAL,
    hasTeam: HAS_TEAM,
    appName: HAS_TEAM ? `${baseName} — Team` : baseName,
  }
}
```

**Step 3: Verify both compile**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && pnpm --filter agent-core build && pnpm --filter @coagent/desktop build`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/desktop/vite.config.ts apps/desktop/src/lib/edition.ts
git commit -m "feat: add frontend edition module and Vite define flags"
```

---

### Task 4: Wire edition into Sidebar (team tab + app name)

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx:12,124-136`
- Modify: `apps/desktop/src/App.tsx:68-79`

**Step 1: Import edition in Sidebar and use for app name**

In `apps/desktop/src/components/Sidebar.tsx`, replace the hardcoded "Co-Agent" title with the edition app name:

At the top, add:
```typescript
import { getEditionInfo } from '@/lib/edition'
```

Replace line 129-131:
```typescript
        <span className="text-[15px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          Co-Agent
        </span>
```

With:
```typescript
        <span className="text-[15px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          {getEditionInfo().appName}
        </span>
```

**Step 2: Use edition for team tab instead of prop**

In `apps/desktop/src/components/Sidebar.tsx`, update the Team nav item on line 136.

Replace:
```typescript
        {hasTeam && <NavItem icon={Users} label="Team" active={view === 'team'} onClick={() => onViewChange('team')} />}
```

With:
```typescript
        {(getEditionInfo().hasTeam && hasTeam) && <NavItem icon={Users} label="Team" active={view === 'team'} onClick={() => onViewChange('team')} />}
```

This means: Team tab only shows when the edition includes team AND the user actually has a team connected. Personal editions never show it regardless of relay state.

**Step 3: Verify it renders**

Run: `cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop && pnpm tauri dev`
Expected: App opens. Title shows "CoAgent" (since default vertical is personal). No Team tab visible (since COAGENT_TEAM is not set).

**Step 4: Test with team flag**

Run: `COAGENT_TEAM=true cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop && pnpm tauri dev`
Expected: Team tab appears (if relay connected with a team).

**Step 5: Commit**

```bash
git add apps/desktop/src/components/Sidebar.tsx apps/desktop/src/App.tsx
git commit -m "feat: wire edition into sidebar app name and team tab"
```

---

### Task 5: Wire edition into default settings

**Files:**
- Modify: `packages/agent-core/src/settings.ts:10-25,32-56`

**Step 1: Use preset for DEFAULT_SETTINGS**

In `packages/agent-core/src/settings.ts`, import the edition and use its preset for defaults.

Add import at top:
```typescript
import { getEdition } from './edition.js'
```

Replace the static `DEFAULT_SETTINGS` (lines 10-25) with a function:
```typescript
function getDefaultSettings(): AgentSettings {
  const { preset } = getEdition()
  return {
    name: '',
    email: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago',
    role: preset.defaultRole,
    active_hours: { ...preset.activeHours },
    active_days: [...preset.activeDays],
    autonomy: preset.defaultAutonomy,
    heartbeat_interval: 60,
    powerModel: 'claude-sonnet-4-6',
    voice_enabled: false,
    voice_response: false,
    voice_hotkey: 'Control+Alt+Space',
    voice_voice: 'alloy',
  }
}

export const DEFAULT_SETTINGS: AgentSettings = getDefaultSettings()
```

**Step 2: Verify it compiles and defaults are correct**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && pnpm --filter agent-core build`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/agent-core/src/settings.ts
git commit -m "feat: use edition preset for default settings"
```

---

### Task 6: Wire edition into system prompt

**Files:**
- Modify: `packages/agent-core/src/agent.ts:592-633`

**Step 1: Add preset flavor to system prompt**

In `packages/agent-core/src/agent.ts`, import the edition:
```typescript
import { getEdition } from './edition.js'
```

In `buildSystemPrompt()` (line 592), add the vertical flavor after the existing prompt. Find line 633 (the return statement's closing backtick area) and insert the flavor before the team section:

Replace line 633:
```typescript
Notifications: title 2-4 words, body one sentence.${onboardingSection}${teamRoster && teamRoster.length > 0 ? `\n\n## Team: ...` : ''}`
```

With:
```typescript
Notifications: title 2-4 words, body one sentence.${onboardingSection}${getEdition().preset.systemPromptFlavor ? `\n\n## Specialization\n${getEdition().preset.systemPromptFlavor}` : ''}${teamRoster && teamRoster.length > 0 ? `\n\n## Team: ${teamName || 'Your Team'}\n\nYou are part of a team. Each member has their own AI agent — when you message someone, you're talking to their agent (another AI like you), not the person directly.\nMembers:\n${teamRoster.map((m: any) => `- ${m.name} (${m.role})`).join('\n')}\n\nUse send_team_message with to="name" to message their agent. You'll wait for and receive their agent's response. Omit "to" to broadcast.\nInclude agent_context with relevant background for the receiving agent.` : ''}`
```

**Step 2: Wire COAGENT_TEAM into tool gating**

In the same file, update `getInternalTools()` (line 556) so team tools also check the edition flag:

```typescript
function getInternalTools(context: ToolContext, activeSkillTools?: Set<string>, hasTeam?: boolean): Anthropic.Tool[] {
  const editionHasTeam = getEdition().team
  if (context === 'heartbeat') return INTERNAL_TOOLS.filter(t => HEARTBEAT_TOOLS.has(t.name))
  return INTERNAL_TOOLS.filter(t => {
    if (SKILL_GATED_TOOLS.has(t.name) && !activeSkillTools?.has(t.name)) return false
    if (TEAM_ONLY_TOOLS.has(t.name) && (!hasTeam || !editionHasTeam)) return false
    return true
  })
}
```

**Step 3: Verify it compiles**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && pnpm --filter agent-core build`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/agent-core/src/agent.ts
git commit -m "feat: wire edition vertical flavor into system prompt and tool gating"
```

---

### Task 7: Create build script to patch tauri.conf.json

**Files:**
- Create: `scripts/build-edition.sh`

**Step 1: Write the build script**

```bash
#!/bin/bash
# Usage: COAGENT_VERTICAL=sales COAGENT_TEAM=false ./scripts/build-edition.sh
set -euo pipefail

VERTICAL="${COAGENT_VERTICAL:-personal}"
TEAM="${COAGENT_TEAM:-false}"
CONF="apps/desktop/src-tauri/tauri.conf.json"

# Map vertical to app name and bundle ID
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
COAGENT_VERTICAL="$VERTICAL" COAGENT_TEAM="$TEAM" pnpm build
bun build ./dist/server.js --compile --outfile ../../apps/desktop/src-tauri/binaries/coagent-server-aarch64-apple-darwin --define "process.env.COAGENT_VERTICAL='$VERTICAL'" --define "process.env.COAGENT_TEAM='$TEAM'"
cd ../..

# Build Tauri app with edition env vars
echo "Building Tauri app..."
cd apps/desktop
COAGENT_VERTICAL="$VERTICAL" COAGENT_TEAM="$TEAM" pnpm tauri build
cd ../..

# Restore original config
mv "$CONF.bak" "$CONF"

echo "Done! DMG at apps/desktop/src-tauri/target/release/bundle/dmg/"
```

**Step 2: Make it executable**

Run: `chmod +x /Users/brettponters/AI-Projects/CoAgent/scripts/build-edition.sh`

**Step 3: Commit**

```bash
git add scripts/build-edition.sh
git commit -m "feat: add build-edition script for vertical builds"
```

---

### Task 8: Wire edition into server.ts team client init

**Files:**
- Modify: `packages/agent-core/src/server.ts:985-990`

**Step 1: Gate team client initialization on edition flag**

In `packages/agent-core/src/server.ts`, import the edition:
```typescript
import { getEdition } from './edition.js'
```

Find the team client initialization block (around line 985):
```typescript
// Team client
try {
  if (process.env.RELAY_URL && process.env.RELAY_TOKEN) {
```

Change to:
```typescript
// Team client — only initialize if edition includes team
try {
  if (getEdition().team && process.env.RELAY_URL && process.env.RELAY_TOKEN) {
```

**Step 2: Verify it compiles**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && pnpm --filter agent-core build`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/agent-core/src/server.ts
git commit -m "feat: gate team client init on edition flag"
```

---

### Task 9: End-to-end test — personal edition

**Step 1: Run dev with personal defaults (no flags)**

Run: `cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop && pnpm tauri dev`

**Verify:**
- [ ] App title shows "CoAgent" (not "Co-Agent")
- [ ] No Team tab in sidebar
- [ ] Settings defaults match personal preset (ask_first autonomy, 7am-midnight, all days)
- [ ] Agent system prompt has no specialization section
- [ ] Team tools not available to agent

**Step 2: Run dev with sales + team flags**

Run: `COAGENT_VERTICAL=sales COAGENT_TEAM=true cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop && pnpm tauri dev`

**Verify:**
- [ ] App title shows "CoAgent for Sales — Team"
- [ ] Team tab visible (if relay connected with team)
- [ ] Settings defaults match sales preset (balanced autonomy, 8am-7pm, Mon-Fri)
- [ ] Agent system prompt includes sales specialization
- [ ] Team tools available

**Step 3: Commit any fixes**

```bash
git commit -m "test: verify edition system end-to-end"
```
