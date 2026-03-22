# Settings View Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Settings view to the desktop app where users can configure profile (name, email, role, timezone), schedule (active hours/days), and autonomy level — auto-saved and kept in sync with the existing chat-based `update_settings` tool.

**Architecture:** `AgentSettings` type moves to `@coagent/shared` so both frontend and backend share it. New `get_settings`/`update_settings` WS messages let the UI read and write `~/.coagent/settings.json`. `server.ts` handles the new messages. `useAgent.ts` gets a `settings` state + `updateSettings` callback. A new `SettingsPane.tsx` renders three sections (Profile, Schedule, Behavior). `Sidebar.tsx` and `App.tsx` wire it up as a new view.

**Tech Stack:** TypeScript, React, Tailwind CSS (existing shadcn/ui components), Vitest (existing tests)

---

### Task 1: Extend `@coagent/shared` with settings types and update `settings.ts`

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/agent-core/src/settings.ts`
- Modify: `packages/agent-core/src/settings.test.ts`

**Step 1: Add types and WS messages to shared**

In `packages/shared/src/index.ts`, add these exports at the top of the file (before `TriggerSource`):

```typescript
export type Autonomy = 'ask_first' | 'balanced' | 'autonomous'
export type DayName = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

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

In `WSClientMessage`, add two new variants:
```typescript
| { type: 'get_settings' }
| { type: 'update_settings'; patch: Partial<AgentSettings> }
```

In `WSServerMessage`, add one new variant:
```typescript
| { type: 'settings_update'; settings: AgentSettings }
```

**Step 2: Update `settings.ts` to import from shared and add new fields**

Replace the top of `packages/agent-core/src/settings.ts` — remove local type definitions and import from shared instead, then add new fields:

```typescript
// packages/agent-core/src/settings.ts
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { AgentSettings, Autonomy, DayName } from '@coagent/shared'

export type { AgentSettings, Autonomy, DayName }

const DAY_NAMES: DayName[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export const DEFAULT_SETTINGS: AgentSettings = {
  name: '',
  email: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago',
  role: '',
  active_hours: { start: 7, end: 24 },
  active_days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  autonomy: 'balanced'
}

const SETTINGS_FILE = 'settings.json'

export async function readSettings(dataDir: string): Promise<AgentSettings> {
  try {
    const raw = await readFile(join(dataDir, SETTINGS_FILE), 'utf-8')
    const parsed = JSON.parse(raw)
    return {
      name: parsed.name ?? DEFAULT_SETTINGS.name,
      email: parsed.email ?? DEFAULT_SETTINGS.email,
      timezone: parsed.timezone ?? DEFAULT_SETTINGS.timezone,
      role: parsed.role ?? DEFAULT_SETTINGS.role,
      active_hours: { ...DEFAULT_SETTINGS.active_hours, ...parsed.active_hours },
      active_days: parsed.active_days ?? DEFAULT_SETTINGS.active_days,
      autonomy: parsed.autonomy ?? DEFAULT_SETTINGS.autonomy
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function writeSettings(dataDir: string, patch: Partial<AgentSettings>): Promise<AgentSettings> {
  await mkdir(dataDir, { recursive: true })
  const current = await readSettings(dataDir)

  const patchHours = patch.active_hours
  const validatedHours = patchHours ? {
    start: Math.max(0, Math.min(23, Math.round(patchHours.start ?? current.active_hours.start))),
    end: Math.max(0, Math.min(24, Math.round(patchHours.end ?? current.active_hours.end)))
  } : undefined

  const VALID_DAYS: DayName[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
  const VALID_AUTONOMY: Autonomy[] = ['ask_first', 'balanced', 'autonomous']

  const validatedDays = patch.active_days
    ? patch.active_days.filter((d): d is DayName => VALID_DAYS.includes(d as DayName))
    : undefined

  const validatedAutonomy = patch.autonomy && VALID_AUTONOMY.includes(patch.autonomy)
    ? patch.autonomy
    : undefined

  const updated: AgentSettings = {
    name: patch.name !== undefined ? patch.name : current.name,
    email: patch.email !== undefined ? patch.email : current.email,
    timezone: patch.timezone !== undefined ? patch.timezone : current.timezone,
    role: patch.role !== undefined ? patch.role : current.role,
    active_hours: validatedHours ?? current.active_hours,
    active_days: validatedDays !== undefined ? validatedDays : current.active_days,
    autonomy: validatedAutonomy ?? current.autonomy
  }

  await writeFile(join(dataDir, SETTINGS_FILE), JSON.stringify(updated, null, 2), 'utf-8')
  return updated
}

export function isActiveNow(settings: AgentSettings, now: Date = new Date()): boolean {
  const hour = now.getHours()
  const day = DAY_NAMES[now.getDay()]
  const inHours = hour >= settings.active_hours.start && hour < settings.active_hours.end
  const inDays = settings.active_days.includes(day)
  return inHours && inDays
}
```

**Step 3: Update `settings.test.ts` to cover new fields**

Add these tests to the existing test file (before the closing `})`):

```typescript
it('returns empty defaults for new profile fields', async () => {
  const s = await readSettings(tmpDir)
  expect(s.name).toBe('')
  expect(s.email).toBe('')
  expect(s.role).toBe('')
  expect(s.timezone).toBeTruthy() // system timezone or fallback
})

it('persists and reads back profile fields', async () => {
  await writeSettings(tmpDir, { name: 'Brett', email: 'brett@example.com', role: 'real estate agent' })
  const s = await readSettings(tmpDir)
  expect(s.name).toBe('Brett')
  expect(s.email).toBe('brett@example.com')
  expect(s.role).toBe('real estate agent')
})

it('partial profile update does not clobber other fields', async () => {
  await writeSettings(tmpDir, { name: 'Brett', email: 'brett@example.com' })
  await writeSettings(tmpDir, { name: 'Brett P' })
  const s = await readSettings(tmpDir)
  expect(s.name).toBe('Brett P')
  expect(s.email).toBe('brett@example.com')
})
```

**Step 4: Run existing tests to ensure they still pass**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core && npx vitest run src/settings.test.ts
```
Expected: all tests PASS

**Step 5: Verify TypeScript compiles**

```bash
cd /Users/brettponters/AI-Projects/CoAgent && npx tsc --noEmit -p packages/agent-core/tsconfig.json && npx tsc --noEmit -p packages/shared/tsconfig.json
```
Expected: no errors

**Step 6: Commit**

```bash
git add packages/shared/src/index.ts packages/agent-core/src/settings.ts packages/agent-core/src/settings.test.ts
git commit -m "feat: add profile fields to AgentSettings and move types to shared"
```

---

### Task 2: Handle settings WS messages in `server.ts`

**Files:**
- Modify: `packages/agent-core/src/server.ts`

**Step 1: Add import**

At the top of `server.ts`, add to imports:
```typescript
import { readSettings, writeSettings } from './settings.js'
```

**Step 2: Send settings on initial connection**

In the `wss.on('connection', ...)` block, after the existing `sendIntegrations(ws).catch(console.error)` line, add:
```typescript
readSettings(DATA_DIR).then(settings => send(ws, { type: 'settings_update', settings })).catch(console.error)
```

**Step 3: Handle `get_settings`**

In the `ws.on('message', ...)` handler, after the `integration_disconnect` block, add:
```typescript
if (msg.type === 'get_settings') {
  const settings = await readSettings(DATA_DIR)
  send(ws, { type: 'settings_update', settings })
}

if (msg.type === 'update_settings') {
  const settings = await writeSettings(DATA_DIR, msg.patch)
  send(ws, { type: 'settings_update', settings })
}
```

**Step 4: Verify TypeScript compiles**

```bash
cd /Users/brettponters/AI-Projects/CoAgent && npx tsc --noEmit -p packages/agent-core/tsconfig.json
```
Expected: no errors

**Step 5: Commit**

```bash
git add packages/agent-core/src/server.ts
git commit -m "feat: handle get_settings and update_settings WS messages in server"
```

---

### Task 3: Extend system prompt in `agent.ts` to show new profile fields

**Files:**
- Modify: `packages/agent-core/src/agent.ts`

**Step 1: Update `update_settings` tool schema**

In the `INTERNAL_TOOLS` array, find the `update_settings` entry. Add `name`, `email`, `timezone`, `role` properties to its `input_schema.properties`:

```typescript
name: {
  type: 'string',
  description: 'The user\'s name.'
},
email: {
  type: 'string',
  description: 'The user\'s email address.'
},
timezone: {
  type: 'string',
  description: 'IANA timezone string, e.g. "America/Chicago".'
},
role: {
  type: 'string',
  description: 'What the user does, e.g. "real estate agent", "sales manager".'
},
```

**Step 2: Extend `settingsSection` in `buildSystemPrompt`**

Find the `settingsSection` template string in `buildSystemPrompt`. Replace it with:

```typescript
const settingsSection = `
Current settings:
- Name: ${settings.name || '(not set)'}
- Email: ${settings.email || '(not set)'}
- Role: ${settings.role || '(not set)'}
- Timezone: ${settings.timezone}
- Active hours: ${formatHour(settings.active_hours.start)}–${formatHour(settings.active_hours.end)}
- Active days: ${settings.active_days.join(', ')}
- Autonomy: ${settings.autonomy} — ${AUTONOMY_DESCRIPTIONS[settings.autonomy]}
`
```

**Step 3: Verify TypeScript compiles + run tests**

```bash
cd /Users/brettponters/AI-Projects/CoAgent && npx tsc --noEmit -p packages/agent-core/tsconfig.json && cd packages/agent-core && npx vitest run
```
Expected: no errors, all tests PASS

**Step 4: Commit**

```bash
git add packages/agent-core/src/agent.ts
git commit -m "feat: extend agent system prompt with profile fields and update_settings schema"
```

---

### Task 4: Add settings state to `useAgent.ts`

**Files:**
- Modify: `apps/desktop/src/hooks/useAgent.ts`

**Step 1: Add import and state**

Add `AgentSettings` to the import from `@coagent/shared`:
```typescript
import type { ApprovalItem, DoneItem, TodoItem, AgentMessage, WSServerMessage, WSClientMessage, Integration, AgentSettings } from '@coagent/shared'
```

Add settings state after the `integrations` state line:
```typescript
const [settings, setSettings] = useState<AgentSettings | null>(null)
```

**Step 2: Handle `settings_update` in the onmessage handler**

After the `if (msg.type === 'integrations_update')` block, add:
```typescript
if (msg.type === 'settings_update') setSettings(msg.settings)
```

**Step 3: Add `updateSettings` callback**

After the `disconnectIntegration` callback, add:
```typescript
const updateSettings = useCallback((patch: Partial<AgentSettings>) => {
  send({ type: 'update_settings', patch })
}, [send])
```

**Step 4: Include `settings` and `updateSettings` in the return value**

Add `settings` and `updateSettings` to the returned object:
```typescript
return { queue, done, todos, messages, streamingText, thinking, connected, integrations, settings, error, chat, approve, reject, editQueueItem, completeTodo, deleteTodo, connectIntegration, disconnectIntegration, updateSettings }
```

**Step 5: Verify TypeScript compiles**

```bash
cd /Users/brettponters/AI-Projects/CoAgent && npx tsc --noEmit -p apps/desktop/tsconfig.json
```
Expected: no errors

**Step 6: Commit**

```bash
git add apps/desktop/src/hooks/useAgent.ts
git commit -m "feat: add settings state and updateSettings callback to useAgent"
```

---

### Task 5: Create `SettingsPane.tsx`

**Files:**
- Create: `apps/desktop/src/components/SettingsPane.tsx`

**Step 1: Create the component**

```typescript
// apps/desktop/src/components/SettingsPane.tsx
import React from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { AgentSettings, DayName, Autonomy } from '@coagent/shared'

interface SettingsPaneProps {
  settings: AgentSettings | null
  onUpdate: (patch: Partial<AgentSettings>) => void
}

const TIMEZONES = [
  { value: '__detect__', label: 'Detect automatically' },
  { value: 'America/New_York', label: 'Eastern (ET)' },
  { value: 'America/Chicago', label: 'Central (CT)' },
  { value: 'America/Denver', label: 'Mountain (MT)' },
  { value: 'America/Phoenix', label: 'Arizona (no DST)' },
  { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
  { value: 'America/Anchorage', label: 'Alaska (AKT)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (HT)' },
]

const ALL_DAYS: DayName[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const DAY_LABELS: Record<DayName, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun'
}

function buildHourOptions() {
  const options: { value: number; label: string }[] = []
  for (let h = 0; h <= 24; h++) {
    let label: string
    if (h === 0) label = '12am'
    else if (h === 12) label = '12pm'
    else if (h === 24) label = 'midnight'
    else if (h < 12) label = `${h}am`
    else label = `${h - 12}pm`
    options.push({ value: h, label })
  }
  return options
}

const HOUR_OPTIONS = buildHourOptions()

const AUTONOMY_OPTIONS: { value: Autonomy; label: string; description: string }[] = [
  {
    value: 'ask_first',
    label: 'Ask first',
    description: 'Queue almost everything for approval before acting',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    description: 'Act on routine tasks automatically, queue anything that sends or edits',
  },
  {
    value: 'autonomous',
    label: 'Autonomous',
    description: 'Handle most things, only queue permanent or destructive actions',
  },
]

function SectionHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="mb-5">
      <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-widest mb-0.5">{eyebrow}</p>
      <h2 className="text-[17px] font-bold tracking-tight text-neutral-900">{title}</h2>
    </div>
  )
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 mb-4">
      <label className="text-[12.5px] font-medium text-neutral-600">{label}</label>
      {children}
    </div>
  )
}

export function SettingsPane({ settings, onUpdate }: SettingsPaneProps) {
  if (!settings) {
    return (
      <div className="flex-1 bg-white flex items-center justify-center">
        <span className="text-[13px] text-neutral-400">Loading settings…</span>
      </div>
    )
  }

  const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const tzValue = TIMEZONES.find(t => t.value === settings.timezone) ? settings.timezone : '__detect__'

  function handleTimezoneChange(value: string) {
    if (value === '__detect__') {
      onUpdate({ timezone: detectedTz })
    } else {
      onUpdate({ timezone: value })
    }
  }

  function toggleDay(day: DayName) {
    const current = settings.active_days
    const next = current.includes(day) ? current.filter(d => d !== day) : [...current, day]
    // Keep in week order
    const ordered = ALL_DAYS.filter(d => next.includes(d))
    onUpdate({ active_days: ordered })
  }

  return (
    <ScrollArea className="flex-1 bg-white">
      <div className="px-8 py-7 max-w-xl">

        {/* Profile */}
        <SectionHeader eyebrow="Profile" title="About you" />
        <FieldRow label="Name">
          <Input
            className="text-[13.5px]"
            placeholder="Your name"
            defaultValue={settings.name}
            onBlur={e => onUpdate({ name: e.target.value })}
          />
        </FieldRow>
        <FieldRow label="Email">
          <Input
            className="text-[13.5px]"
            placeholder="your@email.com"
            defaultValue={settings.email}
            onBlur={e => onUpdate({ email: e.target.value })}
          />
        </FieldRow>
        <FieldRow label="What you do">
          <Input
            className="text-[13.5px]"
            placeholder="e.g. real estate agent, sales manager"
            defaultValue={settings.role}
            onBlur={e => onUpdate({ role: e.target.value })}
          />
        </FieldRow>
        <FieldRow label="Timezone">
          <select
            value={tzValue}
            onChange={e => handleTimezoneChange(e.target.value)}
            className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-[13.5px] text-neutral-800 focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {TIMEZONES.map(tz => (
              <option key={tz.value} value={tz.value}>{tz.label}</option>
            ))}
          </select>
        </FieldRow>

        <Separator className="my-6" />

        {/* Schedule */}
        <SectionHeader eyebrow="Schedule" title="Active hours" />
        <FieldRow label="Active window">
          <div className="flex items-center gap-2">
            <select
              value={settings.active_hours.start}
              onChange={e => onUpdate({ active_hours: { ...settings.active_hours, start: Number(e.target.value) } })}
              className="h-9 rounded-md border border-input bg-background px-3 py-1 text-[13.5px] text-neutral-800 focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {HOUR_OPTIONS.filter(o => o.value < 24).map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <span className="text-[13px] text-neutral-400">to</span>
            <select
              value={settings.active_hours.end}
              onChange={e => onUpdate({ active_hours: { ...settings.active_hours, end: Number(e.target.value) } })}
              className="h-9 rounded-md border border-input bg-background px-3 py-1 text-[13.5px] text-neutral-800 focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {HOUR_OPTIONS.filter(o => o.value > 0).map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </FieldRow>

        <FieldRow label="Active days">
          <div className="flex gap-1.5 flex-wrap">
            {ALL_DAYS.map(day => {
              const active = settings.active_days.includes(day)
              return (
                <button
                  key={day}
                  onClick={() => toggleDay(day)}
                  className={cn(
                    'px-3 py-1 rounded-full text-[12.5px] font-medium border transition-colors',
                    active
                      ? 'bg-neutral-900 text-white border-neutral-900'
                      : 'bg-white text-neutral-500 border-neutral-300 hover:border-neutral-500'
                  )}
                >
                  {DAY_LABELS[day]}
                </button>
              )
            })}
          </div>
        </FieldRow>

        <Separator className="my-6" />

        {/* Behavior */}
        <SectionHeader eyebrow="Behavior" title="Autonomy level" />
        <div className="flex flex-col gap-2.5">
          {AUTONOMY_OPTIONS.map(opt => {
            const selected = settings.autonomy === opt.value
            return (
              <button
                key={opt.value}
                onClick={() => onUpdate({ autonomy: opt.value })}
                className={cn(
                  'w-full text-left px-4 py-3.5 rounded-xl border transition-colors',
                  selected
                    ? 'border-neutral-900 bg-neutral-50'
                    : 'border-neutral-200 bg-white hover:border-neutral-400'
                )}
              >
                <div className="flex items-center gap-2.5 mb-0.5">
                  <div className={cn(
                    'w-3.5 h-3.5 rounded-full border-2 flex-shrink-0',
                    selected ? 'border-neutral-900 bg-neutral-900' : 'border-neutral-300'
                  )} />
                  <span className={cn('text-[13.5px] font-semibold', selected ? 'text-neutral-900' : 'text-neutral-700')}>
                    {opt.label}
                  </span>
                </div>
                <p className="text-[12.5px] text-neutral-500 ml-6">{opt.description}</p>
              </button>
            )
          })}
        </div>

        <div className="h-8" />
      </div>
    </ScrollArea>
  )
}
```

**Step 2: Verify TypeScript compiles**

```bash
cd /Users/brettponters/AI-Projects/CoAgent && npx tsc --noEmit -p apps/desktop/tsconfig.json
```
Expected: no errors

**Step 3: Commit**

```bash
git add apps/desktop/src/components/SettingsPane.tsx
git commit -m "feat: add SettingsPane component with profile, schedule, and behavior sections"
```

---

### Task 6: Wire Settings view into `Sidebar.tsx` and `App.tsx`

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/App.tsx`

**Step 1: Update `Sidebar.tsx`**

Change the `View` type (line 12) to include `'settings'`:
```typescript
export type View = 'chat' | 'queue' | 'todos' | 'done' | 'settings'
```

Find the Settings `NavItem` and the user avatar button at the bottom (lines 164–173). Replace the `{/* TODO: wire to settings view */}` comment and unwired `NavItem`:
```typescript
<NavItem icon={Settings} label="Settings" active={view === 'settings'} onClick={() => onViewChange('settings')} />
```

The user avatar button below it: replace the hardcoded initials `SM` and name `Sarah Mitchell` with dynamic values from a `name` prop. Add `name` to `SidebarProps`:
```typescript
interface SidebarProps {
  view: View
  onViewChange: (v: View) => void
  queueCount: number
  todoCount: number
  integrations: Integration[]
  onConnect: (slug: string) => void
  onDisconnect: (slug: string) => void
  onOpenModal: () => void
  userName?: string
}
```

Update the `export function Sidebar(...)` signature to destructure `userName`:
```typescript
export function Sidebar({ view, onViewChange, queueCount, todoCount, integrations, onConnect, onDisconnect, onOpenModal, userName }: SidebarProps) {
```

Replace the avatar button:
```typescript
<button
  onClick={() => onViewChange('settings')}
  className="flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-md hover:bg-neutral-100 transition-colors mt-0.5"
>
  <Avatar className="h-6 w-6">
    <AvatarFallback className="text-[10px] font-semibold bg-neutral-200 text-neutral-600">
      {userName ? userName.slice(0, 2).toUpperCase() : 'ME'}
    </AvatarFallback>
  </Avatar>
  <span className="text-[13px] font-medium text-neutral-600">{userName || 'Settings'}</span>
</button>
```

**Step 2: Update `App.tsx`**

Add import:
```typescript
import { SettingsPane } from '@/components/SettingsPane'
```

Destructure `settings` and `updateSettings` from `useAgent()`:
```typescript
const { queue, done, todos, messages, streamingText, thinking, connected, integrations, settings, error, chat, approve, reject, editQueueItem, completeTodo, deleteTodo, connectIntegration, disconnectIntegration, updateSettings } = useAgent()
```

Pass `userName` to `Sidebar`:
```typescript
<Sidebar
  view={view}
  onViewChange={setView}
  queueCount={queue.length}
  todoCount={todos.length}
  integrations={integrations}
  onConnect={connectIntegration}
  onDisconnect={disconnectIntegration}
  onOpenModal={() => setModalOpen(true)}
  userName={settings?.name || undefined}
/>
```

Add the settings view render after the `done` view block:
```typescript
{view === 'settings' && (
  <SettingsPane settings={settings} onUpdate={updateSettings} />
)}
```

**Step 3: Verify TypeScript compiles**

```bash
cd /Users/brettponters/AI-Projects/CoAgent && npx tsc --noEmit -p apps/desktop/tsconfig.json
```
Expected: no errors

**Step 4: Run all agent-core tests**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core && npx vitest run
```
Expected: all tests PASS

**Step 5: Commit**

```bash
git add apps/desktop/src/components/Sidebar.tsx apps/desktop/src/App.tsx
git commit -m "feat: wire Settings view into Sidebar and App"
```

---

### Task 7: Manual smoke test

**Step 1: Restart the server**

```bash
kill $(lsof -ti :7830) 2>/dev/null; sleep 1
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core && npm run dev &
sleep 3
```

**Step 2: Open the desktop app and click Settings**

Expected: Settings pane loads with three sections — Profile, Active hours, Autonomy level.

**Step 3: Fill in Name and Email, tab away**

Expected: `~/.coagent/settings.json` shows `name` and `email` fields updated.

**Step 4: Toggle a day off (e.g., Sun), change From to 8am**

Expected: `settings.json` shows `active_days` without `sun` and `active_hours.start: 8`.

**Step 5: Select "Ask first" autonomy**

Expected: `settings.json` shows `"autonomy": "ask_first"`.

**Step 6: In chat, say "What are my current settings?"**

Expected: agent lists name, email, role, timezone, active hours, days, and autonomy from the system prompt.

**Step 7: In chat, say "Switch back to balanced mode"**

Expected: agent calls `update_settings({ autonomy: 'balanced' })`, `settings.json` updates, and the autonomy card in the Settings pane reflects the change after clicking away and back to Settings.

**Step 8: Commit if smoke test passes**

```bash
git add -A && git commit -m "chore: verified settings view smoke test"
```
