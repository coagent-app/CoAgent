# Unified Calendar Design

## Goal

Replace `routines.md` and `todos.json` with a single `calendar.json` file and unified calendar view. One tool, one data file, one view for everything time-related.

## Data Model

Single file: `~/.coagent/calendar.json`

```typescript
interface CalendarEntry {
  id: string
  type: 'routine' | 'task' | 'event'
  label: string

  // Timing (depends on type)
  cron?: string       // routine: "0 9 * * 1-5"
  due?: string        // task: "2026-03-28T14:30:00"
  start?: string      // event: "2026-03-28T14:00:00"
  end?: string        // event: "2026-03-28T15:00:00"

  instruction?: string  // what the agent executes (routines, tasks)
  enabled: boolean      // toggle (mainly for routines)
  completed?: boolean   // for tasks
  createdAt: string
}
```

**Routine** — recurring, has `cron`, agent executes automatically on schedule.
**Task** — one-time, has `due`, agent executes or user completes.
**Event** — informational, has `start`/`end`, displays on calendar only. No agent action.

## Agent Tool

Single `calendar` tool replaces `todos`:

```
name: 'calendar'
actions: create, update, delete, complete, list
```

- `create` — type, label, cron/due/start/end, instruction (optional)
- `update` — id + any fields to change
- `delete` — id
- `complete` — id (marks task completed)
- `list` — returns all entries (optionally filtered by type)

Agent infers type from user intent:
- "Check Gmail every morning at 9" → routine with cron
- "Remind me to call Alex Thursday at 5pm" → task with due
- "I have a dentist appointment Friday at 3" → event with start/end

## Backend Changes

### Retired
- `routines.md` — no longer read by heartbeat
- `todos.json` — replaced by calendar.json
- `todos` tool — replaced by calendar tool
- `TodoList` class — replaced by `Calendar` class

### New: Calendar class (`calendar.ts`)
- CRUD operations on `calendar.json`
- `getRoutinesDueNow()` — checks cron expressions against current time
- `getTasksDue()` — tasks past their due time
- `getNextFireTime()` — earliest upcoming routine/task (for wake scheduling)
- `complete(id)` — marks task completed

### Scheduler changes
- Each routine gets its own cron timer via `node-cron`
- When a routine fires: `agent.handleTrigger({ source: 'routine', payload: { id, label, instruction } })`
- Tasks keep setTimeout behavior (same as current todos)
- Heartbeat simplified: no more "read routines.md" — just checks queue and any ad-hoc triage

### WebSocket
- New message type: `{ type: 'calendar_update', entries: CalendarEntry[] }`
- Sent on connection and after any calendar mutation
- Replaces `todo_update` message

### Migration
- On first startup: if `todos.json` exists and `calendar.json` doesn't, convert todos to calendar entries with `type: 'task'`
- `routines.md` left as-is for reference but no longer read programmatically

## Frontend Changes

### Tab restructure: 6 → 5 tabs
- Chat, **Calendar**, Queue, Files, Settings
- Remove: Todo tab, Done tab
- Done items already visible in Queue pane

### Calendar tab — 4 view toggles
- **Week** (default) — 7-column time grid with hour slots
- **Month** — grid of days, colored dots/bars for entries
- **Day** — single day time grid, detailed
- **Agenda** — chronological list (replaces todo list). Unscheduled tasks at top. Complete/delete inline.

### Color coding
- Routines → light blue
- Tasks → amber/orange
- Events → blue

### Interaction
- View only — all creation/editing through chat
- Agenda view: click to complete tasks (same as current todo UI)
- No drag-and-drop, no inline editing

## System Prompt Changes

- Remove references to `todos` tool
- Add `calendar` tool documentation
- Heartbeat triage: remove "read routines.md" instruction, replace with "check calendar for due items"

## What's NOT included (future)
- External calendar sync (Google Calendar, Outlook)
- Drag-and-drop editing
- Inline event creation
- Two-way sync with external calendars
