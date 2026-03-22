# Integrations Sidebar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add Gmail, Google Calendar, DocuSign, HubSpot, and Follow Up Boss to the sidebar with real connect/disconnect functionality via Composio OAuth.

**Architecture:** Add new WebSocket message types for integration status/connect/disconnect. The server queries Composio's connectedAccounts API to determine connection status, generates OAuth URLs on demand, and the client opens them in the browser. When a toolkit connects, the Composio MCP config is updated and reconnected.

**Tech Stack:** `@composio/core`, React, TypeScript, WebSockets, Lucide icons, Tailwind CSS

---

### Task 1: Add integration types to shared package

**Files:**
- Modify: `packages/shared/src/index.ts`

**Step 1: Add Integration type and new WS messages**

Replace the existing `WSClientMessage` and `WSServerMessage` with these updated versions (add to bottom, before the `DoneItem` interface):

```typescript
export interface Integration {
  slug: string
  name: string
  connected: boolean
}

// Add to WSClientMessage union:
| { type: 'get_integrations' }
| { type: 'integration_connect'; slug: string }
| { type: 'integration_disconnect'; slug: string }

// Add to WSServerMessage union:
| { type: 'integrations_update'; integrations: Integration[] }
| { type: 'integration_auth_url'; slug: string; url: string }
```

Full updated file:

```typescript
export type TriggerSource = 'heartbeat' | 'webhook' | 'manual'

export interface AgentTrigger {
  source: TriggerSource
  payload?: Record<string, unknown>
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface ApprovalItem {
  id: string
  type: 'contract' | 'analysis' | 'cma' | 'email' | 'other'
  title: string
  description: string
  detail: string
  notes: string
  action: string
  metadata: Record<string, string>
  status: ApprovalStatus
  createdAt: string
}

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export interface Integration {
  slug: string
  name: string
  connected: boolean
}

export type WSClientMessage =
  | { type: 'chat'; message: string }
  | { type: 'get_queue' }
  | { type: 'approve'; id: string }
  | { type: 'reject'; id: string }
  | { type: 'get_done' }
  | { type: 'get_integrations' }
  | { type: 'integration_connect'; slug: string }
  | { type: 'integration_disconnect'; slug: string }

export type WSServerMessage =
  | { type: 'queue_update'; items: ApprovalItem[] }
  | { type: 'done_update'; items: DoneItem[] }
  | { type: 'chat_response'; message: AgentMessage }
  | { type: 'chat_chunk'; text: string }
  | { type: 'agent_thinking' }
  | { type: 'error'; message: string }
  | { type: 'integrations_update'; integrations: Integration[] }
  | { type: 'integration_auth_url'; slug: string; url: string }

export interface DoneItem {
  id: string
  description: string
  completedAt: string
}
```

**Step 2: Commit**
```bash
git add packages/shared/src/index.ts
git commit -m "feat: add integration WS types to shared package"
```

---

### Task 2: Create composio-integrations.ts in agent-core

**Files:**
- Create: `packages/agent-core/src/composio-integrations.ts`

**Context:** This file handles all Composio integration logic: listing status, generating OAuth URLs, disconnecting. The `INTEGRATIONS` constant defines the 5 supported integrations. The `userId` is always `'default'` for the single-user desktop app.

**Step 1: Create the file**

```typescript
import { Composio } from '@composio/core'

export const INTEGRATIONS = [
  { slug: 'gmail', name: 'Gmail' },
  { slug: 'googlecalendar', name: 'Google Calendar' },
  { slug: 'docusign', name: 'DocuSign' },
  { slug: 'hubspot', name: 'HubSpot' },
  { slug: 'follow_up_boss', name: 'Follow Up Boss' },
]

/**
 * Get connection status for all integrations for this user.
 * Queries Composio connectedAccounts and checks which toolkit slugs are active.
 */
export async function getIntegrationStatuses(
  apiKey: string,
  userId = 'default'
): Promise<{ slug: string; name: string; connected: boolean }[]> {
  const composio = new Composio({ apiKey })

  // Get all connected accounts for this user
  const result = await composio.connectedAccounts.list({ user_uuid: userId })
  const accounts = (result as any)?.items ?? []

  // Build set of connected toolkit slugs (only active connections)
  const connectedSlugs = new Set<string>(
    accounts
      .filter((a: any) => a.status === 'ACTIVE')
      .map((a: any) => a.toolkitSlug ?? a.appName?.toLowerCase())
  )

  return INTEGRATIONS.map(({ slug, name }) => ({
    slug,
    name,
    connected: connectedSlugs.has(slug),
  }))
}

/**
 * Generate an OAuth URL for the user to connect a toolkit.
 * Returns the redirect URL that should be opened in the browser.
 */
export async function generateAuthUrl(
  apiKey: string,
  slug: string,
  userId = 'default'
): Promise<string> {
  const composio = new Composio({ apiKey })

  const result = await composio.connectedAccounts.initiate({
    toolkitSlug: slug,
    userUuid: userId,
    redirectUrl: null as any,
  })

  // Composio returns a redirectUrl that starts the OAuth flow
  const url = (result as any).redirectUrl ?? (result as any).connectionStatus?.redirectUrl
  if (!url) throw new Error(`No auth URL returned for ${slug}`)
  return url
}

/**
 * Disconnect (delete) the connected account for a toolkit.
 */
export async function disconnectIntegration(
  apiKey: string,
  slug: string,
  userId = 'default'
): Promise<void> {
  const composio = new Composio({ apiKey })

  const result = await composio.connectedAccounts.list({ user_uuid: userId })
  const accounts = (result as any)?.items ?? []

  const account = accounts.find(
    (a: any) => (a.toolkitSlug ?? a.appName?.toLowerCase()) === slug
  )

  if (account) {
    await composio.connectedAccounts.delete?.(account.id) ??
      console.warn(`[Composio] No delete method — skipping disconnect for ${slug}`)
  }
}

/**
 * Return the list of currently connected toolkit slugs (for MCP config).
 */
export async function getConnectedSlugs(
  apiKey: string,
  userId = 'default'
): Promise<string[]> {
  const statuses = await getIntegrationStatuses(apiKey, userId)
  return statuses.filter(s => s.connected).map(s => s.slug)
}
```

**Step 2: Commit**
```bash
git add packages/agent-core/src/composio-integrations.ts
git commit -m "feat: add composio-integrations helpers"
```

---

### Task 3: Update composio-setup.ts to use dynamic toolkits

**Files:**
- Modify: `packages/agent-core/src/composio-setup.ts`

**Context:** Currently `composio-setup.ts` hardcodes `toolkits: ['gmail', 'googlecalendar']`. We need it to accept a dynamic list, and also support refreshing the MCP connection when toolkits change.

**Step 1: Update setupComposioMcp to accept toolkits param and support refresh**

Replace the entire file:

```typescript
import { Composio } from '@composio/core'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

const CONFIG_DIR = join(process.env.HOME ?? '', '.coagent')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const MCP_CONFIG_NAME = 'coagent-real-estate'

interface CoagentConfig {
  [key: string]: unknown
}

function readConfig(): CoagentConfig {
  if (!existsSync(CONFIG_FILE)) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeConfig(config: CoagentConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

/**
 * Set up or refresh Composio MCP.
 * Pass forceRefresh=true after a new toolkit is connected/disconnected.
 */
export async function setupComposioMcp(
  apiKey: string,
  toolkits: string[],
  userId = 'default',
  forceRefresh = false
): Promise<{ url: string; apiKey: string }> {
  const composio = new Composio({ apiKey })
  const cfg = readConfig()

  const cacheKey = `composioMcpUrl_${userId}`
  const cachedUrl = cfg[cacheKey] as string | undefined

  if (cachedUrl && !forceRefresh) {
    console.log(`[Composio] Using cached MCP URL for user "${userId}"`)
    return { url: cachedUrl, apiKey }
  }

  // Find or create MCP config
  const listResult = await composio.mcp.list({ name: MCP_CONFIG_NAME })
  const existing = (listResult as any)?.items?.find((s: any) => s.name === MCP_CONFIG_NAME)

  let mcpBaseUrl: string

  if (existing) {
    // Update toolkits if refreshing
    if (forceRefresh && toolkits.length > 0) {
      await composio.mcp.update(existing.id, { toolkits })
      console.log(`[Composio] Updated MCP config toolkits: ${toolkits.join(', ')}`)
    }
    mcpBaseUrl = existing.MCPUrl
  } else {
    const created = await composio.mcp.create(MCP_CONFIG_NAME, {
      toolkits: toolkits.length > 0 ? toolkits : ['gmail', 'googlecalendar'],
      manuallyManageConnections: false,
    })
    mcpBaseUrl = (created as any).MCPUrl
    console.log(`[Composio] Created MCP config: ${created.id}`)
  }

  const url = `${mcpBaseUrl}?user_id=${encodeURIComponent(userId)}`
  writeConfig({ ...cfg, [cacheKey]: url })
  console.log(`[Composio] MCP URL: ${url}`)
  return { url, apiKey }
}
```

**Step 2: Commit**
```bash
git add packages/agent-core/src/composio-setup.ts
git commit -m "feat: dynamic toolkits + forceRefresh support in composio-setup"
```

---

### Task 4: Update server.ts with integration WS handlers

**Files:**
- Modify: `packages/agent-core/src/server.ts`

**Context:** Add handlers for `get_integrations`, `integration_connect`, `integration_disconnect`. On connection, push integrations status. On connect, generate OAuth URL and send it back. On disconnect, delete connected account and refresh MCP.

**Step 1: Update server.ts**

Add these imports at top (after existing imports):
```typescript
import {
  getIntegrationStatuses,
  generateAuthUrl,
  disconnectIntegration,
  getConnectedSlugs,
} from './composio-integrations.js'
```

Update the Composio setup call (replace the existing if block):
```typescript
// Connect Composio MCP if key is set
if (process.env.COMPOSIO_API_KEY) {
  getConnectedSlugs(process.env.COMPOSIO_API_KEY).then(async (slugs) => {
    const toolkits = slugs.length > 0 ? slugs : ['gmail', 'googlecalendar']
    const { url, apiKey } = await setupComposioMcp(process.env.COMPOSIO_API_KEY!, toolkits)
    await agent.mcpManager.connectHttp('composio', url, apiKey)
    console.log('[Composio] MCP connected with toolkits:', toolkits.join(', '))
  }).catch(err => console.error('[Composio] Failed to connect MCP:', err.message))
}
```

Add a helper to push integration status to a client:
```typescript
async function sendIntegrations(ws: WebSocket): Promise<void> {
  if (!process.env.COMPOSIO_API_KEY) return
  const integrations = await getIntegrationStatuses(process.env.COMPOSIO_API_KEY)
  send(ws, { type: 'integrations_update', integrations })
}
```

In the `wss.on('connection', ...)` handler, add `sendIntegrations(ws)` after the existing `send` calls:
```typescript
wss.on('connection', (ws) => {
  send(ws, { type: 'queue_update', items: agent.queue.getPending() })
  send(ws, { type: 'done_update', items: agent.queue.getDone() })
  sendIntegrations(ws).catch(console.error)  // ADD THIS
  ...
```

In the `ws.on('message', ...)` handler, add after existing handlers:
```typescript
if (msg.type === 'get_integrations') {
  await sendIntegrations(ws)
}

if (msg.type === 'integration_connect') {
  try {
    const url = await generateAuthUrl(process.env.COMPOSIO_API_KEY!, msg.slug)
    send(ws, { type: 'integration_auth_url', slug: msg.slug, url })
  } catch (err: any) {
    send(ws, { type: 'error', message: err.message })
  }
}

if (msg.type === 'integration_disconnect') {
  try {
    await disconnectIntegration(process.env.COMPOSIO_API_KEY!, msg.slug)
    // Refresh MCP with updated toolkit list
    const slugs = await getConnectedSlugs(process.env.COMPOSIO_API_KEY!)
    const { url, apiKey } = await setupComposioMcp(
      process.env.COMPOSIO_API_KEY!,
      slugs,
      'default',
      true
    )
    await agent.mcpManager.disconnectAll()
    await agent.mcpManager.connect(mcpConfigs)  // reconnect stdio servers
    await agent.mcpManager.connectHttp('composio', url, apiKey)
    await sendIntegrations(ws)
  } catch (err: any) {
    send(ws, { type: 'error', message: err.message })
  }
}
```

**Step 2: Commit**
```bash
git add packages/agent-core/src/server.ts
git commit -m "feat: add integration connect/disconnect WS handlers"
```

---

### Task 5: Update useAgent hook with integrations state

**Files:**
- Modify: `apps/desktop/src/hooks/useAgent.ts`

**Context:** Add `integrations` state and `connectIntegration`/`disconnectIntegration` callbacks. When `integration_auth_url` arrives, open it in the browser. After opening, poll for status update after 5 seconds (user may complete OAuth quickly).

**Step 1: Update useAgent.ts**

```typescript
import { useState, useEffect, useCallback } from 'react'
import type { ApprovalItem, DoneItem, AgentMessage, WSServerMessage, WSClientMessage, Integration } from '@coagent/shared'

const WS_URL = 'ws://localhost:7830'

export function useAgent() {
  const [ws, setWs] = useState<WebSocket | null>(null)
  const [queue, setQueue] = useState<ApprovalItem[]>([])
  const [done, setDone] = useState<DoneItem[]>([])
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [thinking, setThinking] = useState(false)
  const [connected, setConnected] = useState(false)
  const [integrations, setIntegrations] = useState<Integration[]>([])

  useEffect(() => {
    const socket = new WebSocket(WS_URL)

    socket.onopen = () => setConnected(true)
    socket.onclose = () => setConnected(false)

    socket.onmessage = (event) => {
      const msg: WSServerMessage = JSON.parse(event.data)
      if (msg.type === 'queue_update') setQueue(msg.items)
      if (msg.type === 'done_update') setDone(msg.items)
      if (msg.type === 'agent_thinking') {
        setThinking(true)
        setStreamingText(null)
      }
      if (msg.type === 'chat_chunk') {
        setThinking(false)
        setStreamingText(prev => (prev ?? '') + msg.text)
      }
      if (msg.type === 'chat_response') {
        setThinking(false)
        setStreamingText(null)
        setMessages(prev => [...prev, msg.message])
      }
      if (msg.type === 'integrations_update') {
        setIntegrations(msg.integrations)
      }
      if (msg.type === 'integration_auth_url') {
        // Open OAuth URL in browser
        window.open(msg.url, '_blank')
        // Poll for updated status after 10s (user completing OAuth)
        setTimeout(() => {
          socket.send(JSON.stringify({ type: 'get_integrations' } as WSClientMessage))
        }, 10000)
      }
    }

    setWs(socket)
    return () => socket.close()
  }, [])

  const send = useCallback((msg: WSClientMessage) => {
    ws?.send(JSON.stringify(msg))
  }, [ws])

  const chat = useCallback((message: string) => {
    setMessages(prev => [...prev, { role: 'user', content: message, timestamp: new Date().toISOString() }])
    send({ type: 'chat', message })
  }, [send])

  const approve = useCallback((id: string) => send({ type: 'approve', id }), [send])
  const reject = useCallback((id: string) => send({ type: 'reject', id }), [send])
  const connectIntegration = useCallback((slug: string) => send({ type: 'integration_connect', slug }), [send])
  const disconnectIntegration = useCallback((slug: string) => send({ type: 'integration_disconnect', slug }), [send])

  return { queue, done, messages, streamingText, thinking, connected, integrations, chat, approve, reject, connectIntegration, disconnectIntegration }
}
```

**Step 2: Commit**
```bash
git add apps/desktop/src/hooks/useAgent.ts
git commit -m "feat: add integrations state and connect/disconnect to useAgent"
```

---

### Task 6: Update App.tsx to pass integrations props to Sidebar

**Files:**
- Modify: `apps/desktop/src/App.tsx`

**Step 1: Update App.tsx**

```typescript
import React, { useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sidebar } from '@/components/Sidebar'
import { QueuePane } from '@/components/QueuePane'
import { DetailPane } from '@/components/DetailPane'
import { ChatPane } from '@/components/ChatPane'
import { useAgent } from '@/hooks/useAgent'
import type { ApprovalItem } from '@coagent/shared'

type View = 'queue' | 'chat' | 'done'

export default function App() {
  const {
    queue, done, messages, streamingText, thinking, connected,
    integrations, chat, approve, reject, connectIntegration, disconnectIntegration
  } = useAgent()
  const [view, setView] = useState<View>('queue')
  const [selectedItem, setSelectedItem] = useState<ApprovalItem | null>(null)

  function handleApprove(id: string) {
    approve(id)
    setSelectedItem(null)
  }

  function handleReject(id: string) {
    reject(id)
    setSelectedItem(null)
  }

  return (
    <>
      <div className="window-chrome">
        <div className="chrome-dot red" />
        <div className="chrome-dot yellow" />
        <div className="chrome-dot green" />
      </div>

      <div className="app-body">
        <Sidebar
          view={view}
          onViewChange={setView}
          queueCount={queue.length}
          integrations={integrations}
          onConnect={connectIntegration}
          onDisconnect={disconnectIntegration}
        />

        {view === 'queue' && (
          <>
            <QueuePane queue={queue} done={done} selectedId={selectedItem?.id ?? null} onSelect={setSelectedItem} />
            <DetailPane item={selectedItem} onApprove={handleApprove} onReject={handleReject} />
          </>
        )}

        {view === 'chat' && (
          <ChatPane messages={messages} streamingText={streamingText} thinking={thinking} connected={connected} onChat={chat} />
        )}

        {view === 'done' && (
          <ScrollArea className="flex-1 bg-white">
            <div className="px-8 py-7">
              <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-widest mb-1">
                Completed
              </p>
              <h1 className="text-[19px] font-bold tracking-tight text-neutral-900 mb-6">
                Activity log
              </h1>
              {done.length === 0 ? (
                <p className="text-[14px] text-neutral-400">Nothing completed yet today.</p>
              ) : (
                <div className="flex flex-col divide-y divide-neutral-100">
                  {done.map(item => (
                    <div key={item.id} className="flex items-start gap-3 py-3">
                      <CheckCircle2 size={15} strokeWidth={1.75} className="text-emerald-500 flex-shrink-0 mt-0.5" />
                      <span className="text-[14px] text-neutral-600 leading-relaxed">{item.description}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </div>
    </>
  )
}
```

**Step 2: Commit**
```bash
git add apps/desktop/src/App.tsx
git commit -m "feat: pass integrations props from App to Sidebar"
```

---

### Task 7: Update Sidebar.tsx with live integration status

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx`

**Context:** Replace the hardcoded static integration nav items with dynamic ones that show a green/grey dot, and handle click to connect/disconnect. The integration name maps to a Lucide icon.

**Step 1: Update Sidebar.tsx**

```typescript
import React from 'react'
import {
  Inbox, MessageSquare, CheckCircle2, Mail, Calendar,
  FileSignature, Settings, Building2, Users
} from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { Integration } from '@coagent/shared'

type View = 'queue' | 'chat' | 'done'

interface SidebarProps {
  view: View
  onViewChange: (v: View) => void
  queueCount: number
  integrations: Integration[]
  onConnect: (slug: string) => void
  onDisconnect: (slug: string) => void
}

const INTEGRATION_ICONS: Record<string, React.ElementType> = {
  gmail: Mail,
  googlecalendar: Calendar,
  docusign: FileSignature,
  hubspot: Building2,
  follow_up_boss: Users,
}

function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
  badge,
}: {
  icon: React.ElementType
  label: string
  active?: boolean
  onClick?: () => void
  badge?: number
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors text-left',
        active
          ? 'bg-neutral-100 text-neutral-900'
          : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800'
      )}
    >
      <Icon size={15} strokeWidth={1.75} className="flex-shrink-0" />
      <span className="flex-1">{label}</span>
      {badge != null && badge > 0 && (
        <Badge className="ml-auto h-4 px-1.5 text-[10px] bg-neutral-900 text-white hover:bg-neutral-900">
          {badge}
        </Badge>
      )}
    </button>
  )
}

function IntegrationItem({
  integration,
  onConnect,
  onDisconnect,
}: {
  integration: Integration
  onConnect: (slug: string) => void
  onDisconnect: (slug: string) => void
}) {
  const Icon = INTEGRATION_ICONS[integration.slug] ?? Building2

  function handleClick() {
    if (integration.connected) {
      onDisconnect(integration.slug)
    } else {
      onConnect(integration.slug)
    }
  }

  return (
    <button
      onClick={handleClick}
      title={integration.connected ? `${integration.name} — click to disconnect` : `Connect ${integration.name}`}
      className="flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors text-left text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
    >
      <Icon size={15} strokeWidth={1.75} className="flex-shrink-0" />
      <span className="flex-1">{integration.name}</span>
      <span
        className={cn(
          'w-1.5 h-1.5 rounded-full flex-shrink-0',
          integration.connected ? 'bg-emerald-400' : 'bg-neutral-300'
        )}
      />
    </button>
  )
}

export function Sidebar({ view, onViewChange, queueCount, integrations, onConnect, onDisconnect }: SidebarProps) {
  // Fallback static list while integrations load
  const STATIC = [
    { slug: 'gmail', name: 'Gmail' },
    { slug: 'googlecalendar', name: 'Google Calendar' },
    { slug: 'docusign', name: 'DocuSign' },
    { slug: 'hubspot', name: 'HubSpot' },
    { slug: 'follow_up_boss', name: 'Follow Up Boss' },
  ]

  const displayIntegrations = integrations.length > 0
    ? integrations
    : STATIC.map(s => ({ ...s, connected: false }))

  return (
    <div className="w-52 bg-[#FAFAFA] border-r border-neutral-200 flex flex-col py-4 px-3 flex-shrink-0">
      <div className="px-2 mb-5">
        <span className="text-[15px] font-semibold tracking-tight text-neutral-900">
          Co-Agent
        </span>
      </div>

      <div className="flex flex-col gap-0.5 mb-2">
        <NavItem icon={Inbox} label="Queue" active={view === 'queue'} onClick={() => onViewChange('queue')} badge={queueCount} />
        <NavItem icon={MessageSquare} label="Chat" active={view === 'chat'} onClick={() => onViewChange('chat')} />
        <NavItem icon={CheckCircle2} label="Done" active={view === 'done'} onClick={() => onViewChange('done')} />
      </div>

      <Separator className="my-3" />

      <p className="px-2.5 text-[10px] font-semibold text-neutral-400 uppercase tracking-widest mb-2">
        Integrations
      </p>
      <div className="flex flex-col gap-0.5">
        {displayIntegrations.map(integration => (
          <IntegrationItem
            key={integration.slug}
            integration={integration}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
          />
        ))}
      </div>

      <div className="flex-1" />

      <Separator className="mb-3" />

      <NavItem icon={Settings} label="Settings" />
      <button className="flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-md hover:bg-neutral-100 transition-colors mt-0.5">
        <Avatar className="h-6 w-6">
          <AvatarFallback className="text-[10px] font-semibold bg-neutral-200 text-neutral-600">
            SM
          </AvatarFallback>
        </Avatar>
        <span className="text-[13px] font-medium text-neutral-600">Sarah Mitchell</span>
      </button>
    </div>
  )
}
```

**Step 2: Commit**
```bash
git add apps/desktop/src/components/Sidebar.tsx
git commit -m "feat: live integration status with connect/disconnect in sidebar"
```

---

### Task 8: Restart server and verify

**Step 1: Kill existing server and restart**
```bash
lsof -ti:7830 | xargs kill -9 2>/dev/null; true
cd packages/agent-core && pnpm dev
```

**Step 2: Expected server output**
```
[Composio] MCP connected with toolkits: gmail, googlecalendar
Co-Agent running on ws://localhost:7830
```

**Step 3: Open the web app and verify**
- Open `http://localhost:5173` in browser
- Sidebar should show 5 integrations with grey dots (not yet connected)
- Clicking Gmail should open a browser tab to Composio's Google OAuth page
- After connecting, the dot should turn green within ~10 seconds

**Step 4: Final commit if all good**
```bash
git add -A
git commit -m "feat: complete integrations sidebar with live Composio OAuth"
```
