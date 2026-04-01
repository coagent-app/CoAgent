# Team Message Context System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give agents hybrid context (recent + semantic) when processing team messages, on a separate conversation thread using Haiku.

**Architecture:** Extend TeamLog with LanceDB embeddings for semantic search. Add `teamChat()` to Agent with its own conversation history. Wire up context assembly in server.ts's `onTaggedMessage` callback.

**Tech Stack:** LanceDB, text-embedding-3-small (512 dims) via relay, TypeScript/CommonJS

---

### Task 1: Add LanceDB dependency to team-core

**Files:**
- Modify: `packages/team-core/package.json`

**Step 1: Add @lancedb/lancedb dependency**

In `packages/team-core/package.json`, add to `dependencies`:

```json
"@lancedb/lancedb": "^0.13.0"
```

**Step 2: Install**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && pnpm install`
Expected: Clean install, no errors

**Step 3: Commit**

```bash
git add packages/team-core/package.json pnpm-lock.yaml
git commit -m "feat(team-core): add lancedb dependency for team embeddings"
```

---

### Task 2: Add embedding + search to TeamLog

**Files:**
- Modify: `packages/team-core/src/team-log.ts`

**Context:** The existing `TeamLog` class stores messages in `team-log.json`. We're adding a LanceDB table at `{dataDir}/team-embeddings/` that embeds each message's `visible + agentContext` on append, plus methods to retrieve recent messages (channel-filtered) and semantic search results.

The embedding logic should match `packages/mcp-memory/src/memory-store.ts` — same model, same dims, same relay endpoint pattern. Key reference: `MemoryStore.embed()` at line 345 and `MemoryStore.searchMemory()` at line 229.

**Step 1: Add embedding infrastructure to TeamLog**

Replace the contents of `packages/team-core/src/team-log.ts` with:

```typescript
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { connect, Table } from '@lancedb/lancedb'
import type { TeamMessage } from '@coagent/shared'

const EMBED_MODEL = 'text-embedding-3-small'
const EMBED_DIM = 512

export interface TeamSearchResult {
  id: string
  from: string
  timestamp: string
  content: string
  score: number
}

export class TeamLog {
  private logPath: string
  private messagesDir: string
  private dbDir: string
  private relayUrl: string | null
  private relayToken: string | null
  private db: Awaited<ReturnType<typeof connect>> | null = null
  private table: Table | null = null

  constructor(dataDir: string, relayUrl?: string, relayToken?: string) {
    this.logPath = join(dataDir, 'team-log.json')
    this.messagesDir = join(dataDir, 'team-messages')
    this.dbDir = join(dataDir, 'team-embeddings')
    this.relayUrl = relayUrl?.replace(/\/$/, '') || null
    this.relayToken = relayToken || null
  }

  async init(): Promise<void> {
    await mkdir(this.messagesDir, { recursive: true })
    if (!existsSync(this.logPath)) {
      await writeFile(this.logPath, '[]', 'utf-8')
    }

    // Initialize LanceDB for embeddings
    try {
      await mkdir(this.dbDir, { recursive: true })
      this.db = await connect(this.dbDir)
      const tables = await this.db.tableNames()
      if (tables.includes('team_messages')) {
        this.table = await this.db.openTable('team_messages')
      } else {
        this.table = await this.db.createTable('team_messages', [
          { id: '', fromUserId: '', fromName: '', timestamp: '', to: '', content: '', vector: new Array(EMBED_DIM).fill(0) }
        ])
      }
    } catch (err) {
      console.warn('[TeamLog] Failed to init embeddings, semantic search disabled:', err)
    }
  }

  async append(message: TeamMessage): Promise<void> {
    // Always write to JSON log
    const log = await this.readLog()
    log.push(message)
    await writeFile(this.logPath, JSON.stringify(log, null, 2), 'utf-8')

    // Embed in background — don't block on failure
    this.embedMessage(message).catch(err => {
      console.warn('[TeamLog] Failed to embed message:', err)
    })
  }

  async readLog(): Promise<TeamMessage[]> {
    if (!existsSync(this.logPath)) return []
    const raw = await readFile(this.logPath, 'utf-8')
    try { return JSON.parse(raw) } catch { return [] }
  }

  async clearLog(): Promise<void> {
    await writeFile(this.logPath, '[]', 'utf-8')
  }

  /**
   * Get the last N messages, optionally filtered by channel.
   * - broadcast: true → only messages with to=null
   * - dmWith: "brian-agent" → messages between me and that agent
   */
  async getRecentMessages(n: number, filter?: { broadcast?: boolean; dmWith?: string; myUserId?: string }): Promise<TeamMessage[]> {
    const log = await this.readLog()
    let filtered = log

    if (filter?.broadcast) {
      filtered = log.filter(m => !m.to)
    } else if (filter?.dmWith && filter?.myUserId) {
      const dmId = filter.dmWith
      const dmBase = dmId.replace('-agent', '')
      const myId = filter.myUserId
      filtered = log.filter(m => {
        if (!m.to) return false
        const targets = Array.isArray(m.to) ? m.to : [m.to]
        const fromMe = m.from.userId === myId
        const fromThem = m.from.userId === dmBase || m.from.userId === dmId
        const toMe = targets.some(t => t === myId || t === `${myId}-agent`)
        const toThem = targets.some(t => t === dmId || t === dmBase)
        return (fromMe && toThem) || (fromThem && toMe)
      })
    }

    return filtered.slice(-n)
  }

  /**
   * Semantic search over embedded team messages.
   * Returns top-K results ranked by relevance, excluding messages with IDs in `excludeIds`.
   */
  async searchMessages(query: string, topK: number = 5, excludeIds?: Set<string>): Promise<TeamSearchResult[]> {
    if (!this.table) return []

    try {
      const vector = await this.embed(query)
      const results = await this.table
        .vectorSearch(vector)
        .limit(topK + (excludeIds?.size || 0))
        .toArray()

      return results
        .filter(r => r.id && r.content)
        .filter(r => !excludeIds?.has(r.id as string))
        .filter(r => (r._distance as number ?? 999) < 1.5)
        .slice(0, topK)
        .map(r => ({
          id: r.id as string,
          from: r.fromName as string,
          timestamp: r.timestamp as string,
          content: r.content as string,
          score: r._distance as number
        }))
    } catch (err) {
      console.warn('[TeamLog] Semantic search failed:', err)
      return []
    }
  }

  private async embedMessage(message: TeamMessage): Promise<void> {
    if (!this.table) return

    const content = [message.visible, message.agentContext].filter(Boolean).join('\n')
    if (content.trim().length < 10) return

    const vector = await this.embed(content)
    const toStr = message.to ? (Array.isArray(message.to) ? message.to.join(',') : message.to) : ''

    await this.table.add([{
      id: message.id,
      fromUserId: message.from.userId,
      fromName: message.from.name,
      timestamp: message.timestamp,
      to: toStr,
      content,
      vector
    }])
  }

  private async embed(text: string): Promise<number[]> {
    const embedUrl = this.relayUrl ? `${this.relayUrl}/v1/embeddings` : null
    if (!embedUrl) {
      // Fallback: deterministic hash-based mock
      return new Array(EMBED_DIM).fill(0).map((_, i) => (text.charCodeAt(i % text.length) / 255))
    }

    const res = await fetch(embedUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.relayToken ?? ''}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ input: [text], model: EMBED_MODEL, dimensions: EMBED_DIM })
    })

    if (!res.ok) {
      throw new Error(`Embedding failed: ${await res.text()}`)
    }

    const json = await res.json() as { data: { embedding: number[] }[] }
    return json.data[0].embedding
  }
}
```

**Step 2: Update TeamLog constructor call in TeamClient**

In `packages/team-core/src/team-client.ts:28`, the constructor creates a TeamLog. Update it to pass relay config:

```typescript
// Before:
this.teamLog = new TeamLog(options.dataDir)

// After:
this.teamLog = new TeamLog(options.dataDir, options.relayUrl, options.relayToken)
```

**Step 3: Build and verify**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && npx tsc --project packages/team-core/tsconfig.json`
Expected: Clean compile, no errors

**Step 4: Commit**

```bash
git add packages/team-core/src/team-log.ts packages/team-core/src/team-client.ts
git commit -m "feat(team-core): add LanceDB embeddings to TeamLog with semantic search"
```

---

### Task 3: Add `teamChat()` to Agent

**Files:**
- Modify: `packages/agent-core/src/agent.ts`

**Context:** The `Agent` class at line 615 has `conversationHistory` (personal chat), `historyPath` (saves to `conversation.json`), and `chat()` at line 802. We need a parallel system for team messages: `teamConversationHistory`, `teamHistoryPath` (saves to `team-history.json`), and a `teamChat()` method.

The key differences from `chat()`:
- Uses Haiku model (same as heartbeat, line 879)
- Has its own conversation history (doesn't touch personal)
- Takes a pre-assembled context block
- Has a team-specific system prompt (roster, role, team instructions)
- Still accesses all the same tools via the shared `mcpManager`

**Step 1: Add team history fields to Agent constructor**

After line 679 (`this.historyPath = join(dataDir, 'conversation.json')`), add:

```typescript
    this.teamHistoryPath = join(dataDir, 'team-history.json')
```

Add the field declarations near line 621 (after `conversationHistory`):

```typescript
  private teamConversationHistory: Anthropic.MessageParam[] = []
  private teamHistoryPath: string
  private teamRunLoopPromise: Promise<string> | null = null
```

Load team history in constructor after line 682 (`this.loadHistory().catch(console.error)`):

```typescript
    this.loadTeamHistory().catch(console.error)
```

Add the load/save methods near `loadHistory()` (after line 714):

```typescript
  private async loadTeamHistory(): Promise<void> {
    try {
      const raw = await readFile(this.teamHistoryPath, 'utf-8')
      this.teamConversationHistory = JSON.parse(raw)
      console.log(`[Agent] Loaded ${this.teamConversationHistory.length} team messages from history`)
    } catch {
      this.teamConversationHistory = []
    }
  }

  private async saveTeamHistory(): Promise<void> {
    const trimmed = this.teamConversationHistory.slice(-100)
    await writeFile(this.teamHistoryPath, JSON.stringify(trimmed), 'utf-8')
  }
```

**Step 2: Add `teamChat()` method**

Add after the `chat()` method (after line 844):

```typescript
  async teamChat(
    message: string,
    teamContext: string,
    onChunk?: (text: string) => void,
    onToolCall?: (tool: string, label: string) => void
  ): Promise<string> {
    // Build the user message with context
    const fullMessage = teamContext
      ? `${teamContext}\n\n---\n\n${message}`
      : message

    this.teamConversationHistory.push({ role: 'user', content: fullMessage })

    const prev = this.teamRunLoopPromise ?? Promise.resolve('')
    const next: Promise<string> = prev.catch(() => '').then(() => this.runLoop(onChunk, 'team', onToolCall))
    this.teamRunLoopPromise = next
    try {
      return await next
    } finally {
      if (this.teamRunLoopPromise === next) this.teamRunLoopPromise = null
    }
  }
```

**Step 3: Add `'team'` to `ToolContext` and wire up model selection**

At line 480, update the ToolContext type:

```typescript
// Before:
type ToolContext = 'heartbeat' | 'chat' | 'webhook'

// After:
type ToolContext = 'heartbeat' | 'chat' | 'webhook' | 'team'
```

At line 880, update model selection in `runLoop()`:

```typescript
// Before:
const currentModel = context === 'heartbeat' ? HAIKU : settings.powerModel

// After:
const currentModel = (context === 'heartbeat' || context === 'team') ? HAIKU : settings.powerModel
```

**Step 4: Use team history when context is `'team'`**

In `runLoop()`, the conversation history is accessed via `this.conversationHistory`. We need to switch to team history when context is `'team'`.

Near the start of `runLoop()` (after line 850), add a helper:

```typescript
    const history = context === 'team' ? this.teamConversationHistory : this.conversationHistory
    const saveHistory = context === 'team'
      ? () => this.saveTeamHistory()
      : () => this.saveHistory()
```

Then find every reference to `this.conversationHistory` inside `runLoop()` and replace with `history`, and every call to `this.saveHistory()` and replace with `saveHistory()`. There will be several — the agent pushes assistant messages, tool results, etc. into the history array during the loop.

**Step 5: Build and verify**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && npx tsc --project packages/agent-core/tsconfig.json`
Expected: Clean compile

**Step 6: Commit**

```bash
git add packages/agent-core/src/agent.ts
git commit -m "feat(agent): add teamChat() with separate history and Haiku model"
```

---

### Task 4: Wire up context assembly in server.ts

**Files:**
- Modify: `packages/agent-core/src/server.ts:985-993`

**Context:** The `onTaggedMessage` callback at line 985 currently calls `agent.chat()` with a flat string. We need to:
1. Get recent messages from the TeamLog (channel-filtered)
2. Get semantic matches from the TeamLog
3. Assemble a context block
4. Call `agent.teamChat()` instead of `agent.chat()`

The TeamLog is accessible via `teamClient.getTeamLog()` (defined at line 55 of team-client.ts).

**Step 1: Replace the onTaggedMessage callback**

Replace lines 985-993 in `packages/agent-core/src/server.ts`:

```typescript
      onTaggedMessage: async (message) => {
        const teamPrompt = `[TEAM MESSAGE from ${message.from.name} (${message.from.role})]\n${message.visible}\n\n[Agent Context]: ${message.agentContext}\n\nRespond to this team message. Use the send_team_message tool to reply in the team channel.`
        try {
          const response = await agent.chat(teamPrompt, (text) => broadcast({ type: 'chat_chunk', text }), (tool, label) => broadcast({ type: 'tool_start', tool, label } as any))
          broadcast({ type: 'chat_response', message: { role: 'assistant', content: response, timestamp: new Date().toISOString() } })
        } catch (err) {
          console.warn('[Team] Failed to process tagged message:', err)
        }
      },
```

With:

```typescript
      onTaggedMessage: async (message) => {
        try {
          const log = teamClient!.getTeamLog()
          const myUserId = process.env.RELAY_USER_ID || ''

          // Determine channel filter
          const isDm = message.to !== null
          const filter = isDm
            ? { dmWith: message.from.userId + (message.from.isAgent ? '' : '-agent'), myUserId }
            : { broadcast: true }

          // 1. Recent messages (same channel)
          const recent = await log.getRecentMessages(5, filter)
          const recentIds = new Set(recent.map(m => m.id))
          recentIds.add(message.id) // exclude the incoming message itself

          // 2. Semantic search (all messages you've seen)
          const semantic = await log.searchMessages(message.visible, 5, recentIds)

          // 3. Assemble context
          const parts: string[] = []

          if (recent.length > 0) {
            const recentLines = recent.map(m => {
              const ago = timeAgo(m.timestamp)
              const sender = m.from.isAgent ? `${m.from.name}'s Agent` : m.from.name
              return `- ${sender} (${ago}): "${m.visible}"`
            })
            parts.push(`[Recent team messages]\n${recentLines.join('\n')}`)
          }

          if (semantic.length > 0) {
            const semanticLines = semantic.map(r => {
              const ago = timeAgo(r.timestamp)
              return `- ${r.from} (${ago}): "${r.content.slice(0, 200)}"`
            })
            parts.push(`[Relevant older context]\n${semanticLines.join('\n')}`)
          }

          const teamContext = parts.length > 0 ? parts.join('\n\n') : ''

          const teamPrompt = `[TEAM MESSAGE from ${message.from.name} (${message.from.role})]\n${message.visible}${message.agentContext ? `\n\n[Agent Context]: ${message.agentContext}` : ''}\n\nRespond to this team message. Use the send_team_message tool to reply.`

          const response = await agent.teamChat(teamPrompt, teamContext, (text) => broadcast({ type: 'chat_chunk', text }), (tool, label) => broadcast({ type: 'tool_start', tool, label } as any))
          broadcast({ type: 'chat_response', message: { role: 'assistant', content: response, timestamp: new Date().toISOString() } })
        } catch (err) {
          console.warn('[Team] Failed to process tagged message:', err)
        }
      },
```

**Step 2: Add the `timeAgo` helper**

Add this helper function near the top of `server.ts` (after the imports):

```typescript
function timeAgo(isoTimestamp: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}
```

**Step 3: Build and verify**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && npx tsc --project packages/agent-core/tsconfig.json`
Expected: Clean compile

**Step 4: Commit**

```bash
git add packages/agent-core/src/server.ts
git commit -m "feat(server): wire up hybrid context assembly for team messages"
```

---

### Task 5: Rebuild, restart, and verify end-to-end

**Files:** None (testing only)

**Step 1: Rebuild team-core**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && npx tsc --project packages/team-core/tsconfig.json`
Expected: Clean compile

**Step 2: Rebuild agent-core**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && npx tsc --project packages/agent-core/tsconfig.json`
Expected: Clean compile

**Step 3: Restart Brian's agent**

```bash
# Find and kill Brian's agent
lsof -i :7831 -t | xargs kill 2>/dev/null
sleep 1
# Restart
COAGENT_DATA_DIR="$HOME/.coagent-brian" COAGENT_PORT=7831 node packages/agent-core/dist/server.js &
```

Wait for: `[Team] Connected to team "Brett Team" with 2 members`

**Step 4: Verify embeddings directory created**

Run: `ls ~/.coagent-brian/team-embeddings/`
Expected: `team_messages.lance/` directory exists

**Step 5: Send a test message from the Team pane**

In the app, go to the Team pane, select Brian's Agent DM, and send:
"What's the name of Brian's dog?"

Expected:
- Message appears in the DM channel (no duplicates)
- Brian's agent processes via `teamChat()` with Haiku
- Brian's agent searches memory, finds `test-recall.md`
- Brian's agent responds with "Biscuit"
- Response appears in the DM channel with markdown rendering

**Step 6: Verify team history separation**

Run: `cat ~/.coagent-brian/team-history.json | python3 -m json.tool | head -20`
Expected: Team conversation history exists, separate from `conversation.json`

**Step 7: Commit any fixes**

If any adjustments were needed during testing, commit them.
