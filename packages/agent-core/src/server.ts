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

import { listFiles, listFolders, ingestFile, deleteFileEntry, createFolder, moveFile, moveFolder, renameFile, renameFolder, deleteFolder, saveFolderOrder, searchFiles, updateDocumentContent, readDocumentContent, finalizeDocument } from './file-store.js'
import { writeRelayCredentials, getRelayConfig, writeApiKeys, loadApiKeysToEnv, getApiKeyStatus } from './auth.js'
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

// Resolve MCP server entry points relative to this package's node_modules
const mcpMemoryPath = require.resolve('@coagent/mcp-memory')

function buildMcpConfigs(): MCPServerConfig[] {
  return [
    {
      name: 'memory',
      command: 'node',
      args: [mcpMemoryPath],
      env: {
        COAGENT_DATA_DIR: join(homedir(), '.coagent'),
        ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {})
      } as Record<string, string>
    }
  ]
}

const DATA_DIR = join(homedir(), '.coagent')

// --- Default memory files (written on first run, never overwritten) ---

const MEMORY_FILES: Record<string, string> = {
  'setup.md': `# About CoAgent

CoAgent is a personal AI assistant that runs privately on your computer. Nothing leaves your machine except calls to Claude (the AI) and the tools you've connected. No data is stored in the cloud.

## How I work

**I stay in the background.** I sit quietly until something needs attention or you talk to me directly.

**I check in every hour.** I look at your connected tools (email, calendar, etc.) for anything that needs your attention. If nothing is going on, I skip it and wait.

**Once a day I tidy my memory.** Every night at 3am I review my notes and clean out anything stale or resolved.

**I ask before doing anything risky.** If I'm about to do something that can't be undone — like sending an email or deleting something — I'll queue it up for you to approve first.

**I keep a to-do list.** I can add things to a to-do list and check them off when done. I'll remind you about them when they're due.

## My memory

I keep notes in \`~/.coagent/memory/\`. These are my brain — I read them on every check-in.

- **setup.md** — this file. What CoAgent is and how it works.
- **agent.md** — your profile: who you are, what you do, how you like things handled.
- **routines.md** — my heartbeat schedule: what to check and when.
- **preferences.md** — how you like things done (tone, format, behavior).
- **contacts.md** — key people in your life and how to handle their messages.
- **projects.md** — active projects, context, and deadlines.

I create and update these as we work together. You can also edit them directly.

## Connected tools

I can connect to your apps to take action on your behalf — reading emails, creating calendar events, looking up contacts, etc.

Apps with live alerts (I get notified when something happens):
- Gmail, Outlook — new emails
- Google Calendar — new events, upcoming meetings
- Google Drive — new or shared files
- HubSpot — new contacts, deal updates
- Slack — messages and DMs
- Notion — new pages and comments

Apps where I can take action but don't get live alerts:
- Google Sheets, Google Docs, Google Meet, Google Maps
- Microsoft Teams, SharePoint, Excel
- Salesforce, Shopify, ClickUp, Monday
- Dropbox, Dropbox Sign, LinkedIn
- GitHub

## What I can always do

Even without any apps connected, I can help with writing, research, math, analysis, and general questions. I can also run Python code for calculations or data work.
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

const agent = new Agent(buildMcpConfigs(), DATA_DIR)

agent.onDocumentEvent = (event) => {
  if (event.type === 'opened') {
    broadcast({ type: 'document_opened', id: event.id, filename: event.filename, content: event.content })
  } else if (event.type === 'updated') {
    broadcast({ type: 'document_updated', id: event.id, content: event.content })
  }
}

agent.onDocumentStream = (event) => {
  if (event.type === 'start') {
    broadcast({ type: 'document_stream_start', filename: event.filename })
  } else if (event.type === 'chunk') {
    broadcast({ type: 'document_stream_chunk', text: event.text })
  }
}

startScheduler(agent, DATA_DIR)

const relay = new RelayClient(DATA_DIR)

// Track which slugs are currently loaded in MCP so we can detect changes
let currentMcpSlugs: string[] = []

// Always-on toolkits that require no auth — loaded regardless of user connections
const ALWAYS_ON_TOOLKITS = ['composio_search', 'text_to_pdf']

async function refreshComposioMcp(slugs: string[]): Promise<void> {
  const allToolkits = [...new Set([...ALWAYS_ON_TOOLKITS, ...slugs])]
  const { url, apiKey } = await setupComposioMcp(process.env.COMPOSIO_API_KEY!, allToolkits, 'default', true)
  await agent.mcpManager.disconnectAll()
  await agent.mcpManager.connect(buildMcpConfigs())
  await agent.mcpManager.connectHttp('composio', url, apiKey)
  currentMcpSlugs = slugs
  console.log('[Composio] MCP refreshed with toolkits:', slugs.join(', '))
}

if (process.env.COMPOSIO_API_KEY) {
  // Clean up any stale expired accounts on boot to prevent duplicate buildup
  purgeExpiredAccounts(process.env.COMPOSIO_API_KEY)
    .catch(err => console.error('[Composio] Failed to purge expired accounts:', err.message))

  getConnectedSlugs(process.env.COMPOSIO_API_KEY).then(async (slugs) => {
    // Default to all supported integrations so tools are available even before user connects
    const userToolkits = slugs.length > 0 ? slugs : ['gmail', 'googlecalendar']
    const toolkits = [...new Set([...ALWAYS_ON_TOOLKITS, ...userToolkits])]
    const { url, apiKey } = await setupComposioMcp(process.env.COMPOSIO_API_KEY!, toolkits)
    await agent.mcpManager.connectHttp('composio', url, apiKey)
    currentMcpSlugs = userToolkits
    console.log('[Composio] MCP connected with toolkits:', toolkits.join(', '))
    // Subscribe triggers for all currently connected integrations
    for (const slug of slugs) {
      subscribeTriggersForSlug(process.env.COMPOSIO_API_KEY!, slug)
        .catch(err => console.error(`[Composio] Trigger subscribe failed for ${slug}:`, err.message))
    }
  }).catch(err => console.error('[Composio] Failed to connect MCP:', err.message))
}

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
  send(ws, { type: 'todo_update', items: agent.todos.getAll() })
  send(ws, { type: 'chat_history', messages: agent.getChatHistory() })
  sendIntegrations(ws).catch(console.error)
  sendFilesAndFolders(ws).catch(console.error)
  readSettings(DATA_DIR).then(settings => send(ws, { type: 'settings_update', settings })).catch(console.error)
  sendRelayStatus(ws).catch(console.error)
  send(ws, { type: 'api_keys_status', keys: getApiKeyStatus() })

  ws.on('message', async (raw) => {
    const msg: WSClientMessage = JSON.parse(raw.toString())

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
        const response = await agent.chat(
          msg.message,
          (chunk) => send(ws, { type: 'chat_chunk', text: chunk }),
          (tool, label) => send(ws, { type: 'tool_start', tool, label })
        )
        send(ws, {
          type: 'chat_response',
          message: { role: 'assistant', content: response, timestamp: new Date().toISOString() }
        })
        send(ws, { type: 'queue_update', items: agent.queue.getPending() })
        send(ws, { type: 'done_update', items: agent.queue.getDone() })
        send(ws, { type: 'todo_update', items: agent.todos.getAll() })
        sendFilesAndFolders(ws).catch(console.error)
      } catch (err: any) {
        console.error('[Server] chat error:', err.message)
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
          send(ws, { type: 'todo_update', items: agent.todos.getAll() })
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
      send(ws, { type: 'todo_update', items: agent.todos.getAll() })
    }

    if (msg.type === 'complete_todo') {
      agent.todos.complete(msg.id)
      send(ws, { type: 'todo_update', items: agent.todos.getAll() })
    }

    if (msg.type === 'delete_todo') {
      agent.todos.delete(msg.id)
      send(ws, { type: 'todo_update', items: agent.todos.getAll() })
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
        await ingestFile(DATA_DIR, msg.filename, buffer, msg.mimeType)
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

    if (msg.type === 'update_document') {
      try {
        await updateDocumentContent(DATA_DIR, msg.id, msg.content)
        // Also refresh the files list since metadata changed
        await sendFilesAndFolders(ws)
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to update document: ${err.message}` })
      }
    }

    if (msg.type === 'close_document') {
      broadcast({ type: 'document_closed' })
    }

    if (msg.type === 'open_document') {
      try {
        const content = await readDocumentContent(DATA_DIR, msg.id)
        const files = await listFiles(DATA_DIR)
        const file = files.find(f => f.id === msg.id)
        broadcast({ type: 'document_opened', id: msg.id, filename: file?.filename ?? 'Document', content })
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to open document: ${err.message}` })
      }
    }

    if (msg.type === 'trigger_heartbeat') {
      console.log('[Server] Manual heartbeat triggered')
      send(ws, { type: 'agent_thinking' })
      try {
        await agent.handleTrigger({ source: 'heartbeat' })
        send(ws, { type: 'queue_update', items: agent.queue.getPending() })
        send(ws, { type: 'done_update', items: agent.queue.getDone() })
        send(ws, { type: 'todo_update', items: agent.todos.getAll() })
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
