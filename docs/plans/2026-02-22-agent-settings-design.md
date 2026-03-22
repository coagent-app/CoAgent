# Agent Settings Design

## Goal

Let the agent configure its own behavior through conversation. Two settings to start: active hours (when heartbeats fire) and autonomy level (how independently it acts).

## Settings file

`~/.coagent/settings.json` — written by the agent, read by the scheduler and system prompt.

```json
{
  "active_hours": { "start": 7, "end": 23 },
  "active_days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
  "autonomy": "balanced"
}
```

Defaults: 7am–11pm every day, balanced autonomy. Settings file is created on first run if missing.

## Active hours

The scheduler checks the settings file before each hourly heartbeat. If the current time is outside `active_hours` or the current day isn't in `active_days`, it skips silently. No other change to the heartbeat.

Examples the user can say:
- "Don't run overnight" → sets `active_hours` end to 22
- "Weekdays only" → sets `active_days` to mon–fri
- "Start checking at 8" → sets `active_hours` start to 8

## Autonomy level

Three levels:

| Level | Behavior |
|-------|----------|
| `ask_first` | Queue almost everything — only truly mechanical lookups happen automatically |
| `balanced` | Act on clearly routine/read-only things, queue anything that sends, edits, or contacts someone (current default) |
| `autonomous` | Act on most things, only queue for permanent destructive actions |

The active autonomy level is injected into the system prompt so the agent knows how to behave on every turn.

## Agent tool: `update_settings`

Internal tool (not MCP) that lets the agent update its own settings:

```typescript
{
  name: 'update_settings',
  description: 'Update your own operational settings. Use when the user asks you to change your schedule or how autonomously you act.',
  input_schema: {
    active_hours?: { start: number, end: number },   // 0–23 hour range
    active_days?: string[],                           // mon tue wed thu fri sat sun
    autonomy?: 'ask_first' | 'balanced' | 'autonomous'
  }
}
```

After updating, the agent confirms in plain language what changed.

## Architecture

- `packages/agent-core/src/settings.ts` — read/write/defaults for settings.json
- `scheduler.ts` — reads settings before each heartbeat, skips if outside active window
- `agent.ts` — adds `update_settings` tool, reads settings to inject autonomy into system prompt
