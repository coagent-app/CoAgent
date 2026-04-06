import { config } from 'dotenv'
import { WebSocketServer, WebSocket } from 'ws'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { Agent } from './agent.js'
import { GoogleCalendarService } from './google-calendar.js'
import { MCPServerConfig } from './mcp-manager.js'
import { setupComposioMcp } from './composio-setup.js'
import { INTEGRATIONS, getIntegrationStatuses, generateAuthUrl, getRequiredFields, disconnectIntegration, getConnectedSlugs, subscribeTriggersForSlug, subscribeSingleTrigger, purgeExpiredAccounts, getAvailableTriggersForSlug, getSubscribedTriggers, setTriggerEnabled, loadPersistedTriggers, markLocalConnected, seedLocalConnectionsIfNeeded, ensureWebhookSubscription, invalidateAccountsCache } from './composio-integrations.js'
import { startScheduler } from './scheduler.js'
import { readSettings, writeSettings } from './settings.js'

import { listFiles, listFolders, ingestFile, deleteFileEntry, createFolder, moveFile, moveFolder, renameFile, renameFolder, deleteFolder, saveFolderOrder, searchFiles, autoOrganizeFiles, getDocumentMeta, updateDocumentMeta } from './file-store.js'
import { IMESSAGE_TOOLS, handleImessageTool } from './local-tools-imessage.js'
import { CONTACTS_TOOLS, handleContactsTool } from './local-tools-contacts.js'
import { embedTools, purgeTools, setToolEmbeddingsDir } from './tool-embeddings.js'
import { writeRelayCredentials, getRelayConfig, getOpenAIProxy, loadApiKeysToEnv } from './auth.js'
import { getUsageSummary, recordUsageGlobal, setUsageDataDir } from './usage-tracker.js'

/** Returns the relay token for Composio API calls */
function composioKey(): string | undefined {
  return process.env.RELAY_TOKEN
}

/** Returns the per-user Composio entity ID — explicit entity, or relay user ID, or 'default' */
function composioUserId(): string {
  return process.env.COMPOSIO_ENTITY_ID || process.env.RELAY_USER_ID || 'default'
}

import { RelayClient } from './relay-client.js'
import { TeamClient } from '@coagent/team-core'
import { WhatsAppClient, WhatsAppMedia } from './whatsapp-client.js'
import { getEdition } from './edition.js'
import type { WSClientMessage, WSServerMessage } from '@coagent/shared'
import { join } from 'path'
import { homedir } from 'os'
import { initCustomMcpDir, readRegistry, writeCustomMcpCredentials, disconnectCustomMcp, deleteCustomMcp, getCustomMcpConfigs, getCustomIntegrations, readCustomMcpCode, updateCustomMcpCode, getCustomMcpDir } from './custom-mcp.js'

// Load from data dir .env — the secure isolated folder on the user's machine.
// loadApiKeysToEnv runs first so any keys already in process.env (e.g. from the
// shell) are respected; dotenv fills in whatever remains.
const _envDir = process.env.COAGENT_DATA_DIR || join(homedir(), '.coagent')
loadApiKeysToEnv(_envDir)
config({ path: join(_envDir, '.env') })
config({ path: join(__dirname, '..', '..', '..', '.env') })

function timeAgo(isoTimestamp: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

// ── TTS helpers ──────────────────────────────────────────────────────────────
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

// ── TTS via relay (relay picks cheapest provider: Google Cloud → OpenAI) ────
async function streamTts(text: string, voice: string | undefined, sendFn: (msg: any) => void): Promise<void> {
  const proxy = getOpenAIProxy()
  if (!proxy) { console.log('[TTS] No relay configured, skipping'); return }
  const clean = stripMdForTts(text)
  if (!clean) { console.log('[TTS] No text after markdown cleanup, skipping'); return }
  const ttsVoice = voice || 'alloy'
  console.log('[TTS] Relay streaming (voice: %s) text: %s', ttsVoice, clean.slice(0, 80))
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Authorization': proxy.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', input: clean, voice: ttsVoice, response_format: 'mp3', speed: 1.10 }),
    })
    if (!res.ok) { console.error('[TTS] Relay error:', res.status, await res.text().catch(() => '')); return }
    if (!res.body) { console.error('[TTS] No response body'); return }
    const reader = res.body.getReader()
    let seq = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      sendFn({ type: 'voice_tts_chunk', seq, data: Buffer.from(value).toString('base64'), format: 'mp3' })
      seq++
    }
    console.log('[TTS] Stream complete, sent %d chunks', seq)
    sendFn({ type: 'voice_tts_done', format: 'mp3' })
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


function resolveMcpExa(): { command: string; args: string[] } | null {
  // Only enable if EXA_API_KEY is configured
  if (!process.env.EXA_API_KEY) return null
  const { dirname } = require('path') as typeof import('path')
  const sidecarPath = join(dirname(process.execPath), 'coagent-exa')
  if (existsSync(sidecarPath)) {
    return { command: sidecarPath, args: [] }
  }
  try {
    const mcpPath = require.resolve('@coagent/mcp-exa')
    return { command: 'node', args: [mcpPath] }
  } catch {
    return null
  }
}


function canAccessChatDb(): boolean {
  try {
    const { openSync, readSync, closeSync } = require('fs')
    const fd = openSync(join(homedir(), 'Library', 'Messages', 'chat.db'), 'r')
    const buf = Buffer.alloc(16)
    readSync(fd, buf, 0, 16, 0)
    closeSync(fd)
    return true
  } catch {
    return false
  }
}

function canAccessAddressBook(): boolean {
  try {
    const { openSync, readSync, closeSync } = require('fs')
    const fd = openSync(join(homedir(), 'Library', 'Application Support', 'AddressBook', 'AddressBook-v22.abcddb'), 'r')
    const buf = Buffer.alloc(16)
    readSync(fd, buf, 0, 16, 0)
    closeSync(fd)
    return true
  } catch {
    return false
  }
}

function buildMcpConfigs(): MCPServerConfig[] {
  const mem = resolveMcpMemory()
  const configs: MCPServerConfig[] = [
    {
      name: 'memory',
      command: mem.command,
      args: mem.args,
      env: {
        COAGENT_DATA_DIR: process.env.COAGENT_DATA_DIR || join(homedir(), '.coagent'),
        ...(process.env.RELAY_URL ? { RELAY_URL: process.env.RELAY_URL } : {}),
        ...(process.env.RELAY_TOKEN ? { RELAY_TOKEN: process.env.RELAY_TOKEN } : {})
      } as Record<string, string>
    }
  ]

  const exa = resolveMcpExa()
  if (exa) {
    configs.push({
      name: 'exa',
      command: exa.command,
      args: exa.args,
      env: {
        COAGENT_DATA_DIR: process.env.COAGENT_DATA_DIR || join(homedir(), '.coagent'),
        EXA_API_KEY: process.env.EXA_API_KEY!,
        ...(process.env.RELAY_URL ? { RELAY_URL: process.env.RELAY_URL } : {}),
        ...(process.env.RELAY_USER_ID ? { RELAY_USER_ID: process.env.RELAY_USER_ID } : {}),
      } as Record<string, string>
    })
    console.log('[Server] Exa MCP enabled (Powered by Exa)')
  }

  return configs
}

const DATA_DIR = process.env.COAGENT_DATA_DIR || join(homedir(), '.coagent')
mkdirSync(DATA_DIR, { recursive: true })
setUsageDataDir(DATA_DIR)
initCustomMcpDir(DATA_DIR)

function writeRelayCredentialsFile() {
  const relayUrl = process.env.RELAY_URL ?? ''
  const token = process.env.RELAY_TOKEN ?? ''
  const userId = process.env.RELAY_USER_ID ?? 'default'
  if (relayUrl && token) {
    const credPath = join(DATA_DIR, '.relay-credentials')
    writeFileSync(credPath, JSON.stringify({ relayUrl, token, userId }), { mode: 0o600 })
  }
}
writeRelayCredentialsFile()

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
- **files** (list/search/grep/read/delete/stats/create_folder/move/get_pdf_fields/fill_pdf) — uploaded file management + content search + PDF form filling.
  - **grep**: regex search across file contents (PDFs, DOCX, XLSX, text). Scope by folder or single file id. Returns matching snippets with context — use this instead of reading entire files.
  - **create_folder** / **move**: organize files into folders.
  - **get_pdf_fields**: list fillable form fields in a PDF (text, checkbox, dropdown, radio). Only works on fillable PDF forms.
  - **fill_pdf**: fill fields in a fillable PDF form by name→value map. Saves as a new file, original untouched.
- **schedule** (create/update/delete/complete/list) — unified schedule for routines (recurring cron), tasks (one-time due), and followups (check-back reminders that fire like tasks).
- **exa** (search/find_similar/get_contents) — web search. Auto-saves to research DB.
- **research** (search/list/stats) — local research DB queries. Free, instant.
- **monitor** (create/list/delete/trigger) — recurring web searches on specific domains.
- **skills** (save/list/delete/execute) — reusable automations. Use execute to run a skill by name — loads its full instructions for you to follow.
- **search_tools** — find and load external service tools (Gmail, Calendar, Slack, etc.). Optional "context" param greps recent tool logs for activity context.
- **queue_approval** / **add_done_item** — approval queue and activity log.

When multiple independent tool calls are needed, batch them in a single response (e.g. memory read + schedule list + get_current_time in one turn).

**Token efficiency:** Old tool results are automatically compacted after 2 conversation turns — raw data gets truncated but my text responses (which contain the processed info) stay intact. This keeps history lean without losing context.

## My memory

Notes in \`~/.coagent/memory/\` — my brain across conversations.

- **setup.md** — this file (read-only).
- **agent.md** — user profile: who you are, preferences, how to handle things.
- **heartbeat.md** — what to check and how to handle events during heartbeats.
- **preferences.md** — tone, format, behavior preferences.
- **contacts.md** — key people and how to handle their messages.
- **projects.md** — active projects, context, deadlines.

Updated as we work together. User can edit directly.

**Off-limits to the 3 AM job:** setup.md, agent.md, heartbeat.md, preferences.md — only the user or main agent edits these.

## Workflows

Combine tools for multi-step tasks: lead gen (exa → research → email outreach), competitor monitoring (monitor → research), daily briefings (email + calendar), outreach campaigns (research → gmail/mailchimp).

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

What's your name?"

After they answer, save it immediately: update_settings({ name: "their name" })

## Step 2: Name your agent

Ask: "What would you like to call me? Some people go with something like Jarvis, Friday, or just keep it as CoAgent — totally up to you."

Save their choice: update_settings({ agent_name: "their choice" })

## Step 3: Get to know them

Ask follow-up questions ONE AT A TIME. Cover:
1. What they do for work and who they work with (clients, team, solo?)
2. What takes up most of their time or causes the most friction day-to-day
3. What they'd most want an AI agent handling for them automatically
4. Which of their connected tools (check setup.md for the list) they actually use daily and want monitored
5. What makes a good lead or client for them — revenue size, ad spend, industry, location, team size, whatever signals matter. Save this to memory as "lead_criteria".

Do NOT ask all questions at once. One question per message. Listen and ask smarter follow-ups — if they mention clients, ask about that. If they mention email overload, dig into that.

## Step 4: Set autonomy level

Ask: "How hands-off do you want me to be? I can:
- **Ask first** — I check with you before doing anything
- **Balanced** — I handle small stuff, ask about big decisions
- **Autonomous** — I just handle it and tell you what I did"

Save their choice: update_settings({ autonomy: "ask_first" | "balanced" | "autonomous" })

## Step 5: Write their profile

When you have a clear picture, write their profile to agent.md:

# [their name]
**About**: [what they do, in their words]
**Focus**: [top 1-2 things they want help with]

## How I work
- Handle automatically: [list]
- Always ask first: [list]

## What to monitor
- [tool]: [what to watch for]

## Step 6: Wrap up

End with: "Got it. I'll run in the background and surface anything that needs you.

Tip: type @skill-creator anytime to build custom automations — like a daily briefing, auto follow-ups, or weekly recaps."

Then delete this file (onboarding.md) — onboarding is complete.
`,

  'heartbeat.md': `# Heartbeat

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

// ── Vertical-specific starter kits ───────────────────────────────────────────

const VERTICAL_MEMORY: Record<string, Record<string, string>> = {
  'real-estate': {
    'onboarding.md': `# Onboarding — Real Estate Edition

This file exists because the user hasn't set up their profile yet. Follow these instructions, then delete this file when done.

## Step 1: Introduction

Start with this exact opening, then immediately ask the first question:

"Hey, I'm CoAgent — your AI assistant built for real estate agents. I run privately on your machine and can help with contracts, clients, listings, and your daily workflow.

What's your name?"

After they answer, save it immediately: update_settings({ name: "their name" })

## Step 2: Name your agent

Ask: "What would you like to call me? Some people go with something like Jarvis, Friday, or just keep it as CoAgent — totally up to you."

Save their choice: update_settings({ agent_name: "their choice" })

## Step 3: Get to know them

Ask follow-up questions ONE AT A TIME. Cover:
1. Their market and property types (residential, commercial, luxury?)
2. Buyers, sellers, or both — and typical deal volume
3. What part of the deal cycle takes the most time (lead gen, showings, paperwork, follow-ups?)
4. What tools they use (MLS, CRM, DocuSign, email?)
5. Which of their connected tools (check setup.md) they want monitored
6. What makes a good lead for them — price range, property type, area, investor vs. owner-occupant, etc. Save to memory as "lead_criteria".

ONE question per message. If they mention contracts, ask about that. If they mention lead follow-up, dig into that.

## Step 4: Set autonomy level

Ask: "How hands-off do you want me to be? I can:
- **Ask first** — I check with you before doing anything
- **Balanced** — I handle small stuff, ask about big decisions
- **Autonomous** — I just handle it and tell you what I did"

Save their choice: update_settings({ autonomy: "ask_first" | "balanced" | "autonomous" })

## Step 5: Write their profile

When you have a clear picture, write their profile to agent.md:

# [their name]
**About**: Real estate agent in [market]. [buyers/sellers/both]. [property types].
**Focus**: [top 1-2 things they want help with]

## How I work
- Handle automatically: [list]
- Always ask first: [list]

## What to monitor
- [tool]: [what to watch for]

## Step 6: Set up routines

Based on what they told you, create schedule entries:
- Morning briefing routine if they want daily updates
- Follow-up reminders for active deals
- Weekly pipeline review if they have volume

## Step 7: Wrap up

End with: "All set. I'll run in the background and surface anything that needs you. Your Contracts, Listings, Clients, and Marketing folders are ready for files.

Tip: upload a fillable PDF contract and I can fill it out for you. Type @contract-review to analyze any contract."

Then delete this file (onboarding.md) — onboarding is complete.
`,
  },
}

const VERTICAL_FOLDERS: Record<string, string[]> = {
  'real-estate': ['Contracts', 'Listings', 'Clients', 'Marketing'],
}

const VERTICAL_SKILLS: Record<string, Record<string, { name: string; description: string; instructions: string; placeholder?: string }>> = {
  'real-estate': {
    'contract-review': {
      name: 'contract-review',
      description: 'Analyze a real estate contract for key terms, dates, and red flags',
      placeholder: 'review a contract…',
      instructions: `The user wants a contract reviewed. Follow these steps:

1. Ask which contract to review, or if they mention one, find it:
   - files(action: 'list', folder: 'Contracts') to see available contracts
   - Or files(action: 'search', query: '[what they mentioned]')

2. Use files(action: 'grep') to search the contract for key terms:
   - grep pattern: "closing date|settlement date|close of escrow"
   - grep pattern: "commission|compensation|broker fee"
   - grep pattern: "earnest money|deposit|escrow"
   - grep pattern: "contingenc|inspection|appraisal|financing"
   - grep pattern: "penalty|default|termination|cancel"

3. Summarize findings:
   - Closing date and key deadlines
   - Commission structure
   - Earnest money amount and terms
   - All contingencies and their deadlines
   - Any unusual clauses or red flags

4. If it's a fillable PDF, mention they can use fill_pdf to fill it out.

Keep the summary concise and actionable.`,
    },
    'listing-prep': {
      name: 'listing-prep',
      description: 'Draft an MLS listing description from property details',
      placeholder: 'draft a listing description…',
      instructions: `The user wants to prepare a listing. Ask for (one at a time, skip what they already gave):

1. Property address
2. Property type (single family, condo, townhouse, etc.)
3. Beds/baths/sqft
4. Key features (updated kitchen, pool, view, etc.)
5. Price point

Then write an MLS-ready description:
- Lead with the strongest selling point
- 150-250 words, professional tone
- Highlight location, features, recent updates
- End with a call to action

Save the description to memory (write to a file like "listing-[address].md") and offer to create a PDF listing sheet with create_document.`,
    },
  },
}

async function writeMemoryFiles(): Promise<void> {
  const memDir = join(DATA_DIR, 'memory')
  await mkdir(memDir, { recursive: true })

  // Merge vertical-specific memory (overrides base files like onboarding.md)
  const { vertical } = getEdition()
  const verticalMemory = VERTICAL_MEMORY[vertical] || {}
  const allMemory = { ...MEMORY_FILES, ...verticalMemory }

  for (const [filename, content] of Object.entries(allMemory)) {
    const filePath = join(memDir, filename)
    if (!existsSync(filePath)) {
      await writeFile(filePath, content, 'utf-8')
    }
  }

  // Seed folders for the vertical
  const folders = VERTICAL_FOLDERS[vertical]
  if (folders) {
    for (const folder of folders) {
      try { await createFolder(DATA_DIR, folder) } catch { /* already exists */ }
    }
  }
}

writeMemoryFiles().catch(err => console.error('[Server] Failed to write memory files:', err.message))

// ── Default skills (shipped with the app, read-only) ─────────────────────────
const DEFAULT_SKILLS: Record<string, { name: string; description: string; instructions: string; placeholder?: string }> = {
  'skill-creator': {
    name: 'skill-creator',
    description: 'Build custom skills to automate your workflows — @skill-creator to start',
    placeholder: 'create a new skill…',
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
    placeholder: 'build a custom integration…',
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

  // Merge vertical-specific skills into defaults
  const { vertical } = getEdition()
  const verticalSkills = VERTICAL_SKILLS[vertical] || {}
  const allSkills = { ...DEFAULT_SKILLS, ...verticalSkills }

  for (const [filename, skill] of Object.entries(allSkills)) {
    const filePath = join(dir, `${filename}.json`)
    // Always write defaults — they're read-only and ship with the app
    await writeFile(filePath, JSON.stringify(skill, null, 2), 'utf-8')
  }
}

writeDefaultSkills().catch(err => console.error('[Server] Failed to write default skills:', err.message))

const agent = new Agent(buildMcpConfigs(), DATA_DIR)


let wss: WebSocketServer | null = null
let voiceProcessing = false
let chatInProgress = false
let agentBusy = false
let nextHeartbeatAt: string | undefined

const scheduler = startScheduler(agent, DATA_DIR, {
  onHeartbeat: (status, summary, nextAt) => {
    if (nextAt) nextHeartbeatAt = nextAt.toISOString()
    console.log(`[Server] Heartbeat callback: status=${status}, nextAt=${nextAt?.toISOString() ?? 'none'}`)
    broadcast({ type: 'heartbeat', status, summary, nextAt: nextAt?.toISOString() })
  },
  onHeartbeatStream: (() => {
    return (type: 'start' | 'chunk' | 'tool' | 'done', data?: any) => {
      // Heartbeat is independent — don't stream into the chat UI.
      // Status updates reach the UI via set_status_line tool.
      if (type === 'done') {
        broadcast({ type: 'queue_update', items: agent.queue.getPending() })
        broadcast({ type: 'done_update', items: agent.queue.getDone() })
        broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() })
      }
    }
  })(),
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

agent.onStatusLine = (message: string) => {
  broadcast({ type: 'status_line', message })
}

agent.onNotifyUser = (title: string, body: string) => {
  broadcast({ type: 'push_notification', title, body } as any)
}

agent.onResearchProgress = (agents) => {
  broadcast({ type: 'research_progress', agents } as any)
}

agent.onBroadcast = (event) => {
  broadcast(event)
}

agent.onSettingsChanged = async () => {
  const settings = await readSettings(DATA_DIR)
  broadcast({ type: 'settings_update', settings })
  scheduler.rescheduleHeartbeat()
  scheduler.rescheduleBrief()
}

agent.onSkillsChanged = async () => {
  const skills = await agent.getSkills()
  broadcast({ type: 'skills_update', skills })
}

// Google Calendar
let googleCal: GoogleCalendarService | null = null

/** Apply sync results correctly — full sync replaces, incremental upserts */
function applyGoogleSyncResult(result: { entries: any[]; changed: boolean; full: boolean; removedIds?: string[] }) {
  if (!result.changed || result.entries.length === 0 && !result.removedIds?.length) return
  if (result.full) {
    agent.calendar.setGoogleEvents(result.entries)
  } else {
    agent.calendar.applyGoogleSync(result.entries, result.removedIds || [])
  }
}

function initGoogleCalendar(clientId: string, clientSecret: string) {
  if (googleCal) return // already initialized
  googleCal = new GoogleCalendarService(clientId, clientSecret, DATA_DIR)
  googleCal.setStoreCallback((entries) => {
    agent.calendar.setGoogleEvents(entries)
  })
  googleCal.setUpdateCallback(async () => {
    broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() } as any)
    const status = await googleCal!.getStatus()
    broadcast({ type: 'google_calendar_status', ...status } as any)
  })
  googleCal.init().then(async () => {
    agent.googleCalendarConnected = await googleCal!.isConnected()
    if (agent.googleCalendarConnected) {
      const result = await googleCal!.sync()
      applyGoogleSyncResult(result)
      broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() } as any)
    }
  }).catch(err => console.error('[Server] Google Calendar init error:', err.message))
  console.log('[Server] Google Calendar initialized')
}

// Init on startup if env vars are present
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  initGoogleCalendar(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET)
}

agent.onCustomIntegration = async (action, data) => {
  if (action === 'propose') {
    // Normalize capabilities — agent may send array, object, or JSON string
    let parsed = data.capabilities
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed) } catch { parsed = null }
    }
    let rawCaps: { name: string; description: string }[] = []
    if (Array.isArray(parsed)) {
      rawCaps = parsed.map((c: any) =>
        typeof c === 'string' ? { name: c, description: '' } : { name: c.name || '', description: c.description || '' }
      )
    } else if (typeof parsed === 'object' && parsed !== null) {
      rawCaps = Object.entries(parsed).map(([k, v]) => ({ name: k, description: String(v) }))
    }
    const caps = rawCaps.filter(c => c.name).map(c => ({ ...c, checked: true }))
    // Normalize auth_fields
    let parsedAuth = data.auth_fields
    if (typeof parsedAuth === 'string') { try { parsedAuth = JSON.parse(parsedAuth) } catch { parsedAuth = [] } }
    const authFields = (Array.isArray(parsedAuth) ? parsedAuth : []).map((f: any) => ({
      name: f.name, displayName: f.display_name || f.displayName || f.name,
      description: f.description || '', helpUrl: f.help_url || f.helpUrl, helpText: f.help_text || f.helpText,
    }))
    broadcast({ type: 'capability_card', name: data.display_name || data.name, capabilities: caps, authFields: authFields.length > 0 ? authFields : undefined } as any)
    return 'Capabilities proposed to the user. They will see checkboxes to confirm which capabilities they want, plus input fields for any required auth credentials (API keys, etc.). Ask them to review and confirm.'
  }

  if (action === 'create') {
    if (!data.code) return 'Error: code is required for create action.'
    if (!data.display_name) return 'Error: display_name is required for create action.'

    const name = data.name
    const displayName = data.display_name
    const description = data.description || ''
    let parsedCaps = data.capabilities
    if (typeof parsedCaps === 'string') { try { parsedCaps = JSON.parse(parsedCaps) } catch { parsedCaps = [] } }
    const capabilities = (Array.isArray(parsedCaps) ? parsedCaps : []).map((c: any) => typeof c === 'string' ? c : c.name)
    let parsedAuth = data.auth_fields
    if (typeof parsedAuth === 'string') { try { parsedAuth = JSON.parse(parsedAuth) } catch { parsedAuth = [] } }
    const authFields = (Array.isArray(parsedAuth) ? parsedAuth : []).map((f: any) => ({
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
        ...(data.icon ? { icon: data.icon } : {}),
        ...(data.domain ? { domain: data.domain } : {})
      }, data.code, pkg)

      // Run npm install
      const { execSync } = await import('child_process')
      const dir = getCustomMcpDir(name)
      console.log(`[Custom MCP] Installing dependencies in ${dir}...`)
      execSync('npm install --production --ignore-scripts', { cwd: dir, stdio: 'pipe', timeout: 60000 })
      console.log(`[Custom MCP] Dependencies installed for ${name}`)

      // Send credential form to frontend
      if (authFields.length > 0) {
        broadcast({ type: 'integration_needs_fields', slug: `custom:${name}`, fields: authFields })
      }

      // Refresh integrations list
      const clients = Array.from(wss!.clients)
      if (clients.length > 0) sendIntegrations(clients[0] as WebSocket).catch(() => {})

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
        execSync('npm install --production --ignore-scripts', { cwd: dir, stdio: 'pipe', timeout: 60000 })
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
let teamClient: TeamClient | null = null

// Track which slugs are currently loaded in MCP so we can detect changes
let currentMcpSlugs: string[] = []
let imessageConnected = false
let contactsConnected = false

// Persist local integration connections so they survive restarts
const LOCAL_CONNECTIONS_FILE = join(DATA_DIR, 'local-connections.json')
function saveLocalConnections() {
  const data = { imessage: imessageConnected, contacts: contactsConnected }
  require('fs').writeFileSync(LOCAL_CONNECTIONS_FILE, JSON.stringify(data))
}
function loadLocalConnections(): { imessage: boolean; contacts: boolean } {
  try {
    return JSON.parse(require('fs').readFileSync(LOCAL_CONNECTIONS_FILE, 'utf-8'))
  } catch { return { imessage: false, contacts: false } }
}
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
    form.append('response_format', 'verbose_json')

    const res = await fetch(`${proxy.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': proxy.authHeader },
      body: form,
    })
    const data = await res.json() as { text?: string; duration?: number; error?: { message: string } }
    if (data.error) {
      console.error('[WhatsApp] Whisper error:', data.error.message)
      return null
    }
    // Track Whisper usage — duration from API verbose_json response
    if (data.duration) {
      recordUsageGlobal({
        category: 'whisper', model: 'whisper-1', audioSeconds: data.duration,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        timestamp: new Date().toISOString(),
      }).catch(err => console.error('[WhatsApp] Usage tracking failed:', err.message))
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
  agent.composioConnectedSlugs = slugs
  updateSetupMd(mergedSlugs).catch(err => console.error('[Server] Failed to update setup.md:', err.message))
  console.log('[Composio] MCP refreshed with toolkits:', mergedSlugs.join(', '))
  // Embed new tools + params immediately so they're ready before the user types
  embedToolsFromMcp().catch(() => {})
}

// Load persisted trigger state before Composio init
loadPersistedTriggers().catch(err => console.warn('[Composio] Failed to load persisted triggers:', err.message))

if (composioKey()) {
  console.log('[Composio] API key present, initializing MCP connection...')
  // Seed local connection tracking from Composio on first run (backwards compat)
  seedLocalConnectionsIfNeeded(composioKey()!, composioUserId())
    .catch(err => console.warn('[Composio] Failed to seed local connections:', err.message))
  // Ensure webhook subscription exists so Composio delivers trigger events to this user's relay
  ensureWebhookSubscription(composioKey()!)
    .catch(err => console.warn('[Composio] Failed to ensure webhook subscription:', err.message))
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
    agent.composioConnectedSlugs = slugs
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

// Auto-reconnect local integrations (iMessage, Contacts) that were connected before restart
;(async () => {
  const saved = loadLocalConnections()
  if (saved.imessage && canAccessChatDb()) {
    try {
      agent.mcpManager.registerLocal('coagent:imessage', IMESSAGE_TOOLS, handleImessageTool)
      imessageConnected = true
      agent.imessageConnected = true
      console.log('[iMessage] Auto-reconnected from saved state')
    } catch (e: any) { console.log('[iMessage] Auto-reconnect failed:', e.message) }
  }
  if (saved.contacts) {
    try {
      agent.mcpManager.registerLocal('coagent:contacts', CONTACTS_TOOLS, handleContactsTool)
      contactsConnected = true
      console.log('[Contacts] Auto-reconnected from saved state')
    } catch (e: any) { console.log('[Contacts] Auto-reconnect failed:', e.message) }
  }
  if (saved.imessage || saved.contacts) embedToolsFromMcp().catch(() => {})
})()

// Kill any stale process on the port before starting
try {
  const { execSync } = require('child_process')
  if (process.platform === 'win32') {
    const out = execSync(`netstat -ano | findstr ":${PORT}" | findstr LISTENING`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
    const pids: string[] = out.split('\n').map((l: string) => l.trim().split(/\s+/).pop() || '').filter(Boolean)
    const myPid = String(process.pid)
    const stale = pids.filter(p => p !== myPid)
    if (stale.length > 0) {
      for (const pid of stale) { try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }) } catch {} }
      console.log(`[Server] Killed stale process(es) on port ${PORT}: ${stale.join(', ')}`)
    }
  } else {
    const pids = execSync(`lsof -ti:${PORT}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
    if (pids) {
      const myPid = String(process.pid)
      const stale = pids.split('\n').filter((p: string) => p !== myPid)
      if (stale.length > 0) {
        execSync(`kill -9 ${stale.join(' ')}`, { stdio: 'ignore' })
        console.log(`[Server] Killed stale process(es) on port ${PORT}: ${stale.join(', ')}`)
      }
    }
  }
} catch {}

// Sync model from relay on startup — relay is the source of truth
// This MUST complete before any chat starts to avoid empty-model 403s
const relaySyncReady = (async () => {
  const relay = getRelayConfig()
  if (!relay) return
  try {
    const res = await fetch(`${relay.url}/v1/account`, {
      headers: { 'Authorization': `Bearer ${relay.token}` },
      signal: AbortSignal.timeout(10000),
    })
    if (res.ok) {
      const data = await res.json() as { model: string }
      if (data.model) {
        await writeSettings(DATA_DIR, { powerModel: data.model })
        console.log(`[Server] Synced model from relay: ${data.model}`)
      }
    }
  } catch (err: any) {
    console.warn('[Server] Failed to sync model from relay:', err.message)
  }
})()

wss = new WebSocketServer({ host: '127.0.0.1', port: PORT })

// Generate WebSocket auth nonce — only Tauri app can read this via IPC
const WS_NONCE = require('crypto').randomBytes(32).toString('hex')
const noncePath = require('path').join(DATA_DIR, '.ws-nonce')
require('fs').writeFileSync(noncePath, WS_NONCE, { mode: 0o600 })
console.log(`[Server] WS auth nonce written to ${noncePath}`)

wss.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] Port ${PORT} already in use — attempting to reclaim...`)
    const { execSync } = require('child_process')
    try {
      if (process.platform === 'win32') {
        const out = execSync(`netstat -ano | findstr ":${PORT}" | findstr LISTENING`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
        const pids: string[] = out.split('\n').map((l: string) => l.trim().split(/\s+/).pop() || '').filter(Boolean)
        for (const pid of pids) { try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }) } catch {} }
      } else {
        execSync(`lsof -ti:${PORT} | xargs kill -9`, { stdio: 'ignore', timeout: 3000 })
      }
      console.log(`[Server] Killed stale process(es) on port ${PORT}, retrying in 1s...`)
    } catch {
      console.warn(`[Server] Could not kill process on port ${PORT}, retrying anyway...`)
    }
    setTimeout(() => {
      wss!.removeAllListeners()
      wss!.close()
      wss = new WebSocketServer({ host: '127.0.0.1', port: PORT })
      wss.on('error', (retryErr: any) => {
        console.error(`[Server] Port ${PORT} still unavailable after retry:`, retryErr.message)
        process.exit(1)
      })
      attachWssHandlers(wss)
    }, 1000)
  } else {
    console.error('[Server] WebSocket server error:', err.message)
  }
})

// When relay reports subscription expired, notify all connected frontend clients
relay.onRevoked = () => {
  broadcast({ type: 'subscription_expired' } as any)
}

relay.connect()

// Team client — only initialize if edition includes team
try {
  if (getEdition().team && process.env.RELAY_URL && process.env.RELAY_TOKEN) {
    teamClient = new TeamClient({
      relayUrl: process.env.RELAY_URL.replace(/\/$/, ''),
      relayToken: process.env.RELAY_TOKEN,
      userId: process.env.RELAY_USER_ID || '',
      dataDir: DATA_DIR,
      onTaggedMessage: async (message) => {
        try {
          // If this is a reply from an agent we messaged, resolve the waiting tool call
          const pendingCallback = message.from.isAgent ? agent.pendingAgentReplies.get(message.from.userId) : undefined
          if (pendingCallback) {
            console.log(`[Team] Resolving pending reply from ${message.from.userId}`)
            agent.pendingAgentReplies.delete(message.from.userId)
            pendingCallback(message.visible)
            return
          }

          broadcast({ type: 'team_status', status: 'processing', from: message.from.name } as any)
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
          recentIds.add(message.id)

          // 2. Semantic search (all messages you've seen)
          const semantic = await log.searchMessages(message.visible, 5, recentIds)

          // 3. Fetch shared team notes
          let teamNotes = ''
          try {
            const relayUrl = process.env.RELAY_URL?.replace(/\/$/, '')
            const relayToken = process.env.RELAY_TOKEN
            if (relayUrl && relayToken) {
              const notesRes = await fetch(`${relayUrl}/team/notes`, {
                headers: { 'Authorization': `Bearer ${relayToken}` },
                signal: AbortSignal.timeout(15000),
              })
              if (notesRes.ok) {
                const data = await notesRes.json() as { content: string }
                if (data.content) teamNotes = data.content
              }
            }
          } catch (err) {
            console.warn('[Team] Failed to fetch team notes:', err)
          }

          // 4. Assemble context
          const parts: string[] = []

          if (teamNotes) {
            parts.push(`[Team Notes]\n${teamNotes}`)
          }

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

          const senderLabel = message.from.isAgent ? `${message.from.name}'s Agent` : message.from.name
          const replyTo = message.from.isAgent
            ? `Reply to @${message.from.userId}-agent so their agent receives your response.`
            : `Reply to @${message.from.name} to notify the human.`
          const teamPrompt = `[TEAM MESSAGE from ${senderLabel} (${message.from.role})]\n${message.visible}${message.agentContext ? `\n\n[Agent Context]: ${message.agentContext}` : ''}\n\nRespond to this team message. Use the send_team_message tool to reply. ${replyTo}`

          const response = await agent.teamChat(teamPrompt, teamContext, (text) => broadcast({ type: 'chat_chunk', text }), (tool, label) => broadcast({ type: 'tool_start', tool, label } as any))
          broadcast({ type: 'chat_response', message: { role: 'assistant', content: response, timestamp: new Date().toISOString() } })
          broadcast({ type: 'team_status', status: 'idle' } as any)
        } catch (err) {
          console.warn('[Team] Failed to process tagged message:', err)
          broadcast({ type: 'team_status', status: 'idle' } as any)
        }
      },
      onHumanNotify: async (message) => {
        broadcast({ type: 'push_notification', title: message.from.name, body: message.visible } as any)
      },
      onMessage: (message) => {
        broadcast({ type: 'team_message', message } as any)
      }
    })
    agent.teamClient = teamClient
    teamClient.init().then(() => teamClient!.connect()).catch(err => {
      console.warn('[Team] Failed to initialize team client:', err)
      teamClient = null
      agent.teamClient = null
    })
  }
} catch (err) {
  console.warn('[Team] Failed to initialize team client:', err)
}

function shutdown(signal: string): void {
  console.log(`[Server] ${signal} received — shutting down gracefully`)
  relay.stop()
  if (teamClient) { teamClient.stop(); teamClient = null }
  if (wss) {
    wss.close((err) => {
      if (err) console.error('[Server] Error closing WebSocket server:', err)
      else console.log('[Server] WebSocket server closed')
      process.exit(0)
    })
    // Force-close any still-open client connections
    for (const client of wss.clients) client.terminate()
  } else {
    process.exit(0)
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

function send(ws: WebSocket, msg: WSServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(msg: WSServerMessage): void {
  if (!wss) return
  const json = JSON.stringify(msg)
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(json)
  }
}

async function sendIntegrations(ws: WebSocket): Promise<void> {
  let integrations: any[]
  if (!composioKey()) {
    integrations = INTEGRATIONS.map(({ slug, name, category, description, capabilities }) => ({ slug, name, category, description, capabilities, connected: false }))
  } else {
    integrations = await getIntegrationStatuses(composioKey()!, composioUserId())
  }

  // Mark suggested integrations from the vertical preset
  const { preset } = getEdition()
  const suggestedSlugs = new Set(preset.suggestedIntegrations.map(s => s.toLowerCase()))

  // Enrich Composio integrations with available trigger info + suggested flag
  const subscribedSet = getSubscribedTriggers()
  integrations = integrations.map(integration => {
    const suggested = suggestedSlugs.has(integration.slug.toLowerCase())
    const availableTriggers = getAvailableTriggersForSlug(integration.slug)
    if (availableTriggers.length === 0) return suggested ? { ...integration, suggested } : integration
    const triggers = availableTriggers.map(t => ({
      slug: t.slug,
      label: t.label,
      appSlug: integration.slug,
      enabled: subscribedSet.has(t.slug),
    }))
    return { ...integration, triggers, ...(suggested ? { suggested } : {}) }
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

/** Debounced broadcast of files/folders to all clients — coalesces rapid file ops */
let filesBroadcastTimer: ReturnType<typeof setTimeout> | null = null
function broadcastFilesDebounced(): void {
  if (filesBroadcastTimer) return
  filesBroadcastTimer = setTimeout(async () => {
    filesBroadcastTimer = null
    try {
      const [files, folders] = await Promise.all([listFiles(DATA_DIR), listFolders(DATA_DIR)])
      broadcast({ type: 'files_update', files } as any)
      broadcast({ type: 'folders_update', folders } as any)
    } catch (err: any) {
      console.warn('[Server] broadcastFilesDebounced error:', err.message)
    }
  }, 500)
}

let relayStatusCache: { data: any; ts: number } | null = null
const RELAY_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

async function sendRelayStatus(ws: WebSocket, forceRefresh = false): Promise<void> {
  const relay = getRelayConfig()
  if (!relay) {
    send(ws, { type: 'relay_status', active: false, model: null, usage: null })
    return
  }
  if (!forceRefresh && relayStatusCache && Date.now() - relayStatusCache.ts < RELAY_CACHE_TTL) {
    send(ws, relayStatusCache.data)
    return
  }
  const res = await fetch(`${relay.url}/v1/account`, {
    headers: { 'Authorization': `Bearer ${relay.token}` },
    signal: AbortSignal.timeout(15000),
  })
  if (res.ok) {
    const data = await res.json() as { model: string; usage: any; admin?: boolean }
    const msg = { type: 'relay_status' as const, active: true, model: data.model, usage: data.usage, admin: data.admin ?? false }
    relayStatusCache = { data: msg, ts: Date.now() }
    send(ws, msg)
  } else {
    const msg = { type: 'relay_status' as const, active: false, model: null, usage: null }
    relayStatusCache = { data: msg, ts: Date.now() }
    send(ws, msg)
  }
}

/** Send full agent state to a single WebSocket connection. */
async function sendFullState(ws: WebSocket): Promise<void> {
  send(ws, { type: 'queue_update', items: agent.queue.getPending() })
  send(ws, { type: 'done_update', items: agent.queue.getDone() })
  send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
  console.log(`[Server] sendFullState heartbeat: nextHeartbeatAt=${nextHeartbeatAt ?? 'not set'}`)
  if (nextHeartbeatAt) send(ws, { type: 'heartbeat', status: 'scheduled', nextAt: nextHeartbeatAt })
  if (googleCal) {
    const gcalStatus = await googleCal.getStatus()
    send(ws, { type: 'google_calendar_status', ...gcalStatus } as any)
  }
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

function attachWssHandlers(server: WebSocketServer): void {
  server.on('connection', (ws) => {
    let authenticated = false
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        console.warn('[Server] WS client failed to authenticate within 2s — closing')
        ws.close(4001, 'Auth timeout')
      }
    }, 2000)

    const authHandler = (raw: any) => {
      try {
        const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
        if (msg.type === 'auth' && msg.nonce === WS_NONCE) {
          authenticated = true
          clearTimeout(authTimer)
          ws.removeListener('message', authHandler)
          handleAuthenticatedConnection(ws)
        } else {
          console.warn('[Server] WS auth failed — invalid nonce')
          ws.close(4003, 'Invalid nonce')
        }
      } catch {
        ws.close(4002, 'Invalid auth message')
      }
    }

    ws.on('message', authHandler)
  })
} // end attachWssHandlers

function handleAuthenticatedConnection(ws: WebSocket): void {
    sendFullState(ws).catch(console.error)

  ws.on('close', () => { console.log('[Server] Client disconnected') })
  ws.on('error', (err) => { console.error('[Server] WS error:', err.message); ws.close() })

  ws.on('message', async (raw) => {
    let msg: WSClientMessage
    try {
      msg = JSON.parse(raw.toString())
    } catch (err: any) {
      console.error('[Server] Malformed WS message — could not parse JSON:', err.message)
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }))
      return
    }

    // Exa monitor results — auto-save to research storage
    if ((msg as any).type === 'exa_monitor') {
      const data = (msg as any).data
      if (data?.results?.length) {
        try {
          const { saveResearch } = await import('@coagent/mcp-exa/dist/research-store.js' as any)
          const query = data.search?.query || data.query || 'monitor'
          const entries = data.results.map((r: any) => ({
            url: r.url,
            company: r.title || undefined,
            summary: r.summary || r.text?.slice(0, 300) || undefined,
            source: 'monitor',
            query,
            tags: ['monitor'],
          }))
          const res = saveResearch(DATA_DIR, entries)
          console.log(`[Server] Exa monitor auto-save: ${res.added} new, ${res.duplicates} merged`)
        } catch (err: any) {
          console.error(`[Server] Exa monitor auto-save failed: ${err.message}`)
        }
      }
      return
    }

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
      if (!file.path.startsWith(DATA_DIR)) {
        console.error(`[Server] get_file_content: path outside DATA_DIR rejected: ${file.path}`)
        send(ws, { type: 'file_content_error', id: msg.id, error: 'Access denied' } as any)
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
      voiceProcessing = false
      chatInProgress = false
      agentBusy = false
      broadcast({ type: 'voice_tts_cancel' } as any)
      return
    }

    if (msg.type === 'steer') {
      console.log(`[Server] Steer received: ${msg.message}`)
      agent.steer(msg.message)
      return
    }

    if (msg.type === 'chat') {
      if (chatInProgress || agentBusy) {
        send(ws, { type: 'error', message: 'Please wait — still processing your last message.' } as any)
        return
      }
      if (!getRelayConfig()) {
        send(ws, {
          type: 'chat_response',
          message: { role: 'assistant', content: 'I need a relay connection before I can help. Activate your relay in **Settings** to get started.', timestamp: new Date().toISOString() }
        })
        return
      }
      chatInProgress = true
      agentBusy = true
      broadcast({ type: 'agent_thinking' } as any)
      // Ensure relay model sync is complete before first chat
      await relaySyncReady
      try {
        let streamed = ''
        const chatTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Agent chat timed out after 10 minutes')), 10 * 60 * 1000)
        )
        const response = await Promise.race([
          agent.chat(
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
          ),
          chatTimeout
        ])
        broadcast({
          type: 'chat_response',
          message: { role: 'assistant', content: streamed || response, timestamp: new Date().toISOString() }
        } as any)
        send(ws, { type: 'queue_update', items: agent.queue.getPending() })
        send(ws, { type: 'done_update', items: agent.queue.getDone() })
        send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
        broadcastFilesDebounced()
      } catch (err: any) {
        console.error('[Server] chat error:', err.message)
        broadcast({ type: 'error', message: err.message ?? 'Something went wrong.' } as any)
        broadcast({ type: 'agent_stopped' } as any)
      } finally {
        chatInProgress = false
        agentBusy = false
      }
    }

    // Dictation: transcribe audio → clean up with Haiku → return text
    if (msg.type === 'voice_dictation') {
      const proxy = getOpenAIProxy()
      if (!proxy) { send(ws, { type: 'voice_dictation_result', text: '' }); return }
      try {
        const buf = Buffer.from(msg.data, 'base64')
        const fmt = msg.format === 'm4a' ? { mime: 'audio/mp4', ext: 'm4a' } : { mime: 'audio/webm', ext: 'webm' }
        const blob = new Blob([buf], { type: fmt.mime })
        const form = new FormData()
        form.append('file', blob, `dictation.${fmt.ext}`)
        form.append('model', 'whisper-1')
        form.append('language', 'en')
        form.append('prompt', 'Dictation for a chat message to an AI assistant.')
        form.append('temperature', '0.2')
        form.append('response_format', 'verbose_json')
        const res = await fetch(`${proxy.baseUrl}/v1/audio/transcriptions`, {
          method: 'POST',
          headers: { 'Authorization': proxy.authHeader },
          body: form,
        })
        const data = await res.json() as { text?: string; duration?: number }
        const text = data.text?.trim() || ''
        if (text) console.log('[Dictation] Result:', text.slice(0, 80))
        // Track Whisper usage — duration from API response
        if (data.duration) {
          recordUsageGlobal({
            category: 'whisper', model: 'whisper-1', audioSeconds: data.duration,
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
            timestamp: new Date().toISOString(),
          }).catch(err => console.error('[Dictation] Usage tracking failed:', err.message))
        }
        send(ws, { type: 'voice_dictation_result', text })
      } catch (err: any) {
        console.error('[Dictation] Error:', err.message)
        send(ws, { type: 'voice_dictation_result', text: '' })
      }
      return
    }

    if (msg.type === 'voice_audio') {
      // Guard: skip if another voice request is already being processed
      if (voiceProcessing || agentBusy) {
        console.log('[Voice] Skipping duplicate voice_audio — already processing')
        return
      }
      voiceProcessing = true
      agentBusy = true
      // Receive base64 audio from frontend, transcribe with Whisper, then process as voice chat
      const voiceProxy = getOpenAIProxy()
      if (!voiceProxy) {
        voiceProcessing = false
        agentBusy = false
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
        form.append('response_format', 'verbose_json')

        const res = await fetch(`${voiceProxy.baseUrl}/v1/audio/transcriptions`, {
          method: 'POST',
          headers: { 'Authorization': voiceProxy.authHeader },
          body: form,
        })
        const data = await res.json() as { text?: string; duration?: number; error?: { message: string } }
        const text = data.text?.trim()

        // Track Whisper usage — duration from API verbose_json response
        if (data.duration) {
          recordUsageGlobal({
            category: 'whisper', model: 'whisper-1', audioSeconds: data.duration,
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
            timestamp: new Date().toISOString(),
          }).catch(err => console.error('[Voice] Usage tracking failed:', err.message))
        }

        if (!text) {
          // Nothing transcribed — silently dismiss the pill
          voiceProcessing = false
          agentBusy = false
          send(ws, { type: 'voice_summary', summary: '' })
          return
        }

        console.log('[Voice] Transcribed:', text)

        // Process as a voice chat message
        if (!getRelayConfig()) {
          voiceProcessing = false
          agentBusy = false
          send(ws, { type: 'chat_response', message: { role: 'assistant', content: 'Relay not configured — cannot respond.', timestamp: new Date().toISOString() } })
          return
        }
        // Show transcribed text immediately, then process
        broadcast({ type: 'voice_transcribed', text } as any)
        broadcast({ type: 'agent_thinking' } as any)
        let streamed = ''
        let currentSegment = ''
        const settingsForTts = await readSettings(DATA_DIR)
        const doTts = settingsForTts.voice_response && !!getOpenAIProxy()
        // Queue TTS segments so they play in order (each awaits the previous)
        let ttsChain = Promise.resolve()
        const voicePrompt = text + ' [voice]'
        const voiceAudioTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Agent chat timed out after 10 minutes')), 10 * 60 * 1000)
        )
        const response = await Promise.race([
          agent.chat(
            voicePrompt,
            (chunk) => {
              streamed += chunk
              currentSegment += chunk
              broadcast({ type: 'chat_chunk', text: chunk } as any)
            },
            (tool, label) => {
              // Text segment ended — TTS it now before the tool runs
              if (doTts && currentSegment.trim()) {
                const segText = currentSegment
                ttsChain = ttsChain.then(() => streamTts(segText, settingsForTts.voice_voice, (msg) => send(ws, msg as any)))
              }
              currentSegment = ''
              broadcast({ type: 'chat_segment_end' } as any)
              broadcast({ type: 'tool_start', tool, label } as any)
            }
          ),
          voiceAudioTimeout
        ])
        // TTS the final segment (after last tool call, or the whole response if no tools)
        if (doTts && currentSegment.trim()) {
          const segText = currentSegment
          ttsChain = ttsChain.then(() => streamTts(segText, settingsForTts.voice_voice, (msg) => send(ws, msg as any)))
        }
        const fullResponse = streamed || response
        broadcast({ type: 'chat_response', message: { role: 'assistant', content: fullResponse, timestamp: new Date().toISOString() } } as any)
        send(ws, { type: 'queue_update', items: agent.queue.getPending() })
        send(ws, { type: 'done_update', items: agent.queue.getDone() })
        send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
        broadcastFilesDebounced()
        // Wait for all TTS segments to finish streaming before dismissing pill
        await ttsChain
        send(ws, { type: 'voice_summary', summary: fullResponse })
        voiceProcessing = false
        agentBusy = false
      } catch (err: any) {
        voiceProcessing = false
        agentBusy = false
        console.error('[Voice] Transcription/chat error:', err.message)
        send(ws, { type: 'error', message: `Voice failed: ${err.message}` })
        send(ws, { type: 'agent_stopped' })
      }
    }

    if (msg.type === 'voice_chat') {
      if (chatInProgress || agentBusy) {
        send(ws, { type: 'chat_response', message: { role: 'assistant', content: 'I\'m still working on the previous request.', timestamp: new Date().toISOString() } })
        return
      }
      if (!getRelayConfig()) {
        send(ws, {
          type: 'chat_response',
          message: { role: 'assistant', content: 'I need a relay connection before I can help. Activate your relay in **Settings** to get started.', timestamp: new Date().toISOString() }
        })
        return
      }
      broadcast({ type: 'agent_thinking' } as any)
      chatInProgress = true
      agentBusy = true
      try {
        let streamed = ''
        let currentSegment = ''
        const settingsForTts = await readSettings(DATA_DIR)
        const doTts = settingsForTts.voice_response && !!getOpenAIProxy()
        let ttsChain = Promise.resolve()
        const voicePrompt = msg.message + ' [voice]'
        const voiceChatTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Agent chat timed out after 10 minutes')), 10 * 60 * 1000)
        )
        const response = await Promise.race([
          agent.chat(
            voicePrompt,
            (chunk) => {
              streamed += chunk
              currentSegment += chunk
              broadcast({ type: 'chat_chunk', text: chunk } as any)
            },
            (tool, label) => {
              if (doTts && currentSegment.trim()) {
                const segText = currentSegment
                ttsChain = ttsChain.then(() => streamTts(segText, settingsForTts.voice_voice, (m) => send(ws, m as any)))
              }
              currentSegment = ''
              broadcast({ type: 'chat_segment_end' } as any)
              broadcast({ type: 'tool_start', tool, label } as any)
            }
          ),
          voiceChatTimeout
        ])
        if (doTts && currentSegment.trim()) {
          const segText = currentSegment
          ttsChain = ttsChain.then(() => streamTts(segText, settingsForTts.voice_voice, (m) => send(ws, m as any)))
        }
        const fullResp = streamed || response
        broadcast({
          type: 'chat_response',
          message: { role: 'assistant', content: fullResp, timestamp: new Date().toISOString() }
        } as any)
        send(ws, { type: 'queue_update', items: agent.queue.getPending() })
        send(ws, { type: 'done_update', items: agent.queue.getDone() })
        send(ws, { type: 'calendar_update', entries: agent.calendar.getAll() })
        broadcastFilesDebounced()
        // Wait for all TTS segments to finish streaming before dismissing pill
        await ttsChain
        send(ws, { type: 'voice_summary', summary: fullResp })
      } catch (err: any) {
        console.error('[Server] voice_chat error:', err.message)
        broadcast({ type: 'error', message: err.message ?? 'Something went wrong.' } as any)
        broadcast({ type: 'agent_stopped' } as any)
      } finally {
        chatInProgress = false
        agentBusy = false
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
        if (chatInProgress || agentBusy) {
          send(ws, { type: 'error', message: 'Agent is busy — try again in a moment.' })
          return
        }
        chatInProgress = true
        agentBusy = true
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
          broadcastFilesDebounced()
        } catch (err: any) {
          console.error('[Server] approve execution error:', err.message)
          send(ws, { type: 'error', message: err.message ?? 'Something went wrong.' })
          send(ws, { type: 'agent_stopped' })
        } finally {
          chatInProgress = false
          agentBusy = false
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

    if (msg.type === 'get_google_calendar_status') {
      if (googleCal) {
        const status = await googleCal.getStatus()
        send(ws, { type: 'google_calendar_status', ...status } as any)
      } else {
        send(ws, { type: 'google_calendar_status', connected: false, calendars: [], lastSync: null } as any)
      }
    }

    if (msg.type === 'google_calendar_connect') {
      if (!googleCal) {
        send(ws, { type: 'error', message: 'Google Calendar not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' })
        return
      }
      try {
        send(ws, { type: 'agent_thinking' })
        await googleCal.connect()
        const result = await googleCal.sync()
        applyGoogleSyncResult(result)
        const status = await googleCal.getStatus()
        broadcast({ type: 'google_calendar_status', ...status } as any)
        broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() })
        agent.googleCalendarConnected = true
      } catch (err: any) {
        console.error('[Server] Google Calendar connect error:', err.message)
        send(ws, { type: 'error', message: `Google Calendar connection failed: ${err.message}` })
      }
    }

    if (msg.type === 'google_calendar_disconnect') {
      if (googleCal) {
        await googleCal.disconnect()
        agent.calendar.clearGoogleEvents()
        agent.googleCalendarConnected = false
        const status = await googleCal.getStatus()
        broadcast({ type: 'google_calendar_status', ...status } as any)
        broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() })
      }
    }

    if (msg.type === 'google_calendar_toggle') {
      if (googleCal) {
        googleCal.toggleCalendar((msg as any).calendarId, (msg as any).enabled)
        const toggleResult = await googleCal.sync()
        applyGoogleSyncResult(toggleResult)
        const status = await googleCal.getStatus()
        broadcast({ type: 'google_calendar_status', ...status } as any)
        broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() })
      }
    }

    if (msg.type === 'google_calendar_color') {
      if (googleCal) {
        googleCal.setCalendarColor((msg as any).calendarId, (msg as any).color)
        const status = await googleCal.getStatus()
        broadcast({ type: 'google_calendar_status', ...status } as any)
      }
    }

    if (msg.type === 'google_calendar_sync') {
      if (googleCal) {
        const syncResult = await googleCal.sync()
        applyGoogleSyncResult(syncResult)
        const status = await googleCal.getStatus()
        broadcast({ type: 'google_calendar_status', ...status } as any)
        broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() })
      }
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
        // Always fetch fresh data when UI polls (e.g. after OAuth completion)
        invalidateAccountsCache()
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
        // Credentials available via Tauri IPC (get_relay_credentials) — write fresh file
        writeRelayCredentialsFile()
        send(ws, { type: 'relay_credentials_ready' } as any)
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
        if (!canAccessChatDb()) {
          console.log('[iMessage] FDA check failed — opening settings')
          try {
            const { execSync } = require('child_process')
            execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"')
          } catch {}
          send(ws, {
            type: 'integration_fda_required' as any,
            slug: msg.slug,
            message: 'Add Co-Agent to Full Disk Access in System Settings, then restart the app and click Connect again.'
          })
          return
        }
        console.log('[iMessage] Registering local handler...')
        try {
          await agent.mcpManager.disconnect('coagent:imessage')
          agent.mcpManager.registerLocal('coagent:imessage', IMESSAGE_TOOLS, handleImessageTool)
          imessageConnected = true
          agent.imessageConnected = true
          saveLocalConnections()
          embedToolsFromMcp().catch(() => {})
          await sendIntegrations(ws)
        } catch (err: any) {
          send(ws, { type: 'error', message: `Failed to connect iMessage: ${err.message}` })
        }
        return
      }
      if (msg.slug === 'coagent:contacts') {
        console.log('[Contacts] Connect requested...')
        if (!canAccessAddressBook()) {
          console.log('[Contacts] FDA check failed — opening settings')
          try {
            const { execSync } = require('child_process')
            execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"')
          } catch {}
          send(ws, {
            type: 'integration_fda_required' as any,
            slug: msg.slug,
            message: 'Add Co-Agent to Full Disk Access in System Settings, then restart the app and click Connect again.'
          })
          return
        }
        console.log('[Contacts] Registering local handler...')
        try {
          await agent.mcpManager.disconnect('coagent:contacts')
          agent.mcpManager.registerLocal('coagent:contacts', CONTACTS_TOOLS, handleContactsTool)
          contactsConnected = true
          saveLocalConnections()
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
          } else {
            // No auth fields needed — connect directly
            try {
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
          }
        }
        return
      }
      if (!composioKey()) {
        send(ws, { type: 'error', message: 'Add your Composio API key in Settings → API Keys to connect integrations.' })
      } else {
        try {
          const url = await generateAuthUrl(composioKey()!, msg.slug, composioUserId(), msg.params)
          await markLocalConnected(msg.slug)
          if (url === 'CONNECTED_DIRECTLY') {
            // API key integrations connect without OAuth redirect
            invalidateAccountsCache()
            const slugs = await getConnectedSlugs(composioKey()!, composioUserId())
            await refreshComposioMcp(slugs).catch(console.error)
            await sendIntegrations(ws)
            return
          }
          send(ws, { type: 'integration_auth_url', slug: msg.slug, url })
        } catch (err: any) {
          if (err.message === 'NEEDS_FIELDS') {
            send(ws, { type: 'integration_needs_fields', slug: msg.slug, fields: err.fields })
          } else {
            console.error(`[Composio] Connect ${msg.slug} failed:`, err.message)
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
          agent.imessageConnected = false
          saveLocalConnections()
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
          saveLocalConnections()
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
          // Snapshot tool names for this slug before disconnecting
          const prefix = msg.slug.toUpperCase() + '_'
          const { tools: priorTools } = await agent.mcpManager.getAllTools()
          const toolsToPurge = priorTools.filter(t => t.name.startsWith(prefix)).map(t => t.name)

          await disconnectIntegration(composioKey()!, msg.slug, composioUserId())
          // Explicitly remove from tracked slugs so refreshComposioMcp doesn't re-add it
          currentMcpSlugs = currentMcpSlugs.filter(s => s !== msg.slug)
          const slugs = await getConnectedSlugs(composioKey()!, composioUserId())
          await refreshComposioMcp(slugs)

          // Purge disconnected tools from LanceDB index
          if (toolsToPurge.length > 0) {
            purgeTools(toolsToPurge).catch(err => console.warn('[Server] Tool purge failed:', err.message))
          }

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
      if (chatInProgress || agentBusy) {
        send(ws, { type: 'error', message: 'Please wait — still processing your last message.' } as any)
        return
      }
      const selected = msg.capabilities.join(', ')
      const authInfo = msg.authValues && Object.keys(msg.authValues).length > 0
        ? `\nThe user provided these auth credentials: ${JSON.stringify(msg.authValues)}. Store these securely in the integration's env config.`
        : ''
      const chatMsg = `The user confirmed these capabilities for the custom integration: ${selected}.${authInfo} Now generate the MCP server code and call create_custom_integration with action "create" to build it.`
      chatInProgress = true
      agentBusy = true
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
      } finally {
        chatInProgress = false
        agentBusy = false
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
        // If auto-brief settings changed, reschedule the brief timer
        if (msg.patch.auto_brief_meetings !== undefined || msg.patch.auto_brief_minutes !== undefined) {
          scheduler.rescheduleBrief()
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

    if (msg.type === 'update_document_fields') {
      try {
        const meta = await getDocumentMeta(DATA_DIR, msg.fileId)
        if (!meta) {
          send(ws, { type: 'error', message: 'This document has no stored template data.' } as any)
          return
        }

        // Deep merge: arrays replaced, objects shallow-merged, primitives replaced
        const merged = { ...meta.templateData }
        for (const [key, value] of Object.entries(msg.data)) {
          if (Array.isArray(value)) {
            merged[key] = value
          } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            merged[key] = { ...(merged[key] || {}), ...value }
          } else {
            merged[key] = value
          }
        }

        const settings = await readSettings(DATA_DIR)
        const brand = (settings.brand_company || settings.brand_color || settings.brand_logo)
          ? { companyName: settings.brand_company || undefined, accentColor: settings.brand_color || undefined, logoBase64: settings.brand_logo || undefined }
          : undefined

        const { renderTemplatedDocument } = await import('./document-renderer.js')
        const buf = await renderTemplatedDocument({ ...merged, template: meta.template }, brand)

        // Write the new PDF to the same path
        const files = await listFiles(DATA_DIR)
        const originalFile = files.find(f => f.id === msg.fileId)

        if (originalFile) {
          // Overwrite the file on disk
          const { writeFile: writeFileAsync } = await import('fs/promises')
          await writeFileAsync(originalFile.path, buf)

          // Update the metadata with new data
          await updateDocumentMeta(DATA_DIR, msg.fileId, {
            template: meta.template,
            templateData: merged,
            lastRenderedAt: new Date().toISOString()
          })

          send(ws, { type: 'document_updated', fileId: msg.fileId } as any)
          broadcastFilesDebounced()
        }
      } catch (err: any) {
        console.error('[Server] update_document_fields error:', err.message)
        send(ws, { type: 'error', message: `Failed to update document: ${err.message}` } as any)
      }
    }

    if (msg.type === 'trigger_heartbeat') {
      console.log('[Server] Manual heartbeat triggered')
      try {
        await agent.handleTrigger(
          { source: 'heartbeat' },
          () => {},
          () => {}
        )
        send(ws, { type: 'heartbeat', status: 'done' })
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
          signal: AbortSignal.timeout(15000),
        })
        if (res.ok) {
          const data = await res.json() as { model: string; usage: any; admin?: boolean; googleClientId?: string; googleClientSecret?: string }
          writeRelayCredentialsFile()
          // Initialize Google Calendar if relay provides credentials
          if (data.googleClientId && data.googleClientSecret) {
            const envPath = join(DATA_DIR, '.env')
            writeFileSync(envPath, `GOOGLE_CLIENT_ID=${data.googleClientId}\nGOOGLE_CLIENT_SECRET=${data.googleClientSecret}\n`, { mode: 0o600 })
            initGoogleCalendar(data.googleClientId, data.googleClientSecret)
          }
          send(ws, { type: 'relay_status', active: true, model: data.model, usage: data.usage, admin: data.admin ?? false })
          send(ws, { type: 'relay_credentials_ready' })
        } else {
          send(ws, { type: 'relay_status', active: false, model: null, usage: null })
          send(ws, { type: 'error', message: 'Invalid activation code' })
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
        // Sync model choice to relay so it persists across devices/restarts
        const relay = getRelayConfig()
        if (relay) {
          fetch(`${relay.url}/v1/model`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${relay.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: msg.model }),
          }).catch(err => console.warn('[Server] Failed to sync model to relay:', err.message))
        }
        relayStatusCache = null // invalidate cached status
        console.log('[Server] Model switched to', msg.model)
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to switch model: ${err.message}` })
      }
    }

    if (msg.type === 'get_relay_status') {
      agent.reinitClient()
      relayStatusCache = null
      sendRelayStatus(ws, true).catch(console.error)
    }

    if (msg.type === 'admin_create_token') {
      const relayUrl = process.env.RELAY_URL
      const relayToken = process.env.RELAY_TOKEN
      if (!relayUrl || !relayToken) {
        send(ws, { type: 'error', message: 'Relay not configured' })
      } else {
        try {
          const res = await fetch(`${relayUrl}/admin/create-token`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${relayToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: msg.label }),
            signal: AbortSignal.timeout(15000),
          })
          if (res.ok) {
            const data = await res.json() as { token: string; userId: string }
            send(ws, { type: 'admin_token_created', token: data.token, userId: data.userId })
          } else {
            const err = await res.text()
            send(ws, { type: 'error', message: `Failed to create token: ${err}` })
          }
        } catch (err: any) {
          send(ws, { type: 'error', message: `Admin error: ${err.message}` })
        }
      }
    }

    if (msg.type === 'admin_list_tokens') {
      const relayUrl = process.env.RELAY_URL
      const relayToken = process.env.RELAY_TOKEN
      if (!relayUrl || !relayToken) {
        send(ws, { type: 'error', message: 'Relay not configured' })
      } else {
        try {
          const res = await fetch(`${relayUrl}/admin/list-tokens`, {
            headers: { 'Authorization': `Bearer ${relayToken}` },
            signal: AbortSignal.timeout(15000),
          })
          if (res.ok) {
            const data = await res.json() as { users: any[] }
            send(ws, { type: 'admin_tokens_list', users: data.users })
          } else {
            const err = await res.text()
            send(ws, { type: 'error', message: `Failed to list tokens: ${err}` })
          }
        } catch (err: any) {
          send(ws, { type: 'error', message: `Admin error: ${err.message}` })
        }
      }
    }

    if (msg.type === 'admin_revoke_token') {
      const relayUrl = process.env.RELAY_URL
      const relayToken = process.env.RELAY_TOKEN
      if (!relayUrl || !relayToken) {
        send(ws, { type: 'error', message: 'Relay not configured' })
      } else {
        try {
          const res = await fetch(`${relayUrl}/admin/revoke-token`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${relayToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: msg.token }),
            signal: AbortSignal.timeout(15000),
          })
          if (res.ok) {
            const data = await res.json() as { token: string; active: boolean }
            send(ws, { type: 'admin_token_toggled', token: data.token, active: data.active })
          } else {
            const err = await res.text()
            send(ws, { type: 'error', message: `Failed to toggle token: ${err}` })
          }
        } catch (err: any) {
          send(ws, { type: 'error', message: `Admin error: ${err.message}` })
        }
      }
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

    // Handle team messages from desktop client
    if (msg.type === 'team_send') {
      if (teamClient && teamClient.teamId) {
        console.log(`[Team] Sending human message to: ${(msg as any).to || 'broadcast'}`)
        await teamClient.sendHumanMessage((msg as any).message, (msg as any).to || null)
      } else {
        console.warn('[Team] Cannot send — teamClient not connected or no teamId')
      }
    }

    if (msg.type === 'get_team_info') {
      if (teamClient) {
        await teamClient.fetchRoster()
        if (teamClient.teamId) {
          send(ws, {
            type: 'team_info',
            team: { teamId: teamClient.teamId, name: teamClient.teamName || '', ownerId: '', created: '', members: teamClient.getRoster() }
          } as any)
        } else {
          send(ws, { type: 'team_info', team: null } as any)
        }
      } else {
        send(ws, { type: 'team_info', team: null } as any)
      }
    }

    if (msg.type === 'team_history') {
      if (teamClient && teamClient.teamId && process.env.RELAY_URL && process.env.RELAY_TOKEN) {
        try {
          const res = await fetch(`${process.env.RELAY_URL.replace(/\/$/, '')}/team/history?limit=${(msg as any).limit || 50}`, {
            headers: { 'Authorization': `Bearer ${process.env.RELAY_TOKEN}` },
            signal: AbortSignal.timeout(15000),
          })
          const messages = await res.json()
          send(ws, { type: 'team_history', messages } as any)
        } catch {}
      }
    }

  })
} // end handleAuthenticatedConnection

attachWssHandlers(wss!)

console.log(`Co-Agent running on ws://localhost:${PORT}`)
