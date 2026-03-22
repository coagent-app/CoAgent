# Activity Tray Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show a real-time activity tray below the chat that reveals what the agent is doing, lets the user stop it, and lets them queue a correction mid-run.

**Architecture:** Backend emits `tool_start`/`tool_end` WS events and handles a new `stop_agent` message via an abort flag on the Agent class. Frontend tracks a live step list, renders a slim tray above the input bar, and expands into a popup on click. Queued corrections are held client-side and sent automatically on `chat_response`.

**Tech Stack:** TypeScript, React, Tailwind, Lucide icons, `@coagent/shared` WS types, `packages/agent-core` Agent class

---

### Task 1: Add WS types to shared package

**Files:**
- Modify: `packages/shared/src/index.ts`

**Step 1: Add new message types**

Add to `WSClientMessage`:
```typescript
| { type: 'stop_agent' }
```

Add to `WSServerMessage`:
```typescript
| { type: 'tool_start'; tool: string; label: string }
| { type: 'tool_end'; tool: string }
| { type: 'agent_stopped' }
```

**Step 2: Build shared**
```bash
cd packages/shared && npm run build
```
Expected: no errors, `dist/` updated.

**Step 3: Commit**
```bash
git add packages/shared/src/index.ts packages/shared/dist
git commit -m "feat: add tool_start/tool_end/stop_agent WS types"
```

---

### Task 2: Add friendly label mapper to agent-core

**Files:**
- Create: `packages/agent-core/src/tool-labels.ts`

**Step 1: Create the file**

```typescript
const OVERRIDES: Record<string, string> = {
  search_tools:    'Searching available tools',
  read_memory:     'Reading memory',
  write_memory:    'Saving to memory',
  search_memory:   'Searching memory',
  list_memories:   'Listing memories',
  queue_approval:  'Queuing for approval',
  add_done_item:   'Recording completed action',
  add_todo:        'Adding to-do',
  complete_todo:   'Completing to-do',
  get_rental_estimate: 'Getting rental estimate',
  get_market_data:     'Fetching market data',
}

export function toolLabel(name: string): string {
  if (OVERRIDES[name]) return OVERRIDES[name]
  // Composio tools: GMAIL_SEND_EMAIL → "Sending email via Gmail"
  // General: some_tool_name → "Some tool name"
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}
```

**Step 2: Build to verify no errors**
```bash
cd packages/agent-core && npm run build
```
Expected: no errors.

**Step 3: Commit**
```bash
git add packages/agent-core/src/tool-labels.ts
git commit -m "feat: add tool label mapper"
```

---

### Task 3: Add abort flag + tool callbacks to Agent

**Files:**
- Modify: `packages/agent-core/src/agent.ts`

**Step 1: Add abort flag and callback types to Agent class**

Add to the class fields (after `private agentProfilePath`):
```typescript
private abortFlag = false
```

**Step 2: Add `onToolStart`/`onToolEnd` callback params to `chat()` and `runLoop()`**

Change `chat()` signature:
```typescript
async chat(
  message: string,
  onChunk?: (text: string) => void,
  onToolStart?: (tool: string, label: string) => void,
  onToolEnd?: (tool: string) => void
): Promise<string> {
  this.abortFlag = false
  this.conversationHistory.push({ role: 'user', content: message })
  return this.runLoop(onChunk, onToolStart, onToolEnd)
}
```

Change `runLoop()` signature:
```typescript
private async runLoop(
  onChunk?: (text: string) => void,
  onToolStart?: (tool: string, label: string) => void,
  onToolEnd?: (tool: string) => void
): Promise<string> {
```

**Step 3: Add abort check + fire callbacks around every tool call**

In `runLoop()`, at the top of the `tool_use` block (after `const toolResults`), add:
```typescript
if (this.abortFlag) {
  this.abortFlag = false
  finalText = 'Stopped.'
  break
}
```

Before each tool is executed (just before the `if (block.name === 'search_tools')` chain), add:
```typescript
const label = toolLabel(block.name)
onToolStart?.(block.name, label)
```

After `result` is assigned (just before the `toolResults.content.push(...)` call), add:
```typescript
onToolEnd?.(block.name)
```

Import `toolLabel` at the top of agent.ts:
```typescript
import { toolLabel } from './tool-labels.js'
```

**Step 4: Add `stop()` method to Agent**
```typescript
stop(): void {
  this.abortFlag = true
}
```

**Step 5: Build**
```bash
cd packages/agent-core && npm run build
```
Expected: no errors.

**Step 6: Commit**
```bash
git add packages/agent-core/src/agent.ts packages/agent-core/src/tool-labels.ts
git commit -m "feat: add abort flag and tool lifecycle callbacks to Agent"
```

---

### Task 4: Wire tool events + stop through server.ts

**Files:**
- Modify: `packages/agent-core/src/server.ts`

**Step 1: Pass callbacks into `agent.chat()` call**

Find the `if (msg.type === 'chat')` block. Change:
```typescript
const response = await agent.chat(msg.message, (chunk) => {
  send(ws, { type: 'chat_chunk', text: chunk })
})
```
To:
```typescript
const response = await agent.chat(
  msg.message,
  (chunk) => send(ws, { type: 'chat_chunk', text: chunk }),
  (tool, label) => send(ws, { type: 'tool_start', tool, label }),
  (tool) => send(ws, { type: 'tool_end', tool })
)
```

**Step 2: Handle `stop_agent` message**

Add after the `delete_todo` handler:
```typescript
if (msg.type === 'stop_agent') {
  agent.stop()
  send(ws, { type: 'agent_stopped' })
}
```

**Step 3: Build**
```bash
cd packages/agent-core && npm run build
```
Expected: no errors.

**Step 4: Commit**
```bash
git add packages/agent-core/src/server.ts
git commit -m "feat: emit tool_start/tool_end events and handle stop_agent"
```

---

### Task 5: Add activity state to useAgent hook

**Files:**
- Modify: `apps/desktop/src/hooks/useAgent.ts`

**Step 1: Add step tracking state and correction queue**

Add new state after `integrations`:
```typescript
const [steps, setSteps] = useState<{ tool: string; label: string; done: boolean }[]>([])
const [pendingCorrection, setPendingCorrection] = useState<string | null>(null)
```

**Step 2: Handle new WS messages**

Add inside the `socket.onmessage` handler:
```typescript
if (msg.type === 'tool_start') {
  setSteps(prev => [...prev, { tool: msg.tool, label: msg.label, done: false }])
}
if (msg.type === 'tool_end') {
  setSteps(prev => prev.map(s => s.tool === msg.tool && !s.done ? { ...s, done: true } : s))
}
if (msg.type === 'agent_stopped') {
  setSteps([])
  setThinking(false)
  setStreamingText(null)
}
```

**Step 3: Clear steps on chat_response and send queued correction**

Find the `if (msg.type === 'chat_response')` block, add after the existing lines:
```typescript
setSteps([])
if (pendingCorrection) {
  const correction = pendingCorrection
  setPendingCorrection(null)
  socket.send(JSON.stringify({ type: 'chat', message: correction } as WSClientMessage))
}
```

**Note:** `pendingCorrection` is a ref issue here — useState is stale in closures. Use `useRef` instead:

Replace `useState<string | null>(null)` for pendingCorrection with:
```typescript
const pendingCorrectionRef = useRef<string | null>(null)
```

And update all references from `pendingCorrection` / `setPendingCorrection` to `pendingCorrectionRef.current` / `pendingCorrectionRef.current = ...`.

**Step 4: Add stop and queueCorrection callbacks**

```typescript
const stopAgent = useCallback(() => send({ type: 'stop_agent' }), [send])
const queueCorrection = useCallback((msg: string) => {
  pendingCorrectionRef.current = msg
}, [])
```

**Step 5: Export new values**

Add `steps`, `stopAgent`, `queueCorrection` to the return object.

**Step 6: Build desktop**
```bash
cd apps/desktop && npm run build
```
Expected: no TypeScript errors.

**Step 7: Commit**
```bash
git add apps/desktop/src/hooks/useAgent.ts
git commit -m "feat: track tool steps and correction queue in useAgent"
```

---

### Task 6: Build ActivityTray component

**Files:**
- Create: `apps/desktop/src/components/ActivityTray.tsx`

**Step 1: Create the component**

```tsx
import React, { useState } from 'react'
import { ChevronUp, ChevronDown, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'

interface Step {
  tool: string
  label: string
  done: boolean
}

interface ActivityTrayProps {
  steps: Step[]
  onStop: () => void
  onCorrection: (msg: string) => void
}

export function ActivityTray({ steps, onStop, onCorrection }: ActivityTrayProps) {
  const [expanded, setExpanded] = useState(false)
  const [correction, setCorrection] = useState('')

  if (steps.length === 0) return null

  const current = steps.filter(s => !s.done).at(-1) ?? steps.at(-1)!

  function handleCorrectionSubmit(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || !correction.trim()) return
    onCorrection(correction.trim())
    setCorrection('')
    setExpanded(false)
  }

  return (
    <div className="border-t border-neutral-100">
      {/* Tray bar */}
      <div className="flex items-center gap-2 px-7 py-2 bg-neutral-50 text-[12px] text-neutral-500">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
        <span className="flex-1 truncate">{current.label}{!current.done ? '…' : ''}</span>
        <button
          onClick={onStop}
          title="Stop agent"
          className="flex items-center gap-1 text-neutral-400 hover:text-red-500 transition-colors"
        >
          <Square size={11} fill="currentColor" />
          <span>Stop</span>
        </button>
        <button
          onClick={() => setExpanded(v => !v)}
          className="text-neutral-400 hover:text-neutral-600 transition-colors ml-1"
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
      </div>

      {/* Expanded popup */}
      {expanded && (
        <div className="px-7 pb-3 bg-neutral-50 border-t border-neutral-100">
          <div className="flex flex-col gap-1 py-2 max-h-48 overflow-y-auto">
            {steps.map((step, i) => (
              <div key={i} className="flex items-center gap-2 text-[12px]">
                <span className={cn(
                  'flex-shrink-0 w-3.5 text-center',
                  step.done ? 'text-emerald-500' : 'text-blue-400'
                )}>
                  {step.done ? '✓' : '⟳'}
                </span>
                <span className={cn(
                  step.done ? 'text-neutral-400' : 'text-neutral-700 font-medium'
                )}>
                  {step.label}
                </span>
              </div>
            ))}
          </div>
          <Input
            className="text-[12px] h-7 mt-1"
            placeholder="Correction (queued for next turn)…"
            value={correction}
            onChange={e => setCorrection(e.target.value)}
            onKeyDown={handleCorrectionSubmit}
          />
        </div>
      )}
    </div>
  )
}
```

**Step 2: Build to check for errors**
```bash
cd apps/desktop && npm run build
```
Expected: no errors.

**Step 3: Commit**
```bash
git add apps/desktop/src/components/ActivityTray.tsx
git commit -m "feat: add ActivityTray component"
```

---

### Task 7: Wire ActivityTray into ChatPane and App

**Files:**
- Modify: `apps/desktop/src/components/ChatPane.tsx`
- Modify: `apps/desktop/src/App.tsx`

**Step 1: Update ChatPane props**

Add to `ChatPaneProps`:
```typescript
steps: { tool: string; label: string; done: boolean }[]
onStop: () => void
onCorrection: (msg: string) => void
```

**Step 2: Import and render ActivityTray in ChatPane**

Add import:
```tsx
import { ActivityTray } from './ActivityTray'
```

Replace the existing `border-t` input bar wrapper. The tray goes between the `ScrollArea` and the input bar:
```tsx
<ActivityTray steps={steps} onStop={onStop} onCorrection={onCorrection} />

<div className="px-7 py-4 border-t border-neutral-100 flex gap-2.5 items-center">
  ...
</div>
```

**Step 3: Update App.tsx to pass new props**

In `App.tsx`, destructure new values from `useAgent`:
```typescript
const { ..., steps, stopAgent, queueCorrection } = useAgent()
```

Pass them to `ChatPane`:
```tsx
<ChatPane
  messages={messages}
  streamingText={streamingText}
  thinking={thinking}
  connected={connected}
  onChat={chat}
  steps={steps}
  onStop={stopAgent}
  onCorrection={queueCorrection}
/>
```

**Step 4: Build**
```bash
cd apps/desktop && npm run build
```
Expected: no TypeScript errors.

**Step 5: Manual test**
- Start server: `cd packages/agent-core && npm run dev`
- Start frontend: `cd apps/desktop && npm run dev`
- Send a message that triggers tool use (e.g. "What's the rental estimate for 1000 Brickell Ave?")
- Verify: tray appears with animated label
- Click chevron: popup opens, steps accumulate with ✓ and ⟳
- Click Stop: agent stops, tray disappears
- Type correction + Enter: correction queued, sent after next response

**Step 6: Commit**
```bash
git add apps/desktop/src/components/ChatPane.tsx apps/desktop/src/App.tsx
git commit -m "feat: wire ActivityTray into ChatPane — transparent agent activity"
```
