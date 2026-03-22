# User-Defined Schedules Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users create recurring scheduled tasks through chat that fire automatically via cron, with a dedicated UI to manage them.

**Architecture:** New `ScheduleStore` class (file-backed, like `ApprovalQueue`) manages schedule CRUD. Three new agent tools let the AI create/update/delete schedules conversationally. The existing `scheduler.ts` dynamically registers user cron jobs that call `agent.handleTrigger()`. A new `SchedulesPane` in the desktop sidebar shows all schedules with toggle/delete. Trigger output broadcasts to the UI so users see results in chat.

**Tech Stack:** node-cron, uuid, React, Tailwind, lucide-react, WebSocket

---

### Task 1: Schedule type and WS messages in shared package

**Files:**
- Modify: `packages/shared/src/index.ts`

**Step 1: Add Schedule interface after TodoItem**

Add this after the `TodoItem` interface (line 51):

```typescript
export interface Schedule {
  id: string
  cron: string
  instruction: string
  label: string
  enabled: boolean
  createdAt: string
}
```

**Step 2: Add TriggerSource 'schedule'**

Change line 23 from:
```typescript
export type TriggerSource = 'heartbeat' | 'webhook' | 'manual' | 'memory_cleanup'
```
to:
```typescript
export type TriggerSource = 'heartbeat' | 'webhook' | 'manual' | 'memory_cleanup' | 'schedule'
```

**Step 3: Add WS messages**

Add to `WSClientMessage` (after `close_document` line):
```typescript
  | { type: 'get_schedules' }
  | { type: 'toggle_schedule'; id: string; enabled: boolean }
  | { type: 'delete_schedule_ui'; id: string }
```

Add to `WSServerMessage` (after `document_stream_chunk` line):
```typescript
  | { type: 'schedules_update'; schedules: Schedule[] }
```

**Step 4: Build shared package**

Run: `npx tsc -p packages/shared/tsconfig.json`
Expected: No errors

**Step 5: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat: add Schedule type and WS messages to shared package"
```

---

### Task 2: ScheduleStore — persistence class

**Files:**
- Create: `packages/agent-core/src/schedule-store.ts`

**Step 1: Create the store**

Create `packages/agent-core/src/schedule-store.ts`:

```typescript
import { v4 as uuidv4 } from 'uuid'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { Schedule } from '@coagent/shared'

export class ScheduleStore {
  private schedules: Schedule[] = []
  private filePath: string

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'schedules.json')
    mkdirSync(dataDir, { recursive: true })
    try {
      if (existsSync(this.filePath)) {
        this.schedules = JSON.parse(readFileSync(this.filePath, 'utf-8'))
      }
    } catch { /* corrupt file — start fresh */ }
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.schedules, null, 2))
  }

  getAll(): Schedule[] {
    return this.schedules
  }

  getEnabled(): Schedule[] {
    return this.schedules.filter(s => s.enabled)
  }

  get(id: string): Schedule | undefined {
    return this.schedules.find(s => s.id === id)
  }

  create(input: { cron: string; instruction: string; label: string }): Schedule {
    const schedule: Schedule = {
      id: uuidv4(),
      cron: input.cron,
      instruction: input.instruction,
      label: input.label,
      enabled: true,
      createdAt: new Date().toISOString()
    }
    this.schedules.push(schedule)
    this.save()
    return schedule
  }

  update(id: string, patch: Partial<Pick<Schedule, 'cron' | 'instruction' | 'label' | 'enabled'>>): Schedule | undefined {
    const schedule = this.schedules.find(s => s.id === id)
    if (!schedule) return undefined
    if (patch.cron !== undefined) schedule.cron = patch.cron
    if (patch.instruction !== undefined) schedule.instruction = patch.instruction
    if (patch.label !== undefined) schedule.label = patch.label
    if (patch.enabled !== undefined) schedule.enabled = patch.enabled
    this.save()
    return schedule
  }

  delete(id: string): boolean {
    const idx = this.schedules.findIndex(s => s.id === id)
    if (idx === -1) return false
    this.schedules.splice(idx, 1)
    this.save()
    return true
  }
}
```

**Step 2: Verify it compiles**

Run: `npx tsc -p packages/agent-core/tsconfig.json --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/agent-core/src/schedule-store.ts
git commit -m "feat: add ScheduleStore persistence class"
```

---

### Task 3: Agent tools — create_schedule, update_schedule, delete_schedule

**Files:**
- Modify: `packages/agent-core/src/agent.ts`

**Step 1: Import ScheduleStore**

Add import at top of file (after the TodoList import):
```typescript
import { ScheduleStore } from './schedule-store.js'
```

**Step 2: Add tool definitions to INTERNAL_TOOLS array**

Add these after the `complete_todo` tool definition (after line ~100):

```typescript
  {
    name: 'create_schedule',
    description: 'Create a recurring scheduled task. Convert the user\'s natural language schedule into a cron expression. Examples: "every weekday at 9am" = "0 9 * * 1-5", "every Monday at 8am" = "0 8 * * 1", "every hour" = "0 * * * *", "first day of each month at 10am" = "0 10 1 * *". The instruction should be a complete prompt the agent will receive when the job fires.',
    input_schema: {
      type: 'object' as const,
      properties: {
        cron: { type: 'string', description: 'Cron expression (5-field: minute hour day-of-month month day-of-week)' },
        instruction: { type: 'string', description: 'Full instruction the agent will execute when this schedule fires' },
        label: { type: 'string', description: 'Short human-readable label, e.g. "Weekly briefing"' }
      },
      required: ['cron', 'instruction', 'label']
    }
  },
  {
    name: 'update_schedule',
    description: 'Update an existing schedule — toggle enabled/disabled, change timing, or modify the instruction.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Schedule ID' },
        enabled: { type: 'boolean', description: 'Enable or disable the schedule' },
        cron: { type: 'string', description: 'New cron expression' },
        instruction: { type: 'string', description: 'New instruction' },
        label: { type: 'string', description: 'New label' }
      },
      required: ['id']
    }
  },
  {
    name: 'delete_schedule',
    description: 'Permanently remove a scheduled task.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Schedule ID to delete' }
      },
      required: ['id']
    }
  },
```

**Step 3: Add ScheduleStore to Agent class**

In the Agent class constructor area, add `schedules` as a public property alongside `queue` and `todos`:

```typescript
public schedules: ScheduleStore
```

Initialize it in the constructor (after `this.todos = new TodoList()`):
```typescript
this.schedules = new ScheduleStore(dataDir)
```

**Step 4: Add onScheduleChange callback**

Add alongside the existing `onDocumentEvent` and `onDocumentStream` callback properties:

```typescript
public onScheduleChange?: () => void
```

**Step 5: Add tool handlers in runLoop**

In the tool handler switch section (after the `complete_todo` handler around line 704), add:

```typescript
          } else if (block.name === 'create_schedule') {
            const input = block.input as { cron: string; instruction: string; label: string }
            const schedule = this.schedules.create(input)
            this.onScheduleChange?.()
            result = `Created schedule "${schedule.label}" (id: ${schedule.id}, cron: ${schedule.cron})`

          } else if (block.name === 'update_schedule') {
            const { id, ...patch } = block.input as { id: string; enabled?: boolean; cron?: string; instruction?: string; label?: string }
            const schedule = this.schedules.update(id, patch)
            if (schedule) {
              this.onScheduleChange?.()
              result = `Updated schedule "${schedule.label}" (enabled: ${schedule.enabled})`
            } else {
              result = `Schedule ${id} not found.`
            }

          } else if (block.name === 'delete_schedule') {
            const { id } = block.input as { id: string }
            const deleted = this.schedules.delete(id)
            if (deleted) {
              this.onScheduleChange?.()
              result = `Deleted schedule ${id}`
            } else {
              result = `Schedule ${id} not found.`
            }
```

**Step 6: Add 'schedule' case to buildTriggerMessage**

In `buildTriggerMessage()`, add before the final `return` line:

```typescript
    if (trigger.source === 'schedule') {
      const label = (trigger.payload?.label as string) ?? 'Scheduled task'
      const instruction = (trigger.payload?.instruction as string) ?? ''
      return `[Scheduled task: ${label} — ${time}] ${instruction}`
    }
```

**Step 7: Add schedule tools to always-available list in system prompt**

Find the line in `buildSystemPrompt` that lists always-available tools (around line 398) and add `create_schedule, update_schedule, delete_schedule` to the list.

**Step 8: Verify it compiles**

Run: `npx tsc -p packages/agent-core/tsconfig.json --noEmit`
Expected: No errors

**Step 9: Commit**

```bash
git add packages/agent-core/src/agent.ts
git commit -m "feat: add schedule agent tools and trigger handler"
```

---

### Task 4: Scheduler — dynamic user cron job registration

**Files:**
- Modify: `packages/agent-core/src/scheduler.ts`

**Step 1: Rewrite scheduler with user schedule support**

Replace the entire file with:

```typescript
import cron from 'node-cron'
import { spawn, type ChildProcess } from 'child_process'
import type { Agent } from './agent.js'
import { hasUnreadEvents, purgeEventStore } from './relay-client.js'
import { readSettings, isActiveNow } from './settings.js'

let caffeinateProc: ChildProcess | null = null

function updateCaffeinate(active: boolean): void {
  if (process.platform !== 'darwin') return

  if (active && !caffeinateProc) {
    caffeinateProc = spawn('caffeinate', ['-i'], { stdio: 'ignore', detached: false })
    caffeinateProc.on('exit', () => { caffeinateProc = null })
    console.log('[Scheduler] caffeinate started — preventing idle sleep')
  } else if (!active && caffeinateProc) {
    caffeinateProc.kill()
    caffeinateProc = null
    console.log('[Scheduler] caffeinate stopped — sleep allowed')
  }
}

// User-defined schedule tasks
const userJobs = new Map<string, cron.ScheduledTask>()

export function reloadUserSchedules(agent: Agent, dataDir: string): void {
  // Stop all existing user jobs
  for (const [id, task] of userJobs) {
    task.stop()
  }
  userJobs.clear()

  // Register enabled schedules
  const schedules = agent.schedules.getEnabled()
  for (const schedule of schedules) {
    if (!cron.validate(schedule.cron)) {
      console.warn(`[Scheduler] Invalid cron for schedule "${schedule.label}": ${schedule.cron}`)
      continue
    }
    const task = cron.schedule(schedule.cron, async () => {
      const settings = await readSettings(dataDir).catch(() => null)
      if (settings && !isActiveNow(settings)) {
        console.log(`[Scheduler] Outside active hours — skipping schedule "${schedule.label}"`)
        return
      }
      console.log(`[Scheduler] Firing schedule: ${schedule.label}`)
      agent.handleTrigger({
        source: 'schedule',
        payload: { scheduleId: schedule.id, instruction: schedule.instruction, label: schedule.label }
      })
    })
    userJobs.set(schedule.id, task)
  }

  console.log(`[Scheduler] Loaded ${userJobs.size} user schedule(s)`)
}

export function startScheduler(agent: Agent, dataDir: string): void {
  // Check active hours and manage caffeinate on startup + every minute
  async function syncCaffeinate() {
    const settings = await readSettings(dataDir).catch(() => null)
    if (settings) updateCaffeinate(isActiveNow(settings))
  }
  syncCaffeinate()
  cron.schedule('* * * * *', () => { syncCaffeinate() })

  // Daily memory cleanup — 3am (runs regardless of active hours)
  cron.schedule('0 3 * * *', () => {
    agent.handleTrigger({ source: 'memory_cleanup' })
  })

  // Hourly heartbeat — top of every hour
  cron.schedule('0 * * * *', async () => {
    const settings = await readSettings(dataDir)
    if (!isActiveNow(settings)) {
      console.log('[Scheduler] Outside active hours — skipping heartbeat')
      return
    }

    await purgeEventStore(dataDir).catch((err) =>
      console.error('[Scheduler] Purge failed:', err.message)
    )

    const hasEvents = await hasUnreadEvents(dataDir).catch(() => false)
    const due = agent.todos.getDue()

    if (!hasEvents && due.length === 0) {
      console.log('[Scheduler] Nothing to do — skipping heartbeat')
      return
    }

    agent.handleTrigger({ source: 'heartbeat' })
  })

  // Load user schedules on startup
  reloadUserSchedules(agent, dataDir)
}
```

**Step 2: Verify it compiles**

Run: `npx tsc -p packages/agent-core/tsconfig.json --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/agent-core/src/scheduler.ts
git commit -m "feat: scheduler supports dynamic user cron job registration"
```

---

### Task 5: Server — wire schedules to WebSocket

**Files:**
- Modify: `packages/agent-core/src/server.ts`

**Step 1: Import reloadUserSchedules**

Change the scheduler import from:
```typescript
import { startScheduler } from './scheduler.js'
```
to:
```typescript
import { startScheduler, reloadUserSchedules } from './scheduler.js'
```

**Step 2: Wire onScheduleChange callback**

After the `agent.onDocumentStream = ...` block (around line 109), add:

```typescript
agent.onScheduleChange = () => {
  reloadUserSchedules(agent, DATA_DIR)
  broadcast({ type: 'schedules_update', schedules: agent.schedules.getAll() })
}
```

**Step 3: Add schedule-related WS message handlers**

In the `ws.on('message', ...)` handler, add after existing message handlers:

```typescript
    if (msg.type === 'get_schedules') {
      send(ws, { type: 'schedules_update', schedules: agent.schedules.getAll() })
    }

    if (msg.type === 'toggle_schedule') {
      agent.schedules.update(msg.id, { enabled: msg.enabled })
      reloadUserSchedules(agent, DATA_DIR)
      broadcast({ type: 'schedules_update', schedules: agent.schedules.getAll() })
    }

    if (msg.type === 'delete_schedule_ui') {
      agent.schedules.delete(msg.id)
      reloadUserSchedules(agent, DATA_DIR)
      broadcast({ type: 'schedules_update', schedules: agent.schedules.getAll() })
    }
```

**Step 4: Send schedules on client connect**

In the `ws.on('connection', ...)` handler, after the existing sends (around line 186), add:

```typescript
  send(ws, { type: 'schedules_update', schedules: agent.schedules.getAll() })
```

**Step 5: Build the full agent-core package**

Run: `npx tsc -p packages/agent-core/tsconfig.json`
Expected: No errors

**Step 6: Commit**

```bash
git add packages/agent-core/src/server.ts
git commit -m "feat: wire schedule CRUD and broadcasting to WebSocket server"
```

---

### Task 6: useAgent hook — schedule state and actions

**Files:**
- Modify: `apps/desktop/src/hooks/useAgent.ts`

**Step 1: Add Schedule import**

Add `Schedule` to the shared import:
```typescript
import type { ..., Schedule } from '@coagent/shared'
```

**Step 2: Add state**

After the existing state declarations (around line 28), add:
```typescript
const [schedules, setSchedules] = useState<Schedule[]>([])
```

**Step 3: Add message handler**

In `socket.onmessage`, add:
```typescript
if (msg.type === 'schedules_update') setSchedules(msg.schedules)
```

**Step 4: Add action functions**

After the existing action functions (near the bottom, alongside `deleteFile`, `createFolder`, etc.), add:

```typescript
const toggleSchedule = useCallback((id: string, enabled: boolean) => {
  wsRef.current?.send(JSON.stringify({ type: 'toggle_schedule', id, enabled } as WSClientMessage))
}, [])

const deleteSchedule = useCallback((id: string) => {
  wsRef.current?.send(JSON.stringify({ type: 'delete_schedule_ui', id } as WSClientMessage))
}, [])
```

**Step 5: Add to return object**

Add `schedules`, `toggleSchedule`, `deleteSchedule` to the return object.

**Step 6: Commit**

```bash
git add apps/desktop/src/hooks/useAgent.ts
git commit -m "feat: add schedule state and actions to useAgent hook"
```

---

### Task 7: SchedulesPane component

**Files:**
- Create: `apps/desktop/src/components/SchedulesPane.tsx`

**Step 1: Create the component**

Create `apps/desktop/src/components/SchedulesPane.tsx`:

```typescript
import React from 'react'
import { Trash2, Clock } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { Schedule } from '@coagent/shared'

interface SchedulesPaneProps {
  schedules: Schedule[]
  onToggle: (id: string, enabled: boolean) => void
  onDelete: (id: string) => void
}

function cronToHuman(cron: string): string {
  const parts = cron.split(' ')
  if (parts.length !== 5) return cron

  const [min, hour, dom, mon, dow] = parts

  const dayNames: Record<string, string> = {
    '0': 'Sunday', '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday',
    '4': 'Thursday', '5': 'Friday', '6': 'Saturday', '7': 'Sunday'
  }

  function formatTime(h: string, m: string): string {
    const hr = parseInt(h)
    const mn = parseInt(m)
    if (isNaN(hr)) return ''
    const ampm = hr >= 12 ? 'pm' : 'am'
    const h12 = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr
    return mn === 0 ? `${h12}${ampm}` : `${h12}:${mn.toString().padStart(2, '0')}${ampm}`
  }

  const time = hour !== '*' ? formatTime(hour, min) : ''

  // Every minute
  if (cron === '* * * * *') return 'Every minute'

  // Every hour
  if (min !== '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Every hour at :${min.padStart(2, '0')}`
  }

  // Daily
  if (dom === '*' && mon === '*' && dow === '*' && time) {
    return `Every day at ${time}`
  }

  // Weekdays
  if (dom === '*' && mon === '*' && dow === '1-5' && time) {
    return `Weekdays at ${time}`
  }

  // Specific day of week
  if (dom === '*' && mon === '*' && dow !== '*' && time) {
    const days = dow.split(',').map(d => dayNames[d] ?? d).join(', ')
    return `Every ${days} at ${time}`
  }

  // Monthly
  if (dom !== '*' && mon === '*' && dow === '*' && time) {
    const suffix = dom === '1' ? 'st' : dom === '2' ? 'nd' : dom === '3' ? 'rd' : 'th'
    return `${dom}${suffix} of each month at ${time}`
  }

  return cron
}

export function SchedulesPane({ schedules, onToggle, onDelete }: SchedulesPaneProps) {
  return (
    <ScrollArea className="flex-1 bg-white dark:bg-neutral-950">
      <div className="px-8 py-7">
        <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-1">Automation</p>
        <h1 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-neutral-100 mb-6">Schedules</h1>
        {schedules.length === 0 ? (
          <p className="text-[14px] text-neutral-400 dark:text-neutral-500">
            No schedules yet. Ask Co-Agent to set one up — e.g. "Every Monday at 9am, send me a weekly briefing."
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-800">
            {schedules.map(schedule => (
              <div key={schedule.id} className="flex items-start gap-3 py-3 group">
                <button
                  onClick={() => onToggle(schedule.id, !schedule.enabled)}
                  className="mt-0.5 flex-shrink-0"
                  title={schedule.enabled ? 'Disable' : 'Enable'}
                >
                  <Clock
                    size={15}
                    strokeWidth={1.75}
                    className={cn(
                      'transition-colors',
                      schedule.enabled
                        ? 'text-blue-500'
                        : 'text-neutral-300 dark:text-neutral-600'
                    )}
                  />
                </button>
                <div className="flex-1 min-w-0">
                  <p className={cn(
                    'text-[14px] leading-relaxed',
                    schedule.enabled
                      ? 'text-neutral-800 dark:text-neutral-200'
                      : 'text-neutral-400 dark:text-neutral-500 line-through'
                  )}>
                    {schedule.label}
                  </p>
                  <p className="text-[12px] mt-0.5 text-neutral-400 dark:text-neutral-500">
                    {cronToHuman(schedule.cron)}
                  </p>
                </div>
                <button
                  onClick={() => onDelete(schedule.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-neutral-300 dark:text-neutral-600 hover:text-red-500 flex-shrink-0 mt-0.5"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  )
}
```

**Step 2: Commit**

```bash
git add apps/desktop/src/components/SchedulesPane.tsx
git commit -m "feat: add SchedulesPane component"
```

---

### Task 8: Wire SchedulesPane into Sidebar and App

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/App.tsx`

**Step 1: Add 'schedules' to View type in Sidebar.tsx**

Change line 12 from:
```typescript
export type View = 'chat' | 'queue' | 'todos' | 'done' | 'settings' | 'files'
```
to:
```typescript
export type View = 'chat' | 'queue' | 'todos' | 'done' | 'settings' | 'files' | 'schedules'
```

**Step 2: Add CalendarClock to Sidebar imports**

Change the lucide-react import to include `CalendarClock`:
```typescript
import {
  Inbox, MessageSquare, CheckCircle2, Settings, ListTodo,
  ChevronRight, FolderOpen, Sun, Moon, CalendarClock
} from 'lucide-react'
```

**Step 3: Add scheduleCount prop to SidebarProps**

Add after `todoCount: number`:
```typescript
  scheduleCount: number
```

**Step 4: Add scheduleCount to destructured props**

Update the function signature to include `scheduleCount`.

**Step 5: Add NavItem for Schedules**

After the Files NavItem (line 135), add:
```typescript
        <NavItem icon={CalendarClock} label="Schedules" active={view === 'schedules'} onClick={() => onViewChange('schedules')} badge={scheduleCount} />
```

**Step 6: Update App.tsx — import SchedulesPane**

Add import:
```typescript
import { SchedulesPane } from '@/components/SchedulesPane'
```

**Step 7: Update App.tsx — pass scheduleCount to Sidebar**

In the Sidebar component usage, add prop:
```typescript
scheduleCount={schedules.filter(s => s.enabled).length}
```

**Step 8: Update App.tsx — destructure new values from useAgent**

Add `schedules`, `toggleSchedule`, `deleteSchedule` to the useAgent destructuring.

**Step 9: Update App.tsx — add schedules view**

After the `files` view block, add:

```typescript
        {view === 'schedules' && (
          <SchedulesPane
            schedules={schedules}
            onToggle={toggleSchedule}
            onDelete={deleteSchedule}
          />
        )}
```

**Step 10: Build frontend**

Run: `cd apps/desktop && npx vite build`
Expected: Build succeeds

**Step 11: Commit**

```bash
git add apps/desktop/src/components/Sidebar.tsx apps/desktop/src/App.tsx
git commit -m "feat: wire SchedulesPane into sidebar and app"
```

---

### Task 9: Build, test end-to-end

**Step 1: Rebuild shared package**

Run: `npx tsc -p packages/shared/tsconfig.json`

**Step 2: Rebuild agent-core**

Run: `npx tsc -p packages/agent-core/tsconfig.json`

**Step 3: Rebuild frontend**

Run: `cd apps/desktop && npx vite build`

**Step 4: Restart backend**

Kill existing server and start fresh:
```bash
lsof -ti:7830 | xargs kill; sleep 1; node packages/agent-core/dist/server.js
```

Verify log shows: `[Scheduler] Loaded 0 user schedule(s)`

**Step 5: Test via chat**

Send a chat message: "Set up a schedule to check my email every weekday at 9am and give me a summary"

Verify:
- Agent calls `create_schedule` tool
- Server log shows `[Scheduler] Loaded 1 user schedule(s)`
- Schedules view in sidebar shows the new schedule
- Toggle and delete work from the UI

**Step 6: Commit if any fixes needed**
