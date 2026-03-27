# Custom Integration Infrastructure — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the infrastructure for user-created custom MCP integrations — registry, server lifecycle, credential forms, capability cards, and integrations modal support.

**Architecture:** New `custom-mcp.ts` module in agent-core manages a registry at `~/.coagent/custom-mcps/`. Each custom integration is a stdio MCP server spawned as a subprocess. Two new WebSocket message types (`capability_card` / `capability_confirm`) enable structured capability confirmation in chat. Custom integrations merge into the existing integrations modal under a "Custom" category. The `custom:` slug prefix routes connect/disconnect/delete to the custom MCP system instead of Composio.

**Tech Stack:** TypeScript, MCP SDK (`@modelcontextprotocol/sdk`), WebSocket, React (frontend card + modal changes)

---

### Task 1: Shared Types — New WebSocket Messages + Integration.custom field

**Files:**
- Modify: `packages/shared/src/index.ts`

**Step 1: Add `custom` field to Integration interface**

In `packages/shared/src/index.ts`, add `custom?: boolean` to the `Integration` interface:

```typescript
export interface Integration {
  slug: string
  name: string
  connected: boolean
  category?: string
  description?: string
  capabilities?: string
  custom?: boolean
}
```

**Step 2: Add capability_card and capability_confirm to WSServerMessage / WSClientMessage**

Add to `WSServerMessage`:

```typescript
| { type: 'capability_card'; name: string; capabilities: { name: string; description: string; checked: boolean }[] }
```

Add to `WSClientMessage`:

```typescript
| { type: 'capability_confirm'; capabilities: string[] }
| { type: 'custom_integration_delete'; slug: string }
```

**Step 3: Build shared package**

Run: `cd packages/shared && pnpm build`
Expected: Clean build, no errors.

**Step 4: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat: add custom integration types to shared package"
```

---

### Task 2: Custom MCP Registry Module (`custom-mcp.ts`)

**Files:**
- Create: `packages/agent-core/src/custom-mcp.ts`

**Step 1: Create the custom MCP registry module**

This module manages `~/.coagent/custom-mcps/registry.json` and the lifecycle of custom MCP servers.

```typescript
import { readFile, writeFile, mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { config as dotenvConfig } from 'dotenv'
import type { MCPServerConfig } from './mcp-manager.js'

export interface CustomMCPEntry {
  name: string           // kebab-case slug e.g. "notion"
  displayName: string    // "Notion"
  description: string
  capabilities: string[] // ["Create pages", "Search databases"]
  createdAt: string      // ISO
  connected: boolean
  authFields: { name: string; displayName: string; description: string }[]
}

const CUSTOM_MCP_DIR = join(homedir(), '.coagent', 'custom-mcps')
const REGISTRY_PATH = join(CUSTOM_MCP_DIR, 'registry.json')

export async function ensureCustomMcpDir(): Promise<void> {
  await mkdir(CUSTOM_MCP_DIR, { recursive: true })
}

export async function readRegistry(): Promise<CustomMCPEntry[]> {
  await ensureCustomMcpDir()
  if (!existsSync(REGISTRY_PATH)) return []
  const raw = await readFile(REGISTRY_PATH, 'utf-8')
  return JSON.parse(raw)
}

export async function writeRegistry(entries: CustomMCPEntry[]): Promise<void> {
  await ensureCustomMcpDir()
  await writeFile(REGISTRY_PATH, JSON.stringify(entries, null, 2), 'utf-8')
}

export async function addCustomMcp(entry: CustomMCPEntry, indexJs: string, packageJson: string): Promise<void> {
  const dir = join(CUSTOM_MCP_DIR, entry.name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'index.js'), indexJs, 'utf-8')
  await writeFile(join(dir, 'package.json'), packageJson, 'utf-8')
  await writeFile(join(dir, 'config.json'), JSON.stringify(entry, null, 2), 'utf-8')

  const registry = await readRegistry()
  const existing = registry.findIndex(e => e.name === entry.name)
  if (existing >= 0) registry[existing] = entry
  else registry.push(entry)
  await writeRegistry(registry)
}

export async function writeCustomMcpCredentials(name: string, credentials: Record<string, string>): Promise<void> {
  const dir = join(CUSTOM_MCP_DIR, name)
  if (!existsSync(dir)) throw new Error(`Custom MCP not found: ${name}`)
  const envContent = Object.entries(credentials)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  await writeFile(join(dir, '.env'), envContent, 'utf-8')

  // Mark as connected in registry
  const registry = await readRegistry()
  const entry = registry.find(e => e.name === name)
  if (entry) {
    entry.connected = true
    await writeRegistry(registry)
  }
}

export async function disconnectCustomMcp(name: string): Promise<void> {
  const registry = await readRegistry()
  const entry = registry.find(e => e.name === name)
  if (entry) {
    entry.connected = false
    await writeRegistry(registry)
  }
}

export async function deleteCustomMcp(name: string): Promise<void> {
  const dir = join(CUSTOM_MCP_DIR, name)
  if (existsSync(dir)) await rm(dir, { recursive: true })
  const registry = await readRegistry()
  await writeRegistry(registry.filter(e => e.name !== name))
}

export function hasCredentials(name: string): boolean {
  const envPath = join(CUSTOM_MCP_DIR, name, '.env')
  if (!existsSync(envPath)) return false
  try {
    const content = require('fs').readFileSync(envPath, 'utf-8')
    return content.trim().length > 0
  } catch { return false }
}

export function getCustomMcpDir(name: string): string {
  return join(CUSTOM_MCP_DIR, name)
}

/** Load .env for a custom MCP and return as env vars record */
export function loadCustomMcpEnv(name: string): Record<string, string> {
  const envPath = join(CUSTOM_MCP_DIR, name, '.env')
  if (!existsSync(envPath)) return {}
  const parsed = dotenvConfig({ path: envPath, override: true })
  return (parsed.parsed ?? {}) as Record<string, string>
}

/** Build MCPServerConfig for all connected custom MCPs */
export async function getCustomMcpConfigs(): Promise<MCPServerConfig[]> {
  const registry = await readRegistry()
  const configs: MCPServerConfig[] = []
  for (const entry of registry) {
    if (!entry.connected || !hasCredentials(entry.name)) continue
    const dir = getCustomMcpDir(entry.name)
    const indexPath = join(dir, 'index.js')
    if (!existsSync(indexPath)) continue
    configs.push({
      name: `custom:${entry.name}`,
      command: 'node',
      args: [indexPath],
      env: loadCustomMcpEnv(entry.name)
    })
  }
  return configs
}

/** Get Integration objects for the integrations modal */
export async function getCustomIntegrations(): Promise<Array<{
  slug: string; name: string; connected: boolean; category: string;
  description: string; capabilities: string; custom: boolean
}>> {
  const registry = await readRegistry()
  return registry.map(e => ({
    slug: `custom:${e.name}`,
    name: e.displayName,
    connected: e.connected,
    category: 'Custom',
    description: e.description,
    capabilities: e.capabilities.join(', '),
    custom: true
  }))
}
```

**Step 2: Commit**

```bash
git add packages/agent-core/src/custom-mcp.ts
git commit -m "feat: add custom MCP registry module"
```

---

### Task 3: Server Integration — Connect Custom MCPs + Handle Messages

**Files:**
- Modify: `packages/agent-core/src/server.ts`

**Step 1: Import custom-mcp module**

At top of `server.ts`, add:

```typescript
import { readRegistry, writeCustomMcpCredentials, disconnectCustomMcp, deleteCustomMcp, getCustomMcpConfigs, getCustomIntegrations, addCustomMcp } from './custom-mcp.js'
```

**Step 2: Connect custom MCPs on startup**

After the existing MCP memory connection (after `buildMcpConfigs()` and the Composio setup block), add:

```typescript
// Connect custom MCPs on startup
getCustomMcpConfigs().then(async (configs) => {
  if (configs.length > 0) {
    console.log(`[Custom MCP] Connecting ${configs.length} custom integration(s)...`)
    await agent.mcpManager.connect(configs)
    console.log('[Custom MCP] Connected:', configs.map(c => c.name).join(', '))
    embedToolsFromMcp().catch(() => {})
  }
}).catch(err => console.error('[Custom MCP] Failed to connect:', err.message))
```

**Step 3: Merge custom integrations into sendIntegrations**

Modify the `sendIntegrations` function to merge custom integrations:

```typescript
async function sendIntegrations(ws: WebSocket): Promise<void> {
  let integrations: any[]
  if (!process.env.COMPOSIO_API_KEY) {
    integrations = INTEGRATIONS.map(({ slug, name, category, description, capabilities }) => ({ slug, name, category, description, capabilities, connected: false }))
  } else {
    integrations = await getIntegrationStatuses(process.env.COMPOSIO_API_KEY)
  }
  // Merge custom integrations
  const custom = await getCustomIntegrations()
  integrations = [...custom, ...integrations]
  send(ws, { type: 'integrations_update', integrations })
}
```

**Step 4: Handle custom integration connect (credentials submission)**

In the `integration_connect` handler, add a check for `custom:` prefix before the Composio logic:

```typescript
if (msg.type === 'integration_connect') {
  if (msg.slug.startsWith('custom:')) {
    const name = msg.slug.slice(7) // strip "custom:"
    if (msg.params) {
      // Credentials submitted — write .env and connect
      try {
        await writeCustomMcpCredentials(name, msg.params)
        const configs = await getCustomMcpConfigs()
        const config = configs.find(c => c.name === `custom:${name}`)
        if (config) {
          await agent.mcpManager.connect([config])
          embedToolsFromMcp().catch(() => {})
        }
        await sendIntegrations(ws)
      } catch (err: any) {
        send(ws, { type: 'error', message: err.message })
      }
    } else {
      // No params — send back the auth fields
      const registry = await readRegistry()
      const entry = registry.find(e => e.name === name)
      if (entry && entry.authFields.length > 0) {
        send(ws, { type: 'integration_needs_fields', slug: msg.slug, fields: entry.authFields })
      }
    }
    return
  }
  // ... existing Composio logic
}
```

**Step 5: Handle custom integration disconnect**

In the `integration_disconnect` handler, add a check:

```typescript
if (msg.type === 'integration_disconnect') {
  if (msg.slug.startsWith('custom:')) {
    const name = msg.slug.slice(7)
    try {
      // Close the MCP client
      const client = (agent.mcpManager as any).clients.get(`custom:${name}`)
      if (client) {
        await client.close().catch(() => {})
        ;(agent.mcpManager as any).clients.delete(`custom:${name}`)
        agent.mcpManager.invalidateToolCache()
      }
      await disconnectCustomMcp(name)
      await sendIntegrations(ws)
    } catch (err: any) {
      send(ws, { type: 'error', message: err.message })
    }
    return
  }
  // ... existing Composio logic
}
```

**Step 6: Handle custom integration delete**

Add a new handler for `custom_integration_delete`:

```typescript
if (msg.type === 'custom_integration_delete') {
  const name = msg.slug.startsWith('custom:') ? msg.slug.slice(7) : msg.slug
  try {
    const client = (agent.mcpManager as any).clients.get(`custom:${name}`)
    if (client) {
      await client.close().catch(() => {})
      ;(agent.mcpManager as any).clients.delete(`custom:${name}`)
      agent.mcpManager.invalidateToolCache()
    }
    await deleteCustomMcp(name)
    await sendIntegrations(ws)
  } catch (err: any) {
    send(ws, { type: 'error', message: err.message })
  }
}
```

**Step 7: Handle capability_confirm (from chat card)**

Add a handler that stores the confirmed capabilities so the agent can read them:

```typescript
if (msg.type === 'capability_confirm') {
  // Store confirmed capabilities for the agent's current MCP creation flow
  // The agent will pick these up via a pending confirmation mechanism
  ;(agent as any)._pendingCapabilities = msg.capabilities
}
```

**Step 8: Add a disconnect method to MCPManager**

In `packages/agent-core/src/mcp-manager.ts`, add a method to disconnect a single client:

```typescript
async disconnect(name: string): Promise<void> {
  const client = this.clients.get(name)
  if (client) {
    await client.close().catch(err => console.warn(`[MCP] Error closing ${name}:`, (err as Error).message))
    this.clients.delete(name)
    this.cacheVersion++
    this.toolCache = null
  }
}
```

**Step 9: Build agent-core**

Run: `cd packages/agent-core && pnpm build`
Expected: Clean build.

**Step 10: Commit**

```bash
git add packages/agent-core/src/server.ts packages/agent-core/src/mcp-manager.ts
git commit -m "feat: custom MCP server lifecycle in server.ts + MCPManager.disconnect()"
```

---

### Task 4: Capability Card — Frontend Chat Component

**Files:**
- Create: `apps/desktop/src/components/CapabilityCard.tsx`
- Modify: `apps/desktop/src/components/ChatPane.tsx` (or wherever chat messages render)
- Modify: `apps/desktop/src/hooks/useAgent.ts`

**Step 1: Create CapabilityCard component**

```tsx
import React, { useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Capability {
  name: string
  description: string
  checked: boolean
}

interface CapabilityCardProps {
  name: string
  capabilities: Capability[]
  onConfirm: (selected: string[]) => void
}

export function CapabilityCard({ name, capabilities, onConfirm }: CapabilityCardProps) {
  const [items, setItems] = useState(capabilities)
  const [confirmed, setConfirmed] = useState(false)

  function toggle(idx: number) {
    if (confirmed) return
    setItems(prev => prev.map((item, i) => i === idx ? { ...item, checked: !item.checked } : item))
  }

  function handleConfirm() {
    const selected = items.filter(i => i.checked).map(i => i.name)
    if (selected.length === 0) return
    setConfirmed(true)
    onConfirm(selected)
  }

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 p-4 max-w-md">
      <p className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-200 mb-3">
        Set up {name} — select capabilities:
      </p>
      <div className="flex flex-col gap-1.5 mb-4">
        {items.map((cap, i) => (
          <button
            key={cap.name}
            type="button"
            onClick={() => toggle(i)}
            disabled={confirmed}
            className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors',
              cap.checked
                ? 'bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800'
                : 'bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700',
              !confirmed && 'hover:border-neutral-300 dark:hover:border-neutral-600'
            )}
          >
            <div className={cn(
              'w-4 h-4 rounded border flex items-center justify-center flex-shrink-0',
              cap.checked
                ? 'bg-emerald-500 border-emerald-500'
                : 'border-neutral-300 dark:border-neutral-600'
            )}>
              {cap.checked && <Check size={10} className="text-white" strokeWidth={3} />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">{cap.name}</p>
              <p className="text-[11px] text-neutral-400 dark:text-neutral-500">{cap.description}</p>
            </div>
          </button>
        ))}
      </div>
      {!confirmed ? (
        <button
          type="button"
          onClick={handleConfirm}
          disabled={items.every(i => !i.checked)}
          className="text-[13px] font-medium px-4 py-2 rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Confirm
        </button>
      ) : (
        <p className="text-[12px] text-emerald-500 font-medium">Confirmed — building integration...</p>
      )}
    </div>
  )
}
```

**Step 2: Add capability_card state to useAgent hook**

In `apps/desktop/src/hooks/useAgent.ts`, add state and handler:

```typescript
// State
const [capabilityCard, setCapabilityCard] = useState<{ name: string; capabilities: { name: string; description: string; checked: boolean }[] } | null>(null)

// In message handler
if (msg.type === 'capability_card') {
  setCapabilityCard({ name: msg.name, capabilities: msg.capabilities })
}

// Confirm handler
const confirmCapabilities = useCallback((selected: string[]) => {
  send({ type: 'capability_confirm', capabilities: selected })
  setCapabilityCard(null)
}, [send])
```

Return `capabilityCard` and `confirmCapabilities` from the hook.

**Step 3: Render CapabilityCard in ChatPane**

In the chat message rendering area, after the last assistant message, render the card if present:

```tsx
{capabilityCard && (
  <CapabilityCard
    name={capabilityCard.name}
    capabilities={capabilityCard.capabilities}
    onConfirm={confirmCapabilities}
  />
)}
```

**Step 4: Commit**

```bash
git add apps/desktop/src/components/CapabilityCard.tsx apps/desktop/src/hooks/useAgent.ts apps/desktop/src/components/ChatPane.tsx
git commit -m "feat: capability confirmation card in chat"
```

---

### Task 5: Integrations Modal — Show Custom Integrations with Delete

**Files:**
- Modify: `apps/desktop/src/components/IntegrationsModal.tsx`
- Modify: `apps/desktop/src/hooks/useAgent.ts`

**Step 1: Add onDelete prop to IntegrationsModal**

Add `onDelete` callback to the props:

```typescript
interface IntegrationsModalProps {
  open: boolean
  onClose: () => void
  integrations: Integration[]
  onConnect: (slug: string, params?: Record<string, string>) => void
  onDisconnect: (slug: string) => void
  onDelete?: (slug: string) => void  // new — only for custom integrations
  pendingFields: PendingFields | null
  onClearPendingFields: () => void
}
```

**Step 2: Show "Custom" category at top**

The existing category grouping already handles this — custom integrations come with `category: 'Custom'`. To ensure "Custom" sorts first, modify the grouped map iteration:

```typescript
// Sort categories: "Custom" first, then alphabetical
const sortedCategories = [...grouped.keys()].sort((a, b) => {
  if (a === 'Custom') return -1
  if (b === 'Custom') return 1
  return a.localeCompare(b)
})
```

Then iterate `sortedCategories` instead of `grouped.entries()`.

**Step 3: Use a generic icon for custom integrations**

In the grid card, check `integration.custom`:

```tsx
{integration.custom ? (
  <div className="w-5 h-5 rounded bg-neutral-200 dark:bg-neutral-700 flex items-center justify-center flex-shrink-0">
    <span className="text-[10px]">+</span>
  </div>
) : (
  <img src={`https://logos.composio.dev/api/${integration.slug}`} ... />
)}
```

Same pattern in the detail view icon (10x10 version).

**Step 4: Add Delete button in detail view for custom integrations**

Below the existing Disconnect button, add:

```tsx
{detailIntegration.custom && (
  <button
    type="button"
    onClick={() => { onDelete?.(detailIntegration.slug); handleBackToGrid() }}
    className="text-[13px] font-medium px-4 py-2 rounded-xl text-red-500 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950 transition-colors"
  >
    Delete
  </button>
)}
```

**Step 5: Wire up onDelete in useAgent and App**

In `useAgent.ts`:

```typescript
const deleteCustomIntegration = useCallback((slug: string) => send({ type: 'custom_integration_delete', slug }), [send])
```

Pass this through to the modal in `App.tsx`.

**Step 6: Commit**

```bash
git add apps/desktop/src/components/IntegrationsModal.tsx apps/desktop/src/hooks/useAgent.ts apps/desktop/src/App.tsx
git commit -m "feat: show custom integrations in modal with delete support"
```

---

### Task 6: Install MCP SDK Dependency in agent-core

**Files:**
- Modify: `packages/agent-core/package.json`

**Step 1: Verify MCP SDK is available**

The MCP SDK is already used by agent-core (it imports from `@modelcontextprotocol/sdk/client/`). The `dotenv` package is also already available. No new dependencies needed for the custom-mcp module.

Verify by checking: `cd packages/agent-core && pnpm list @modelcontextprotocol/sdk dotenv`

**Step 2: Build everything**

```bash
cd packages/shared && pnpm build && cd ../agent-core && pnpm build
```

Expected: Clean build, all new types and modules compile.

**Step 3: Commit if any package.json changes were needed**

---

### Task 7: End-to-End Smoke Test

**Step 1: Start the dev server**

```bash
cd apps/desktop && pnpm tauri dev
```

**Step 2: Verify integrations modal**

Open integrations modal. Verify:
- No errors in console
- If no custom MCPs exist, modal looks exactly the same as before
- "Custom" category would appear at top if entries existed

**Step 3: Verify server startup**

Check terminal output for:
- `[Custom MCP] Connecting 0 custom integration(s)...` or no message (both OK)
- No errors related to custom-mcp.ts

**Step 4: Commit any fixes**

---

## File Summary

| File | Action | Purpose |
|------|--------|---------|
| `packages/shared/src/index.ts` | Modify | Add `custom` to Integration, new WS message types |
| `packages/agent-core/src/custom-mcp.ts` | Create | Registry CRUD, credential storage, MCP config builder |
| `packages/agent-core/src/mcp-manager.ts` | Modify | Add `disconnect(name)` method |
| `packages/agent-core/src/server.ts` | Modify | Connect custom MCPs on startup, handle custom: prefix routing, merge into integrations |
| `apps/desktop/src/components/CapabilityCard.tsx` | Create | Chat card with checkboxes for capability confirmation |
| `apps/desktop/src/components/IntegrationsModal.tsx` | Modify | Custom category, generic icon, delete button |
| `apps/desktop/src/hooks/useAgent.ts` | Modify | capability_card state, confirm/delete handlers |
| `apps/desktop/src/App.tsx` | Modify | Pass onDelete to IntegrationsModal |
