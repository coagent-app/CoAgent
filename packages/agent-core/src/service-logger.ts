import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { mkdir } from 'fs/promises'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { recordUsage } from './usage-tracker.js'
import { getRelayConfig } from './auth.js'
import { streamOpenAI } from './openai-provider.js'
import { embed } from './tool-embeddings.js'
import { connect, Table } from '@lancedb/lancedb'
import { KIMI_MODEL, MOONSHOT_BASE_URL, EMBED_DIM } from './constants.js'

// ── Types ────────────────────────────────────────────────────────────────────

interface ToolLogEntry {
  service: string
  tool: string
  params: Record<string, unknown>
  result?: string
  ts: string
}

// ── Paths ────────────────────────────────────────────────────────────────────

function servicesDir(dataDir: string): string {
  const dir = join(dataDir, 'services')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function logPath(dataDir: string): string {
  return join(servicesDir(dataDir), 'tool-log.json')
}

// ── LanceDB for log embeddings ──────────────────────────────────────────────

let logTable: Table | null = null
let logDbDir: string | null = null

async function getLogTable(dataDir: string): Promise<Table | null> {
  const dbDir = join(dataDir, 'services', 'tool-log-db')
  if (logTable && logDbDir === dbDir) return logTable
  await mkdir(dbDir, { recursive: true })
  const db = await connect(dbDir)
  const tables = await db.tableNames()
  if (tables.includes('logs')) {
    logTable = await db.openTable('logs')
  } else {
    // Create with a dummy row so the table exists
    logTable = await db.createTable('logs', [
      { ts: '', text: '', vector: new Array(EMBED_DIM).fill(0) }
    ])
  }
  logDbDir = dbDir
  return logTable
}

/** Format a log entry into an embeddable text string */
function logEntryText(entry: ToolLogEntry): string {
  const params = Object.entries(entry.params).map(([k, v]) => `${k}: ${v}`).join(', ')
  return `${entry.service} ${entry.tool} ${params}${entry.result ? ' → ' + entry.result : ''}`
}

// ── Integration Extraction ───────────────────────────────────────────────────

/**
 * Derive integration name from tool name.
 * Composio tools follow INTEGRATION_ACTION pattern (e.g. GMAIL_SEND_EMAIL → gmail).
 * Non-Composio tools just use the server name.
 */
export function extractIntegration(serverName: string, toolName: string): string {
  if (serverName === 'composio') {
    const idx = toolName.indexOf('_')
    if (idx > 0) return toolName.slice(0, idx).toLowerCase()
  }
  return serverName
}

// ── Logging ──────────────────────────────────────────────────────────────────

const MAX_TOOL_LOG_ENTRIES = 500
const MAX_TOOL_LOG_AGE_DAYS = 7

/** Append a tool call entry to the daily log and embed it into LanceDB. */
export function logToolCall(
  dataDir: string,
  service: string,
  tool: string,
  params: Record<string, unknown>,
  result?: string
): void {
  const integration = extractIntegration(service, tool)

  const path = logPath(dataDir)
  let log: ToolLogEntry[] = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf-8'))
    : []

  const cleanParams: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      cleanParams[k] = typeof v === 'string' && v.length > 150 ? v.slice(0, 150) + '…' : v
    }
  }

  // Truncate result to capture key identifiers (user IDs, channel names, etc.) without bloating logs
  const trimmedResult = result ? (result.length > 300 ? result.slice(0, 300) + '…' : result) : undefined

  const entry: ToolLogEntry = { service: integration, tool, params: cleanParams, result: trimmedResult, ts: new Date().toISOString() }
  log.push(entry)

  // Prune on every write: drop entries older than 7 days, then cap at 500
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - MAX_TOOL_LOG_AGE_DAYS)
  const cutoffStr = cutoff.toISOString()
  log = log.filter(e => e.ts >= cutoffStr)
  if (log.length > MAX_TOOL_LOG_ENTRIES) {
    log = log.slice(log.length - MAX_TOOL_LOG_ENTRIES)
  }

  writeFileSync(path, JSON.stringify(log, null, 2))

  // Embed async into LanceDB — don't block the tool call
  const text = logEntryText(entry)
  embed([text]).then(async ([vec]) => {
    if (!vec || vec.length === 0) return
    const tbl = await getLogTable(dataDir)
    if (!tbl) return
    await tbl.add([{ ts: entry.ts, text, vector: vec }])
  }).catch(() => {})
}

// ── Log Search ──────────────────────────────────────────────────────────────

function formatLogEntry(e: ToolLogEntry): string {
  const time = e.ts.slice(5, 16).replace('T', ' ')
  const params = Object.entries(e.params).map(([k, v]) => `${k}: ${v}`).join(', ')
  // Show result on its own line so the agent can actually read the context
  if (e.result) {
    return `${time} ${e.service}/${e.tool}(${params})\n  Result: ${e.result}`
  }
  return `${time} ${e.service}/${e.tool}(${params})`
}

/**
 * Semantic search over tool logs using LanceDB vector search.
 * Falls back to keyword matching if no embeddings available.
 */
export async function searchToolLogs(
  dataDir: string,
  query: string,
  limit = 5
): Promise<string[]> {
  const path = logPath(dataDir)
  if (!existsSync(path)) return []

  const log: ToolLogEntry[] = JSON.parse(readFileSync(path, 'utf-8'))
  if (log.length === 0) return []

  // Build a ts→entry map for fast lookup
  const byTs = new Map(log.map(e => [e.ts, e]))

  // Try LanceDB vector search
  try {
    const tbl = await getLogTable(dataDir)
    if (tbl) {
      const [queryVec] = await embed([query])
      if (queryVec && queryVec.length > 0) {
        const results = await tbl
          .vectorSearch(queryVec)
          .limit(limit * 2)
          .toArray()

        // Filter by distance threshold (L2 distance < 1.0 ≈ cosine > 0.50)
        const matched = results
          .filter(r => r.ts && (r._distance as number) < 1.0)
          .slice(0, limit)
          .map(r => byTs.get(r.ts as string))
          .filter((e): e is ToolLogEntry => !!e)
          .map(formatLogEntry)

        if (matched.length > 0) return matched
      }
    }
  } catch {}

  // Fallback: keyword matching
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1)
  if (words.length === 0) return []

  const scored = log.map(entry => {
    const text = `${entry.service} ${entry.tool} ${JSON.stringify(entry.params)}`.toLowerCase()
    let score = 0
    for (const w of words) {
      if (text.includes(w)) score++
    }
    return { entry, score }
  })

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.ts.localeCompare(a.entry.ts))
    .slice(0, limit)
    .map(s => formatLogEntry(s.entry))
}

// ── 3 AM Extraction — Agentic Haiku with Memory Tools ───────────────────────

const SYSTEM_PROMPT = `You are a background maintenance agent. You run every night to keep the user's memory organized and up to date. You have four jobs, in order:

OFF-LIMITS files (never modify): heartbeat.md, nightly.md, setup.md, profile.md

1. PROCESS TODAY'S LOGS: Review the tool usage logs below and extract anything worth remembering.
   - Use search_memory FIRST to check what already exists before writing anything.
   - New people (name, email, company, role) → contacts.md
   - New projects or major milestones → projects.md
   - Use edit_memory to update existing entries. Use append_memory to add to existing files.
   - Only use write_memory for genuinely new long-term topics that deserve their own file.
   - SKIP ephemeral stuff: individual emails, one-time file shares, meeting confirmations, status updates.
   - TEST: "Will this matter in a month?" If no, skip it.
   - Do NOT duplicate entries that already exist.

2. CONSOLIDATE AND ORGANIZE: Read through ALL memory files (use list_memory, then read each one).
   - Merge duplicate entries (same person in contacts.md twice, same project described in two files).
   - Merge small related files into larger topic files when it makes sense.
   - Update project statuses — if a deadline has passed, mark it. If something was completed, note it.
   - Remove one-off files that were clearly temporary (meeting prep for a past meeting, research that was already used, etc.).
   - Move misplaced information to the right file (a contact buried in projects.md → contacts.md).

3. PRUNE STALE ENTRIES: Clean up anything that's no longer relevant.
   - Remove entries for people/projects with no activity in 30+ days AND no future relevance.
   - Delete completed/resolved items that are just taking up space.
   - Remove outreach logs older than 2 weeks.
   - Clean up "status" fields that are clearly outdated (e.g. "Due: March 27" when it's now April).
   - Do NOT delete anything that is still actively useful or might be referenced again.
   - If everything looks clean, skip this step.

4. UPDATE preferences.md WITH OBSERVED PATTERNS: Review today's logs for patterns in how the user works, and keep preferences.md accurate.
   - Record style patterns you saw in their sent messages: tone, length, greetings, sign-offs, emoji use, formality.
   - Record workflow habits: recipients they always CC, times they never send, integrations they favor for a given task.
   - REQUIRE ≥3 supporting examples before recording a pattern. If you only saw it once or twice, skip it.
   - If a pattern already in preferences.md is contradicted by new behavior, UPDATE or REMOVE it — don't let stale inferences persist.
   - If no new patterns emerged with enough examples, skip this step.

After you finish all memory tool calls, reply with a brief summary of what you did. Format:
- Added: [what was added]
- Updated: [what was changed]
- Removed: [what was cleaned up]
- Consolidated: [what was merged]
- Patterns: [what was observed about how the user works]
Or "Nothing to update." if you made no changes.`

/**
 * Process tool logs via an agentic Haiku loop with memory tools.
 * Haiku searches, edits, and appends memory — updates contacts, projects, etc.
 * No briefing generation — context is provided live via search_tools context param.
 */
export async function extractInsights(
  dataDir: string,
  memoryTools: Anthropic.Tool[],
  callMemoryTool: (tool: string, args: Record<string, unknown>) => Promise<string>,
  apiKey?: string
): Promise<string | undefined> {
  const logFile = logPath(dataDir)
  let log: ToolLogEntry[] = []
  if (existsSync(logFile)) {
    try { log = JSON.parse(readFileSync(logFile, 'utf-8')) } catch { log = [] }
  }

  // Read user-editable nightly.md — additive instructions, not a replacement
  let nightlyInstructions = ''
  try {
    const nightlyPath = join(dataDir, 'memory', 'nightly.md')
    if (existsSync(nightlyPath)) {
      const raw = readFileSync(nightlyPath, 'utf-8')
      // Strip comment blocks and check if anything non-whitespace remains beyond section headers
      const stripped = raw.replace(/<!--[\s\S]*?-->/g, '')
      const hasContent = stripped
        .split('\n')
        .some(line => {
          const trimmed = line.trim()
          return trimmed.length > 0 && !trimmed.startsWith('#')
        })
      if (hasContent) nightlyInstructions = raw.trim()
    }
  } catch {}

  const relay = getRelayConfig()
  let openaiClient: OpenAI | null = null
  if (relay) {
    openaiClient = new OpenAI({ baseURL: `${relay.url.replace(/\/$/, '')}/v1`, apiKey: relay.token })
  } else if (process.env.MOONSHOT_API_KEY) {
    openaiClient = new OpenAI({ baseURL: MOONSHOT_BASE_URL, apiKey: process.env.MOONSHOT_API_KEY })
  }
  // Fallback to Anthropic if no Kimi client available
  const anthropic = !openaiClient ? (relay
    ? new Anthropic({ baseURL: relay.url, apiKey: relay.token })
    : new Anthropic()) : null

  // Group logs by integration
  const byService = new Map<string, ToolLogEntry[]>()
  for (const entry of log) {
    const existing = byService.get(entry.service) || []
    existing.push(entry)
    byService.set(entry.service, existing)
  }

  // Format log sections
  const logSections = [...byService.entries()].map(([service, entries]) => {
    const lines = entries.map(e =>
      `  ${e.ts.slice(5, 16)} ${e.tool}(${JSON.stringify(e.params)})`
    ).join('\n')
    return `${service} (${entries.length} calls):\n${lines}`
  }).join('\n\n')

  const nightlySection = nightlyInstructions
    ? `\n\nUSER INSTRUCTIONS FROM nightly.md (follow these in addition to your default jobs):\n${nightlyInstructions}\n`
    : ''

  const today = new Date().toISOString().slice(0, 10)

  const logSection = log.length > 0
    ? `Tool usage logs from today:\n\n${logSections}`
    : 'No tool usage logs from today.'

  const userMessage = `Today's date: ${today}

${logSection}
${nightlySection}
Run all three jobs: (1) process these logs into memory, (2) read ALL memory files and consolidate/organize, (3) prune stale entries. Use list_memory first to see all files, then read and process each one.`

  // Cache system prompt + tool definitions (stable across runs)
  const cachedTools: Anthropic.Tool[] = memoryTools.map((t, i) =>
    i === memoryTools.length - 1
      ? { ...t, cache_control: { type: 'ephemeral' as const } }
      : t
  )

  // Agentic loop — Kimi K2.5 calls memory tools, then outputs briefings
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }]
  const MAX_TURNS = 30
  const useKimi = !!openaiClient
  const modelName = useKimi ? KIMI_MODEL : 'claude-haiku-4-5-20251001'

  let finalSummary: string | undefined

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response: { content: Anthropic.ContentBlock[]; stop_reason: string | null; usage: { input_tokens: number; output_tokens: number } }

    if (useKimi) {
      response = await streamOpenAI(openaiClient!, {
        model: KIMI_MODEL,
        system: SYSTEM_PROMPT,
        messages,
        tools: cachedTools,
        maxTokens: 2048,
      })
    } else {
      response = await (anthropic!.messages.create as Function)({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: cachedTools,
        messages
      })
    }

    recordUsage(dataDir, {
      category: 'nightly_job',
      model: modelName,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: (response.usage as any).cache_read_input_tokens ?? 0,
      cacheCreationTokens: (response.usage as any).cache_creation_input_tokens ?? 0,
      timestamp: new Date().toISOString(),
    }).catch(() => {})

    if (response.stop_reason === 'end_turn') {
      // Extract the final text summary from the model
      const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text')
      const text = textBlocks.map(b => b.text).join(' ').trim()
      if (text && text.toLowerCase() !== 'done.' && text.toLowerCase() !== 'done') {
        finalSummary = text
      }
      console.log('[ServiceLogger] Nightly memory update complete')
      break
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content })

      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue

        console.log(`[ServiceLogger] ${modelName} calling: ${block.name}(${JSON.stringify(block.input).slice(0, 100)})`)
        try {
          const result = await callMemoryTool(block.name, block.input as Record<string, unknown>)
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
        } catch (err: any) {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true })
        }
      }

      messages.push({ role: 'user', content: toolResults })
      continue
    }

    console.warn(`[ServiceLogger] Unexpected stop_reason: ${response.stop_reason}`)
    break
  }

  // Clear processed logs and LanceDB log table, then close the connection
  writeFileSync(logFile, '[]')
  try {
    const dbDir = join(dataDir, 'services', 'tool-log-db')
    const db = await connect(dbDir)
    try {
      const tables = await db.tableNames()
      if (tables.includes('logs')) await db.dropTable('logs')
      logTable = null
    } finally {
      try { await (db as any).close?.() } catch {}
    }
  } catch {}
  console.log(`[ServiceLogger] Cleared ${log.length} processed log entries`)

  return finalSummary
}
