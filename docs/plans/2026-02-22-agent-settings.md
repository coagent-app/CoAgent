# Agent Settings Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the agent configure its own active hours and autonomy level through conversation, persisted in `~/.coagent/settings.json`.

**Architecture:** A new `settings.ts` module owns reading/writing `settings.json` with safe defaults. The scheduler reads settings before each heartbeat to skip outside active hours. Agent gets an `update_settings` internal tool and the current settings are injected into the system prompt so the agent knows its own config.

**Tech Stack:** TypeScript, Vitest (tests), node-cron (scheduler), fs/promises (file I/O)

---

### Task 1: Create `settings.ts` module

**Files:**
- Create: `packages/agent-core/src/settings.ts`
- Create: `packages/agent-core/src/settings.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/agent-core/src/settings.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readSettings, writeSettings, DEFAULT_SETTINGS } from './settings'

describe('settings', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'settings-test-'))
  })

  it('returns defaults when no file exists', async () => {
    const s = await readSettings(tmpDir)
    expect(s.autonomy).toBe('balanced')
    expect(s.active_hours.start).toBe(7)
    expect(s.active_hours.end).toBe(23)
    expect(s.active_days).toEqual(['mon','tue','wed','thu','fri','sat','sun'])
  })

  it('persists and reads back settings', async () => {
    await writeSettings(tmpDir, { autonomy: 'ask_first' })
    const s = await readSettings(tmpDir)
    expect(s.autonomy).toBe('ask_first')
    // Other fields stay at default
    expect(s.active_hours.start).toBe(7)
  })

  it('merges partial updates', async () => {
    await writeSettings(tmpDir, { active_hours: { start: 9, end: 21 } })
    const s = await readSettings(tmpDir)
    expect(s.active_hours.start).toBe(9)
    expect(s.active_hours.end).toBe(21)
    expect(s.autonomy).toBe('balanced')
  })

  it('isActiveNow returns true inside active window', async () => {
    const { isActiveNow } = await import('./settings')
    const settings = {
      ...DEFAULT_SETTINGS,
      active_hours: { start: 8, end: 22 },
      active_days: ['mon','tue','wed','thu','fri','sat','sun']
    }
    // 10am on any day should be active
    const midday = new Date('2026-02-23T10:00:00') // Monday
    expect(isActiveNow(settings, midday)).toBe(true)
  })

  it('isActiveNow returns false outside active window', async () => {
    const { isActiveNow } = await import('./settings')
    const settings = {
      ...DEFAULT_SETTINGS,
      active_hours: { start: 8, end: 22 },
      active_days: ['mon','tue','wed','thu','fri','sat','sun']
    }
    // 3am should be inactive
    const night = new Date('2026-02-23T03:00:00')
    expect(isActiveNow(settings, night)).toBe(false)
  })

  it('isActiveNow returns false on inactive day', async () => {
    const { isActiveNow } = await import('./settings')
    const settings = {
      ...DEFAULT_SETTINGS,
      active_hours: { start: 8, end: 22 },
      active_days: ['mon','tue','wed','thu','fri'] // weekdays only
    }
    // Saturday
    const saturday = new Date('2026-02-21T10:00:00')
    expect(isActiveNow(settings, saturday)).toBe(false)
  })
})
```

**Step 2: Run test to verify it fails**

```bash
cd packages/agent-core && npx vitest run src/settings.test.ts
```
Expected: FAIL — `Cannot find module './settings'`

**Step 3: Write the implementation**

```typescript
// packages/agent-core/src/settings.ts
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

export type Autonomy = 'ask_first' | 'balanced' | 'autonomous'

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export interface AgentSettings {
  active_hours: { start: number; end: number }
  active_days: string[]
  autonomy: Autonomy
}

export const DEFAULT_SETTINGS: AgentSettings = {
  active_hours: { start: 7, end: 23 },
  active_days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  autonomy: 'balanced'
}

const SETTINGS_FILE = 'settings.json'

export async function readSettings(dataDir: string): Promise<AgentSettings> {
  const path = join(dataDir, SETTINGS_FILE)
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS }
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw)
    return {
      active_hours: { ...DEFAULT_SETTINGS.active_hours, ...parsed.active_hours },
      active_days: parsed.active_days ?? DEFAULT_SETTINGS.active_days,
      autonomy: parsed.autonomy ?? DEFAULT_SETTINGS.autonomy
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function writeSettings(dataDir: string, patch: Partial<AgentSettings>): Promise<AgentSettings> {
  await mkdir(dataDir, { recursive: true }).catch(() => {})
  const current = await readSettings(dataDir)
  const updated: AgentSettings = {
    active_hours: { ...current.active_hours, ...patch.active_hours },
    active_days: patch.active_days ?? current.active_days,
    autonomy: patch.autonomy ?? current.autonomy
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

**Step 4: Run test to verify it passes**

```bash
cd packages/agent-core && npx vitest run src/settings.test.ts
```
Expected: all 6 tests PASS

**Step 5: Commit**

```bash
git add packages/agent-core/src/settings.ts packages/agent-core/src/settings.test.ts
git commit -m "feat: add settings module with active hours, active days, and autonomy level"
```

---

### Task 2: Wire settings into the scheduler

**Files:**
- Modify: `packages/agent-core/src/scheduler.ts`

The scheduler currently fires heartbeats every hour unconditionally (besides the events/todos check). We need it to also check `isActiveNow` before firing.

**Step 1: Read the current scheduler**

```typescript
// Current packages/agent-core/src/scheduler.ts (for reference)
import cron from 'node-cron'
import type { Agent } from './agent.js'
import { hasUnreadEvents, purgeEventStore } from './relay-client.js'

export function startScheduler(agent: Agent, dataDir: string): void {
  cron.schedule('0 3 * * *', () => {
    agent.handleTrigger({ source: 'memory_cleanup' })
  })

  cron.schedule('0 * * * *', async () => {
    await purgeEventStore(dataDir).catch(...)
    const hasEvents = await hasUnreadEvents(dataDir).catch(() => false)
    const due = agent.todos.getDue()
    if (!hasEvents && due.length === 0) {
      console.log('[Scheduler] Nothing to do — skipping heartbeat')
      return
    }
    agent.handleTrigger({ source: 'heartbeat' })
  })
}
```

**Step 2: Update the scheduler to check active hours**

Replace the entire file content:

```typescript
import cron from 'node-cron'
import type { Agent } from './agent.js'
import { hasUnreadEvents, purgeEventStore } from './relay-client.js'
import { readSettings, isActiveNow } from './settings.js'

export function startScheduler(agent: Agent, dataDir: string): void {
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
}
```

**Step 3: Verify TypeScript compiles**

```bash
cd packages/agent-core && npx tsc --noEmit
```
Expected: no errors

**Step 4: Run existing tests to confirm nothing broke**

```bash
cd packages/agent-core && npx vitest run
```
Expected: all tests PASS

**Step 5: Commit**

```bash
git add packages/agent-core/src/scheduler.ts
git commit -m "feat: scheduler respects active hours and active days settings"
```

---

### Task 3: Add `update_settings` tool to the agent + inject settings into system prompt

**Files:**
- Modify: `packages/agent-core/src/agent.ts`

This task has two parts:
1. Add an `update_settings` entry to `INTERNAL_TOOLS`
2. Handle the tool call in `runLoop`
3. Read settings at the top of `buildSystemPrompt` and inject a plain-language description of current config

**Step 1: Add the tool definition**

In `agent.ts`, find the `INTERNAL_TOOLS` array (line ~17). Add this entry at the end of the array, before the closing `]`:

```typescript
  {
    name: 'update_settings',
    description: 'Update your operational settings. Use when the user asks to change your schedule or how autonomously you act. Confirm the change in plain language after updating.',
    input_schema: {
      type: 'object' as const,
      properties: {
        active_hours: {
          type: 'object',
          description: 'Hour range (0–23) when heartbeats fire. E.g. { start: 8, end: 22 } = 8am to 10pm.',
          properties: {
            start: { type: 'number' },
            end: { type: 'number' }
          }
        },
        active_days: {
          type: 'array',
          items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
          description: 'Days of the week when heartbeats fire.'
        },
        autonomy: {
          type: 'string',
          enum: ['ask_first', 'balanced', 'autonomous'],
          description: 'ask_first = queue almost everything. balanced = act on routine tasks, queue anything that contacts someone or edits data. autonomous = act on most things, only queue permanent destructive actions.'
        }
      }
    }
  }
```

**Step 2: Handle the tool call in `runLoop`**

In `runLoop`, find the big `if/else if` chain that handles tool calls (around line 428). Add this branch before the final `else`:

```typescript
} else if (block.name === 'update_settings') {
  const patch = block.input as Partial<import('./settings.js').AgentSettings>
  await writeSettings(this.dataDir, patch)
  result = 'Settings updated.'
```

Also add the import at the top of `agent.ts`:

```typescript
import { readSettings, writeSettings, isActiveNow } from './settings.js'
import type { AgentSettings } from './settings.js'
```

**Step 3: Inject settings into the system prompt**

`buildSystemPrompt` is currently a sync function that takes `(connectedServices, agentProfilePath)`. We need to pass in the current settings so it can include them in the prompt.

Change the signature to accept settings as a third parameter:

```typescript
function buildSystemPrompt(
  connectedServices: string[],
  agentProfilePath: string,
  settings: AgentSettings
): string {
```

Add this block near the top of the returned string, after the `serviceSection`:

```typescript
const AUTONOMY_DESCRIPTIONS: Record<string, string> = {
  ask_first: 'Queue almost everything for approval — only truly mechanical lookups happen automatically.',
  balanced: 'Act on clearly routine or read-only things. Queue anything that sends a message, edits data, or contacts someone.',
  autonomous: 'Act on most things. Only queue permanent or destructive actions (deleting data, sending emails to third parties).'
}

const settingsSection = `
Current settings (configured by you via update_settings):
- Active hours: ${settings.active_hours.start}:00–${settings.active_hours.end}:00
- Active days: ${settings.active_days.join(', ')}
- Autonomy: ${settings.autonomy} — ${AUTONOMY_DESCRIPTIONS[settings.autonomy]}
`
```

Then include `settingsSection` in the returned template string, after `serviceSection`:

```typescript
return `You are CoAgent — ...

${serviceSection}

${settingsSection}

How to use external tools:
...`
```

**Step 4: Update the call site in `runLoop`**

Find where `buildSystemPrompt` is called in `runLoop` (around line 327). Change it to:

```typescript
const settings = await readSettings(this.dataDir)
const systemPrompt = buildSystemPrompt(connectedServices, this.agentProfilePath, settings)
```

**Step 5: Verify TypeScript compiles**

```bash
cd packages/agent-core && npx tsc --noEmit
```
Expected: no errors

**Step 6: Run all tests**

```bash
cd packages/agent-core && npx vitest run
```
Expected: all tests PASS

**Step 7: Commit**

```bash
git add packages/agent-core/src/agent.ts
git commit -m "feat: add update_settings tool and inject current settings into system prompt"
```

---

### Task 4: Manual smoke test

**Step 1: Restart the server**

```bash
pkill -f "tsx src/server.ts" 2>/dev/null; sleep 1
cd packages/agent-core && npm run dev &
sleep 3
```

**Step 2: Verify settings.json is created with defaults**

```bash
cat ~/.coagent/settings.json
```
Expected:
```json
{
  "active_hours": { "start": 7, "end": 23 },
  "active_days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
  "autonomy": "balanced"
}
```

Note: the file is created on first `update_settings` call, not on startup. If it doesn't exist yet, that's fine — defaults are returned.

**Step 3: In the desktop app chat, say:**

> "Don't run overnight — stop checking after 10pm"

Expected: agent calls `update_settings({ active_hours: { end: 22 } })`, confirms in plain language, and `~/.coagent/settings.json` now shows `"end": 22`.

**Step 4: Say:**

> "Switch to ask first mode"

Expected: agent calls `update_settings({ autonomy: "ask_first" })` and confirms.

**Step 5: Final commit if smoke test passes**

```bash
git add -A && git commit -m "chore: verified agent settings smoke test"
```
