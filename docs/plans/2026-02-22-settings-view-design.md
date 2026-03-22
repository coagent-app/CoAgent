# Settings View Design

## Goal

A Settings view in the desktop app where users can configure their profile, schedule, and agent behavior. Settings are also configurable through chat — both methods write to the same file.

## Data

`~/.coagent/settings.json` gains four new fields alongside the existing schedule/autonomy fields:

```json
{
  "name": "",
  "email": "",
  "timezone": "America/Chicago",
  "role": "",
  "active_hours": { "start": 7, "end": 24 },
  "active_days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
  "autonomy": "balanced"
}
```

`name`, `email`, `role` default to empty string. `timezone` defaults to the system timezone detected at first run, falling back to `"America/Chicago"`.

## UI Layout

Settings replaces the main content pane when "Settings" is clicked in the sidebar. Scrollable, three sections separated by dividers.

### Profile

| Field | Control |
|-------|---------|
| Name | Text input |
| Email | Text input |
| What you do | Text input (placeholder: "e.g. real estate agent, sales manager") |
| Timezone | Select dropdown — common US timezones + "Detect automatically" option |

### Schedule

Active hours: two dropdowns side by side — "From" and "Until". Options: every hour from 12am to midnight (12am, 1am, … 11pm, midnight).

Active days: seven pill toggles in a row — Mon Tue Wed Thu Fri Sat Sun. Selected = dark fill, unselected = outline.

### Behavior

Autonomy level: three radio-style cards stacked vertically.

- **Ask first** — Queue almost everything for approval before acting
- **Balanced** — Act on routine tasks automatically, queue anything that sends or edits
- **Autonomous** — Handle most things, only queue permanent or destructive actions

## Sync

- On mount, UI sends `get_settings` WS message → server reads `settings.json` → sends `settings_update` back
- Any field change sends `update_settings` WS message → server writes `settings.json`
- Agent's `update_settings` tool writes to same file → both methods always in sync
- Auto-save on change/blur — no save button

## WebSocket messages

Add to `WSClientMessage`:
```typescript
| { type: 'get_settings' }
| { type: 'update_settings'; patch: Partial<AgentSettings> }
```

Add to `WSServerMessage`:
```typescript
| { type: 'settings_update'; settings: AgentSettings }
```

## `AgentSettings` type additions

```typescript
export interface AgentSettings {
  name: string
  email: string
  timezone: string
  role: string
  active_hours: { start: number; end: number }
  active_days: DayName[]
  autonomy: Autonomy
}
```

## System prompt

The agent's system prompt already injects `settingsSection`. Extend it to include name, email, timezone, and role so the agent knows who it's talking to without reading memory on every turn:

```
Current settings:
- Name: Brett
- Email: brett@example.com
- Role: real estate agent
- Timezone: America/Chicago
- Active hours: 7am–midnight
- Active days: mon, tue, wed, thu, fri, sat, sun
- Autonomy: balanced — Act on clearly routine tasks…
```

## Files to touch

- `packages/agent-core/src/settings.ts` — add new fields + defaults
- `packages/agent-core/src/server.ts` — handle `get_settings` / `update_settings` WS messages
- `packages/shared/src/index.ts` — add WS message types + export `AgentSettings`
- `apps/desktop/src/hooks/useAgent.ts` — add `settings` state + `updateSettings` callback
- `apps/desktop/src/components/SettingsPane.tsx` — new component (create)
- `apps/desktop/src/App.tsx` — render `SettingsPane` when `view === 'settings'`
- `apps/desktop/src/components/Sidebar.tsx` — wire Settings nav item to `'settings'` view
