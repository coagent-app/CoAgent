# CoAgent Editions System Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support multiple CoAgent editions (verticals + team/personal) from a single codebase using build-time flags.

**Architecture:** Two env vars (`COAGENT_VERTICAL`, `COAGENT_TEAM`) control what gets included in each build. A `presets.ts` file defines per-vertical configuration. Everything else stays the same — presets are defaults, not locks.

---

## Build Flags

Two env vars at build time:

- **`COAGENT_VERTICAL`** — `personal` | `real-estate` | `sales` | `ecommerce` | `agency`
- **`COAGENT_TEAM`** — `true` | `false`

Baked into frontend via Vite `define`, into backend via sidecar build env.

```bash
COAGENT_VERTICAL=sales COAGENT_TEAM=false pnpm tauri build
```

## What Each Vertical Controls

A single `presets.ts` defines each vertical:

| Field | Description | Example (Real Estate) |
|---|---|---|
| `id` | Vertical identifier | `real-estate` |
| `appName` | Window title / DMG name | "CoAgent for Real Estate" |
| `bundleId` | macOS bundle identifier | `com.coagent.real-estate` |
| `defaultRole` | Pre-filled role in settings | "Real Estate Agent" |
| `defaultAutonomy` | Starting autonomy level | "balanced" |
| `suggestedIntegrations` | Highlighted during onboarding | Gmail, Google Calendar, DocuSign, Google Drive |
| `systemPromptFlavor` | Domain-specific agent behavior | Watch for leads, draft offer summaries, track closings |
| `activeHours` | Default active hours | { start: 8, end: 19 } |
| `activeDays` | Default active days | Mon-Sat |

`COAGENT_TEAM` independently controls:
- Team tab visibility in sidebar
- Team tools included (`send_team_message`, `read_team`, `team_notes`)
- Team section in system prompt

## Preset Definitions

### Personal (default)
- Integrations: Gmail, Google Calendar, Google Drive
- Behavior: General productivity — emails, scheduling, file management, follow-ups
- Autonomy: Ask first

### Real Estate
- Integrations: Gmail, Google Calendar, DocuSign, Google Drive
- Behavior: Watch for new leads, schedule showings, draft offer summaries, track closing timelines
- Autonomy: Balanced

### Sales
- Integrations: HubSpot, Salesforce, LinkedIn, Gmail, Google Calendar
- Behavior: Monitor deal stage changes, follow-up reminders, contact research, meeting prep
- Autonomy: Balanced

### E-commerce
- Integrations: Shopify, Gmail, Slack, Stripe, Google Sheets
- Behavior: Watch for orders, handle customer emails, flag refund requests, inventory alerts
- Autonomy: Autonomous

### Agency / Marketing
- Integrations: Slack, Notion, Google Drive, Monday, Gmail
- Behavior: Track project updates, draft briefs, manage approvals, summarize meeting notes
- Autonomy: Ask first

## Where Presets Apply

1. **Tauri config** — Build script patches `tauri.conf.json` with `appName` and `bundleId`
2. **Sidebar** — Team tab shown/hidden based on `COAGENT_TEAM`
3. **Settings defaults** — First-run populates role, autonomy, active hours from preset
4. **System prompt** — `buildSystemPrompt()` appends the vertical's `systemPromptFlavor`
5. **Onboarding** — Suggested integrations highlighted (not forced)
6. **Agent tools** — Team tools gated by `COAGENT_TEAM` (existing `TEAM_ONLY_TOOLS` mechanism)

## File Structure

```
packages/agent-core/src/presets.ts    — vertical definitions + types
packages/agent-core/src/edition.ts    — reads COAGENT_VERTICAL + COAGENT_TEAM, exports current config
apps/desktop/src/lib/edition.ts       — frontend mirror (reads from Vite define)
```

No new packages. Presets are plain data objects.

## App Naming & Distribution

| Vertical | Team | App Name | Bundle ID |
|---|---|---|---|
| personal | false | CoAgent | com.coagent.personal |
| personal | true | CoAgent — Team | com.coagent.personal-team |
| real-estate | false | CoAgent for Real Estate | com.coagent.real-estate |
| real-estate | true | CoAgent for Real Estate — Team | com.coagent.real-estate-team |
| sales | false | CoAgent for Sales | com.coagent.sales |
| sales | true | CoAgent for Sales — Team | com.coagent.sales-team |
| ecommerce | false | CoAgent for E-commerce | com.coagent.ecommerce |
| ecommerce | true | CoAgent for E-commerce — Team | com.coagent.ecommerce-team |
| agency | false | CoAgent for Agencies | com.coagent.agency |
| agency | true | CoAgent for Agencies — Team | com.coagent.agency-team |

Build script patches `tauri.conf.json` before `tauri build`.

## What This Does NOT Change

- **Runtime behavior** — After first-run, users can still change role, autonomy, integrations. Presets are defaults, not locks.
- **Relay/billing** — Same relay, same token system. Vertical doesn't affect pricing (yet).
- **Codebase** — One repo, one branch. No forks per vertical.
