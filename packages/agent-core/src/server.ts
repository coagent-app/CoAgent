import { config } from 'dotenv'
import { WebSocketServer, WebSocket } from 'ws'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { Agent } from './agent.js'
import { MCPServerConfig } from './mcp-manager.js'
import { setupComposioMcp } from './composio-setup.js'
import { INTEGRATIONS, getIntegrationStatuses, generateAuthUrl, getRequiredFields, disconnectIntegration, getConnectedSlugs, subscribeTriggersForSlug, purgeExpiredAccounts } from './composio-integrations.js'
import { startScheduler } from './scheduler.js'
import { readSettings, writeSettings } from './settings.js'

import { listFiles, listFolders, ingestFile, deleteFileEntry, createFolder, moveFile, moveFolder, renameFile, renameFolder, deleteFolder, saveFolderOrder, searchFiles, autoOrganizeFiles } from './file-store.js'
import { writeRelayCredentials, getRelayConfig, writeApiKeys, loadApiKeysToEnv, getApiKeyStatus } from './auth.js'
import { getUsageSummary } from './usage-tracker.js'
import { RelayClient } from './relay-client.js'
import type { WSClientMessage, WSServerMessage } from '@coagent/shared'
import { join } from 'path'
import { homedir } from 'os'

// Load from ~/.coagent/.env — the secure isolated folder on the user's machine.
// loadApiKeysToEnv runs first so any keys already in process.env (e.g. from the
// shell) are respected; dotenv fills in whatever remains.
loadApiKeysToEnv(join(homedir(), '.coagent'))
config({ path: join(homedir(), '.coagent', '.env') })

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

function buildMcpConfigs(): MCPServerConfig[] {
  const mem = resolveMcpMemory()
  return [
    {
      name: 'memory',
      command: mem.command,
      args: mem.args,
      env: {
        COAGENT_DATA_DIR: join(homedir(), '.coagent'),
        ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {})
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

**I keep a to-do list.** To-dos can have a specific due time. They fire at exactly their due time — no polling. A precise timer is set, and the machine is scheduled to wake from sleep if needed. Past-due times are rejected; all to-dos must be in the future. When a to-do fires, it appears in the chat as an auto-injected prompt and the response streams live.

**I manage files.** Users can upload files (PDF, DOCX, XLSX, images, etc.) which are summarized and embedded for semantic search. An "Auto-organize" button clusters loose files into named folders using embeddings — files already in folders are left alone.

**I track usage.** All API calls (chat, file ingestion, nightly job) are tracked with token counts and estimated costs, viewable in Settings → Usage.

**Skills.** Users can create reusable automations (e.g. daily briefing, follow-ups, weekly recaps) with @skill-creator. Skills are invoked by typing @skill-name in chat.

## My tools

Consolidated tools — each handles multiple actions via an \`action\` parameter:
- **memory** (search/grep/read/write/edit/append/list/delete) — long-term memory. Use directly, never via search_tools. Prefer search (semantic) or grep (pattern match within a file) over read.
- **files** (list/search/read/delete/stats) — uploaded file management.
- **todos** (add/complete/list) — to-do items with optional due times.
- **skills** (save/list/delete) — reusable automations.
- **search_tools** — find and load external service tools (Gmail, Calendar, Slack, etc.). Optional "context" param greps recent tool logs for activity context.
- **queue_approval** / **add_done_item** — approval queue and activity log.

When multiple independent tool calls are needed, batch them in a single response (e.g. memory read + todos list + get_current_time in one turn).

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

agent.onSettingsChanged = async () => {
  const settings = await readSettings(DATA_DIR)
  broadcast({ type: 'settings_update', settings })
  scheduler.rescheduleHeartbeat()
}

agent.onSkillsChanged = async () => {
  const skills = await agent.getSkills()
  broadcast({ type: 'skills_update', skills })
}

const relay = new RelayClient(DATA_DIR)

// Track which slugs are currently loaded in MCP so we can detect changes
let currentMcpSlugs: string[] = []

// Always-on toolkits that require no auth — loaded regardless of user connections
const ALWAYS_ON_TOOLKITS = ['composio_search', 'text_to_pdf']

async function refreshComposioMcp(slugs: string[]): Promise<void> {
  // Merge with current slugs so we never drop recently-added integrations
  // (Composio may report them as not-yet-ACTIVE during OAuth flow)
  const mergedSlugs = [...new Set([...currentMcpSlugs, ...slugs])]
  const allToolkits = [...new Set([...ALWAYS_ON_TOOLKITS, ...mergedSlugs])]
  const { url, apiKey } = await setupComposioMcp(process.env.COMPOSIO_API_KEY!, allToolkits, 'default', true)
  // Only reconnect the composio HTTP client — don't touch the memory MCP
  await agent.mcpManager.connectHttp('composio', url, apiKey)
  currentMcpSlugs = mergedSlugs
  updateSetupMd(mergedSlugs).catch(err => console.error('[Server] Failed to update setup.md:', err.message))
  console.log('[Composio] MCP refreshed with toolkits:', mergedSlugs.join(', '))
}

if (process.env.COMPOSIO_API_KEY) {
  console.log('[Composio] API key present, initializing MCP connection...')
  // Clean up any stale expired accounts on boot to prevent duplicate buildup
  purgeExpiredAccounts(process.env.COMPOSIO_API_KEY)
    .catch(err => console.error('[Composio] Failed to purge expired accounts:', err.message))

  getConnectedSlugs(process.env.COMPOSIO_API_KEY).then(async (slugs) => {
    console.log(`[Composio] Found ${slugs.length} connected integrations: ${slugs.join(', ') || 'none'}`)
    // Default to all supported integrations so tools are available even before user connects
    const userToolkits = slugs.length > 0 ? slugs : ['gmail', 'googlecalendar']
    const toolkits = [...new Set([...ALWAYS_ON_TOOLKITS, ...userToolkits])]
    const { url, apiKey } = await setupComposioMcp(process.env.COMPOSIO_API_KEY!, toolkits)
    console.log('[Composio] MCP URL obtained, connecting HTTP client...')
    await agent.mcpManager.connectHttp('composio', url, apiKey)
    currentMcpSlugs = userToolkits
    updateSetupMd(slugs).catch(err => console.error('[Server] Failed to update setup.md:', err.message))
    console.log('[Composio] MCP connected with toolkits:', toolkits.join(', '))
    // Subscribe triggers for all currently connected integrations
    for (const slug of slugs) {
      subscribeTriggersForSlug(process.env.COMPOSIO_API_KEY!, slug)
        .catch(err => console.error(`[Composio] Trigger subscribe failed for ${slug}:`, err.message))
    }
  }).catch(err => console.error('[Composio] Failed to connect MCP:', err.message))
} else {
  console.log('[Composio] No API key found, skipping MCP connection')
}

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

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT })

relay.connect()

function send(ws: WebSocket, msg: WSServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(msg: WSServerMessage): void {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg))
  }
}

async function sendIntegrations(ws: WebSocket): Promise<void> {
  if (!process.env.COMPOSIO_API_KEY) {
    // No key — show all integrations as disconnected so user sees what's possible
    send(ws, { type: 'integrations_update', integrations: INTEGRATIONS.map(i => ({ ...i, connected: false })) })
    return
  }
  const integrations = await getIntegrationStatuses(process.env.COMPOSIO_API_KEY)
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

wss.on('connection', (ws) => {
  send(ws, { type: 'queue_update', items: agent.queue.getPending() })
  send(ws, { type: 'done_update', items: agent.queue.getDone() })
  send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
  send(ws, { type: 'chat_history', messages: agent.getChatHistory() })
  sendIntegrations(ws).catch(console.error)
  sendFilesAndFolders(ws).catch(console.error)
  readSettings(DATA_DIR).then(settings => send(ws, { type: 'settings_update', settings })).catch(console.error)
  sendRelayStatus(ws).catch(console.error)
  send(ws, { type: 'api_keys_status', keys: getApiKeyStatus() })
  agent.getSkills().then(skills => send(ws, { type: 'skills_update', skills })).catch(console.error)

  ws.on('message', async (raw) => {
    const msg: WSClientMessage = JSON.parse(raw.toString())

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
      if (!process.env.ANTHROPIC_API_KEY) {
        send(ws, {
          type: 'chat_response',
          message: { role: 'assistant', content: 'I need an API key before I can help. Head to **Settings → API Keys** and add your Anthropic API key to get started.', timestamp: new Date().toISOString() }
        })
        return
      }
      send(ws, { type: 'agent_thinking' })
      try {
        let streamed = ''
        const response = await agent.chat(
          msg.message,
          (chunk) => {
            streamed += chunk
            send(ws, { type: 'chat_chunk', text: chunk })
          },
          (tool, label) => {
            send(ws, { type: 'chat_segment_end' })
            send(ws, { type: 'tool_start', tool, label })
          },
          msg.fileIds
        )
        send(ws, {
          type: 'chat_response',
          message: { role: 'assistant', content: streamed || response, timestamp: new Date().toISOString() }
        })
        send(ws, { type: 'queue_update', items: agent.queue.getPending() })
        send(ws, { type: 'done_update', items: agent.queue.getDone() })
        send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
        sendFilesAndFolders(ws).catch(console.error)
      } catch (err: any) {
        console.error('[Server] chat error:', err.message)
        send(ws, { type: 'error', message: err.message ?? 'Something went wrong.' })
        send(ws, { type: 'agent_stopped' })
      }
    }

    if (msg.type === 'voice_audio') {
      // Receive base64 audio from frontend, transcribe with Whisper, then process as voice chat
      if (!process.env.OPENAI_API_KEY) {
        send(ws, { type: 'error', message: 'Add your OpenAI API key in Settings → API Keys to use voice input.' })
        return
      }
      try {
        const audioBuffer = Buffer.from(msg.data, 'base64')
        const blob = new Blob([audioBuffer], { type: 'audio/webm' })
        const form = new FormData()
        form.append('file', blob, 'voice.webm')
        form.append('model', 'whisper-1')
        form.append('language', 'en')
        form.append('prompt', 'This is a voice command to a personal AI assistant called Co-Agent. The user is speaking naturally in English.')
        form.append('temperature', '0.2')

        const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
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
        if (!process.env.ANTHROPIC_API_KEY) {
          send(ws, { type: 'chat_response', message: { role: 'assistant', content: 'I need an Anthropic API key to respond.', timestamp: new Date().toISOString() } })
          return
        }
        // Show transcribed text immediately, then process
        send(ws, { type: 'voice_transcribed', text })
        send(ws, { type: 'agent_thinking' })
        let streamed = ''
        const response = await agent.chat(
          text,
          (chunk) => {
            streamed += chunk
            send(ws, { type: 'chat_chunk', text: chunk })
          },
          (tool, label) => {
            send(ws, { type: 'chat_segment_end' })
            send(ws, { type: 'tool_start', tool, label })
          }
        )
        send(ws, { type: 'chat_response', message: { role: 'assistant', content: streamed || response, timestamp: new Date().toISOString() } })
        send(ws, { type: 'queue_update', items: agent.queue.getPending() })
        send(ws, { type: 'done_update', items: agent.queue.getDone() })
        send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
        sendFilesAndFolders(ws).catch(console.error)
        send(ws, { type: 'voice_summary', summary: 'Refer to Co-Agent for full details' })
      } catch (err: any) {
        console.error('[Voice] Transcription/chat error:', err.message)
        send(ws, { type: 'error', message: `Voice failed: ${err.message}` })
        send(ws, { type: 'agent_stopped' })
      }
    }

    if (msg.type === 'voice_chat') {
      if (!process.env.ANTHROPIC_API_KEY) {
        send(ws, {
          type: 'chat_response',
          message: { role: 'assistant', content: 'I need an API key before I can help. Head to **Settings → API Keys** and add your Anthropic API key to get started.', timestamp: new Date().toISOString() }
        })
        return
      }
      send(ws, { type: 'agent_thinking' })
      try {
        let streamed = ''
        const response = await agent.chat(
          msg.message,
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
        send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
        sendFilesAndFolders(ws).catch(console.error)
        send(ws, { type: 'voice_summary', summary: 'Refer to Co-Agent for full details' })
      } catch (err: any) {
        console.error('[Server] voice_chat error:', err.message)
        send(ws, { type: 'error', message: err.message ?? 'Something went wrong.' })
        send(ws, { type: 'agent_stopped' })
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

    if (msg.type === 'get_integrations') {
      if (process.env.COMPOSIO_API_KEY) {
        const slugs = await getConnectedSlugs(process.env.COMPOSIO_API_KEY)
        const newSlugs = slugs.filter(s => !currentMcpSlugs.includes(s))
        if (newSlugs.length > 0) {
          await refreshComposioMcp(slugs).catch(console.error)
          // Auto-subscribe triggers for each newly connected integration
          for (const slug of newSlugs) {
            subscribeTriggersForSlug(process.env.COMPOSIO_API_KEY!, slug)
              .catch(err => console.error(`[Composio] Trigger subscribe failed for ${slug}:`, err.message))
          }
        }
      }
      await sendIntegrations(ws)
    }

    if (msg.type === 'integration_connect') {
      if (!process.env.COMPOSIO_API_KEY) {
        send(ws, { type: 'error', message: 'Add your Composio API key in Settings → API Keys to connect integrations.' })
      } else {
        try {
          const url = await generateAuthUrl(process.env.COMPOSIO_API_KEY, msg.slug, 'default', msg.params)
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
      if (!process.env.COMPOSIO_API_KEY) {
        send(ws, { type: 'error', message: 'No Composio API key configured.' })
      } else {
        try {
          await disconnectIntegration(process.env.COMPOSIO_API_KEY, msg.slug)
          // Explicitly remove from tracked slugs so refreshComposioMcp doesn't re-add it
          currentMcpSlugs = currentMcpSlugs.filter(s => s !== msg.slug)
          const slugs = await getConnectedSlugs(process.env.COMPOSIO_API_KEY)
          await refreshComposioMcp(slugs)
          await sendIntegrations(ws)
        } catch (err: any) {
          send(ws, { type: 'error', message: err.message })
        }
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

    if (msg.type === 'get_api_keys') {
      send(ws, { type: 'api_keys_status', keys: getApiKeyStatus() })
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

    if (msg.type === 'update_api_keys') {
      try {
        await writeApiKeys(DATA_DIR, msg.keys)
        agent.reinitClient()

        // If Composio key changed, reinitialise MCP and refresh integrations
        if (msg.keys.composio !== undefined) {
          if (process.env.COMPOSIO_API_KEY) {
            // Key was set — connect MCP and load integrations
            purgeExpiredAccounts(process.env.COMPOSIO_API_KEY)
              .catch(err => console.error('[Composio] Failed to purge expired accounts:', err.message))

            getConnectedSlugs(process.env.COMPOSIO_API_KEY).then(async (slugs) => {
              const userToolkits = slugs.length > 0 ? slugs : ['gmail', 'googlecalendar']
              await refreshComposioMcp(userToolkits)
              for (const slug of slugs) {
                subscribeTriggersForSlug(process.env.COMPOSIO_API_KEY!, slug)
                  .catch(err => console.error(`[Composio] Trigger subscribe failed for ${slug}:`, err.message))
              }
              // Broadcast updated integrations to all clients
              for (const client of wss.clients) {
                if (client.readyState === WebSocket.OPEN) sendIntegrations(client).catch(console.error)
              }
            }).catch(err => console.error('[Composio] Failed to reinit MCP after key update:', err.message))
          } else {
            // Key was cleared — disconnect MCP and show all as disconnected
            await agent.mcpManager.disconnectAll()
            await agent.mcpManager.connect(buildMcpConfigs())
            currentMcpSlugs = []
            for (const client of wss.clients) {
              if (client.readyState === WebSocket.OPEN) sendIntegrations(client).catch(console.error)
            }
          }
        }

        // If OpenAI key changed, restart memory MCP so it picks up the new key
        if (msg.keys.openai !== undefined) {
          await agent.mcpManager.disconnectAll()
          await agent.mcpManager.connect(buildMcpConfigs())
          // Re-connect Composio MCP if it was active
          if (process.env.COMPOSIO_API_KEY && currentMcpSlugs.length > 0) {
            const allToolkits = [...new Set([...ALWAYS_ON_TOOLKITS, ...currentMcpSlugs])]
            const { url, apiKey } = await setupComposioMcp(process.env.COMPOSIO_API_KEY, allToolkits)
            await agent.mcpManager.connectHttp('composio', url, apiKey)
          }
          console.log('[Server] Memory MCP restarted with updated OpenAI key')
        }

        send(ws, { type: 'api_keys_status', keys: getApiKeyStatus() })
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to save API keys: ${err.message}` })
      }
    }

  })
})

console.log(`Co-Agent running on ws://localhost:${PORT}`)
