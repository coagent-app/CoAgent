# User-Defined Schedules Design

## Goal

Let users create recurring scheduled tasks through natural conversation. The agent converts "every Monday at 9am, send me a weekly briefing" into a cron job that fires automatically.

## Data Model

File: `~/.coagent/schedules.json`

```typescript
interface Schedule {
  id: string              // uuid
  cron: string            // e.g. "0 9 * * 1"
  instruction: string     // full prompt for the agent when job fires
  label: string           // human-readable, e.g. "Weekly briefing"
  enabled: boolean        // toggle without deleting
  createdAt: string       // ISO timestamp
}
```

## Agent Tools

Three internal tools (added to `INTERNAL_TOOLS` in `agent.ts`):

- **create_schedule** — `{ cron, instruction, label }` → creates and registers schedule
- **update_schedule** — `{ id, enabled?, cron?, instruction?, label? }` → modify/toggle
- **delete_schedule** — `{ id }` → removes schedule

No system prompt injection. Agent uses tools to check existing schedules when needed.

## Scheduler Integration

In `scheduler.ts`:

- On startup, load `schedules.json` and register each enabled schedule via `cron.schedule()`
- Maintain `Map<string, cron.ScheduledTask>` for per-job stop/start
- Export `reloadSchedules(dataDir, agent)` — called after any tool mutates schedules
- Each job checks `isActiveNow(settings)` before firing (respects active hours)
- Fires via `agent.handleTrigger({ source: 'schedule', payload: { scheduleId, instruction, label } })`

## Trigger Flow

1. Cron fires → `isActiveNow()` check → `agent.handleTrigger()`
2. `buildTriggerMessage()` formats: "Scheduled task: [label]. Instruction: [instruction]"
3. Agent runs normal loop (can use any tools — email, calendar, documents, etc.)
4. Response broadcasts to UI via existing `chat_chunk` / `chat_response` websocket messages

## Frontend

New sidebar view: `'schedules'`

**SchedulesPane component:**
- List of all schedules with label, human-readable timing, enabled toggle, delete button
- No creation form — schedules are created through chat
- Badge on sidebar icon showing active schedule count

**WebSocket messages:**

Server → Client:
- `{ type: 'schedules_update'; schedules: Schedule[] }`

Client → Server:
- `{ type: 'get_schedules' }`
- `{ type: 'toggle_schedule'; id: string; enabled: boolean }`
- `{ type: 'delete_schedule'; id: string }`

## Persistence Pattern

Follow `queue.ts` pattern: in-memory array backed by JSON file, synced on every mutation.

## Constraints

- Schedules respect user's active hours and active days
- Output appears in chat view like any other agent response
- Agent handles natural language → cron expression conversion
- No limit on number of schedules (practical limit is API cost)
