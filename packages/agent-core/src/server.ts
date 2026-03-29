import { config } from 'dotenv'
import { WebSocketServer, WebSocket } from 'ws'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync, accessSync, constants } from 'fs'
import { Agent } from './agent.js'
import { MCPServerConfig } from './mcp-manager.js'
import { setupComposioMcp } from './composio-setup.js'
import { INTEGRATIONS, getIntegrationStatuses, generateAuthUrl, getRequiredFields, disconnectIntegration, getConnectedSlugs, subscribeTriggersForSlug, subscribeSingleTrigger, purgeExpiredAccounts, getAvailableTriggersForSlug, getSubscribedTriggers, setTriggerEnabled } from './composio-integrations.js'
import { startScheduler } from './scheduler.js'
import { readSettings, writeSettings } from './settings.js'

import { listFiles, listFolders, ingestFile, deleteFileEntry, createFolder, moveFile, moveFolder, renameFile, renameFolder, deleteFolder, saveFolderOrder, searchFiles, autoOrganizeFiles } from './file-store.js'
import { embedTools, setToolEmbeddingsDir } from './tool-embeddings.js'
import { writeRelayCredentials, getRelayConfig, getOpenAIProxy, loadApiKeysToEnv } from './auth.js'
import { getUsageSummary } from './usage-tracker.js'

/** Returns the relay token for Composio API calls */
function composioKey(): string | undefined {
  return process.env.RELAY_TOKEN
}

/** Returns the per-user Composio entity ID — relay user ID when available, otherwise 'default' */
function composioUserId(): string {
  return process.env.RELAY_USER_ID || 'default'
}

import { RelayClient } from './relay-client.js'
import { WhatsAppClient, WhatsAppMedia } from './whatsapp-client.js'
import type { WSClientMessage, WSServerMessage } from '@coagent/shared'
import { join } from 'path'
import { homedir } from 'os'
import { readRegistry, writeCustomMcpCredentials, disconnectCustomMcp, deleteCustomMcp, getCustomMcpConfigs, getCustomIntegrations, readCustomMcpCode, updateCustomMcpCode, getCustomMcpDir } from './custom-mcp.js'

// Load from ~/.coagent/.env — the secure isolated folder on the user's machine.
// loadApiKeysToEnv runs first so any keys already in process.env (e.g. from the
// shell) are respected; dotenv fills in whatever remains.
loadApiKeysToEnv(join(homedir(), '.coagent'))
config({ path: join(homedir(), '.coagent', '.env') })

// ── OpenAI TTS helper ─────────────────────────────────────────────────────────
function stripMdForTts(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, '')         // remove code blocks
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/\n+/g, ' ')
    .trim()
}

/** Extract a short TTS-friendly summary — max ~200 chars, first 1-2 sentences */
function ttsSnippet(s: string): string {
  const clean = stripMdForTts(s)
  if (!clean) return ''
  // Try to grab first 2 sentences
  const re = /[.!?](?:\s|$)/g
  let count = 0, lastEnd = 0, m: RegExpExecArray | null
  while ((m = re.exec(clean)) !== null) {
    count++
    lastEnd = m.index + 1
    if (count >= 2) break
  }
  const snippet = count >= 1 ? clean.slice(0, lastEnd) : clean
  // Hard cap at 250 chars — cut at last word boundary
  if (snippet.length <= 250) return snippet
  const cut = snippet.slice(0, 250).replace(/\s\S*$/, '')
  return cut + '.'
}

async function generateTts(text: string, voice?: string): Promise<string | null> {
  const proxy = getOpenAIProxy()
  if (!proxy) { console.log('[TTS] No relay configured'); return null }
  const clean = ttsSnippet(text)
  if (!clean) { console.log('[TTS] No text after cleanup'); return null }
  const ttsVoice = voice || 'alloy'
  console.log('[TTS] Generating audio (voice: %s) for:', ttsVoice, clean.slice(0, 80))
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Authorization': proxy.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', input: clean, voice: ttsVoice, response_format: 'mp3' }),
    })
    if (!res.ok) {
      console.error('[TTS] Error:', res.status, await res.text())
      return null
    }
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.toString('base64')
  } catch (err: any) {
    console.error('[TTS] Failed:', err.message)
    return null
  }
}

/** Stream TTS audio — sends chunks over WebSocket as they arrive from OpenAI */
async function streamTts(text: string, voice: string | undefined, sendFn: (msg: any) => void): Promise<void> {
  const proxy = getOpenAIProxy()
  if (!proxy) return
  const clean = stripMdForTts(text)
  if (!clean) return
  const ttsVoice = voice || 'alloy'
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Authorization': proxy.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', input: clean, voice: ttsVoice, response_format: 'mp3' }),
    })
    if (!res.ok || !res.body) return
    const reader = res.body.getReader()
    let seq = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      sendFn({ type: 'voice_tts_chunk', seq, data: Buffer.from(value).toString('base64') })
      seq++
    }
    sendFn({ type: 'voice_tts_done' })
  } catch (err: any) {
    console.error('[TTS] Stream failed:', err.message)
  }
}

// Prevent MCP stdio errors from crashing the server when a child process dies.
// The MCP SDK's StdioClientTransport emits 'error' on the child's Socket which
// becomes an uncaughtException if unhandled. Catch pipe/stream errors broadly.
process.on('uncaughtException', (err: any) => {
  const code = err?.code
  const msg = err?.message ?? ''
  const isStreamError =
    code === 'EPIPE' ||
    code === 'ECONNRESET' ||
    code === 'ERR_STREAM_DESTROYED' ||
    code === 'ERR_STREAM_WRITE_AFTER_END' ||
    (err?.syscall === 'write' && (code === 'EPIPE' || code === 'ECONNRESET')) ||
    msg.includes('EPIPE') ||
    msg.includes('write after end') ||
    msg.includes('stream destroyed')
  if (isStreamError) {
    console.error(`[Server] Stream error caught (${code ?? msg.slice(0, 60)}) — continuing`)
    return
  }
  console.error('[Server] Uncaught exception:', err)
  process.exit(1)
})

process.on('unhandledRejection', (reason: any) => {
  const code = reason?.code
  const msg = reason?.message ?? ''
  const isStreamError =
    code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED' ||
    msg.includes('EPIPE') || msg.includes('stream destroyed')
  if (isStreamError) {
    console.error(`[Server] Unhandled stream rejection (${code ?? msg.slice(0, 60)}) — continuing`)
    return
  }
  console.error('[Server] Unhandled rejection:', reason)
})

const PORT = parseInt(process.env.COAGENT_PORT ?? '7830')

// Resolve MCP memory server — use sidecar binary if available, else node
function resolveMcpMemory(): { command: string; args: string[] } {
  const { dirname } = require('path') as typeof import('path')
  // When compiled as a sidecar, the memory binary lives next to the server binary
  const sidecarPath = join(dirname(process.execPath), 'coagent-memory')
  if (existsSync(sidecarPath)) {
    return { command: sidecarPath, args: [] }
  }
  // Fallback for dev mode: use node
  const mcpMemoryPath = require.resolve('@coagent/mcp-memory')
  return { command: 'node', args: [mcpMemoryPath] }
}

function resolveMcpImessage(): { command: string; args: string[] } {
  const { dirname } = require('path') as typeof import('path')
  const sidecarPath = join(dirname(process.execPath), 'coagent-imessage')
  if (existsSync(sidecarPath)) {
    return { command: sidecarPath, args: [] }
  }
  const mcpPath = require.resolve('@coagent/mcp-imessage')
  return { command: 'node', args: [mcpPath] }
}

function resolveMcpContacts(): { command: string; args: string[] } {
  const { dirname } = require('path') as typeof import('path')
  const sidecarPath = join(dirname(process.execPath), 'coagent-contacts')
  if (existsSync(sidecarPath)) {
    return { command: sidecarPath, args: [] }
  }
  const mcpPath = require.resolve('@coagent/mcp-contacts')
  return { command: 'node', args: [mcpPath] }
}

function canAccessChatDb(): boolean {
  try {
    accessSync(join(homedir(), 'Library', 'Messages', 'chat.db'), constants.R_OK)
    return true
  } catch {
    return false
  }
}

function canAccessAddressBook(): boolean {
  try {
    accessSync(join(homedir(), 'Library', 'Application Support', 'AddressBook', 'AddressBook-v22.abcddb'), constants.R_OK)
    return true
  } catch {
    return false
  }
}

function buildMcpConfigs(): MCPServerConfig[] {
  const mem = resolveMcpMemory()
  return [
    {
      name: 'memory',
      command: mem.command,
      args: mem.args,
      env: {
        COAGENT_DATA_DIR: join(homedir(), '.coagent'),
        ...(process.env.RELAY_URL ? { RELAY_URL: process.env.RELAY_URL } : {}),
        ...(process.env.RELAY_TOKEN ? { RELAY_TOKEN: process.env.RELAY_TOKEN } : {})
      } as Record<string, string>
    }
  ]
}

const DATA_DIR = join(homedir(), '.coagent')

// --- Default memory files (written on first run, never overwritten) ---

const SETUP_MD_STATIC = `# About CoAgent

CoAgent is a personal AI assistant that runs privately on your computer. Nothing leaves your machine except calls to Claude (the AI) and the tools you've connected. No data is stored in the cloud.

## How I work

**I stay in the background.** I sit quietly until something needs attention or you talk to me directly.

**I check in on a heartbeat.** At a configurable interval (default: every hour), I look at your connected tools (email, calendar, etc.) for anything that needs your attention. If nothing is going on, I skip it and wait.

**I log all tool calls.** When I use any connected tool, I log a summary of what was done. This helps me build context about your activity across all integrations.

**Every night at 3 AM, a background job runs.** The machine is scheduled to wake from sleep for this. A single Haiku call handles two things:
1. **Memory updates** — New contacts, projects, and relationships from the day's tool logs are added to memory. Only durable facts are stored (people, ongoing partnerships, recurring commitments). One-off events are not stored.
2. **Memory cleanup** — Stale or resolved entries are pruned, duplicates consolidated, outdated info removed.

**I ask before doing anything risky.** If I'm about to do something that can't be undone — like sending an email or deleting something — I'll queue it up for you to approve first.

**I keep a schedule.** Routines (recurring cron), tasks (one-time with due time), and followups (check-back reminders) all live in one schedule. Routines fire on their cron schedule. Tasks and followups fire at their due time. Everything is managed through chat.

**I manage files.** Users can upload files (PDF, DOCX, XLSX, images, etc.) which are summarized and embedded for semantic search. An "Auto-organize" button clusters loose files into named folders using embeddings — files already in folders are left alone.

**I track usage.** All API calls (chat, file ingestion, nightly job) are tracked with token counts and estimated costs, viewable in Settings → Usage.

**Skills.** Users can create reusable automations (e.g. daily briefing, follow-ups, weekly recaps) with @skill-creator. Skills are invoked by typing @skill-name in chat.

## My tools

Consolidated tools — each handles multiple actions via an \`action\` parameter:
- **memory** (search/grep/read/write/edit/append/list/delete) — long-term memory. Use directly, never via search_tools. Prefer search (semantic) or grep (pattern match within a file) over read.
- **files** (list/search/read/delete/stats) — uploaded file management.
- **schedule** (create/update/delete/complete/list) — unified schedule for routines (recurring cron), tasks (one-time due), and followups (check-back reminders that fire like tasks).
- **skills** (save/list/delete/execute) — reusable automations. Use execute to run a skill by name — loads its full instructions for you to follow.
- **search_tools** — find and load external service tools (Gmail, Calendar, Slack, etc.). Optional "context" param greps recent tool logs for activity context.
- **queue_approval** / **add_done_item** — approval queue and activity log.

When multiple independent tool calls are needed, batch them in a single response (e.g. memory read + schedule list + get_current_time in one turn).

**Token efficiency:** Old tool results are automatically compacted after 2 conversation turns — raw data gets truncated but my text responses (which contain the processed info) stay intact. This keeps history lean without losing context.

## My memory

Notes in \`~/.coagent/memory/\` — my brain across conversations.

- **setup.md** — this file (read-only).
- **agent.md** — user profile: who you are, preferences, how to handle things.
- **routines.md** — heartbeat schedule: what to check and when.
- **preferences.md** — tone, format, behavior preferences.
- **contacts.md** — key people and how to handle their messages.
- **projects.md** — active projects, context, deadlines.

Updated as we work together. User can edit directly.

**Off-limits to the 3 AM job:** setup.md, agent.md, routines.md, preferences.md — only the user or main agent edits these.

## What I can always do

Even without any apps connected, I can help with writing, research, math, analysis, and general questions.`

function buildSetupMd(connectedSlugs: string[]): string {
  if (connectedSlugs.length === 0) {
    return SETUP_MD_STATIC + '\n\n## Connected tools\n\nNo integrations connected yet. The user can connect apps in Settings.\n'
  }
  const slugNames: Record<string, string> = {
    gmail: 'Gmail', googlecalendar: 'Google Calendar', slack: 'Slack',
    github: 'GitHub', linkedin: 'LinkedIn', youtube: 'YouTube',
    calendly: 'Calendly', googlesheets: 'Google Sheets', excel: 'Excel',
    google_maps: 'Google Maps', googledrive: 'Google Drive', notion: 'Notion',
    hubspot: 'HubSpot', outlook: 'Outlook', teams: 'Microsoft Teams',
    salesforce: 'Salesforce', shopify: 'Shopify', clickup: 'ClickUp',
    dropbox: 'Dropbox', zoom: 'Zoom', monday: 'Monday',
  }
  const names = connectedSlugs.map(s => slugNames[s] ?? s)
  return SETUP_MD_STATIC + `\n\n## Connected tools\n\nCurrently connected: ${names.join(', ')}\n`
}

async function updateSetupMd(connectedSlugs: string[]): Promise<void> {
  const memDir = join(DATA_DIR, 'memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(join(memDir, 'setup.md'), buildSetupMd(connectedSlugs), 'utf-8')
}

const MEMORY_FILES: Record<string, string> = {
  'setup.md': buildSetupMd([]),

  'onboarding.md': `# Onboarding

This file exists because the user hasn't set up their profile yet. Follow these instructions, then delete this file when done.

## Step 1: Introduction

Start with this exact opening, then immediately ask the first question:

"Hey, I'm CoAgent — your personal AI agent running privately on your machine. I work best once I know a bit about you, so let me ask a few quick questions.

What do you do for work?"

## Step 2: Get to know them

Ask follow-up questions ONE AT A TIME based on what they share. Cover:
1. What they do and who they work with (clients, team, solo?)
2. What takes up most of their time or causes the most friction day-to-day
3. What they'd most want an AI agent handling for them automatically
4. Which of their connected tools (check setup.md for the list) they actually use daily and want monitored
5. How hands-off they want it — what should CoAgent just handle vs. always ask first

Do NOT ask all questions at once. One question per message. Listen and ask smarter follow-ups — if they mention clients, ask about that. If they mention email overload, dig into that.

## Step 3: Write their profile

When you have a clear picture, write their profile to agent.md:

# [their name if given, otherwise "You"]
**About**: [what they do, in their words]
**Focus**: [top 1-2 things they want help with]

## How I work
- Handle automatically: [list]
- Always ask first: [list]

## What to monitor
- [tool]: [what to watch for]

## Step 4: Wrap up

End with: "Got it. I'll run in the background and surface anything that needs you.

Tip: type @skill-creator anytime to build custom automations — like a daily briefing, auto follow-ups, or weekly recaps."

Then delete this file (onboarding.md) — onboarding is complete.
`,

  'routines.md': `# Routines

## Every heartbeat

## Morning

## Evening

## Weekly
`,

  'preferences.md': `# Preferences

## Communication

## Emails

## Documents

## Actions
`,

  'contacts.md': `# Contacts
`,

  'projects.md': `# Projects
`,
}

async function writeMemoryFiles(): Promise<void> {
  const memDir = join(DATA_DIR, 'memory')
  await mkdir(memDir, { recursive: true })
  for (const [filename, content] of Object.entries(MEMORY_FILES)) {
    const filePath = join(memDir, filename)
    if (!existsSync(filePath)) {
      await writeFile(filePath, content, 'utf-8')
    }
  }
}

writeMemoryFiles().catch(err => console.error('[Server] Failed to write memory files:', err.message))

// ── Default skills (shipped with the app, read-only) ─────────────────────────
const DEFAULT_SKILLS: Record<string, { name: string; description: string; instructions: string }> = {
  'skill-creator': {
    name: 'skill-creator',
    description: 'Build custom skills to automate your workflows — @skill-creator to start',
    instructions: `The user wants to create a custom skill. Ask what they want to automate (one question at a time), then build it with save_skill.

A good skill has: a kebab-case name, a one-line description, and instructions that specify exactly which tools to call and in what order. Use actual tool names. No filler.

After saving: "Done. Type @skill-name anytime to use it."

Examples to suggest if they need ideas:
- daily-briefing: Pull calendar, unread emails, Slack DMs, and to-dos. Present what needs action.
- follow-up: Search Gmail/Slack for recent context with a person, draft a follow-up email. Queue for approval.
- client-recap: Search all integrations for a client name over the last 7 days. Timeline + open items.
- weekly-recap: Summarize the week across calendar, email, Slack, to-dos. End with loose ends.
- schedule-meeting: Check calendar availability, suggest slots, draft invite email. Queue for approval.`
  },
  'integration-builder': {
    name: 'integration-builder',
    description: 'Create custom integrations from any API — @integration-builder to start',
    instructions: `The user wants to connect a new API as a custom integration. Follow these steps exactly:

## Step 1: Identify the API

Ask what service they want to connect, or infer from context. Get:
- The service name (e.g. "Notion", "Airtable", "Stripe")
- What they want to do with it (optional — helps filter capabilities)

## Step 2: Research the API

Use search_tools("web search") to find a web search tool, then search for the API documentation. Look for:
- Base URL and authentication method (API key, Bearer token, etc.)
- Available endpoints and what they do
- Request/response formats

## Step 3: Propose capabilities

Based on the API docs, call create_custom_integration with:
- action: "propose"
- name: kebab-case (e.g. "notion")
- display_name: human name (e.g. "Notion")
- capabilities: array of {name, description} for each action the integration can do

Example:
create_custom_integration({
  action: "propose",
  name: "notion",
  display_name: "Notion",
  capabilities: [
    { name: "Search pages", description: "Search across all pages and databases" },
    { name: "Create page", description: "Create a new page in a database" },
    { name: "Get page", description: "Read a page's content and properties" }
  ]
})

Then tell the user to review and confirm the capabilities.

## Step 4: Generate MCP server code

After the user confirms capabilities, generate an MCP server following this EXACT template:

\`\`\`javascript
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

process.stdout.on('error', (err) => { if (err?.code === 'EPIPE') process.exit(0) })
process.on('uncaughtException', (err) => {
  if (err?.code === 'EPIPE' || err?.message?.includes('EPIPE')) process.exit(0)
  console.error('[ServerName] Uncaught:', err)
  process.exit(1)
})

const BASE_URL = 'https://api.example.com/v1'
const API_KEY = process.env.API_KEY // loaded from .env

const server = new Server(
  { name: 'coagent-custom-SERVICE_NAME', version: '0.0.1' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // One tool per confirmed capability
    {
      name: 'TOOL_NAME',
      description: 'What the tool does',
      inputSchema: {
        type: 'object',
        properties: {
          // Parameters from the API docs
        },
        required: []
      }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  try {
    if (name === 'TOOL_NAME') {
      const res = await fetch(\`\${BASE_URL}/endpoint\`, {
        method: 'POST',
        headers: {
          'Authorization': \`Bearer \${API_KEY}\`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(args)
      })
      if (!res.ok) throw new Error(\`API error: \${res.status} \${await res.text()}\`)
      const data = await res.json()
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }
    throw new Error(\`Unknown tool: \${name}\`)
  } catch (err) {
    return { content: [{ type: 'text', text: \`Error: \${err.message}\` }], isError: true }
  }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)
\`\`\`

CRITICAL RULES for generated code:
- Use native fetch() (Node 18+, no axios needed)
- Auth via process.env — the env var names MUST match the auth_fields names
- One tool per confirmed capability
- Always include EPIPE handlers
- Return JSON.stringify(data, null, 2) for API responses
- Handle errors with isError: true

## Step 5: Create the integration

Call create_custom_integration with action "create":
- name, display_name, description
- capabilities: confirmed list
- auth_fields: credentials needed — ALWAYS include help_url (direct link) and help_text (short step-by-step) for each field (e.g. [{name: "API_KEY", display_name: "API Key", description: "Your Notion integration token", help_url: "https://www.notion.so/my-integrations", help_text: "Go to notion.so/my-integrations → New integration → copy the Internal Integration Secret"}])
- code: the generated index.js
- dependencies: {} (only @modelcontextprotocol/sdk is needed, it's added automatically)

## Step 6: Done

The system will prompt the user for credentials automatically. Tell them:
"Done! Enter your API key in the form that just appeared. Once connected, I'll be able to use [service] tools automatically."

## Iteration — fixing and improving

If a custom integration tool fails when the user tries it, you can fix it:

1. Read the current code: create_custom_integration({ action: "read", name: "service-name" })
2. Fix the issue in the code
3. Update it: create_custom_integration({ action: "update", name: "service-name", code: "..." })
   - The MCP server restarts automatically after update
   - If dependencies changed, pass dependencies: {} to re-run npm install

Start simple (1-2 tools), get it working, then iterate to add more capabilities.

## Important
- The generated code is JavaScript (not TypeScript) — it runs directly with node
- Always use the exact MCP SDK import paths shown in the template
- Keep tool names UPPERCASE_SNAKE_CASE matching the service (e.g. NOTION_SEARCH_PAGES)
- Match the existing naming convention from Composio tools`
  }
}

async function writeDefaultSkills(): Promise<void> {
  const dir = join(DATA_DIR, 'skills')
  await mkdir(dir, { recursive: true })
  for (const [filename, skill] of Object.entries(DEFAULT_SKILLS)) {
    const filePath = join(dir, `${filename}.json`)
    // Always write defaults — they're read-only and ship with the app
    await writeFile(filePath, JSON.stringify(skill, null, 2), 'utf-8')
  }
}

writeDefaultSkills().catch(err => console.error('[Server] Failed to write default skills:', err.message))

const agent = new Agent(buildMcpConfigs(), DATA_DIR)

let wss: WebSocketServer | null = null

const scheduler = startScheduler(agent, DATA_DIR, {
  onHeartbeat: (status, summary) => {
    broadcast({ type: 'heartbeat', status, summary })
  },
  onTodoStream: (type, data) => {
    if (type === 'start') {
      const label = `[To-do fired] ${data.task}`
      broadcast({ type: 'chat_response', message: { role: 'user', content: label, timestamp: new Date().toISOString() } })
      broadcast({ type: 'agent_thinking' })
    } else if (type === 'chunk') {
      broadcast({ type: 'chat_chunk', text: data.text })
    } else if (type === 'tool') {
      broadcast({ type: 'chat_segment_end' })
      broadcast({ type: 'tool_start', tool: data.tool, label: data.label })
    } else if (type === 'done') {
      broadcast({ type: 'chat_response', message: { role: 'assistant', content: data.response, timestamp: new Date().toISOString() } })
      broadcast({ type: 'queue_update', items: agent.queue.getPending() })
      broadcast({ type: 'done_update', items: agent.queue.getDone() })
      broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() })
    }
  }
})

agent.onNotifyUser = (title: string, body: string) => {
  broadcast({ type: 'push_notification', title, body } as any)
}

agent.onSettingsChanged = async () => {
  const settings = await readSettings(DATA_DIR)
  broadcast({ type: 'settings_update', settings })
  scheduler.rescheduleHeartbeat()
}

agent.onSkillsChanged = async () => {
  const skills = await agent.getSkills()
  broadcast({ type: 'skills_update', skills })
}

agent.onCustomIntegration = async (action, data) => {
  if (action === 'propose') {
    const caps = (data.capabilities || []).map((c: any) => ({ name: c.name, description: c.description, checked: true }))
    broadcast({ type: 'capability_card', name: data.display_name || data.name, capabilities: caps })
    return 'Capabilities proposed to the user. They will see checkboxes to confirm which capabilities they want. Ask them to review and confirm.'
  }

  if (action === 'create') {
    if (!data.code) return 'Error: code is required for create action.'
    if (!data.display_name) return 'Error: display_name is required for create action.'

    const name = data.name
    const displayName = data.display_name
    const description = data.description || ''
    const capabilities = (data.capabilities || []).map((c: any) => c.name)
    const authFields = (data.auth_fields || []).map((f: any) => ({
      name: f.name,
      displayName: f.display_name,
      description: f.description,
      helpUrl: f.help_url || undefined,
      helpText: f.help_text || undefined,
    }))

    const deps: Record<string, string> = {
      '@modelcontextprotocol/sdk': '^1.0.0',
      ...(data.dependencies || {})
    }
    const pkg = JSON.stringify({
      name: `coagent-custom-${name}`,
      version: '0.0.1',
      type: 'module',
      dependencies: deps
    }, null, 2)

    try {
      const { addCustomMcp, getCustomMcpDir } = await import('./custom-mcp.js')
      await addCustomMcp({
        name,
        displayName,
        description,
        capabilities,
        createdAt: new Date().toISOString(),
        connected: false,
        authFields,
        ...(data.icon ? { icon: data.icon } : {})
      }, data.code, pkg)

      // Run npm install
      const { execSync } = await import('child_process')
      const dir = getCustomMcpDir(name)
      console.log(`[Custom MCP] Installing dependencies in ${dir}...`)
      execSync('npm install --production', { cwd: dir, stdio: 'pipe', timeout: 60000 })
      console.log(`[Custom MCP] Dependencies installed for ${name}`)

      // Send credential form to frontend
      if (authFields.length > 0) {
        broadcast({ type: 'integration_needs_fields', slug: `custom:${name}`, fields: authFields })
      }

      // Refresh integrations list
      sendIntegrations(Array.from(wss!.clients)[0] as WebSocket).catch(() => {})

      return `Integration "${displayName}" created and dependencies installed. ${authFields.length > 0 ? 'The user has been prompted to enter their credentials.' : 'No credentials needed — connecting now.'}`
    } catch (err: any) {
      console.error(`[Custom MCP] Failed to create ${name}:`, err.message)
      return `Error creating integration: ${err.message}`
    }
  }

  if (action === 'read') {
    const code = readCustomMcpCode(data.name)
    if (!code) return `No custom integration found with name "${data.name}".`
    const stderr = agent.mcpManager.getStderr(`custom:${data.name}`)
    const stderrSection = stderr ? `\n\nRecent stderr output:\n\`\`\`\n${stderr}\n\`\`\`` : ''
    return `Current index.js for "${data.name}":\n\n\`\`\`javascript\n${code}\n\`\`\`${stderrSection}`
  }

  if (action === 'update') {
    if (!data.code) return 'Error: code is required for update action.'
    try {
      await updateCustomMcpCode(data.name, data.code)

      // If deps changed, re-run npm install
      if (data.dependencies) {
        const { readFile, writeFile } = await import('fs/promises')
        const dir = getCustomMcpDir(data.name)
        const pkgPath = `${dir}/package.json`
        const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'))
        pkg.dependencies = { '@modelcontextprotocol/sdk': '^1.0.0', ...data.dependencies }
        await writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8')
        const { execSync } = await import('child_process')
        execSync('npm install --production', { cwd: dir, stdio: 'pipe', timeout: 60000 })
      }

      // Restart the MCP if it's currently connected
      const slug = `custom:${data.name}`
      await agent.mcpManager.disconnect(slug)
      // Re-connect will happen on next tool call or we can trigger it now
      const configs = await getCustomMcpConfigs()
      const cfg = configs.find(c => c.name === slug)
      if (cfg) {
        await agent.mcpManager.connect([cfg])
        console.log(`[Custom MCP] Restarted ${slug} with updated code`)
        embedToolsFromMcp().catch(() => {})
      }

      return `Integration "${data.name}" updated and restarted.`
    } catch (err: any) {
      console.error(`[Custom MCP] Failed to update ${data.name}:`, err.message)
      return `Error updating integration: ${err.message}`
    }
  }

  return `Unknown action: ${action}`
}

const relay = new RelayClient(DATA_DIR)

// Track which slugs are currently loaded in MCP so we can detect changes
let currentMcpSlugs: string[] = []
let imessageConnected = false
let contactsConnected = false
let whatsappConnected = false
let whatsAppClient: WhatsAppClient | null = null
const whatsappQueue: { jid: string; name: string; text: string; media?: WhatsAppMedia }[] = []
let processingWhatsApp = false

async function transcribeAudio(buffer: Buffer, mimetype: string): Promise<string | null> {
  const proxy = getOpenAIProxy()
  if (!proxy) {
    console.log('[WhatsApp] No relay configured — cannot transcribe audio')
    return null
  }
  try {
    // WhatsApp sends ogg/opus; Whisper accepts ogg, mp3, wav, webm, etc.
    const ext = mimetype.includes('ogg') ? 'ogg' : mimetype.includes('mp4') ? 'mp4' : 'ogg'
    const blob = new Blob([new Uint8Array(buffer)], { type: mimetype })
    const form = new FormData()
    form.append('file', blob, `voice.${ext}`)
    form.append('model', 'whisper-1')
    form.append('language', 'en')
    form.append('temperature', '0.2')

    const res = await fetch(`${proxy.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': proxy.authHeader },
      body: form,
    })
    const data = await res.json() as { text?: string; error?: { message: string } }
    if (data.error) {
      console.error('[WhatsApp] Whisper error:', data.error.message)
      return null
    }
    return data.text?.trim() || null
  } catch (err: any) {
    console.error('[WhatsApp] Transcription failed:', err.message)
    return null
  }
}

async function processWhatsAppQueue(): Promise<void> {
  if (processingWhatsApp || whatsappQueue.length === 0) return
  processingWhatsApp = true

  // Keep machine awake while processing, then release
  let cafProc: any = null
  if (process.platform === 'darwin') {
    const { spawn } = require('child_process')
    cafProc = spawn('caffeinate', ['-is', '-t', '300'], { stdio: 'ignore', detached: false })
    cafProc.on('error', () => {})
  }

  const { jid, name, text, media } = whatsappQueue.shift()!

  const label = name || jid.replace(/@.*/, '')
  let messageText = text

  // Handle audio: transcribe to text
  if (media?.type === 'audio') {
    const transcription = await transcribeAudio(media.buffer, media.mimetype)
    if (transcription) {
      console.log(`[WhatsApp] Transcribed audio: ${transcription.slice(0, 80)}`)
      messageText = messageText ? `${messageText}\n\n[Voice note]: ${transcription}` : transcription
    } else {
      if (!messageText) {
        processingWhatsApp = false
        processWhatsAppQueue()
        return
      }
    }
  }

  // Handle image: encode as base64 for Claude vision
  let imageBase64: string | undefined
  let imageMime: string | undefined
  if (media?.type === 'image') {
    imageBase64 = media.buffer.toString('base64')
    imageMime = media.mimetype
    if (!messageText) messageText = 'What is this image?'
    console.log(`[WhatsApp] Image attached (${media.buffer.length} bytes)`)
  }

  const prompt = `[WhatsApp from ${label}]: ${messageText}\n\n(This is a WhatsApp message. No markdown in your reply.)`

  broadcast({ type: 'chat_response', message: { role: 'user', content: `[WhatsApp from ${label}]: ${messageText}`, timestamp: new Date().toISOString() } })
  broadcast({ type: 'agent_thinking' })

  try {
    let streamed = ''
    const extraContent = imageBase64 && imageMime
      ? [{ type: 'image', source: { type: 'base64', media_type: imageMime, data: imageBase64 } }]
      : undefined
    const response = await agent.chat(
      prompt,
      (chunk) => { streamed += chunk; broadcast({ type: 'chat_chunk', text: chunk }) },
      (tool, toolLabel) => { broadcast({ type: 'chat_segment_end' }); broadcast({ type: 'tool_start', tool, label: toolLabel }) },
      undefined,
      extraContent
    )
    const fullResponse = streamed || response
    broadcast({ type: 'chat_response', message: { role: 'assistant', content: fullResponse, timestamp: new Date().toISOString() } })
    broadcast({ type: 'queue_update', items: agent.queue.getPending() })
    broadcast({ type: 'done_update', items: agent.queue.getDone() })
    broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() })

    // Send response back to WhatsApp
    if (whatsAppClient?.isConnected) {
      await whatsAppClient.sendMessage(jid, fullResponse).catch(err =>
        console.error('[WhatsApp] Failed to send reply:', err.message)
      )
    }
  } catch (err: any) {
    console.error('[WhatsApp] Chat error:', err.message)
    broadcast({ type: 'error', message: `WhatsApp message failed: ${err.message}` })
    broadcast({ type: 'agent_stopped' })
  }

  if (cafProc) cafProc.kill()
  processingWhatsApp = false
  processWhatsAppQueue()
}

// Always-on toolkits that require no auth — loaded regardless of user connections
const ALWAYS_ON_TOOLKITS = ['composio_search', 'text_to_pdf']

/** Embed tools + params into LanceDB after MCP connects or refreshes */
async function embedToolsFromMcp(): Promise<void> {
  try {
    const { tools, serverMap } = await agent.mcpManager.getAllTools()
    // Embed non-memory tools (the ones search_tools searches over)
    const searchable = tools.filter(t => serverMap.get(t.name) !== 'memory')
    await embedTools(searchable)
  } catch (err: any) {
    console.warn('[Server] Tool embedding failed:', err.message)
  }
}

async function refreshComposioMcp(slugs: string[]): Promise<void> {
  // Merge with current slugs so we never drop recently-added integrations
  // (Composio may report them as not-yet-ACTIVE during OAuth flow)
  const mergedSlugs = [...new Set([...currentMcpSlugs, ...slugs])]
  const allToolkits = [...new Set([...ALWAYS_ON_TOOLKITS, ...mergedSlugs])]
  const { url, apiKey } = await setupComposioMcp(composioKey()!, allToolkits, composioUserId(), true)
  // Only reconnect the composio HTTP client — don't touch the memory MCP
  await agent.mcpManager.connectHttp('composio', url, apiKey)
  currentMcpSlugs = mergedSlugs
  updateSetupMd(mergedSlugs).catch(err => console.error('[Server] Failed to update setup.md:', err.message))
  console.log('[Composio] MCP refreshed with toolkits:', mergedSlugs.join(', '))
  // Embed new tools + params immediately so they're ready before the user types
  embedToolsFromMcp().catch(() => {})
}

if (composioKey()) {
  console.log('[Composio] API key present, initializing MCP connection...')
  // Clean up any stale expired accounts on boot to prevent duplicate buildup
  purgeExpiredAccounts(composioKey()!, composioUserId())
    .catch(err => console.error('[Composio] Failed to purge expired accounts:', err.message))

  getConnectedSlugs(composioKey()!, composioUserId()).then(async (slugs) => {
    console.log(`[Composio] Found ${slugs.length} connected integrations: ${slugs.join(', ') || 'none'}`)
    // Default to all supported integrations so tools are available even before user connects
    const userToolkits = slugs.length > 0 ? slugs : ['gmail', 'googlecalendar']
    const toolkits = [...new Set([...ALWAYS_ON_TOOLKITS, ...userToolkits])]
    const { url, apiKey } = await setupComposioMcp(composioKey()!, toolkits, composioUserId())
    console.log('[Composio] MCP URL obtained, connecting HTTP client...')
    await agent.mcpManager.connectHttp('composio', url, apiKey)
    currentMcpSlugs = userToolkits
    updateSetupMd(slugs).catch(err => console.error('[Server] Failed to update setup.md:', err.message))
    console.log('[Composio] MCP connected with toolkits:', toolkits.join(', '))
    // Embed tools + params on connect so they're ready before the first message
    setToolEmbeddingsDir(DATA_DIR)
    embedToolsFromMcp().catch(() => {})
  }).catch(err => console.error('[Composio] Failed to connect MCP:', err.message))
} else {
  console.log('[Composio] No API key found, skipping MCP connection')
}

// Connect custom MCPs on startup
getCustomMcpConfigs().then(async (configs) => {
  if (configs.length > 0) {
    console.log(`[Custom MCP] Connecting ${configs.length} custom integration(s)...`)
    await agent.mcpManager.connect(configs)
    console.log('[Custom MCP] Connected:', configs.map(c => c.name).join(', '))
    embedToolsFromMcp().catch(() => {})
  }
}).catch(err => console.error('[Custom MCP] Failed to connect:', err.message))

// Kill any stale process on the port before starting
try {
  const { execSync } = require('child_process')
  const pids = execSync(`lsof -ti:${PORT}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
  if (pids) {
    // Don't kill ourselves
    const myPid = String(process.pid)
    const stale = pids.split('\n').filter((p: string) => p !== myPid)
    if (stale.length > 0) {
      execSync(`kill -9 ${stale.join(' ')}`, { stdio: 'ignore' })
      console.log(`[Server] Killed stale process(es) on port ${PORT}: ${stale.join(', ')}`)
    }
  }
} catch {}

wss = new WebSocketServer({ host: '127.0.0.1', port: PORT })

relay.connect()

function send(ws: WebSocket, msg: WSServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(msg: WSServerMessage): void {
  if (!wss) return
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg))
  }
}

async function sendIntegrations(ws: WebSocket): Promise<void> {
  let integrations: any[]
  if (!composioKey()) {
    integrations = INTEGRATIONS.map(({ slug, name, category, description, capabilities }) => ({ slug, name, category, description, capabilities, connected: false }))
  } else {
    integrations = await getIntegrationStatuses(composioKey()!, composioUserId())
  }

  // Enrich Composio integrations with available trigger info
  const subscribedSet = getSubscribedTriggers()
  integrations = integrations.map(integration => {
    const availableTriggers = getAvailableTriggersForSlug(integration.slug)
    if (availableTriggers.length === 0) return integration
    const triggers = availableTriggers.map(t => ({
      slug: t.slug,
      label: t.label,
      appSlug: integration.slug,
      enabled: subscribedSet.has(t.slug),
    }))
    return { ...integration, triggers }
  })

  const custom = await getCustomIntegrations()
  const builtins: any[] = []
  // Mobile app — cross-platform, always shown
  builtins.push({
    slug: 'coagent:mobile',
    name: 'CoAgent Mobile',
    connected: false,
    category: 'CoAgent',
    description: 'Connect the CoAgent iOS app to your agent via relay. Scan the QR code to pair.',
    capabilities: 'Chat with your agent, Voice interaction, View queue and calendar',
    builtin: true
  })
  // WhatsApp — cross-platform, always shown
  builtins.push({
    slug: 'coagent:whatsapp',
    name: 'WhatsApp',
    connected: whatsappConnected,
    category: 'CoAgent',
    description: 'Receive and reply to WhatsApp messages through your agent. Pair with QR code.',
    capabilities: 'Receive messages, Reply to conversations, Cross-platform messaging',
    builtin: true
  })
  if (process.platform === 'darwin') {
    builtins.push({
      slug: 'coagent:imessage',
      name: 'iMessage',
      connected: imessageConnected,
      category: 'CoAgent',
      description: 'Read and send iMessages. Search conversations, get message history, send texts.',
      capabilities: 'Search messages, Get conversations, List recent chats, Send iMessages',
      builtin: true
    })
    builtins.push({
      slug: 'coagent:contacts',
      name: 'Contacts',
      connected: contactsConnected,
      category: 'CoAgent',
      description: 'Search and look up contacts from macOS Contacts. Find phone numbers, emails, addresses.',
      capabilities: 'Search contacts, Get contact details, List recent contacts',
      builtin: true
    })
  }
  integrations = [...builtins, ...custom, ...integrations]
  send(ws, { type: 'integrations_update', integrations })
}

async function sendFilesAndFolders(ws: WebSocket): Promise<void> {
  const [files, folders] = await Promise.all([listFiles(DATA_DIR), listFolders(DATA_DIR)])
  send(ws, { type: 'files_update', files })
  send(ws, { type: 'folders_update', folders })
}

async function sendRelayStatus(ws: WebSocket): Promise<void> {
  const relay = getRelayConfig()
  if (!relay) {
    send(ws, { type: 'relay_status', active: false, model: null, usage: null })
    return
  }
  const res = await fetch(`${relay.url}/v1/account`, {
    headers: { 'Authorization': `Bearer ${relay.token}` },
  })
  if (res.ok) {
    const data = await res.json() as { model: string; usage: any }
    send(ws, { type: 'relay_status', active: true, model: data.model, usage: data.usage })
  } else {
    send(ws, { type: 'relay_status', active: false, model: null, usage: null })
  }
}

/** Send full agent state to a single WebSocket connection. */
async function sendFullState(ws: WebSocket): Promise<void> {
  send(ws, { type: 'queue_update', items: agent.queue.getPending() })
  send(ws, { type: 'done_update', items: agent.queue.getDone() })
  send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
  const chatHistoryMsg = { type: 'chat_history' as const, messages: agent.getChatHistory() }
  const chatJson = JSON.stringify(chatHistoryMsg)
  console.log(`[Server] sendFullState chat_history: ${chatHistoryMsg.messages.length} msgs, ${chatJson.length} bytes`)
  ws.send(chatJson)
  sendIntegrations(ws).catch(console.error)
  sendFilesAndFolders(ws).catch(console.error)
  readSettings(DATA_DIR).then(settings => send(ws, { type: 'settings_update', settings })).catch(console.error)
  sendRelayStatus(ws).catch(console.error)
  agent.getSkills().then(skills => send(ws, { type: 'skills_update', skills })).catch(console.error)
}

/** Broadcast full agent state to all connected WebSocket clients. */
function broadcastFullState(): void {
  if (!wss) return
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      sendFullState(client as WebSocket).catch(console.error)
    }
  }
}

wss.on('connection', (ws) => {
  sendFullState(ws).catch(console.error)

  ws.on('message', async (raw) => {
    const msg: WSClientMessage = JSON.parse(raw.toString())

    if (msg.type === 'client_connected') {
      console.log('[Server] Remote client connected via relay — broadcasting full state')
      broadcastFullState()
      return
    }

    if (msg.type === 'get_chat_history') {
      const full = agent.getChatHistory()
      const history = full.slice(-50).map(m => ({
        ...m,
        content: m.content.length > 4000 ? m.content.slice(0, 4000) + '…' : m.content,
      }))
      const json = JSON.stringify({ type: 'chat_history', messages: history })
      console.log(`[Server] get_chat_history: ${full.length} total, sending ${history.length}, size=${json.length} bytes`)
      ws.send(json)
      return
    }

    if (msg.type === 'get_file_content') {
      console.log(`[Server] get_file_content id=${msg.id}`)
      const file = (await listFiles(DATA_DIR)).find(f => f.id === msg.id)
      if (!file) {
        console.log(`[Server] File not found: ${msg.id}`)
        send(ws, { type: 'file_content_error', id: msg.id, error: 'File not found' } as any)
        return
      }
      try {
        const { readFile } = await import('fs/promises')
        const buf = await readFile(file.path)
        const ext = file.filename.split('.').pop()?.toLowerCase() || ''
        const mimeMap: Record<string, string> = {
          pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
          txt: 'text/plain', csv: 'text/csv', json: 'application/json',
          mp3: 'audio/mpeg', mp4: 'video/mp4',
          md: 'text/markdown', doc: 'application/msword',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          xls: 'application/vnd.ms-excel',
        }
        const mimeType = mimeMap[ext] || 'application/octet-stream'
        console.log(`[Server] Sending file_content: ${file.filename} (${mimeType}, ${Math.round(buf.length / 1024)}KB)`)
        send(ws, { type: 'file_content', id: msg.id, filename: file.filename, mimeType, data: buf.toString('base64') } as any)
      } catch (err: any) {
        console.error(`[Server] File read error: ${err.message}`)
        send(ws, { type: 'file_content_error', id: msg.id, error: err.message } as any)
      }
      return
    }

    if (msg.type === 'stop_agent') {
      console.log('[Server] Stop agent requested')
      agent.stop()
      return
    }

    if (msg.type === 'steer') {
      console.log(`[Server] Steer received: ${msg.message}`)
      agent.steer(msg.message)
      return
    }

    if (msg.type === 'chat') {
      if (!getRelayConfig()) {
        send(ws, {
          type: 'chat_response',
          message: { role: 'assistant', content: 'I need a relay connection before I can help. Activate your relay in **Settings** to get started.', timestamp: new Date().toISOString() }
        })
        return
      }
      broadcast({ type: 'agent_thinking' } as any)
      try {
        let streamed = ''
        const response = await agent.chat(
          msg.message,
          (chunk) => {
            streamed += chunk
            broadcast({ type: 'chat_chunk', text: chunk } as any)
          },
          (tool, label) => {
            broadcast({ type: 'chat_segment_end' } as any)
            broadcast({ type: 'tool_start', tool, label } as any)
          },
          msg.fileIds
        )
        broadcast({
          type: 'chat_response',
          message: { role: 'assistant', content: streamed || response, timestamp: new Date().toISOString() }
        } as any)
        send(ws, { type: 'queue_update', items: agent.queue.getPending() })
        send(ws, { type: 'done_update', items: agent.queue.getDone() })
        send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
        sendFilesAndFolders(ws).catch(console.error)
      } catch (err: any) {
        console.error('[Server] chat error:', err.message)
        broadcast({ type: 'error', message: err.message ?? 'Something went wrong.' } as any)
        broadcast({ type: 'agent_stopped' } as any)
      }
    }

    if (msg.type === 'voice_audio') {
      // Receive base64 audio from frontend, transcribe with Whisper, then process as voice chat
      const voiceProxy = getOpenAIProxy()
      if (!voiceProxy) {
        send(ws, { type: 'error', message: 'Relay not configured — voice input unavailable.' })
        return
      }
      try {
        const audioBuffer = Buffer.from(msg.data, 'base64')
        // Mobile sends m4a (AAC), desktop sends webm — use format hint for correct MIME type
        const fmt = msg.format === 'm4a' ? { mime: 'audio/mp4', ext: 'm4a' } : { mime: 'audio/webm', ext: 'webm' }
        const blob = new Blob([audioBuffer], { type: fmt.mime })
        const form = new FormData()
        form.append('file', blob, `voice.${fmt.ext}`)
        form.append('model', 'whisper-1')
        form.append('language', 'en')
        form.append('prompt', 'This is a voice command to a personal AI assistant called Co-Agent. The user is speaking naturally in English.')
        form.append('temperature', '0.2')

        const res = await fetch(`${voiceProxy.baseUrl}/v1/audio/transcriptions`, {
          method: 'POST',
          headers: { 'Authorization': voiceProxy.authHeader },
          body: form,
        })
        const data = await res.json() as { text?: string; error?: { message: string } }
        const text = data.text?.trim()

        if (!text) {
          // Nothing transcribed — silently dismiss the pill
          send(ws, { type: 'voice_summary', summary: '' })
          return
        }

        console.log('[Voice] Transcribed:', text)

        // Process as a voice chat message
        if (!getRelayConfig()) {
          send(ws, { type: 'chat_response', message: { role: 'assistant', content: 'Relay not configured — cannot respond.', timestamp: new Date().toISOString() } })
          return
        }
        // Show transcribed text immediately, then process
        broadcast({ type: 'voice_transcribed', text } as any)
        broadcast({ type: 'agent_thinking' } as any)
        let streamed = ''
        const settingsForTts = await readSettings(DATA_DIR)
        const voicePrompt = text + ' [voice]'
        const response = await agent.chat(
          voicePrompt,
          (chunk) => {
            streamed += chunk
            broadcast({ type: 'chat_chunk', text: chunk } as any)
          },
          (tool, label) => {
            broadcast({ type: 'chat_segment_end' } as any)
            broadcast({ type: 'tool_start', tool, label } as any)
          }
        )
        const fullResponse = streamed || response
        broadcast({ type: 'chat_response', message: { role: 'assistant', content: fullResponse, timestamp: new Date().toISOString() } } as any)
        send(ws, { type: 'queue_update', items: agent.queue.getPending() })
        send(ws, { type: 'done_update', items: agent.queue.getDone() })
        send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
        sendFilesAndFolders(ws).catch(console.error)
        send(ws, { type: 'voice_summary', summary: fullResponse })
        // TTS the full response — no early fire that cuts off
        if (settingsForTts.voice_response && getOpenAIProxy()) {
          streamTts(fullResponse, settingsForTts.voice_voice, (msg) => send(ws, msg as any))
        }
      } catch (err: any) {
        console.error('[Voice] Transcription/chat error:', err.message)
        send(ws, { type: 'error', message: `Voice failed: ${err.message}` })
        send(ws, { type: 'agent_stopped' })
      }
    }

    if (msg.type === 'voice_chat') {
      if (!getRelayConfig()) {
        send(ws, {
          type: 'chat_response',
          message: { role: 'assistant', content: 'I need a relay connection before I can help. Activate your relay in **Settings** to get started.', timestamp: new Date().toISOString() }
        })
        return
      }
      broadcast({ type: 'agent_thinking' } as any)
      try {
        let streamed = ''
        const settingsForTts = await readSettings(DATA_DIR)
        const voicePrompt = msg.message + ' [voice]'
        const response = await agent.chat(
          voicePrompt,
          (chunk) => {
            streamed += chunk
            broadcast({ type: 'chat_chunk', text: chunk } as any)
          },
          (tool, label) => {
            broadcast({ type: 'chat_segment_end' } as any)
            broadcast({ type: 'tool_start', tool, label } as any)
          }
        )
        const fullResp = streamed || response
        broadcast({
          type: 'chat_response',
          message: { role: 'assistant', content: fullResp, timestamp: new Date().toISOString() }
        } as any)
        send(ws, { type: 'queue_update', items: agent.queue.getPending() })
        send(ws, { type: 'done_update', items: agent.queue.getDone() })
        send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
        sendFilesAndFolders(ws).catch(console.error)
        send(ws, { type: 'voice_summary', summary: fullResp })
        if (settingsForTts.voice_response && getOpenAIProxy()) {
          streamTts(fullResp, settingsForTts.voice_voice, (m) => send(ws, m as any))
        }
      } catch (err: any) {
        console.error('[Server] voice_chat error:', err.message)
        broadcast({ type: 'error', message: err.message ?? 'Something went wrong.' } as any)
        broadcast({ type: 'agent_stopped' } as any)
      }
    }

    if (msg.type === 'get_queue') {
      send(ws, { type: 'queue_update', items: agent.queue.getPending() })
    }

    if (msg.type === 'approve') {
      const item = agent.queue.approve(msg.id)
      send(ws, { type: 'queue_update', items: agent.queue.getPending() })

      // Tell the agent to execute the approved item
      if (item) {
        const prompt = `The user approved this action: "${item.title}". ${item.description}${item.detail ? `\n\nDetails:\n${item.detail}` : ''}\n\nExecute it now.`
        send(ws, { type: 'agent_thinking' })
        try {
          const response = await agent.chat(
            prompt,
            (chunk) => send(ws, { type: 'chat_chunk', text: chunk }),
            (tool, label) => send(ws, { type: 'tool_start', tool, label })
          )
          // Only mark done after successful execution
          agent.queue.addDone(`${item.title}`)
          send(ws, {
            type: 'chat_response',
            message: { role: 'assistant', content: response, timestamp: new Date().toISOString() }
          })
          send(ws, { type: 'queue_update', items: agent.queue.getPending() })
          send(ws, { type: 'done_update', items: agent.queue.getDone() })
          send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
          sendFilesAndFolders(ws).catch(console.error)
        } catch (err: any) {
          console.error('[Server] approve execution error:', err.message)
          send(ws, { type: 'error', message: err.message ?? 'Something went wrong.' })
          send(ws, { type: 'agent_stopped' })
        }
      }
    }

    if (msg.type === 'reject') {
      agent.queue.reject(msg.id)
      send(ws, { type: 'queue_update', items: agent.queue.getPending() })
    }

    if (msg.type === 'edit_queue_item') {
      agent.queue.editDetail(msg.id, msg.detail)
      send(ws, { type: 'queue_update', items: agent.queue.getPending() })
    }

    if (msg.type === 'get_done') {
      send(ws, { type: 'done_update', items: agent.queue.getDone() })
    }

    if (msg.type === 'get_todos') {
      send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
    }

    if (msg.type === 'complete_todo') {
      agent.calendar.complete(msg.id)
      send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
    }

    if (msg.type === 'delete_todo') {
      agent.calendar.delete(msg.id)
      send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
    }

    if (msg.type === 'get_calendar') {
      send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
    }

    if (msg.type === 'complete_calendar_entry') {
      agent.calendar.complete(msg.id)
      agent.onCalendarChanged?.()
      broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() })
    }

    if (msg.type === 'delete_calendar_entry') {
      agent.calendar.delete(msg.id)
      agent.onCalendarChanged?.()
      broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() })
    }

    if (msg.type === 'get_integrations') {
      if (composioKey()) {
        const slugs = await getConnectedSlugs(composioKey()!, composioUserId())
        const newSlugs = slugs.filter(s => !currentMcpSlugs.includes(s))
        if (newSlugs.length > 0) {
          await refreshComposioMcp(slugs).catch(console.error)
          // Triggers are user-controlled — no auto-subscribe
        }
      }
      await sendIntegrations(ws)
    }

    if (msg.type === 'integration_connect') {
      if (msg.slug === 'coagent:mobile') {
        const relayUrl = process.env.RELAY_URL ?? ''
        const token = process.env.RELAY_TOKEN ?? ''
        const userId = process.env.RELAY_USER_ID ?? 'default'
        send(ws, { type: 'relay_credentials', relayUrl, token, userId })
        return
      }
      if (msg.slug === 'coagent:whatsapp') {
        console.log('[WhatsApp] Connect requested...')
        try {
          // Disconnect existing if any
          if (whatsAppClient) {
            whatsAppClient.disconnect()
            whatsAppClient = null
          }
          whatsAppClient = new WhatsAppClient(DATA_DIR, {
            onQr: (dataUrl) => {
              console.log('[WhatsApp] QR code generated, sending to UI')
              broadcast({ type: 'whatsapp_qr', dataUrl } as any)
            },
            onConnected: () => {
              whatsappConnected = true
              sendIntegrations(ws).catch(console.error)
            },
            onDisconnected: () => {
              whatsappConnected = false
              whatsAppClient = null
              sendIntegrations(ws).catch(console.error)
            },
            onMessage: (jid, pushName, text, media) => {
              console.log(`[WhatsApp] Message from ${pushName || jid}: ${text ? text.slice(0, 80) : `[${media?.type || 'empty'}]`}`)
              whatsappQueue.push({ jid, name: pushName, text, media })
              processWhatsAppQueue()
            }
          })
          await whatsAppClient.connect()
        } catch (err: any) {
          console.error('[WhatsApp] Connect failed:', err.message)
          send(ws, { type: 'error', message: `Failed to connect WhatsApp: ${err.message}` })
        }
        return
      }
      if (msg.slug === 'coagent:imessage') {
        console.log('[iMessage] Connect requested...')
        // In production, check FDA first. Skip in dev since the parent app may differ.
        const skipFdaCheck = process.env.NODE_ENV === 'development' || process.env.TAURI_ENV_DEBUG === 'true'
        if (!skipFdaCheck && !canAccessChatDb()) {
          console.log('[iMessage] FDA check failed — opening settings')
          try {
            const { execSync } = require('child_process')
            execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"')
          } catch {}
          send(ws, {
            type: 'integration_fda_required' as any,
            slug: msg.slug,
            message: 'Enable Full Disk Access for CoAgent in the Settings window that just opened, then restart and click Connect again.'
          })
          return
        }
        console.log('[iMessage] Connecting MCP...')
        try {
          const imsg = resolveMcpImessage()
          await agent.mcpManager.disconnect('coagent:imessage')
          await agent.mcpManager.connect([{
            name: 'coagent:imessage',
            command: imsg.command,
            args: imsg.args
          }])
          imessageConnected = true
          embedToolsFromMcp().catch(() => {})
          await sendIntegrations(ws)
        } catch (err: any) {
          send(ws, { type: 'error', message: `Failed to connect iMessage: ${err.message}` })
        }
        return
      }
      if (msg.slug === 'coagent:contacts') {
        console.log('[Contacts] Connect requested...')
        const skipFdaCheck = process.env.NODE_ENV === 'development' || process.env.TAURI_ENV_DEBUG === 'true'
        if (!skipFdaCheck && !canAccessAddressBook()) {
          console.log('[Contacts] FDA check failed — opening settings')
          try {
            const { execSync } = require('child_process')
            execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"')
          } catch {}
          send(ws, {
            type: 'integration_fda_required' as any,
            slug: msg.slug,
            message: 'Enable Full Disk Access for CoAgent in the Settings window that just opened, then restart and click Connect again.'
          })
          return
        }
        console.log('[Contacts] Connecting MCP...')
        try {
          const contacts = resolveMcpContacts()
          await agent.mcpManager.disconnect('coagent:contacts')
          await agent.mcpManager.connect([{
            name: 'coagent:contacts',
            command: contacts.command,
            args: contacts.args
          }])
          contactsConnected = true
          embedToolsFromMcp().catch(() => {})
          await sendIntegrations(ws)
        } catch (err: any) {
          send(ws, { type: 'error', message: `Failed to connect Contacts: ${err.message}` })
        }
        return
      }
      if (msg.slug.startsWith('custom:')) {
        const name = msg.slug.slice(7)
        if (msg.params) {
          try {
            await writeCustomMcpCredentials(name, msg.params)
            await agent.mcpManager.disconnect(`custom:${name}`)
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
          const registry = await readRegistry()
          const entry = registry.find(e => e.name === name)
          if (entry && entry.authFields.length > 0) {
            send(ws, { type: 'integration_needs_fields', slug: msg.slug, fields: entry.authFields })
          }
        }
        return
      }
      if (!composioKey()) {
        send(ws, { type: 'error', message: 'Add your Composio API key in Settings → API Keys to connect integrations.' })
      } else {
        try {
          const url = await generateAuthUrl(composioKey()!, msg.slug, composioUserId(), msg.params)
          send(ws, { type: 'integration_auth_url', slug: msg.slug, url })
        } catch (err: any) {
          if (err.message === 'NEEDS_FIELDS') {
            send(ws, { type: 'integration_needs_fields', slug: msg.slug, fields: err.fields })
          } else {
            send(ws, { type: 'error', message: err.message })
          }
        }
      }
    }

    if (msg.type === 'integration_disconnect') {
      if (msg.slug === 'coagent:whatsapp') {
        try {
          whatsAppClient?.disconnect()
          whatsAppClient = null
          whatsappConnected = false
          await sendIntegrations(ws)
        } catch (err: any) {
          send(ws, { type: 'error', message: err.message })
        }
        return
      }
      if (msg.slug === 'coagent:imessage') {
        try {
          await agent.mcpManager.disconnect('coagent:imessage')
          imessageConnected = false
          await sendIntegrations(ws)
        } catch (err: any) {
          send(ws, { type: 'error', message: err.message })
        }
        return
      }
      if (msg.slug === 'coagent:contacts') {
        try {
          await agent.mcpManager.disconnect('coagent:contacts')
          contactsConnected = false
          await sendIntegrations(ws)
        } catch (err: any) {
          send(ws, { type: 'error', message: err.message })
        }
        return
      }
      if (msg.slug.startsWith('custom:')) {
        const name = msg.slug.slice(7)
        try {
          await agent.mcpManager.disconnect(`custom:${name}`)
          await disconnectCustomMcp(name)
          await sendIntegrations(ws)
        } catch (err: any) {
          send(ws, { type: 'error', message: err.message })
        }
        return
      }
      if (!composioKey()) {
        send(ws, { type: 'error', message: 'No Composio API key configured.' })
      } else {
        try {
          await disconnectIntegration(composioKey()!, msg.slug, composioUserId())
          // Explicitly remove from tracked slugs so refreshComposioMcp doesn't re-add it
          currentMcpSlugs = currentMcpSlugs.filter(s => s !== msg.slug)
          const slugs = await getConnectedSlugs(composioKey()!, composioUserId())
          await refreshComposioMcp(slugs)
          await sendIntegrations(ws)
        } catch (err: any) {
          send(ws, { type: 'error', message: err.message })
        }
      }
    }

    if (msg.type === 'toggle_trigger') {
      const { triggerSlug, appSlug, enabled } = msg
      if (enabled) {
        subscribeSingleTrigger(composioKey()!, triggerSlug, appSlug, composioUserId())
          .then(() => sendIntegrations(ws))
          .catch(err => console.error('[Composio] Failed to subscribe trigger:', err.message))
      } else {
        setTriggerEnabled(triggerSlug, false)
        sendIntegrations(ws).catch(console.error)
      }
    }

    if (msg.type === 'custom_integration_delete') {
      const name = msg.slug.startsWith('custom:') ? msg.slug.slice(7) : msg.slug
      try {
        await agent.mcpManager.disconnect(`custom:${name}`)
        await deleteCustomMcp(name)
        await sendIntegrations(ws)
      } catch (err: any) {
        send(ws, { type: 'error', message: err.message })
      }
    }

    if (msg.type === 'capability_confirm') {
      const selected = msg.capabilities.join(', ')
      const chatMsg = `The user confirmed these capabilities for the custom integration: ${selected}. Now generate the MCP server code and call create_custom_integration with action "create" to build it.`
      send(ws, { type: 'agent_thinking' })
      try {
        let streamed = ''
        const response = await agent.chat(
          chatMsg,
          (chunk) => {
            streamed += chunk
            send(ws, { type: 'chat_chunk', text: chunk })
          },
          (tool, label) => {
            send(ws, { type: 'chat_segment_end' })
            send(ws, { type: 'tool_start', tool, label })
          }
        )
        send(ws, {
          type: 'chat_response',
          message: { role: 'assistant', content: streamed || response, timestamp: new Date().toISOString() }
        })
        send(ws, { type: 'queue_update', items: agent.queue.getPending() })
        send(ws, { type: 'done_update', items: agent.queue.getDone() })
      } catch (err: any) {
        console.error('[Server] capability_confirm error:', err.message)
        send(ws, { type: 'error', message: err.message ?? 'Something went wrong.' })
        send(ws, { type: 'agent_stopped' })
      }
    }

    if (msg.type === 'get_settings') {
      try {
        const settings = await readSettings(DATA_DIR)
        send(ws, { type: 'settings_update', settings })
      } catch (err: any) {
        send(ws, { type: 'error', message: err.message })
      }
    }

    if (msg.type === 'update_settings') {
      try {
        const settings = await writeSettings(DATA_DIR, msg.patch)
        send(ws, { type: 'settings_update', settings })
        // If heartbeat interval or active hours changed, reschedule the wake
        if (msg.patch.heartbeat_interval !== undefined || msg.patch.active_hours !== undefined || msg.patch.active_days !== undefined) {
          scheduler.rescheduleHeartbeat()
        }
      } catch (err: any) {
        send(ws, { type: 'error', message: err.message })
      }
    }

    if (msg.type === 'get_skills') {
      agent.getSkills().then(skills => send(ws, { type: 'skills_update', skills })).catch(console.error)
    }

    if (msg.type === 'update_skill') {
      try {
        await agent.updateSkill(msg.name, msg.description, msg.instructions)
        const skills = await agent.getSkills()
        send(ws, { type: 'skills_update', skills })
      } catch (err: any) {
        send(ws, { type: 'error', message: err.message })
      }
    }

    if (msg.type === 'delete_skill') {
      try {
        await agent.removeSkill(msg.name)
        const skills = await agent.getSkills()
        send(ws, { type: 'skills_update', skills })
      } catch (err: any) {
        send(ws, { type: 'error', message: err.message })
      }
    }

    if (msg.type === 'get_files') {
      try {
        await sendFilesAndFolders(ws)
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to get files: ${err.message}` })
      }
    }

    if (msg.type === 'ingest_file') {
      try {
        const buffer = Buffer.from(msg.data, 'base64')
        const entry = await ingestFile(DATA_DIR, msg.filename, buffer, msg.mimeType)
        send(ws, { type: 'file_ingested', id: entry.id, filename: entry.filename })
        await sendFilesAndFolders(ws)
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to ingest file: ${err.message}` })
      }
    }

    if (msg.type === 'ingest_file_paths') {
      // Tauri drag-drop gives us local file paths — server reads directly (no base64 round-trip)
      try {
        const { readFile } = await import('fs/promises')
        const { basename, extname } = await import('path')
        const MIME_MAP: Record<string, string> = {
          '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel',
          '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/markdown',
          '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
        }
        for (const filePath of msg.paths) {
          const buffer = await readFile(filePath)
          const ext = extname(filePath).toLowerCase()
          const mimeType = MIME_MAP[ext] ?? 'application/octet-stream'
          await ingestFile(DATA_DIR, basename(filePath), buffer, mimeType, msg.group)
        }
        await sendFilesAndFolders(ws)
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to ingest files: ${err.message}` })
      }
    }

    if (msg.type === 'delete_file') {
      try {
        await deleteFileEntry(DATA_DIR, msg.id)
        await sendFilesAndFolders(ws)
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to delete file: ${err.message}` })
      }
    }

    if (msg.type === 'create_folder') {
      try {
        await createFolder(DATA_DIR, msg.name)
        await sendFilesAndFolders(ws)
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to create folder: ${err.message}` })
      }
    }

    if (msg.type === 'move_file') {
      try {
        await moveFile(DATA_DIR, msg.id, msg.targetGroup)
        await sendFilesAndFolders(ws)
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to move file: ${err.message}` })
      }
    }

    if (msg.type === 'rename_file') {
      try {
        await renameFile(DATA_DIR, msg.id, msg.newName)
        await sendFilesAndFolders(ws)
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to rename file: ${err.message}` })
      }
    }

    if (msg.type === 'rename_folder') {
      try {
        await renameFolder(DATA_DIR, msg.oldName, msg.newName)
        await sendFilesAndFolders(ws)
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to rename folder: ${err.message}` })
      }
    }

    if (msg.type === 'delete_folder') {
      try {
        await deleteFolder(DATA_DIR, msg.name)
        await sendFilesAndFolders(ws)
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to delete folder: ${err.message}` })
      }
    }

    if (msg.type === 'reorder_folders') {
      try {
        await saveFolderOrder(DATA_DIR, msg.order)
        await sendFilesAndFolders(ws)
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to reorder folders: ${err.message}` })
      }
    }

    if (msg.type === 'move_folder') {
      try {
        await moveFolder(DATA_DIR, msg.folderPath, msg.newParentPath)
        await sendFilesAndFolders(ws)
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to move folder: ${err.message}` })
      }
    }

    if (msg.type === 'search_files_ui') {
      try {
        const results = await searchFiles(DATA_DIR, msg.query, 20)
        send(ws, { type: 'files_search_result', files: results })
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to search files: ${err.message}` })
      }
    }

    if (msg.type === 'trigger_heartbeat') {
      console.log('[Server] Manual heartbeat triggered')
      send(ws, { type: 'agent_thinking' })
      try {
        await agent.handleTrigger({ source: 'heartbeat' })
        send(ws, { type: 'queue_update', items: agent.queue.getPending() })
        send(ws, { type: 'done_update', items: agent.queue.getDone() })
        send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
      } catch (err: any) {
        console.error('[Server] heartbeat error:', err.message)
        send(ws, { type: 'error', message: `Heartbeat failed: ${err.message}` })
      }
    }

    if (msg.type === 'relay_activate') {
      try {
        await writeRelayCredentials(DATA_DIR, msg.token, msg.relayUrl)
        agent.reinitClient()
        const res = await fetch(`${msg.relayUrl}/v1/account`, {
          headers: { 'Authorization': `Bearer ${msg.token}` },
        })
        if (res.ok) {
          const data = await res.json() as { model: string; usage: any }
          send(ws, { type: 'relay_status', active: true, model: data.model, usage: data.usage })
        } else {
          send(ws, { type: 'relay_status', active: false, model: null, usage: null })
        }
      } catch (err: any) {
        send(ws, { type: 'error', message: `Relay activation failed: ${err.message}` })
        send(ws, { type: 'relay_status', active: false, model: null, usage: null })
      }
    }

    if (msg.type === 'set_model') {
      try {
        await writeSettings(DATA_DIR, { powerModel: msg.model })
        agent.reinitClient()
        const settings = await readSettings(DATA_DIR)
        broadcast({ type: 'settings_update', settings })
        console.log('[Server] Model switched to', msg.model)
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to switch model: ${err.message}` })
      }
    }

    if (msg.type === 'get_relay_status') {
      agent.reinitClient()
      sendRelayStatus(ws).catch(console.error)
    }

    if (msg.type === 'get_relay_credentials') {
      const relayUrl = process.env.RELAY_URL ?? ''
      const token = process.env.RELAY_TOKEN ?? ''
      const userId = process.env.RELAY_USER_ID ?? 'default'
      send(ws, { type: 'relay_credentials', relayUrl, token, userId })
    }

    if (msg.type === 'get_usage') {
      const usage = await getUsageSummary(DATA_DIR)
      send(ws, { type: 'usage_update', usage })
    }

    if (msg.type === 'auto_organize') {
      try {
        const result = await autoOrganizeFiles(DATA_DIR)
        send(ws, { type: 'auto_organize_done', folders: result.folders, moved: result.moved })
        await sendFilesAndFolders(ws)
      } catch (err: any) {
        send(ws, { type: 'auto_organize_done', folders: [], moved: 0 })
        send(ws, { type: 'error', message: `Auto-organize failed: ${err.message}` })
      }
    }


  })
})

console.log(`Co-Agent running on ws://localhost:${PORT}`)
