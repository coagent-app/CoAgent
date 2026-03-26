import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { recordUsage } from './usage-tracker.js'
import { embed, cosine } from './tool-embeddings.js'

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

function embeddingsPath(dataDir: string): string {
  return join(servicesDir(dataDir), 'tool-log-embeddings.json')
}

// ── Log Embeddings Cache ─────────────────────────────────────────────────────

interface LogEmbedding {
  ts: string          // matches ToolLogEntry.ts — used as key
  embedding: number[]
}

function readEmbeddings(dataDir: string): LogEmbedding[] {
  const path = embeddingsPath(dataDir)
  if (!existsSync(path)) return []
  try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return [] }
}

function writeEmbeddings(dataDir: string, embeddings: LogEmbedding[]): void {
  writeFileSync(embeddingsPath(dataDir), JSON.stringify(embeddings))
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

/** Append a tool call entry to the daily log and embed it for semantic search. */
export function logToolCall(
  dataDir: string,
  service: string,
  tool: string,
  params: Record<string, unknown>,
  result?: string
): void {
  const integration = extractIntegration(service, tool)

  const path = logPath(dataDir)
  const log: ToolLogEntry[] = existsSync(path)
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
  writeFileSync(path, JSON.stringify(log, null, 2))

  // Embed async — don't block the tool call
  embed([logEntryText(entry)]).then(([vec]) => {
    if (!vec || vec.length === 0) return
    const embeddings = readEmbeddings(dataDir)
    embeddings.push({ ts: entry.ts, embedding: vec })
    writeEmbeddings(dataDir, embeddings)
  }).catch(() => {})
}

// ── Log Search ──────────────────────────────────────────────────────────────

function formatLogEntry(e: ToolLogEntry): string {
  const time = e.ts.slice(5, 16).replace('T', ' ')
  const params = Object.entries(e.params).map(([k, v]) => `${k}: ${v}`).join(', ')
  return `${time} ${e.service}/${e.tool}(${params})${e.result ? ' → ' + e.result : ''}`
}

/**
 * Semantic search over tool logs. Embeds the query and compares against
 * pre-embedded log entries. Falls back to keyword matching if no embeddings.
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

  // Try semantic search first
  const embeddings = readEmbeddings(dataDir)
  if (embeddings.length > 0) {
    try {
      const [queryVec] = await embed([query])
      if (queryVec && queryVec.length > 0) {
        const scored = embeddings
          .map(le => ({ ts: le.ts, score: cosine(queryVec, le.embedding) }))
          .filter(s => s.score > 0.35)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)

        if (scored.length > 0) {
          return scored
            .map(s => byTs.get(s.ts))
            .filter((e): e is ToolLogEntry => !!e)
            .map(formatLogEntry)
        }
      }
    } catch {}
  }

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

const SYSTEM_PROMPT = `You are a background agent that processes tool usage logs. You have two jobs, in order:

1. UPDATE MEMORY: Search existing memories, then append new entries or edit existing ones.
   - OFF-LIMITS files (never modify): routines.md, setup.md, agent.md, preferences.md
   - Use search_memory FIRST to check what already exists before writing anything.
   - Use edit_memory to update existing entries (pass exact old_content from read/search results).
   - Use append_memory to add NEW entries to existing files.
   - Only use write_memory for genuinely significant new long-term topics that deserve their own file.

   WHAT BELONGS IN MEMORY (durable facts):
   - New people: name, email, company, role, relationship (→ contacts.md)
   - Major ongoing client relationships or partnerships (→ projects.md)
   - Recurring long-term commitments

   WHAT DOES NOT BELONG IN MEMORY (ephemeral):
   - Individual emails, reports, or documents
   - Single deployments, releases, or staging pushes
   - File shares, attachments, one-time tasks
   - Meeting confirmations, status updates, announcements

   TEST: "Is this a PERSON or an ongoing RELATIONSHIP/PROJECT that will exist for months?" If no, skip it.
   Do NOT duplicate entries that already exist.

2. CLEAN UP MEMORY: While you already have the files open, prune stale or resolved entries.
   - Delete entries for people/projects no longer relevant (no activity in weeks, deal closed, etc.)
   - Consolidate duplicates (same person listed twice, etc.)
   - Remove entries that were wrong or outdated
   - Do NOT delete anything that is still actively useful
   - Skip this step if everything looks clean — don't make changes for the sake of it.

When you are DONE with all memory tool calls, reply with "Done." and nothing else.`

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
): Promise<void> {
  const logFile = logPath(dataDir)
  if (!existsSync(logFile)) return

  const log: ToolLogEntry[] = JSON.parse(readFileSync(logFile, 'utf-8'))
  if (log.length === 0) return

  const anthropic = new Anthropic({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY })

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

  const userMessage = `Here are today's tool usage logs grouped by integration:

${logSections}

Search memory for existing entries about the people and projects mentioned. Then update memory as needed (edit existing entries, append new ones). Clean up stale entries. When done, reply "Done."`

  // Cache system prompt + tool definitions (stable across runs)
  const cachedTools: Anthropic.Tool[] = memoryTools.map((t, i) =>
    i === memoryTools.length - 1
      ? { ...t, cache_control: { type: 'ephemeral' as const } }
      : t
  )

  // Agentic loop — Haiku calls memory tools, then outputs briefings
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }]
  const MAX_TURNS = 15

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await (anthropic.messages.create as Function)({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: cachedTools,
      messages
    })

    recordUsage(dataDir, {
      category: 'nightly_job',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: (response.usage as any).cache_read_input_tokens ?? 0,
      cacheCreationTokens: (response.usage as any).cache_creation_input_tokens ?? 0,
      timestamp: new Date().toISOString(),
    }).catch(() => {})

    if (response.stop_reason === 'end_turn') {
      console.log('[ServiceLogger] Nightly memory update complete')
      break
    }

    if (response.stop_reason === 'tool_use') {
      // Execute tool calls and send results back
      messages.push({ role: 'assistant', content: response.content })

      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue

        console.log(`[ServiceLogger] Haiku calling: ${block.name}(${JSON.stringify(block.input).slice(0, 100)})`)
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

    // Unexpected stop reason
    console.warn(`[ServiceLogger] Unexpected stop_reason: ${response.stop_reason}`)
    break
  }

  // Clear processed logs and their embeddings
  writeFileSync(logFile, '[]')
  writeEmbeddings(dataDir, [])
  console.log(`[ServiceLogger] Cleared ${log.length} processed log entries`)
}
