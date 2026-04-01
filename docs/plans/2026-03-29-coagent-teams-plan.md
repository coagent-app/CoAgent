# CoAgent Teams Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add agent-to-agent team communication — a team channel where agents share info on behalf of their users, with dual tagging (@user for notifications, @user-agent for AI processing).

**Architecture:** Extend the Cloudflare relay with a TeamChannel Durable Object for message fan-out. Create `packages/team-core` for client-side team logic. Add TeamPane to the desktop app. Each member's machine keeps a full local vector copy of team messages.

**Tech Stack:** Cloudflare Workers + Durable Objects (relay), TypeScript/Node (team-core), React (TeamPane), LanceDB (local team vector DB), WebSocket (real-time messaging)

**Design Doc:** `docs/plans/2026-03-29-coagent-teams-design.md`

---

## Task 1: Add Team Types to Shared Package

**Files:**
- Modify: `packages/shared/src/index.ts`

**Step 1: Add team-related types**

Add these types after the existing type definitions (after line ~272):

```typescript
// ---------------------------------------------------------------------------
// Team types
// ---------------------------------------------------------------------------

export interface TeamMember {
  userId: string
  name: string
  role: string
  handles: string
}

export interface TeamInfo {
  teamId: string
  name: string
  ownerId: string
  created: string
  members: TeamMember[]
}

export interface TeamMessage {
  id: string
  teamId: string
  timestamp: string
  from: {
    userId: string
    name: string
    role: string
    isAgent: boolean
  }
  visible: string
  agentContext: string
  to: string | string[] | null
  attachments: string[]
}
```

**Step 2: Add team WSClientMessage types**

Add to the `WSClientMessage` union type:

```typescript
| { type: 'team_send'; message: string; agentContext?: string; to?: string | string[] | null }
| { type: 'team_history'; limit?: number }
| { type: 'get_team_info' }
| { type: 'team_create'; name: string; memberName: string; memberRole: string; memberHandles: string }
| { type: 'team_join'; inviteCode: string; memberName: string; memberRole: string; memberHandles: string }
| { type: 'team_leave' }
| { type: 'team_invite' }
```

**Step 3: Add team WSServerMessage types**

Add to the `WSServerMessage` union type:

```typescript
| { type: 'team_message'; message: TeamMessage }
| { type: 'team_history'; messages: TeamMessage[] }
| { type: 'team_info'; team: TeamInfo | null }
| { type: 'team_created'; teamId: string; inviteCode: string }
| { type: 'team_joined'; team: TeamInfo }
| { type: 'team_invite_code'; code: string }
| { type: 'team_error'; error: string }
```

**Step 4: Build and verify**

Run: `cd packages/shared && pnpm build`
Expected: No errors

**Step 5: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(teams): add team types to shared package"
```

---

## Task 2: Add TeamChannel Durable Object to Relay

**Files:**
- Modify: `relay/src/index.ts`
- Modify: `relay/wrangler.toml`

**Step 1: Add TeamChannel Durable Object class**

Add before the `export default { fetch }` block. This is the core of team messaging:

```typescript
export class TeamChannel {
  private state: DurableObjectState
  private env: Env

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
    // Create messages table
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        from_user_id TEXT NOT NULL,
        from_name TEXT NOT NULL,
        from_role TEXT NOT NULL,
        is_agent INTEGER NOT NULL DEFAULT 1,
        visible TEXT NOT NULL,
        agent_context TEXT NOT NULL DEFAULT '',
        to_target TEXT,
        attachments TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `)
    // Offline queue per member
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS offline_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const userId = url.searchParams.get('userId') || 'unknown'
      const pair = new WebSocketPair()
      this.state.acceptWebSocket(pair[1], [userId])

      // Flush offline queue for this user
      const queued = this.state.storage.sql.exec(
        `SELECT message_json FROM offline_queue WHERE user_id = ? ORDER BY created_at ASC`,
        userId
      ).toArray()
      for (const row of queued) {
        pair[1].send(row.message_json as string)
      }
      this.state.storage.sql.exec(`DELETE FROM offline_queue WHERE user_id = ?`, userId)

      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    // POST /message — receive a message and fan out
    if (request.method === 'POST' && url.pathname === '/message') {
      const msg = await request.json() as any

      // Store in message history
      this.state.storage.sql.exec(
        `INSERT INTO messages (id, timestamp, from_user_id, from_name, from_role, is_agent, visible, agent_context, to_target, attachments)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        msg.id, msg.timestamp, msg.from.userId, msg.from.name, msg.from.role,
        msg.from.isAgent ? 1 : 0, msg.visible, msg.agentContext || '',
        JSON.stringify(msg.to), JSON.stringify(msg.attachments || [])
      )

      // Clean up old messages (keep last 500)
      this.state.storage.sql.exec(
        `DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY created_at DESC LIMIT 500)`
      )

      const msgJson = JSON.stringify({ type: 'team_message', message: msg })

      // Fan out to connected sockets
      const sockets = this.state.getWebSockets()
      const connectedUserIds = new Set<string>()
      for (const ws of sockets) {
        const tags = this.state.getTags(ws)
        const uid = tags[0] || 'unknown'
        connectedUserIds.add(uid)
        // Don't echo back to sender
        if (uid !== msg.from.userId) {
          ws.send(msgJson)
        }
      }

      // Queue for offline members
      const teamKey = url.searchParams.get('teamId')
      if (teamKey) {
        const membersJson = await this.env.TOKENS.get(`team:${teamKey}:members`)
        if (membersJson) {
          const members = JSON.parse(membersJson) as { userId: string }[]
          for (const member of members) {
            if (!connectedUserIds.has(member.userId) && member.userId !== msg.from.userId) {
              this.state.storage.sql.exec(
                `INSERT INTO offline_queue (user_id, message_json) VALUES (?, ?)`,
                member.userId, msgJson
              )
            }
          }
        }
      }

      return new Response('OK', { status: 200 })
    }

    // GET /history — return recent messages
    if (request.method === 'GET' && url.pathname === '/history') {
      const limit = parseInt(url.searchParams.get('limit') || '50')
      const rows = this.state.storage.sql.exec(
        `SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`, limit
      ).toArray()

      const messages = rows.reverse().map((r: any) => ({
        id: r.id,
        teamId: url.searchParams.get('teamId') || '',
        timestamp: r.timestamp,
        from: {
          userId: r.from_user_id,
          name: r.from_name,
          role: r.from_role,
          isAgent: r.is_agent === 1
        },
        visible: r.visible,
        agentContext: r.agent_context,
        to: JSON.parse(r.to_target || 'null'),
        attachments: JSON.parse(r.attachments)
      }))

      return new Response(JSON.stringify(messages), {
        headers: { 'Content-Type': 'application/json' }
      })
    }

    return new Response('Not found', { status: 404 })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Ping/keepalive
    if (message === 'ping') {
      ws.send('pong')
      return
    }
  }

  async webSocketClose(ws: WebSocket) {
    // Cleanup handled automatically
  }
}
```

**Step 2: Add team API endpoints to the main fetch handler**

Add these routes before the WebSocket upgrade block (around line 835):

```typescript
// Team: create
if (request.method === 'POST' && url.pathname === '/team/create') {
  const tokenData = await validateRequest(request, env)
  if (!tokenData) return new Response('Unauthorized', { status: 401, headers: corsHeaders() })
  const body = await request.json() as any
  const teamId = crypto.randomUUID().slice(0, 8)
  const inviteCode = `${body.name.replace(/\s+/g, '').slice(0, 5).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`

  await env.TOKENS.put(`team:${teamId}`, JSON.stringify({
    name: body.name, ownerId: body.userId, created: new Date().toISOString()
  }))
  await env.TOKENS.put(`team:${teamId}:members`, JSON.stringify([
    { userId: body.userId, name: body.memberName, role: body.memberRole, handles: body.memberHandles }
  ]))
  await env.TOKENS.put(`team:${teamId}:invite`, JSON.stringify({ code: inviteCode, expires: '' }))
  await env.TOKENS.put(`invite:${inviteCode}`, teamId)

  // Update token with teamId
  const token = request.headers.get('Authorization')?.replace('Bearer ', '') || request.headers.get('x-api-key') || ''
  const td = await getToken(env, token)
  if (td) {
    (td as any).teamId = teamId
    await saveToken(env, token, td)
  }

  return new Response(JSON.stringify({ teamId, inviteCode }), {
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
  })
}

// Team: join
if (request.method === 'POST' && url.pathname === '/team/join') {
  const tokenData = await validateRequest(request, env)
  if (!tokenData) return new Response('Unauthorized', { status: 401, headers: corsHeaders() })
  const body = await request.json() as any
  const teamId = await env.TOKENS.get(`invite:${body.inviteCode}`)
  if (!teamId) return new Response(JSON.stringify({ error: 'Invalid invite code' }), { status: 404, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } })

  const membersJson = await env.TOKENS.get(`team:${teamId}:members`)
  const members = membersJson ? JSON.parse(membersJson) : []
  if (!members.find((m: any) => m.userId === body.userId)) {
    members.push({ userId: body.userId, name: body.memberName, role: body.memberRole, handles: body.memberHandles })
    await env.TOKENS.put(`team:${teamId}:members`, JSON.stringify(members))
  }

  // Update token with teamId
  const token = request.headers.get('Authorization')?.replace('Bearer ', '') || request.headers.get('x-api-key') || ''
  const td = await getToken(env, token)
  if (td) {
    (td as any).teamId = teamId
    await saveToken(env, token, td)
  }

  const teamJson = await env.TOKENS.get(`team:${teamId}`)
  const team = teamJson ? JSON.parse(teamJson) : {}

  return new Response(JSON.stringify({ teamId, ...team, members }), {
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
  })
}

// Team: get roster
if (request.method === 'GET' && url.pathname === '/team/roster') {
  const tokenData = await validateRequest(request, env)
  if (!tokenData) return new Response('Unauthorized', { status: 401, headers: corsHeaders() })
  const teamId = (tokenData as any).teamId
  if (!teamId) return new Response(JSON.stringify({ team: null }), { headers: { ...corsHeaders(), 'Content-Type': 'application/json' } })

  const teamJson = await env.TOKENS.get(`team:${teamId}`)
  const membersJson = await env.TOKENS.get(`team:${teamId}:members`)
  const team = teamJson ? JSON.parse(teamJson) : null
  const members = membersJson ? JSON.parse(membersJson) : []

  return new Response(JSON.stringify({ teamId, ...team, members }), {
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
  })
}

// Team: generate invite
if (request.method === 'POST' && url.pathname === '/team/invite') {
  const tokenData = await validateRequest(request, env)
  if (!tokenData) return new Response('Unauthorized', { status: 401, headers: corsHeaders() })
  const teamId = (tokenData as any).teamId
  if (!teamId) return new Response('Not in a team', { status: 400, headers: corsHeaders() })

  const teamJson = await env.TOKENS.get(`team:${teamId}`)
  const team = teamJson ? JSON.parse(teamJson) : { name: 'team' }
  const code = `${team.name.replace(/\s+/g, '').slice(0, 5).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`
  await env.TOKENS.put(`invite:${code}`, teamId)

  return new Response(JSON.stringify({ code }), {
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
  })
}

// Team: WebSocket — connect to team channel
if (request.headers.get('Upgrade') === 'websocket' && url.pathname === '/team/ws') {
  const token = url.searchParams.get('token')
  if (!token) return new Response('Missing token', { status: 401 })
  const data = await getToken(env, token)
  if (!data || !data.active) return new Response('Invalid token', { status: 401 })
  const teamId = (data as any).teamId
  if (!teamId) return new Response('Not in a team', { status: 400 })

  const doId = env.TEAM_CHANNEL.idFromName(teamId)
  const stub = env.TEAM_CHANNEL.get(doId)
  const userId = url.searchParams.get('userId') || String(data.userId)
  const teamUrl = new URL(request.url)
  teamUrl.searchParams.set('userId', userId)
  teamUrl.searchParams.set('teamId', teamId)
  return stub.fetch(new Request(teamUrl.toString(), request))
}

// Team: POST message (REST fallback for sending from sidecar)
if (request.method === 'POST' && url.pathname === '/team/message') {
  const tokenData = await validateRequest(request, env)
  if (!tokenData) return new Response('Unauthorized', { status: 401, headers: corsHeaders() })
  const teamId = (tokenData as any).teamId
  if (!teamId) return new Response('Not in a team', { status: 400, headers: corsHeaders() })

  const msg = await request.json()
  const doId = env.TEAM_CHANNEL.idFromName(teamId)
  const stub = env.TEAM_CHANNEL.get(doId)
  const postUrl = new URL(`https://internal/message?teamId=${teamId}`)
  await stub.fetch(new Request(postUrl.toString(), {
    method: 'POST',
    body: JSON.stringify(msg),
    headers: { 'Content-Type': 'application/json' }
  }))

  return new Response('OK', { status: 200, headers: corsHeaders() })
}

// Team: GET history
if (request.method === 'GET' && url.pathname === '/team/history') {
  const tokenData = await validateRequest(request, env)
  if (!tokenData) return new Response('Unauthorized', { status: 401, headers: corsHeaders() })
  const teamId = (tokenData as any).teamId
  if (!teamId) return new Response('Not in a team', { status: 400, headers: corsHeaders() })

  const doId = env.TEAM_CHANNEL.idFromName(teamId)
  const stub = env.TEAM_CHANNEL.get(doId)
  const limit = url.searchParams.get('limit') || '50'
  const res = await stub.fetch(new Request(`https://internal/history?limit=${limit}&teamId=${teamId}`))
  const messages = await res.json()

  return new Response(JSON.stringify(messages), {
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
  })
}
```

**Step 3: Update Env interface**

Add the TEAM_CHANNEL binding:

```typescript
export interface Env {
  TUNNEL_SECRET: string
  ANTHROPIC_API_KEY: string
  OPENAI_API_KEY: string
  COMPOSIO_API_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  TOKENS: KVNamespace
  USER_SESSION: DurableObjectNamespace
  TEAM_CHANNEL: DurableObjectNamespace  // NEW
}
```

**Step 4: Update wrangler.toml**

Add the TeamChannel DO binding:

```toml
[[durable_objects.bindings]]
name = "TEAM_CHANNEL"
class_name = "TeamChannel"

[[migrations]]
tag = "v4"
new_sqlite_classes = ["TeamChannel"]
```

**Step 5: Deploy and test**

Run: `cd relay && wrangler deploy`
Test: `curl -H "Authorization: Bearer YOUR_TOKEN" https://coagent-relay.brettponters.workers.dev/team/roster`
Expected: `{"team":null}` (not in a team yet)

**Step 6: Commit**

```bash
git add relay/src/index.ts relay/wrangler.toml
git commit -m "feat(teams): add TeamChannel DO and team endpoints to relay"
```

---

## Task 3: Create `packages/team-core` Package

**Files:**
- Create: `packages/team-core/package.json`
- Create: `packages/team-core/tsconfig.json`
- Create: `packages/team-core/src/index.ts`
- Create: `packages/team-core/src/team-client.ts`
- Create: `packages/team-core/src/team-log.ts`

**Step 1: Create package.json**

```json
{
  "name": "@coagent/team-core",
  "version": "0.0.1",
  "main": "./src/index.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@coagent/shared": "workspace:*",
    "ws": "^8.0.0"
  },
  "devDependencies": {
    "@types/ws": "^8.0.0",
    "typescript": "^5.4.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

**Step 3: Create team-log.ts — local JSON log + team vector DB**

```typescript
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import type { TeamMessage } from '@coagent/shared'

export class TeamLog {
  private logPath: string
  private messagesDir: string

  constructor(dataDir: string) {
    this.logPath = join(dataDir, 'team-log.json')
    this.messagesDir = join(dataDir, 'team-messages')
  }

  async init(): Promise<void> {
    await mkdir(this.messagesDir, { recursive: true })
    if (!existsSync(this.logPath)) {
      await writeFile(this.logPath, '[]', 'utf-8')
    }
  }

  async append(message: TeamMessage): Promise<void> {
    const log = await this.readLog()
    log.push(message)
    await writeFile(this.logPath, JSON.stringify(log, null, 2), 'utf-8')
  }

  async readLog(): Promise<TeamMessage[]> {
    if (!existsSync(this.logPath)) return []
    const raw = await readFile(this.logPath, 'utf-8')
    try { return JSON.parse(raw) } catch { return [] }
  }

  async clearLog(): Promise<void> {
    await writeFile(this.logPath, '[]', 'utf-8')
  }
}
```

**Step 4: Create team-client.ts — WebSocket connection to team channel**

```typescript
import WebSocket from 'ws'
import type { TeamMessage, TeamMember } from '@coagent/shared'
import { TeamLog } from './team-log'

export interface TeamClientOptions {
  relayUrl: string
  relayToken: string
  userId: string
  dataDir: string
  onTaggedMessage?: (message: TeamMessage) => void
  onHumanNotify?: (message: TeamMessage) => void
}

export class TeamClient {
  private ws: WebSocket | null = null
  private options: TeamClientOptions
  private teamLog: TeamLog
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private backoffMs = 2000
  private stopped = false
  private roster: TeamMember[] = []
  public teamId: string | null = null
  public teamName: string | null = null

  constructor(options: TeamClientOptions) {
    this.options = options
    this.teamLog = new TeamLog(options.dataDir)
  }

  async init(): Promise<void> {
    await this.teamLog.init()
  }

  async connect(): Promise<void> {
    this.stopped = false
    await this.fetchRoster()
    if (!this.teamId) {
      console.log('[Team] Not in a team, skipping connection')
      return
    }
    this.openConnection()
  }

  stop(): void {
    this.stopped = true
    if (this.pingInterval) clearInterval(this.pingInterval)
    if (this.ws) this.ws.close()
  }

  getRoster(): TeamMember[] {
    return this.roster
  }

  getTeamLog(): TeamLog {
    return this.teamLog
  }

  private async fetchRoster(): Promise<void> {
    try {
      const res = await fetch(`${this.options.relayUrl}/team/roster`, {
        headers: { 'Authorization': `Bearer ${this.options.relayToken}` }
      })
      const data = await res.json() as any
      if (data.teamId) {
        this.teamId = data.teamId
        this.teamName = data.name || null
        this.roster = data.members || []
        console.log(`[Team] Connected to team "${this.teamName}" with ${this.roster.length} members`)
      }
    } catch (err) {
      console.warn('[Team] Failed to fetch roster:', err)
    }
  }

  private openConnection(): void {
    if (this.stopped || !this.teamId) return

    const wsUrl = `${this.options.relayUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/team/ws?token=${this.options.relayToken}&userId=${this.options.userId}`
    this.ws = new WebSocket(wsUrl)

    this.ws.on('open', () => {
      console.log('[Team] WebSocket connected')
      this.backoffMs = 2000
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('ping')
      }, 30000)
    })

    this.ws.on('message', (raw) => {
      const str = typeof raw === 'string' ? raw : raw.toString()
      if (str === 'pong') return

      try {
        const envelope = JSON.parse(str)
        if (envelope.type === 'team_message') {
          this.handleMessage(envelope.message as TeamMessage)
        }
      } catch (err) {
        console.warn('[Team] Failed to parse message:', err)
      }
    })

    this.ws.on('close', () => {
      if (this.pingInterval) clearInterval(this.pingInterval)
      if (!this.stopped) {
        console.log(`[Team] Reconnecting in ${this.backoffMs}ms`)
        setTimeout(() => this.openConnection(), this.backoffMs)
        this.backoffMs = Math.min(this.backoffMs * 1.5, 30000)
      }
    })

    this.ws.on('error', (err) => {
      console.warn('[Team] WebSocket error:', err)
    })
  }

  private handleMessage(message: TeamMessage): void {
    const { to } = message
    const myUserId = this.options.userId
    const myAgentTag = `${myUserId}-agent`

    // Check if this message tags our agent specifically
    const isTaggedAgent = to === myAgentTag ||
      (Array.isArray(to) && to.includes(myAgentTag))

    // Check if this message tags our human
    const isTaggedHuman = to === myUserId ||
      (Array.isArray(to) && to.includes(myUserId))

    if (isTaggedAgent && this.options.onTaggedMessage) {
      // Agent needs to process and respond — triggers an AI call
      this.options.onTaggedMessage(message)
    } else if (isTaggedHuman && this.options.onHumanNotify) {
      // Just notify the human — no AI call
      this.options.onHumanNotify(message)
    } else {
      // Broadcast — just log it locally
      this.teamLog.append(message).catch(console.warn)
    }
  }

  async sendMessage(visible: string, agentContext: string = '', to: string | string[] | null = null): Promise<void> {
    if (!this.teamId) return

    const me = this.roster.find(m => m.userId === this.options.userId)
    const message: TeamMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      teamId: this.teamId,
      timestamp: new Date().toISOString(),
      from: {
        userId: this.options.userId,
        name: me?.name || this.options.userId,
        role: me?.role || '',
        isAgent: true
      },
      visible,
      agentContext,
      to,
      attachments: []
    }

    // Send via REST endpoint
    try {
      await fetch(`${this.options.relayUrl}/team/message`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.options.relayToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      })
    } catch (err) {
      console.warn('[Team] Failed to send message:', err)
    }
  }

  async sendHumanMessage(visible: string, to: string | null = null): Promise<void> {
    if (!this.teamId) return

    const me = this.roster.find(m => m.userId === this.options.userId)
    const message: TeamMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      teamId: this.teamId,
      timestamp: new Date().toISOString(),
      from: {
        userId: this.options.userId,
        name: me?.name || this.options.userId,
        role: me?.role || '',
        isAgent: false
      },
      visible,
      agentContext: '',
      to,
      attachments: []
    }

    try {
      await fetch(`${this.options.relayUrl}/team/message`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.options.relayToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      })
    } catch (err) {
      console.warn('[Team] Failed to send message:', err)
    }
  }
}
```

**Step 5: Create index.ts**

```typescript
export { TeamClient, type TeamClientOptions } from './team-client'
export { TeamLog } from './team-log'
```

**Step 6: Install deps and verify**

Run: `cd packages/team-core && pnpm install`
Expected: Dependencies installed

**Step 7: Commit**

```bash
git add packages/team-core/
git commit -m "feat(teams): create team-core package with client and log"
```

---

## Task 4: Wire Team Client into Agent Server

**Files:**
- Modify: `packages/agent-core/package.json` (add team-core dep)
- Modify: `packages/agent-core/src/server.ts` (init team client, handle team messages)
- Modify: `packages/agent-core/src/agent.ts` (add team tools, team system prompt)

**Step 1: Add team-core dependency**

In `packages/agent-core/package.json`, add to dependencies:
```json
"@coagent/team-core": "workspace:*"
```

Run: `pnpm install`

**Step 2: Initialize TeamClient in server.ts**

Import and init alongside the relay client. Add after relay client initialization:

```typescript
import { TeamClient } from '@coagent/team-core'

// After relay client setup:
let teamClient: TeamClient | null = null

if (process.env.RELAY_URL && process.env.RELAY_TOKEN) {
  teamClient = new TeamClient({
    relayUrl: process.env.RELAY_URL,
    relayToken: process.env.RELAY_TOKEN,
    userId: process.env.RELAY_USER_ID || '',
    dataDir: DATA_DIR,
    onTaggedMessage: async (message) => {
      // Agent needs to process this — inject into agent as a team query
      const teamPrompt = `[TEAM MESSAGE from ${message.from.name} (${message.from.role})]\n${message.visible}\n\n[Agent Context]: ${message.agentContext}\n\nRespond to this team message appropriately. Use the send_team_message tool to reply.`
      const response = await agent.chat(teamPrompt, (text) => broadcast({ type: 'chat_chunk', text }), (tool, label) => broadcast({ type: 'tool_start', tool, label } as any))
      broadcast({ type: 'chat_response', message: { role: 'assistant', content: response, timestamp: new Date().toISOString() } })
    },
    onHumanNotify: async (message) => {
      // Just notify the user — push notification
      broadcast({ type: 'push_notification', title: `${message.from.name}`, body: message.visible } as any)
    }
  })
  await teamClient.init()
  await teamClient.connect()
}
```

**Step 3: Add team WebSocket message handlers in server.ts**

Add to the `ws.on('message')` handler alongside existing types:

```typescript
case 'team_send': {
  if (teamClient) {
    await teamClient.sendHumanMessage(msg.message, msg.to || null)
  }
  break
}
case 'get_team_info': {
  if (teamClient && teamClient.teamId) {
    send(ws, {
      type: 'team_info',
      team: {
        teamId: teamClient.teamId,
        name: teamClient.teamName || '',
        ownerId: '',
        created: '',
        members: teamClient.getRoster()
      }
    } as any)
  } else {
    send(ws, { type: 'team_info', team: null } as any)
  }
  break
}
case 'team_history': {
  if (teamClient && teamClient.teamId) {
    try {
      const res = await fetch(`${process.env.RELAY_URL}/team/history?limit=${msg.limit || 50}`, {
        headers: { 'Authorization': `Bearer ${process.env.RELAY_TOKEN}` }
      })
      const messages = await res.json()
      send(ws, { type: 'team_history', messages } as any)
    } catch {}
  }
  break
}
```

**Step 4: Add team tools to agent.ts**

Add to the `INTERNAL_TOOLS` array:

```typescript
{
  name: 'send_team_message',
  description: 'Send a message to your team channel. Use this when your user asks you to share info with the team or notify a team member. Set "to" to "@name-agent" to get their AI to respond, "@name" to just notify the human, or leave null for broadcast.',
  input_schema: {
    type: 'object' as const,
    properties: {
      message: { type: 'string', description: 'The visible message text (humans will see this)' },
      agent_context: { type: 'string', description: 'Hidden context for other agents — include relevant details so receiving agents can act without follow-up' },
      to: { type: 'string', description: 'Tag: "@name-agent" for AI processing, "@name" for human notification, null for broadcast. Can also be comma-separated for multiple tags.' }
    },
    required: ['message']
  }
},
{
  name: 'read_team',
  description: 'Read recent team messages or get team roster info.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['recent_messages', 'roster'], description: 'What to read' },
      limit: { type: 'number', description: 'Number of recent messages (default 20)' }
    },
    required: ['action']
  }
}
```

**Step 5: Add tool execution in the run loop**

Add cases in the tool execution switch:

```typescript
case 'send_team_message': {
  if (!teamClient) {
    result = 'Not connected to a team.'
  } else {
    const toField = input.to
      ? (input.to.includes(',') ? input.to.split(',').map((s: string) => s.trim()) : input.to)
      : null
    await teamClient.sendMessage(input.message, input.agent_context || '', toField)
    result = `Message sent to team${input.to ? ` (tagged: ${input.to})` : ''}.`
  }
  break
}
case 'read_team': {
  if (!teamClient) {
    result = 'Not connected to a team.'
  } else if (input.action === 'roster') {
    const roster = teamClient.getRoster()
    result = roster.length > 0
      ? `Team: ${teamClient.teamName}\nMembers:\n${roster.map(m => `- ${m.name} / @${m.userId}-agent (${m.role}): ${m.handles}`).join('\n')}`
      : 'No team members found.'
  } else {
    const log = await teamClient.getTeamLog().readLog()
    const recent = log.slice(-(input.limit || 20))
    result = recent.length > 0
      ? recent.map(m => `[${m.timestamp}] ${m.from.name} (${m.from.role}): ${m.visible}${m.agentContext ? `\n  [context: ${m.agentContext}]` : ''}`).join('\n\n')
      : 'No recent team messages.'
  }
  break
}
```

**Step 6: Add team context to system prompt**

In `buildSystemPrompt()`, add team roster context if available:

```typescript
// Add after existing system prompt content:
if (teamClient && teamClient.teamId) {
  const roster = teamClient.getRoster()
  if (roster.length > 0) {
    prompt += `\n\n## Team: ${teamClient.teamName}\n\n`
    prompt += `You are part of a team. Team members:\n`
    for (const m of roster) {
      prompt += `- ${m.name} / @${m.userId}-agent (${m.role}): ${m.handles}\n`
    }
    prompt += `\nWhen your user asks you to share info with the team or notify someone, use send_team_message.\n`
    prompt += `- @name-agent = their AI processes and responds (use when you need info from their agent)\n`
    prompt += `- @name = notify the human directly (use for informational updates)\n`
    prompt += `- null = broadcast to whole team\n`
    prompt += `\nInclude agentContext with relevant details so receiving agents have context.\n`
  }
}
```

**Step 7: Verify build**

Run: `cd packages/agent-core && pnpm build`
Expected: No errors

**Step 8: Commit**

```bash
git add packages/agent-core/
git commit -m "feat(teams): wire team client into agent server with tools"
```

---

## Task 5: Add TeamPane to Desktop App

**Files:**
- Create: `apps/desktop/src/components/TeamPane.tsx`
- Modify: `apps/desktop/src/components/Sidebar.tsx` (add Team nav)
- Modify: `apps/desktop/src/App.tsx` (add team view + state)
- Modify: `apps/desktop/src/hooks/useAgent.ts` (handle team messages)

**Step 1: Add team state to useAgent hook**

Add state variables:

```typescript
const [teamInfo, setTeamInfo] = useState<any>(null)
const [teamMessages, setTeamMessages] = useState<any[]>([])
```

Add message handlers:

```typescript
case 'team_info':
  setTeamInfo(msg.team)
  break
case 'team_message':
  setTeamMessages(prev => [...prev, msg.message])
  break
case 'team_history':
  setTeamMessages(msg.messages)
  break
```

Add API functions:

```typescript
const sendTeamMessage = (message: string, to?: string) => {
  send({ type: 'team_send', message, to } as any)
}

const getTeamInfo = () => {
  send({ type: 'get_team_info' } as any)
}

const getTeamHistory = (limit = 50) => {
  send({ type: 'team_history', limit } as any)
}
```

Return these from the hook.

Request team info on connect:

```typescript
// In onopen handler, after setting connected:
socket.send(JSON.stringify({ type: 'get_team_info' }))
socket.send(JSON.stringify({ type: 'team_history', limit: 50 }))
```

**Step 2: Create TeamPane component**

```tsx
import { useState, useRef, useEffect } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Users, Send, Bot, User } from 'lucide-react'
import type { TeamMessage, TeamInfo } from '@coagent/shared'

interface TeamPaneProps {
  team: TeamInfo | null
  messages: TeamMessage[]
  onSendMessage: (message: string, to?: string) => void
}

export function TeamPane({ team, messages, onSendMessage }: TeamPaneProps) {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  if (!team) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500">
        <div className="text-center">
          <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p className="text-lg font-medium">No team yet</p>
          <p className="text-sm mt-2">Create or join a team in Settings</p>
        </div>
      </div>
    )
  }

  const handleSend = () => {
    if (!input.trim()) return
    onSendMessage(input.trim())
    setInput('')
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">{team.name}</h2>
          <p className="text-xs text-zinc-500">{team.members.length} members</p>
        </div>
        <div className="flex gap-1">
          {team.members.map(m => (
            <div key={m.userId} className="w-6 h-6 rounded-full bg-zinc-700 flex items-center justify-center text-[10px] text-zinc-300" title={`${m.name} (${m.role})`}>
              {m.name.charAt(0)}
            </div>
          ))}
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 px-4 py-3" ref={scrollRef}>
        <div className="space-y-4">
          {messages.map((msg) => (
            <div key={msg.id} className="flex gap-3">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${msg.from.isAgent ? 'bg-indigo-900/50 text-indigo-400' : 'bg-zinc-700 text-zinc-300'}`}>
                {msg.from.isAgent ? <Bot className="w-3.5 h-3.5" /> : <User className="w-3.5 h-3.5" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-medium text-zinc-300">
                    {msg.from.name}{msg.from.isAgent ? "'s Agent" : ''}
                  </span>
                  <span className="text-[10px] text-zinc-600">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </span>
                  {msg.to && (
                    <span className="text-[10px] text-indigo-400">
                      → {Array.isArray(msg.to) ? msg.to.join(', ') : msg.to}
                    </span>
                  )}
                </div>
                <p className="text-sm text-zinc-200 mt-0.5 whitespace-pre-wrap">{msg.visible}</p>
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="px-4 py-3 border-t border-zinc-800">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Type a message..."
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-600"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm text-white"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
```

**Step 3: Add Team to Sidebar View type**

In `Sidebar.tsx`, update the View type:

```typescript
export type View = 'chat' | 'calendar' | 'queue' | 'files' | 'skills' | 'settings' | 'team'
```

Add the Team nav item (after Calendar, before Queue):

```tsx
<NavItem icon={Users} label="Team" active={view === 'team'} onClick={() => onViewChange('team')} />
```

Import `Users` from lucide-react.

**Step 4: Add TeamPane to App.tsx**

Import and render:

```typescript
import { TeamPane } from '@/components/TeamPane'

// In the render, add:
{view === 'team' && (
  <TeamPane
    team={teamInfo}
    messages={teamMessages}
    onSendMessage={sendTeamMessage}
  />
)}
```

**Step 5: Verify dev build**

Run: `pnpm dev` (from project root)
Expected: Desktop app launches, Team tab visible in sidebar

**Step 6: Commit**

```bash
git add apps/desktop/src/
git commit -m "feat(teams): add TeamPane and team UI to desktop app"
```

---

## Task 6: Test Script — Simulate Other Agents

**Files:**
- Create: `scripts/test-team-agent.ts`

**Step 1: Create test script**

```typescript
/**
 * Simulates a team agent for testing.
 * Usage: RELAY_URL=... RELAY_TOKEN=... USER_ID=brian tsx scripts/test-team-agent.ts
 */

const RELAY_URL = process.env.RELAY_URL || 'https://coagent-relay.brettponters.workers.dev'
const RELAY_TOKEN = process.env.RELAY_TOKEN!
const USER_ID = process.env.USER_ID || 'brian'
const USER_NAME = process.env.USER_NAME || 'Brian'
const USER_ROLE = process.env.USER_ROLE || 'Sales'

async function main() {
  console.log(`[Test Agent] Starting as ${USER_NAME} (${USER_ROLE})...`)

  // Connect to team WebSocket
  const wsUrl = `${RELAY_URL.replace('https://', 'wss://').replace('http://', 'ws://')}/team/ws?token=${RELAY_TOKEN}&userId=${USER_ID}`
  const ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    console.log('[Test Agent] Connected to team channel')

    // Send a test message after 2 seconds
    setTimeout(() => {
      const msg = {
        id: `msg_${Date.now()}`,
        teamId: '',
        timestamp: new Date().toISOString(),
        from: { userId: USER_ID, name: USER_NAME, role: USER_ROLE, isAgent: true },
        visible: 'Test message from Brian\'s agent — just closed a deal!',
        agentContext: 'Test deal, $10k, contact: test@test.com',
        to: null,
        attachments: []
      }

      // Send via REST
      fetch(`${RELAY_URL}/team/message`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RELAY_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(msg)
      }).then(() => console.log('[Test Agent] Message sent'))
    }, 2000)
  }

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data.toString())
    if (data.type === 'team_message') {
      console.log(`[Test Agent] Received: ${data.message.from.name}: ${data.message.visible}`)
      // Check if we're tagged
      if (data.message.to === `${USER_ID}-agent`) {
        console.log('[Test Agent] We are tagged! Auto-responding...')
        setTimeout(async () => {
          await fetch(`${RELAY_URL}/team/message`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${RELAY_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              id: `msg_${Date.now()}`,
              teamId: '',
              timestamp: new Date().toISOString(),
              from: { userId: USER_ID, name: USER_NAME, role: USER_ROLE, isAgent: true },
              visible: `${USER_NAME}'s agent responding to your query!`,
              agentContext: '',
              to: null,
              attachments: []
            })
          })
        }, 1000)
      }
    }
  }

  ws.onerror = (err) => console.error('[Test Agent] Error:', err)
  ws.onclose = () => console.log('[Test Agent] Disconnected')
}

main()
```

**Step 2: Test the full flow**

1. Create a second test token: `curl -X POST -H "Authorization: Bearer YOUR_ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"email":"test-brian@test.com"}' https://coagent-relay.brettponters.workers.dev/admin/create-token`
2. Create team from your CoAgent Settings or via curl
3. Join team with the test token
4. Run the test script: `RELAY_TOKEN=<brian-token> USER_ID=brian tsx scripts/test-team-agent.ts`
5. Verify messages appear in your Team pane

**Step 3: Commit**

```bash
git add scripts/test-team-agent.ts
git commit -m "feat(teams): add test script for simulating team agents"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Shared types | `packages/shared/src/index.ts` |
| 2 | Relay DO + endpoints | `relay/src/index.ts`, `relay/wrangler.toml` |
| 3 | team-core package | `packages/team-core/` (new) |
| 4 | Wire into agent | `packages/agent-core/src/server.ts`, `agent.ts` |
| 5 | Desktop UI | `apps/desktop/src/components/TeamPane.tsx`, Sidebar, App |
| 6 | Test script | `scripts/test-team-agent.ts` |

Build in this order. Each task is independently testable. Iterate after each one.
