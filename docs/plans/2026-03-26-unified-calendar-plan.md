# Unified Calendar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `routines.md` and `todos.json` with a single `calendar.json` file, a unified `calendar` agent tool, and a calendar UI with week/month/day/agenda views.

**Architecture:** Single `CalendarStore` class manages all entries (routines, tasks, events) in `calendar.json`. Routines fire via individual `node-cron` timers. Tasks fire via `setTimeout` (same as current todos). The frontend gets a new `CalendarPane` component with 4 view toggles, replacing the Todo and Done tabs.

**Tech Stack:** TypeScript, node-cron, React, Tailwind CSS, lucide-react, date-fns (new dependency for calendar date math)

---

### Task 1: Shared types — CalendarEntry and WebSocket messages

**Files:**
- Modify: `packages/shared/src/index.ts`

**What:** Add `CalendarEntry` type, `calendar_update` WS message, and new WS client messages. Remove `TodoItem` references from WS messages.

**Step 1: Add CalendarEntry type**

In `packages/shared/src/index.ts`, replace the `TodoItem` interface (lines 57-64) with:

```typescript
export type CalendarEntryType = 'routine' | 'task' | 'event'

export interface CalendarEntry {
  id: string
  type: CalendarEntryType
  label: string
  cron?: string         // routine: "0 9 * * 1-5"
  due?: string          // task: ISO datetime "2026-03-28T14:30:00"
  start?: string        // event: ISO datetime
  end?: string          // event: ISO datetime
  instruction?: string  // what the agent executes (routines, tasks)
  enabled: boolean
  completed?: boolean   // for tasks
  createdAt: string
}

// Keep TodoItem as alias during migration
export interface TodoItem {
  id: string
  task: string
  due?: string
  priority: 'high' | 'normal' | 'low'
  context?: string
  createdAt: string
}
```

**Step 2: Update TriggerSource**

Change line 35:
```typescript
export type TriggerSource = 'heartbeat' | 'webhook' | 'manual' | 'memory_cleanup' | 'todo_due' | 'routine' | 'task_due'
```

**Step 3: Update WSClientMessage**

Replace todo-related messages (lines 97-99):
```typescript
  | { type: 'get_calendar' }
  | { type: 'complete_calendar_entry'; id: string }
  | { type: 'delete_calendar_entry'; id: string }
```

Keep the old todo messages for now (they'll be removed in Task 6 after the frontend is updated). Add the new ones alongside.

**Step 4: Update WSServerMessage**

Add after the `todo_update` line (line 136):
```typescript
  | { type: 'calendar_update'; entries: CalendarEntry[] }
```

Keep `todo_update` for now (removed later).

**Step 5: Verify**

Run: `pnpm --filter @coagent/shared build`
Expected: Clean build

**Step 6: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat: add CalendarEntry type and calendar WS messages"
```

---

### Task 2: CalendarStore class — replaces TodoList

**Files:**
- Create: `packages/agent-core/src/calendar-store.ts`

**What:** A class that manages `calendar.json` with CRUD operations, due/fire queries, and migration from `todos.json`.

**Step 1: Create `calendar-store.ts`**

```typescript
import { v4 as uuidv4 } from 'uuid'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { CalendarEntry, TodoItem } from '@coagent/shared'

type NewCalendarEntry = Omit<CalendarEntry, 'id' | 'createdAt'>

export class CalendarStore {
  private entries: CalendarEntry[] = []
  private filePath: string
  private dataDir: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.filePath = join(dataDir, 'calendar.json')
    mkdirSync(dataDir, { recursive: true })
    this.entries = this.load()
    this.migrate()
  }

  private load(): CalendarEntry[] {
    try {
      if (existsSync(this.filePath)) return JSON.parse(readFileSync(this.filePath, 'utf-8'))
    } catch { /* corrupt file — start fresh */ }
    return []
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2))
  }

  /** One-time migration: convert todos.json → calendar entries */
  private migrate(): void {
    const todosPath = join(this.dataDir, 'todos.json')
    if (!existsSync(todosPath)) return
    // Only migrate if calendar.json was empty (first run)
    if (this.entries.length > 0) return

    try {
      const todos: TodoItem[] = JSON.parse(readFileSync(todosPath, 'utf-8'))
      for (const todo of todos) {
        this.entries.push({
          id: todo.id,
          type: 'task',
          label: todo.task,
          due: todo.due,
          instruction: todo.context,
          enabled: true,
          completed: false,
          createdAt: todo.createdAt,
        })
      }
      if (this.entries.length > 0) {
        this.save()
        console.log(`[Calendar] Migrated ${this.entries.length} todos to calendar.json`)
      }
    } catch (err: any) {
      console.error('[Calendar] Migration failed:', err.message)
    }
  }

  create(entry: NewCalendarEntry): CalendarEntry {
    const item: CalendarEntry = {
      ...entry,
      id: uuidv4(),
      createdAt: new Date().toISOString(),
    }
    this.entries.push(item)
    this.save()
    return item
  }

  update(id: string, patch: Partial<Omit<CalendarEntry, 'id' | 'createdAt'>>): CalendarEntry | undefined {
    const entry = this.entries.find(e => e.id === id)
    if (!entry) return undefined
    Object.assign(entry, patch)
    this.save()
    return entry
  }

  delete(id: string): boolean {
    const before = this.entries.length
    this.entries = this.entries.filter(e => e.id !== id)
    if (this.entries.length < before) { this.save(); return true }
    return false
  }

  complete(id: string): CalendarEntry | undefined {
    const entry = this.entries.find(e => e.id === id)
    if (!entry || entry.type !== 'task') return undefined
    entry.completed = true
    this.save()
    return entry
  }

  getAll(): CalendarEntry[] {
    return [...this.entries].sort((a, b) => {
      // Sort: routines first, then tasks by due, then events by start
      const typeOrder = { routine: 0, task: 1, event: 2 }
      if (typeOrder[a.type] !== typeOrder[b.type]) return typeOrder[a.type] - typeOrder[b.type]
      const aTime = a.due || a.start || a.cron || ''
      const bTime = b.due || b.start || b.cron || ''
      return aTime.localeCompare(bTime)
    })
  }

  getByType(type: CalendarEntry['type']): CalendarEntry[] {
    return this.getAll().filter(e => e.type === type)
  }

  /** Tasks that are past their due time or have no due time (and not completed) */
  getTasksDue(): CalendarEntry[] {
    const now = new Date()
    return this.entries
      .filter(e => e.type === 'task' && !e.completed && e.enabled)
      .filter(e => {
        if (!e.due) return true
        const due = e.due.includes('T') ? new Date(e.due) : new Date(e.due + 'T23:59:59')
        return due <= now
      })
  }

  /** Get all enabled routines */
  getRoutines(): CalendarEntry[] {
    return this.entries.filter(e => e.type === 'routine' && e.enabled)
  }

  /** Next fire time for tasks (for wake scheduling) */
  getNextTaskTime(): Date | null {
    const now = new Date()
    let nearest: Date | null = null
    for (const entry of this.entries) {
      if (entry.type !== 'task' || entry.completed || !entry.due) continue
      const due = entry.due.includes('T') ? new Date(entry.due) : new Date(entry.due + 'T00:00:00')
      if (due > now && (nearest === null || due < nearest)) nearest = due
    }
    return nearest
  }
}
```

**Step 2: Verify**

Run: `pnpm --filter @coagent/agent-core build`
Expected: Clean build

**Step 3: Commit**

```bash
git add packages/agent-core/src/calendar-store.ts
git commit -m "feat: add CalendarStore class with migration from todos.json"
```

---

### Task 3: Wire CalendarStore into Agent — replace TodoList

**Files:**
- Modify: `packages/agent-core/src/agent.ts`

**What:** Replace `this.todos` (TodoList) with `this.calendar` (CalendarStore). Replace the `todos` tool with the `calendar` tool. Update system prompt. Update heartbeat triage message.

**Step 1: Update imports**

Replace:
```typescript
import { TodoList } from './todo.js'
```
With:
```typescript
import { CalendarStore } from './calendar-store.js'
```

**Step 2: Replace TodoList with CalendarStore**

In the Agent class, find where `this.todos` is initialized (likely `this.todos = new TodoList(dataDir)`). Replace with:
```typescript
this.calendar = new CalendarStore(dataDir)
```

Update the type: `todos: TodoList` → `calendar: CalendarStore`

Also update `onTodosChanged` callback to `onCalendarChanged`.

**Step 3: Replace the `todos` tool definition**

Find the tool definition for `todos` in the tools array. Replace with:

```typescript
{
  name: 'calendar',
  description: 'Unified calendar for routines, tasks, and events. Actions: create (type+label+timing+instruction), update (id+fields), delete (id), complete (id — tasks only), list (optional type filter).',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'delete', 'complete', 'list'] },
      type: { type: 'string', enum: ['routine', 'task', 'event'], description: 'Entry type (for create)' },
      id: { type: 'string', description: 'Entry ID (for update/delete/complete)' },
      label: { type: 'string', description: 'Display name' },
      cron: { type: 'string', description: 'Cron expression for routines, e.g. "0 9 * * 1-5"' },
      due: { type: 'string', description: 'ISO datetime for tasks, e.g. "2026-03-28T14:30:00"' },
      start: { type: 'string', description: 'ISO datetime for event start' },
      end: { type: 'string', description: 'ISO datetime for event end' },
      instruction: { type: 'string', description: 'What to execute when routine/task fires' },
      enabled: { type: 'boolean', description: 'Enable/disable (default true)' },
      filter_type: { type: 'string', enum: ['routine', 'task', 'event'], description: 'Filter for list action' },
    },
    required: ['action']
  }
},
```

**Step 4: Replace the `todos` tool handler**

Find the block handling `block.name === 'todos'`. Replace with calendar handler:

```typescript
} else if (block.name === 'calendar') {
  const input = block.input as Record<string, any>
  const action = input.action as string

  if (action === 'create') {
    const entry = this.calendar.create({
      type: input.type || 'task',
      label: input.label || 'Untitled',
      cron: input.cron,
      due: input.due,
      start: input.start,
      end: input.end,
      instruction: input.instruction,
      enabled: input.enabled ?? true,
    })
    result = `Created ${entry.type}: "${entry.label}" (${entry.id})`
    this.onCalendarChanged?.()
  } else if (action === 'update') {
    const { id, action: _, ...patch } = input
    const entry = this.calendar.update(id, patch)
    result = entry ? `Updated: "${entry.label}"` : `Entry ${id} not found.`
    this.onCalendarChanged?.()
  } else if (action === 'delete') {
    const ok = this.calendar.delete(input.id)
    result = ok ? 'Deleted.' : `Entry ${input.id} not found.`
    this.onCalendarChanged?.()
  } else if (action === 'complete') {
    const entry = this.calendar.complete(input.id)
    result = entry ? `Completed: "${entry.label}"` : `Task ${input.id} not found.`
    this.onCalendarChanged?.()
  } else if (action === 'list') {
    const entries = input.filter_type
      ? this.calendar.getByType(input.filter_type)
      : this.calendar.getAll()
    if (entries.length === 0) {
      result = 'No calendar entries.'
    } else {
      result = entries.map(e => {
        const timing = e.cron || e.due || (e.start && e.end ? `${e.start} → ${e.end}` : e.start) || 'no time'
        const status = e.completed ? ' ✓' : e.enabled ? '' : ' (disabled)'
        return `[${e.type}] ${e.label} — ${timing}${status} (${e.id})`
      }).join('\n')
    }
  } else {
    result = `Unknown calendar action: ${action}`
  }
```

**Step 5: Update system prompt**

In `buildSystemPrompt()`, replace any references to the `todos` tool with `calendar`:

```
On heartbeat: use calendar (action: list) to check routines and tasks, check queue. If nothing needs attention, reply "All clear." immediately.
```

And in the memory/tools section:
```
- **calendar** (create/update/delete/complete/list) — unified calendar for routines (recurring cron), tasks (one-time due), and events (informational). Routines auto-execute on schedule. Tasks fire at due time. Events are display-only.
```

Remove the `todos` tool line.

**Step 6: Update heartbeat triage message**

In `buildTriggerMessage()`, replace "Check due tasks" with:
```
2. Use calendar (action: list) — check for due tasks and active routines.
```

And for task_due triggers, update the source check from `'todo_due'` to `'task_due'`.

**Step 7: Update all remaining `this.todos` references**

Search for `this.todos` throughout agent.ts and replace:
- `this.todos.getAll()` → `this.calendar.getAll()`
- `this.todos.getDue()` → `this.calendar.getTasksDue()`
- `this.todos.complete()` → `this.calendar.complete()`
- `this.todos.add()` → `this.calendar.create()`
- `this.todos.getNextDueTime()` → `this.calendar.getNextTaskTime()`
- `this.onTodosChanged` → `this.onCalendarChanged`

**Step 8: Verify**

Run: `pnpm --filter @coagent/agent-core build`
Expected: Clean build

**Step 9: Commit**

```bash
git add packages/agent-core/src/agent.ts
git commit -m "feat: replace todos tool with unified calendar tool in agent"
```

---

### Task 4: Update Scheduler — cron timers for routines

**Files:**
- Modify: `packages/agent-core/src/scheduler.ts`

**What:** Replace the todo timer system with calendar-aware scheduling. Each routine gets a cron timer. Tasks keep setTimeout behavior.

**Step 1: Update imports**

Replace:
```typescript
import { TodoList } from './todo.js'
```
With:
```typescript
import { CalendarStore } from './calendar-store.js'
```

**Step 2: Replace todo timer with task timer**

Rename `todoTimer` → `taskTimer`, `fireDueTodos` → `fireDueTasks`, `scheduleTodoTimer` → `scheduleTaskTimer`.

Update `fireDueTasks` to use `agent.calendar.getTasksDue()` instead of `new TodoList(dataDir).getDue()`.

**Step 3: Add routine cron timers**

After the task timer section, add routine scheduling:

```typescript
// ── Routine cron timers ─────────────────────────────────────────────────
const routineJobs = new Map<string, cron.ScheduledTask>()

function syncRoutineTimers(): void {
  const routines = agent.calendar.getRoutines()
  const activeIds = new Set(routines.map(r => r.id))

  // Remove timers for deleted/disabled routines
  for (const [id, job] of routineJobs) {
    if (!activeIds.has(id)) {
      job.stop()
      routineJobs.delete(id)
    }
  }

  // Add timers for new routines
  for (const routine of routines) {
    if (routineJobs.has(routine.id)) continue
    if (!cron.validate(routine.cron!)) {
      console.warn(`[Scheduler] Invalid cron for "${routine.label}": ${routine.cron}`)
      continue
    }
    const job = cron.schedule(routine.cron!, async () => {
      if (!isActiveNow(await readSettings(dataDir))) {
        console.log(`[Scheduler] Outside active hours — skipping routine "${routine.label}"`)
        return
      }
      console.log(`[Scheduler] Routine firing: "${routine.label}"`)
      try {
        await keepAwakeDuring(
          agent.handleTrigger({
            source: 'routine' as any,
            payload: { id: routine.id, label: routine.label, instruction: routine.instruction }
          })
        )
      } catch (err: any) {
        console.error(`[Scheduler] Routine error (${routine.id}):`, err.message)
      }
    })
    routineJobs.set(routine.id, job)
    console.log(`[Scheduler] Registered routine: "${routine.label}" (${routine.cron})`)
  }
}
```

**Step 4: Hook up calendar changes**

Replace the `onTodosChanged` hook with:

```typescript
const origOnCalendarChanged = agent.onCalendarChanged
agent.onCalendarChanged = () => {
  origOnCalendarChanged?.()
  scheduleTaskTimer()
  syncRoutineTimers()
}
```

**Step 5: Update startup**

Replace:
```typescript
;(async () => {
  await fireDueTodos()
  scheduleHeartbeatTimer()
})()
```
With:
```typescript
;(async () => {
  syncRoutineTimers()
  await fireDueTasks()
  scheduleHeartbeatTimer()
})()
```

**Step 6: Verify**

Run: `pnpm --filter @coagent/agent-core build`
Expected: Clean build

**Step 7: Commit**

```bash
git add packages/agent-core/src/scheduler.ts
git commit -m "feat: add routine cron timers and migrate scheduler to CalendarStore"
```

---

### Task 5: Update server.ts — WebSocket messages and calendar broadcast

**Files:**
- Modify: `packages/agent-core/src/server.ts`

**What:** Replace `todo_update` with `calendar_update` broadcasts. Handle new WS client messages. Update setup.md template.

**Step 1: Replace TodoList with CalendarStore in server**

Find where `agent.todos` is used to build the initial state sent on WebSocket connection. Replace:
```typescript
send(ws, { type: 'todo_update', items: agent.todos.getAll() })
```
With:
```typescript
send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
```

**Step 2: Replace todo WS handlers**

Find the `complete_todo` and `delete_todo` message handlers. Replace with:

```typescript
case 'complete_calendar_entry': {
  agent.calendar.complete(msg.id)
  broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() })
  break
}
case 'delete_calendar_entry': {
  agent.calendar.delete(msg.id)
  agent.onCalendarChanged?.()
  broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() })
  break
}
case 'get_calendar': {
  send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
  break
}
```

**Step 3: Update calendar broadcast in agent callbacks**

Wherever the agent broadcasts `todo_update` after mutations, replace with:
```typescript
broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() })
```

**Step 4: Update SETUP_MD_STATIC**

In the tools section, replace:
```
- **todos** (add/complete/list) — to-do items with optional due times.
```
With:
```
- **calendar** (create/update/delete/complete/list) — unified calendar for routines (recurring), tasks (one-time), and events (informational).
```

**Step 5: Verify**

Run: `pnpm --filter @coagent/agent-core build`
Expected: Clean build

**Step 6: Commit**

```bash
git add packages/agent-core/src/server.ts
git commit -m "feat: wire calendar broadcasts and WS handlers in server"
```

---

### Task 6: Frontend — CalendarPane component with 4 views

**Files:**
- Create: `apps/desktop/src/components/CalendarPane.tsx`
- Modify: `apps/desktop/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/hooks/useAgent.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/package.json` (add date-fns)

**Step 1: Install date-fns**

Run: `cd apps/desktop && pnpm add date-fns`

**Step 2: Update useAgent hook**

In `apps/desktop/src/hooks/useAgent.ts`:

Add `CalendarEntry` import:
```typescript
import type { CalendarEntry, ... } from '@coagent/shared'
```

Add state:
```typescript
const [calendarEntries, setCalendarEntries] = useState<CalendarEntry[]>([])
```

Add handler for `calendar_update` message:
```typescript
case 'calendar_update':
  setCalendarEntries(msg.entries)
  break
```

Add actions:
```typescript
const completeCalendarEntry = useCallback((id: string) => {
  sendMessage({ type: 'complete_calendar_entry', id })
}, [sendMessage])

const deleteCalendarEntry = useCallback((id: string) => {
  sendMessage({ type: 'delete_calendar_entry', id })
}, [sendMessage])
```

Return `calendarEntries`, `completeCalendarEntry`, `deleteCalendarEntry` from hook.

**Step 3: Create CalendarPane.tsx**

Create `apps/desktop/src/components/CalendarPane.tsx`. This is the main calendar component with 4 view toggles.

```typescript
import React, { useState, useMemo } from 'react'
import { ChevronLeft, ChevronRight, Circle, Trash2, Clock, Repeat, CalendarIcon } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import {
  startOfWeek, endOfWeek, startOfMonth, endOfMonth,
  eachDayOfInterval, format, addWeeks, subWeeks,
  addMonths, subMonths, addDays, subDays,
  isSameDay, isSameMonth, isToday, parseISO,
  startOfDay, endOfDay, setHours, getHours,
} from 'date-fns'
import type { CalendarEntry } from '@coagent/shared'

type CalendarView = 'week' | 'month' | 'day' | 'agenda'

interface CalendarPaneProps {
  entries: CalendarEntry[]
  onComplete: (id: string) => void
  onDelete: (id: string) => void
}

// Color classes by entry type
const TYPE_COLORS = {
  routine: { bg: 'bg-sky-100 dark:bg-sky-900/30', text: 'text-sky-700 dark:text-sky-300', dot: 'bg-sky-400' },
  task:    { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-400' },
  event:   { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-300', dot: 'bg-blue-500' },
}

export function CalendarPane({ entries, onComplete, onDelete }: CalendarPaneProps) {
  const [view, setView] = useState<CalendarView>('week')
  const [anchor, setAnchor] = useState(new Date())

  // Navigation
  const navigate = (dir: -1 | 1) => {
    if (view === 'week') setAnchor(d => dir === 1 ? addWeeks(d, 1) : subWeeks(d, 1))
    else if (view === 'month') setAnchor(d => dir === 1 ? addMonths(d, 1) : subMonths(d, 1))
    else if (view === 'day') setAnchor(d => dir === 1 ? addDays(d, 1) : subDays(d, 1))
  }
  const goToday = () => setAnchor(new Date())

  // Header label
  const headerLabel = useMemo(() => {
    if (view === 'day') return format(anchor, 'EEEE, MMMM d, yyyy')
    if (view === 'week') {
      const start = startOfWeek(anchor, { weekStartsOn: 0 })
      const end = endOfWeek(anchor, { weekStartsOn: 0 })
      return `${format(start, 'MMM d')} – ${format(end, 'MMM d, yyyy')}`
    }
    if (view === 'month') return format(anchor, 'MMMM yyyy')
    return 'Agenda'
  }, [view, anchor])

  return (
    <div className="flex-1 flex flex-col bg-white dark:bg-neutral-950 overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-5 pb-3 flex items-center justify-between border-b border-neutral-100 dark:border-neutral-800">
        <div className="flex items-center gap-3">
          {view !== 'agenda' && (
            <>
              <button onClick={() => navigate(-1)} className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded">
                <ChevronLeft size={16} />
              </button>
              <button onClick={() => navigate(1)} className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded">
                <ChevronRight size={16} />
              </button>
              <button onClick={goToday} className="text-[12px] px-2 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700">
                Today
              </button>
            </>
          )}
          <h2 className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">{headerLabel}</h2>
        </div>
        <div className="flex gap-0.5 bg-neutral-100 dark:bg-neutral-800 rounded-lg p-0.5">
          {(['day', 'week', 'month', 'agenda'] as const).map(v => (
            <button key={v} onClick={() => setView(v)}
              className={cn(
                'text-[11px] px-2.5 py-1 rounded-md capitalize transition-colors',
                view === v ? 'bg-white dark:bg-neutral-700 shadow-sm font-medium' : 'hover:bg-neutral-200 dark:hover:bg-neutral-700'
              )}>
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* View content */}
      <div className="flex-1 overflow-hidden">
        {view === 'agenda' && <AgendaView entries={entries} onComplete={onComplete} onDelete={onDelete} />}
        {view === 'week' && <WeekView entries={entries} anchor={anchor} />}
        {view === 'month' && <MonthView entries={entries} anchor={anchor} />}
        {view === 'day' && <DayView entries={entries} anchor={anchor} />}
      </div>
    </div>
  )
}

/* ── Agenda View (replaces Todo list) ────────────────────────────────── */

function AgendaView({ entries, onComplete, onDelete }: { entries: CalendarEntry[]; onComplete: (id: string) => void; onDelete: (id: string) => void }) {
  const uncompleted = entries.filter(e => !e.completed)
  const tasks = uncompleted.filter(e => e.type === 'task')
  const routines = uncompleted.filter(e => e.type === 'routine')
  const events = uncompleted.filter(e => e.type === 'event')

  return (
    <ScrollArea className="h-full">
      <div className="px-6 py-4">
        {uncompleted.length === 0 ? (
          <p className="text-[14px] text-neutral-400 dark:text-neutral-500 mt-4">No calendar entries yet. Ask Co-Agent to add one.</p>
        ) : (
          <>
            {tasks.length > 0 && <AgendaSection title="Tasks" entries={tasks} onComplete={onComplete} onDelete={onDelete} />}
            {routines.length > 0 && <AgendaSection title="Routines" entries={routines} onComplete={onComplete} onDelete={onDelete} />}
            {events.length > 0 && <AgendaSection title="Events" entries={events} onComplete={onComplete} onDelete={onDelete} />}
          </>
        )}
      </div>
    </ScrollArea>
  )
}

function AgendaSection({ title, entries, onComplete, onDelete }: { title: string; entries: CalendarEntry[]; onComplete: (id: string) => void; onDelete: (id: string) => void }) {
  const colors = TYPE_COLORS[entries[0]?.type || 'task']
  return (
    <div className="mb-6">
      <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-2">{title}</p>
      <div className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-800">
        {entries.map(entry => (
          <div key={entry.id} className="flex items-start gap-3 py-3 group">
            {entry.type === 'task' && (
              <button onClick={() => onComplete(entry.id)} className="mt-0.5 flex-shrink-0 text-neutral-300 dark:text-neutral-600 hover:text-emerald-500 transition-colors">
                <Circle size={15} strokeWidth={1.75} />
              </button>
            )}
            {entry.type === 'routine' && <Repeat size={14} className={cn('mt-0.5 flex-shrink-0', colors.text)} />}
            {entry.type === 'event' && <CalendarIcon size={14} className={cn('mt-0.5 flex-shrink-0', colors.text)} />}
            <div className="flex-1 min-w-0">
              <p className="text-[14px] text-neutral-800 dark:text-neutral-200 leading-relaxed">{entry.label}</p>
              <p className={cn('text-[12px] mt-0.5', colors.text)}>
                {entry.cron || (entry.due && formatTime(entry.due)) || (entry.start && `${formatTime(entry.start)}${entry.end ? ` – ${formatTime(entry.end)}` : ''}`)}
              </p>
            </div>
            <button onClick={() => onDelete(entry.id)} className="opacity-0 group-hover:opacity-100 transition-opacity text-neutral-300 dark:text-neutral-600 hover:text-red-500 flex-shrink-0 mt-0.5">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function formatTime(iso: string): string {
  try {
    const d = parseISO(iso)
    return format(d, iso.includes('T') ? 'MMM d, h:mm a' : 'MMM d')
  } catch { return iso }
}

/* ── Week View ───────────────────────────────────────────────────────── */

function WeekView({ entries, anchor }: { entries: CalendarEntry[]; anchor: Date }) {
  const weekStart = startOfWeek(anchor, { weekStartsOn: 0 })
  const days = eachDayOfInterval({ start: weekStart, end: endOfWeek(anchor, { weekStartsOn: 0 }) })
  const hours = Array.from({ length: 16 }, (_, i) => i + 6) // 6am-9pm

  return (
    <ScrollArea className="h-full">
      <div className="grid grid-cols-[50px_repeat(7,1fr)] min-w-0">
        {/* Header row */}
        <div className="sticky top-0 z-10 bg-white dark:bg-neutral-950" />
        {days.map(day => (
          <div key={day.toISOString()} className={cn(
            'sticky top-0 z-10 bg-white dark:bg-neutral-950 text-center py-2 border-b border-l border-neutral-100 dark:border-neutral-800',
            isToday(day) && 'bg-blue-50 dark:bg-blue-950/20'
          )}>
            <p className="text-[10px] text-neutral-400 uppercase">{format(day, 'EEE')}</p>
            <p className={cn('text-[14px] font-medium', isToday(day) ? 'text-blue-600' : 'text-neutral-700 dark:text-neutral-300')}>{format(day, 'd')}</p>
          </div>
        ))}

        {/* Hour rows */}
        {hours.map(hour => (
          <React.Fragment key={hour}>
            <div className="text-[10px] text-neutral-400 text-right pr-2 pt-1 h-[48px]">
              {format(setHours(new Date(), hour), 'h a')}
            </div>
            {days.map(day => {
              const dayEntries = getEntriesForHour(entries, day, hour)
              return (
                <div key={`${day.toISOString()}-${hour}`}
                  className={cn(
                    'h-[48px] border-l border-b border-neutral-50 dark:border-neutral-800/50 relative',
                    isToday(day) && 'bg-blue-50/30 dark:bg-blue-950/10'
                  )}>
                  {dayEntries.map(entry => (
                    <div key={entry.id} className={cn('absolute inset-x-0.5 top-0.5 rounded px-1 py-0.5 text-[10px] truncate', TYPE_COLORS[entry.type].bg, TYPE_COLORS[entry.type].text)}>
                      {entry.label}
                    </div>
                  ))}
                </div>
              )
            })}
          </React.Fragment>
        ))}
      </div>
    </ScrollArea>
  )
}

/* ── Month View ──────────────────────────────────────────────────────── */

function MonthView({ entries, anchor }: { entries: CalendarEntry[]; anchor: Date }) {
  const monthStart = startOfMonth(anchor)
  const monthEnd = endOfMonth(anchor)
  const calStart = startOfWeek(monthStart, { weekStartsOn: 0 })
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: 0 })
  const days = eachDayOfInterval({ start: calStart, end: calEnd })

  return (
    <div className="flex-1 flex flex-col h-full">
      {/* Day headers */}
      <div className="grid grid-cols-7 border-b border-neutral-100 dark:border-neutral-800">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
          <div key={d} className="text-[10px] text-neutral-400 uppercase text-center py-1.5">{d}</div>
        ))}
      </div>
      {/* Day grid */}
      <ScrollArea className="flex-1">
        <div className="grid grid-cols-7 auto-rows-[80px]">
          {days.map(day => {
            const dayEntries = getEntriesForDay(entries, day)
            return (
              <div key={day.toISOString()} className={cn(
                'border-b border-r border-neutral-50 dark:border-neutral-800/50 p-1 overflow-hidden',
                !isSameMonth(day, anchor) && 'opacity-40',
                isToday(day) && 'bg-blue-50/50 dark:bg-blue-950/20'
              )}>
                <p className={cn('text-[11px] font-medium mb-0.5', isToday(day) ? 'text-blue-600' : 'text-neutral-500')}>{format(day, 'd')}</p>
                {dayEntries.slice(0, 3).map(entry => (
                  <div key={entry.id} className={cn('text-[9px] truncate rounded px-1 mb-0.5', TYPE_COLORS[entry.type].bg, TYPE_COLORS[entry.type].text)}>
                    {entry.label}
                  </div>
                ))}
                {dayEntries.length > 3 && (
                  <p className="text-[9px] text-neutral-400">+{dayEntries.length - 3} more</p>
                )}
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}

/* ── Day View ────────────────────────────────────────────────────────── */

function DayView({ entries, anchor }: { entries: CalendarEntry[]; anchor: Date }) {
  const hours = Array.from({ length: 16 }, (_, i) => i + 6)

  return (
    <ScrollArea className="h-full">
      <div className="px-4">
        {hours.map(hour => {
          const hourEntries = getEntriesForHour(entries, anchor, hour)
          return (
            <div key={hour} className="flex border-b border-neutral-50 dark:border-neutral-800/50 min-h-[48px]">
              <div className="w-[50px] text-[11px] text-neutral-400 text-right pr-3 pt-1 flex-shrink-0">
                {format(setHours(new Date(), hour), 'h a')}
              </div>
              <div className="flex-1 py-0.5">
                {hourEntries.map(entry => (
                  <div key={entry.id} className={cn('rounded px-2 py-1 mb-0.5 text-[12px]', TYPE_COLORS[entry.type].bg, TYPE_COLORS[entry.type].text)}>
                    {entry.label}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

/** Get entries that should display on a given day */
function getEntriesForDay(entries: CalendarEntry[], day: Date): CalendarEntry[] {
  return entries.filter(e => {
    if (e.completed) return false
    if (e.due) return isSameDay(parseISO(e.due), day)
    if (e.start) return isSameDay(parseISO(e.start), day)
    if (e.cron) return cronMatchesDay(e.cron, day)
    return false
  })
}

/** Get entries for a specific hour on a specific day */
function getEntriesForHour(entries: CalendarEntry[], day: Date, hour: number): CalendarEntry[] {
  return entries.filter(e => {
    if (e.completed) return false
    if (e.due && e.due.includes('T')) {
      const d = parseISO(e.due)
      return isSameDay(d, day) && getHours(d) === hour
    }
    if (e.start && e.start.includes('T')) {
      const d = parseISO(e.start)
      return isSameDay(d, day) && getHours(d) === hour
    }
    if (e.cron) {
      return cronMatchesDay(e.cron, day) && cronMatchesHour(e.cron, hour)
    }
    return false
  })
}

/** Simple cron day matching (supports day-of-week field) */
function cronMatchesDay(cron: string, day: Date): boolean {
  const parts = cron.split(/\s+/)
  if (parts.length < 5) return false
  const dow = parts[4] // day of week: 0-6 or *
  if (dow === '*') return true
  const dayNum = day.getDay() // 0=Sun
  // Handle ranges like 1-5
  if (dow.includes('-')) {
    const [start, end] = dow.split('-').map(Number)
    return dayNum >= start && dayNum <= end
  }
  // Handle lists like 1,3,5
  if (dow.includes(',')) {
    return dow.split(',').map(Number).includes(dayNum)
  }
  return Number(dow) === dayNum
}

/** Simple cron hour matching */
function cronMatchesHour(cron: string, hour: number): boolean {
  const parts = cron.split(/\s+/)
  if (parts.length < 5) return false
  const cronHour = parts[1]
  if (cronHour === '*') return true
  return Number(cronHour) === hour
}
```

**Step 4: Update Sidebar.tsx**

Change the `View` type:
```typescript
export type View = 'chat' | 'calendar' | 'queue' | 'files' | 'settings'
```

Remove `todos` and `done` NavItems. Add `calendar`:
```typescript
<NavItem icon={CalendarIcon} label="Calendar" active={view === 'calendar'} onClick={() => onViewChange('calendar')} />
```

Import `Calendar as CalendarIcon` from lucide-react.

Remove `todoCount` badge prop (no longer needed).

**Step 5: Update App.tsx**

Remove the entire `view === 'todos'` block (lines 103-134) and `view === 'done'` block (lines 175-194).

Add:
```typescript
{view === 'calendar' && (
  <CalendarPane
    entries={calendarEntries}
    onComplete={completeCalendarEntry}
    onDelete={deleteCalendarEntry}
  />
)}
```

Import `CalendarPane` from `@/components/CalendarPane`.

Update the useAgent destructuring to include `calendarEntries`, `completeCalendarEntry`, `deleteCalendarEntry`.

Remove `completeTodo`, `deleteTodo`, `todos`, `done` from useAgent destructuring.

**Step 6: Verify**

Run: `cd apps/desktop && pnpm build`
Expected: Clean build (or at least no type errors on the calendar components)

**Step 7: Commit**

```bash
git add apps/desktop/src/components/CalendarPane.tsx apps/desktop/src/components/Sidebar.tsx apps/desktop/src/hooks/useAgent.ts apps/desktop/src/App.tsx apps/desktop/package.json apps/desktop/pnpm-lock.yaml
git commit -m "feat: add CalendarPane with week/month/day/agenda views, replace todo and done tabs"
```

---

### Task 7: Update setup.md and system prompt — final cleanup

**Files:**
- Modify: `packages/agent-core/src/server.ts` (SETUP_MD_STATIC)
- Modify: `~/.coagent/memory/setup.md`

**What:** Update the setup.md documentation to reflect the new calendar system.

**Step 1: Update SETUP_MD_STATIC in server.ts**

In the "My tools" section, replace the `todos` line with:
```
- **calendar** (create/update/delete/complete/list) — unified calendar for routines (recurring cron), tasks (one-time with due time), and events (informational with start/end). Routines auto-execute on their cron schedule. Tasks fire at their due time.
```

In "How I work", add:
```
**I keep a calendar.** Routines (recurring), tasks (one-time), and events (informational) all live in one calendar. Routines fire on cron schedules. Tasks fire at their due time. Events are display-only. Everything is managed through chat.
```

Remove the old "I keep a to-do list" paragraph.

**Step 2: Update live setup.md**

Apply the same changes to `~/.coagent/memory/setup.md`.

**Step 3: Verify build**

Run: `pnpm --filter @coagent/agent-core build`
Expected: Clean build

**Step 4: Commit**

```bash
git add packages/agent-core/src/server.ts
git commit -m "docs: update setup.md for unified calendar system"
```
