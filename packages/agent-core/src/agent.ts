import Anthropic from '@anthropic-ai/sdk'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { MCPManager, MCPServerConfig } from './mcp-manager.js'
import { ApprovalQueue } from './queue.js'
import { CalendarStore } from './calendar-store.js'
import { searchEventStore, markEventsDone } from './relay-client.js'
import { readSettings, writeSettings } from './settings.js'
import type { AgentSettings } from './settings.js'
import type { AgentTrigger } from '@coagent/shared'
import { searchFiles, readFileContent, readFileBase64, deleteFileEntry, getStorageStats, listFiles } from './file-store.js'
import { embedTools, searchToolsByEmbedding, clearToolEmbeddings, setToolEmbeddingsDir } from './tool-embeddings.js'
import { logToolCall, extractIntegration, searchToolLogs } from './service-logger.js'
import { recordUsage } from './usage-tracker.js'
import { getRelayConfig } from './auth.js'

const HISTORY_WINDOW = 50        // total pool — recent + TF-IDF ranked

// --- Skills ---
const DEFAULT_SKILL_NAMES = new Set(['skill-creator'])
interface Skill { name: string; description: string; instructions: string }

async function skillsDir(dataDir: string): Promise<string> {
  const dir = join(dataDir, 'skills')
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  return dir
}

async function loadSkill(dataDir: string, name: string): Promise<Skill | null> {
  const path = join(await skillsDir(dataDir), `${name}.json`)
  if (!existsSync(path)) return null
  try { return JSON.parse(await readFile(path, 'utf-8')) } catch { return null }
}

async function saveSkill(dataDir: string, skill: Skill): Promise<void> {
  const path = join(await skillsDir(dataDir), `${skill.name}.json`)
  await writeFile(path, JSON.stringify(skill, null, 2))
}

async function listSkills(dataDir: string): Promise<Skill[]> {
  const dir = await skillsDir(dataDir)
  const { readdirSync } = await import('fs')
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(require('fs').readFileSync(join(dir, f), 'utf-8')) } catch { return null } })
    .filter((s): s is Skill => s !== null)
}

async function deleteSkill(dataDir: string, name: string): Promise<boolean> {
  const path = join(await skillsDir(dataDir), `${name}.json`)
  if (!existsSync(path)) return false
  const { unlink } = await import('fs/promises')
  await unlink(path)
  return true
}

async function resolveSkillMentions(dataDir: string, message: string): Promise<string> {
  const mentions = message.match(/@([\w-]+)/g)
  if (!mentions) return message
  let resolved = message
  for (const mention of mentions) {
    const name = mention.slice(1)
    const skill = await loadSkill(dataDir, name)
    if (skill) {
      resolved = resolved.replace(mention, `[Skill: ${skill.name}]\n${skill.instructions}\n[/Skill]`)
    }
  }
  return resolved
}
const RECENT_KEEP = 15           // always keep this many recent messages (protects tool chains)
const MAX_RANKED = 0             // disabled — memory tools handle long-term context

// --- TF-IDF history ranking ---

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2)
}

function messageText(msg: Anthropic.MessageParam): string {
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return (msg.content as any[])
      .filter(b => b.type === 'text' || b.type === 'tool_result')
      .map(b => b.text ?? b.content ?? '')
      .join(' ')
  }
  return ''
}

/** Rank older messages by TF-IDF relevance to the current query */
function rankByRelevance(
  query: string,
  messages: Anthropic.MessageParam[],
  maxPick: number
): Anthropic.MessageParam[] {
  if (messages.length === 0) return []

  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return messages.slice(-maxPick)

  // Build document frequency across all messages
  const df = new Map<string, number>()
  const msgTokens: string[][] = []
  for (const msg of messages) {
    const tokens = tokenize(messageText(msg))
    msgTokens.push(tokens)
    const unique = new Set(tokens)
    for (const t of unique) df.set(t, (df.get(t) ?? 0) + 1)
  }

  const n = messages.length
  const scored = messages.map((msg, i) => {
    const tokens = msgTokens[i]
    if (tokens.length === 0) return { msg, score: 0 }

    // TF-IDF: sum over query terms
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)

    let score = 0
    for (const term of queryTerms) {
      const termFreq = (tf.get(term) ?? 0) / tokens.length
      const docFreq = df.get(term) ?? 0
      if (docFreq > 0) {
        score += termFreq * Math.log(1 + n / docFreq)
      }
    }
    return { msg, score }
  })

  return scored
    .filter(s => s.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPick)
    .map(s => s.msg)
}

const INTERNAL_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_current_time',
    description: 'Get the current date and time.',
    input_schema: { type: 'object' as const, properties: {}, required: [] }
  },
  {
    name: 'search_tools',
    description: 'Find tools by description. Use before calling any external service. Optionally search recent activity and memory for context.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'e.g. "send email", "create calendar event"' },
        context: { type: 'string', description: 'Semantic search recent tool logs, e.g. "real estate meeting" or "email from Alex"' },
        memory_context: { type: 'string', description: 'Search long-term memory for context, e.g. "Brett project deadlines" or "Alex Morris contact"' }
      },
      required: ['query']
    }
  },
  {
    name: 'queue_approval',
    description: 'Queue an action for user approval before executing.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['task', 'document', 'message', 'request', 'other'] },
        title: { type: 'string' }, description: { type: 'string' },
        detail: { type: 'string' }, notes: { type: 'string' },
        action: { type: 'string' }, metadata: { type: 'object' }
      },
      required: ['type', 'title', 'description', 'notes', 'action']
    }
  },
  {
    name: 'add_done_item',
    description: 'Log a completed action.',
    input_schema: {
      type: 'object' as const,
      properties: { description: { type: 'string' } },
      required: ['description']
    }
  },
  {
    name: 'update_settings',
    description: 'Update user profile or agent settings.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' }, email: { type: 'string' },
        timezone: { type: 'string' }, role: { type: 'string' },
        active_hours: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } } },
        active_days: { type: 'array', items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] } },
        autonomy: { type: 'string', enum: ['ask_first', 'balanced', 'autonomous'] },
        heartbeat_interval: { type: 'number', description: 'Minutes between heartbeats (0 to disable)' }
      }
    }
  },
  {
    name: 'files',
    description: 'Manage user files. Actions: list (optionally by folder), search (by query), read (by id), delete (by id), stats.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'read', 'delete', 'stats'] },
        id: { type: 'string', description: 'File ID (for read/delete)' },
        query: { type: 'string', description: 'Search query (for search)' },
        folder: { type: 'string', description: 'Filter by folder (for list)' },
        limit: { type: 'number', description: 'Max results (for search)' }
      },
      required: ['action']
    }
  },
  {
    name: 'calendar',
    description: 'Unified calendar for routines, tasks, and events. Actions: create (type+label+timing+instruction), update (id+fields), delete (id), complete (id — tasks only), list (optional type filter).',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete', 'complete', 'list'] },
        type: { type: 'string', enum: ['routine', 'task', 'event'], description: 'Entry type (for create)' },
        id: { type: 'string', description: 'Entry ID (for update/delete/complete)' },
        label: { type: 'string', description: 'Display name' },
        cron: { type: 'string', description: 'Cron expression for routines, e.g. "0 9 * * 1-5"' },
        due: { type: 'string', description: 'ISO datetime for tasks, e.g. "2026-03-28T14:30:00"' },
        start: { type: 'string', description: 'ISO datetime for event start' },
        end: { type: 'string', description: 'ISO datetime for event end' },
        instruction: { type: 'string', description: 'What to execute when routine/task fires' },
        enabled: { type: 'boolean', description: 'Enable/disable (default true)' },
        filter_type: { type: 'string', enum: ['routine', 'task', 'event'], description: 'Filter for list action' },
      },
      required: ['action']
    }
  },
  {
    name: 'skills',
    description: 'Manage reusable skills. Actions: save (name/description/instructions required), list, delete (by name). Users invoke with @skill-name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'delete'] },
        name: { type: 'string', description: 'Kebab-case name (for save/delete)' },
        description: { type: 'string', description: 'One-line description (for save)' },
        instructions: { type: 'string', description: 'Full instructions (for save)' }
      },
      required: ['action']
    }
  },
  {
    name: 'memory',
    description: 'Long-term memory. Prefer search (semantic) or grep (pattern match) over read (full file dump). Actions: search (by query), grep (file+pattern — returns matching lines), read (full file — use sparingly), write (file+content), edit (file+old_content+new_content), append (file+content), list, delete (by file).',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['search', 'grep', 'read', 'write', 'edit', 'append', 'list', 'delete'] },
        query: { type: 'string', description: 'Search query (for search)' },
        pattern: { type: 'string', description: 'Text or regex pattern to match (for grep)' },
        file: { type: 'string', description: 'Filename e.g. contacts.md (for grep/read/write/edit/append/delete)' },
        content: { type: 'string', description: 'Content (for write/append)' },
        old_content: { type: 'string', description: 'Content to replace (for edit)' },
        new_content: { type: 'string', description: 'Replacement content (for edit)' },
        category: { type: 'string', description: 'Filter category (for list)' },
        top_k: { type: 'number', description: 'Number of results (for search, default 3)' }
      },
      required: ['action']
    }
  },
]

// Map consolidated memory actions → MCP tool names
const MEMORY_MCP_MAP: Record<string, string> = {
  search: 'search_memory', read: 'read_memory', write: 'write_memory',
  edit: 'edit_memory', append: 'append_memory', list: 'list_memories', delete: 'delete_memory',
}

function mapMemoryParams(action: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (action) {
    case 'search': return { query: input.query, topK: input.top_k ?? 3 }
    case 'read': case 'delete': return { path: input.file }
    case 'write': case 'append': return { path: input.file, content: input.content }
    case 'edit': return { path: input.file, old_content: input.old_content, new_content: input.new_content }
    case 'list': return input.category ? { category: input.category } : {}
    default: return input
  }
}

// --- Tool filtering by trigger context ---

type ToolContext = 'heartbeat' | 'chat' | 'webhook'

const TOOL_LABELS: Record<string, string> = {
  get_current_time: 'Checking time',
  search_tools: 'Searching for tools',
  queue_approval: 'Adding to queue',
  add_done_item: 'Marking done',
  update_settings: 'Updating settings',
  files: 'Managing files',
  calendar: 'Managing calendar',
  skills: 'Managing skills',
  memory: 'Checking memory',
}

// Action-specific labels for consolidated tools
const ACTION_LABELS: Record<string, Record<string, string>> = {
  files: { list: 'Listing files', search: 'Searching files', read: 'Reading file', delete: 'Deleting file', stats: 'Checking storage' },
  calendar: { create: 'Adding to calendar', update: 'Updating calendar entry', delete: 'Deleting calendar entry', complete: 'Completing task', list: 'Checking calendar' },
  skills: { save: 'Saving skill', list: 'Listing skills', delete: 'Deleting skill' },
  memory: { search: 'Searching memory', grep: 'Searching memory', read: 'Reading memory', write: 'Writing memory', edit: 'Editing memory', append: 'Updating memory', list: 'Listing memory', delete: 'Cleaning memory' },
}

// "GMAIL_FETCH_EMAILS" → "Gmail: Fetch emails"
function humanizeToolName(name: string): string {
  const prefixMap: Record<string, string> = {
    GMAIL: 'Gmail', GOOGLECALENDAR: 'Calendar', GOOGLE_CALENDAR: 'Calendar',
    GITHUB: 'GitHub', LINKEDIN: 'LinkedIn', MAILCHIMP: 'Mailchimp',
    CALENDLY: 'Calendly', GOOGLESHEETS: 'Sheets', GOOGLE_SHEETS: 'Sheets',
    GOOGLESLIDES: 'Slides', GOOGLE_SLIDES: 'Slides', EXCEL: 'Excel',
    FIGMA: 'Figma', GOOGLE_MAPS: 'Maps', COMPOSIO: 'Composio',
  }
  let service = ''
  let rest = name
  for (const [key, label] of Object.entries(prefixMap)) {
    if (name.startsWith(key + '_')) {
      service = label
      rest = name.slice(key.length + 1)
      break
    }
  }
  // "FETCH_EMAILS" → "Fetch emails"
  const words = rest.toLowerCase().replace(/_/g, ' ').trim()
  const humanized = words.charAt(0).toUpperCase() + words.slice(1)
  return service ? `${service}: ${humanized}` : humanized
}

const HEARTBEAT_TOOLS = new Set([
  'get_current_time', 'add_done_item', 'calendar', 'queue_approval', 'skills', 'memory',
])

function getInternalTools(context: ToolContext): Anthropic.Tool[] {

  if (context === 'heartbeat') return INTERNAL_TOOLS.filter(t => HEARTBEAT_TOOLS.has(t.name))
  return INTERNAL_TOOLS
}

const AUTONOMY_DESCRIPTIONS: Record<string, string> = {
  ask_first: 'Queue almost everything for approval — only truly mechanical lookups happen automatically.',
  balanced: 'Act on clearly routine or read-only things. Queue anything that sends a message, edits data, or contacts someone.',
  autonomous: 'Act freely — send emails, create events, modify data without asking. Only queue truly destructive actions (bulk deletes). WARNING: the agent may send messages and make changes on your behalf without confirmation.'
}

// Hard guardrail: these tool name patterns ALWAYS require queue_approval, regardless of autonomy level.
// Matching is case-insensitive substring against the tool name.
const ALWAYS_QUEUE_TOOLS = [
  'SEND_EMAIL', 'SEND_MESSAGE', 'SEND_DRAFT',        // Outbound comms
  'DELETE_MESSAGE', 'BATCH_DELETE', 'DELETE_EMAIL',    // Destructive email ops
  'CREATE_EVENT', 'DELETE_EVENT', 'UPDATE_EVENT',      // Calendar mutations
  'CREATE_CONTACT', 'DELETE_CONTACT', 'UPDATE_CONTACT', // CRM mutations
  'POST_MESSAGE',                                       // Slack/Teams posting
]


function buildSystemPrompt(connectedServices: string[], agentProfilePath: string, settings: AgentSettings): string {
  const isFirstRun = !existsSync(agentProfilePath)

  const serviceSection = connectedServices.length > 0
    ? `Connected external services: ${connectedServices.join(', ')}. Use search_tools to find the right tool before calling it.`
    : 'No external services are connected yet. If the user wants to connect tools, tell them to open Settings and connect their integrations.'

  const onboardingSection = isFirstRun
    ? '\n\nONBOARDING: This is a new user. Read onboarding.md from memory and follow it exactly.'
    : ''

  const formatHour = (h: number) => h === 24 ? 'midnight' : h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`

  const settingsSection = `
Current settings:
- Name: ${settings.name || '(not set)'}
- Email: ${settings.email || '(not set)'}
- Role: ${settings.role || '(not set)'}
- Timezone: ${settings.timezone || '(not set)'}
- Active hours: ${formatHour(settings.active_hours.start)}–${formatHour(settings.active_hours.end)}
- Active days: ${settings.active_days.join(', ')}
- Heartbeat: ${settings.heartbeat_interval > 0 ? `every ${settings.heartbeat_interval} minutes — you are automatically woken up on this interval to check to-dos, monitor connected services, and handle pending tasks` : 'disabled — you only respond when the user messages you'}
- Autonomy: ${settings.autonomy} — ${AUTONOMY_DESCRIPTIONS[settings.autonomy]}
`

  return `You are CoAgent — a private AI agent running on the user's machine. Help with anything asked. Never refuse by saying something is outside your scope.

${serviceSection}
${settingsSection}
Skills: Users invoke with @skill-name. When invoked, the skill's instructions appear in the message.

File listings: plain text (e.g. "- report.md — summary"). Only use [filename](coagent-file:FILE_ID) when asked to open a specific file. To attach files to emails, add "coagent_file_ids": ["FILE_ID"] to tool input.

Memory: your long-term brain — history only shows recent messages. Use the memory tool directly (NOT search_tools). Prefer search (semantic) or grep (pattern match within a file) over read (dumps entire file). Only use read when you need the full file. Write things down immediately: names, dates, preferences, decisions. If unsure whether to save, save it. Always search memory before saying you don't know. Files: setup.md (read-only), agent.md, routines.md, preferences.md, contacts.md, projects.md. Update when you learn something new. Delete stale entries.

Routine tasks: act, then add_done_item. High-stakes actions: queue_approval with full draft in "detail" and recipient/subject in "metadata".
On heartbeat: use memory tool (action: read, file: routines.md) to check routines, use calendar (action: list) to check routines and tasks, check queue. If nothing needs attention, reply "All clear." immediately.

- **calendar** (create/update/delete/complete/list) — unified calendar for routines (recurring cron), tasks (one-time due), and events (informational).

When you need multiple independent pieces of information, call all the tools in a single response (e.g. read memory + use calendar (action: list) to check routines and tasks + check time in one turn). This is faster and cheaper.

Concise responses. No emojis. Markdown only when helpful.${onboardingSection}`
}

export class Agent {
  private anthropic: Anthropic
  public mcpManager: MCPManager
  public queue: ApprovalQueue
  public calendar: CalendarStore
  private conversationHistory: Anthropic.MessageParam[] = []
  private historyPath: string
  private agentProfilePath: string
  private dataDir: string
  private runLoopPromise: Promise<string> | null = null
  private activeStream: { abort: () => void } | null = null
  private stopped = false
  private missedEvents: { source: string; payload: unknown; time: string }[] = []
  private steeringQueue: string[] = []
  // Briefings removed — context now provided via search_tools context param
  public onSkillsChanged?: () => void
  public onSettingsChanged?: () => void
  public onCalendarChanged?: () => void

  async getSkills(): Promise<{ name: string; description: string }[]> {
    return (await listSkills(this.dataDir)).map(s => ({ name: s.name, description: s.description }))
  }

  steer(message: string): void {
    this.steeringQueue.push(message)
    // Abort the current stream so the steer is picked up immediately
    if (this.activeStream) {
      this.activeStream.abort()
      console.log(`[Agent] Steering — aborting current stream: "${message.slice(0, 80)}"`)
    }
  }

  stop(): void {
    this.stopped = true
    if (this.activeStream) {
      this.activeStream.abort()
      console.log('[Agent] Stop requested')
    }
  }

  constructor(mcpConfigs: MCPServerConfig[], dataDir: string) {
    this.anthropic = this.createClient()
    this.mcpManager = new MCPManager()
    this.queue = new ApprovalQueue(dataDir)
    this.calendar = new CalendarStore(dataDir)
    this.dataDir = dataDir
    this.historyPath = join(dataDir, 'conversation.json')
    this.agentProfilePath = join(dataDir, 'memory', 'agent.md')
    this.mcpManager.connect(mcpConfigs).catch(console.error)
    this.loadHistory().catch(console.error)
    setToolEmbeddingsDir(dataDir)
  }

  private createClient(): Anthropic {
    const relay = getRelayConfig()
    const defaultHeaders = { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' }
    if (relay) {
      console.log(`[Agent] Using relay proxy at ${relay.url}`)
      return new Anthropic({
        baseURL: relay.url,
        apiKey: relay.token,
        defaultHeaders,
      })
    }
    return new Anthropic({ defaultHeaders })
  }

  reinitClient(): void {
    this.anthropic = this.createClient()
  }

  private async loadHistory(): Promise<void> {
    try {
      const raw = await readFile(this.historyPath, 'utf-8')
      this.conversationHistory = JSON.parse(raw)
      console.log(`[Agent] Loaded ${this.conversationHistory.length} messages from history`)
    } catch {
      this.conversationHistory = []
    }
  }

  private async saveHistory(): Promise<void> {
    await mkdir(join(this.historyPath, '..'), { recursive: true })
    // Cap history to last 100 messages — both in memory and on disk
    this.conversationHistory = this.conversationHistory.slice(-100)
    await writeFile(this.historyPath, JSON.stringify(this.conversationHistory))
  }

  getChatHistory(): { role: 'user' | 'assistant'; content: string; timestamp: string }[] {
    const result: { role: 'user' | 'assistant'; content: string; timestamp: string }[] = []
    for (const m of this.conversationHistory) {
      let text: string
      if (typeof m.content === 'string') {
        text = m.content
      } else if (Array.isArray(m.content)) {
        const textBlock = (m.content as any[]).find(b => b.type === 'text')
        text = textBlock?.text ?? ''
      } else {
        continue
      }
      if (!text.trim()) continue
      result.push({ role: m.role as 'user' | 'assistant', content: text, timestamp: new Date().toISOString() })
    }
    return result
  }

  async handleTrigger(
    trigger: AgentTrigger & { content?: string },
    onChunk?: (text: string) => void,
    onToolCall?: (tool: string, label: string) => void
  ): Promise<void> {
    const isHeartbeat = trigger.source === 'heartbeat'
    const isTodoDue = trigger.source === 'todo_due' || trigger.source === 'task_due'

    // If agent is busy, queue webhook/incoming events for later — don't drop them
    if (this.runLoopPromise) {
      if (!isHeartbeat) {
        this.missedEvents.push({
          source: trigger.source,
          payload: trigger.payload,
          time: new Date().toISOString()
        })
        console.log(`[Agent] Queued missed event (${trigger.source}) — ${this.missedEvents.length} pending`)
      } else {
        console.log(`[Agent] Skipping ${trigger.source} — agent is busy`)
      }
      return
    }

    // todo_due goes straight to Sonnet with full tools — no triage
    const context: ToolContext = isTodoDue ? 'chat'
      : isHeartbeat ? 'heartbeat'
      : trigger.source === 'webhook' ? 'webhook'
      : 'chat'

    // On heartbeat, include any missed events in the triage prompt
    let message = trigger.content ?? this.buildTriggerMessage(trigger)
    if (isHeartbeat && this.missedEvents.length > 0) {
      const missed = this.missedEvents.map(e =>
        `- [${e.time}] ${e.source}: ${JSON.stringify(e.payload)}`
      ).join('\n')
      message += `\n\nMissed events since last check (${this.missedEvents.length}):\n${missed}`
      this.missedEvents = []
      console.log(`[Agent] Heartbeat includes ${this.missedEvents.length} missed events`)
    }

    this.conversationHistory.push({ role: 'user', content: message })
    this.runLoopPromise = this.runLoop(onChunk, context, onToolCall)
    try {
      const result = await this.runLoopPromise

      // Heartbeat escalation: if Haiku found work to do, hand off to Sonnet
      if (context === 'heartbeat' && result && !result.toLowerCase().includes('all clear')) {
        console.log('[Agent] Heartbeat found action needed — escalating to Sonnet')
        this.runLoopPromise = null
        this.conversationHistory.push({ role: 'user', content: `[Escalated from heartbeat triage] Haiku identified the following. Take action now:\n\n${result}` })
        this.runLoopPromise = this.runLoop(onChunk, 'webhook', onToolCall)
        await this.runLoopPromise
      }
    } finally {
      this.runLoopPromise = null
    }
  }

  async chat(
    message: string,
    onChunk?: (text: string) => void,
    onToolCall?: (tool: string, label: string) => void,
    fileIds?: string[]
  ): Promise<string> {
    const resolved = await resolveSkillMentions(this.dataDir, message)

    // If files were attached, build a multi-part content block so Claude can see them
    if (fileIds?.length) {
      const contentParts: any[] = []
      for (const fid of fileIds) {
        try {
          const { base64, filename, mimeType } = await readFileBase64(this.dataDir, fid)
          if (mimeType === 'application/pdf') {
            contentParts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } })
          } else if (mimeType.startsWith('image/')) {
            contentParts.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } })
          } else {
            const text = await readFileContent(this.dataDir, fid)
            contentParts.push({ type: 'text', text: `[File: ${filename}]\n${text}` })
          }
        } catch (err) {
          console.warn(`[Agent] Could not attach file ${fid}:`, (err as Error).message)
        }
      }
      contentParts.push({ type: 'text', text: resolved })
      this.conversationHistory.push({ role: 'user', content: contentParts })
    } else {
      this.conversationHistory.push({ role: 'user', content: resolved })
    }
    const prev = this.runLoopPromise ?? Promise.resolve('')
    const next: Promise<string> = prev.catch(() => '').then(() => this.runLoop(onChunk, 'chat', onToolCall))
    this.runLoopPromise = next
    try {
      return await next
    } finally {
      if (this.runLoopPromise === next) this.runLoopPromise = null
    }
  }

  private async runLoop(
    onChunk?: (text: string) => void,
    context: ToolContext = 'chat',
    onToolCall?: (tool: string, label: string) => void
  ): Promise<string> {
    const { tools: allExternalTools, serverMap } = await this.mcpManager.getAllTools()

    const memoryTools = allExternalTools.filter(t => serverMap.get(t.name) === 'memory')
    const searchableTools = allExternalTools.filter(t => serverMap.get(t.name) !== 'memory')
    const connectedServices = Array.from(new Set(searchableTools.map(t => serverMap.get(t.name)!)))

    // Embed tool names for semantic search (no-op if already cached or no OpenAI key)
    embedTools(searchableTools).catch(err => console.warn('[Agent] Tool embedding failed:', err.message))
    const settings = await readSettings(this.dataDir)
    let systemPrompt = buildSystemPrompt(connectedServices, this.agentProfilePath, settings)


    // Model routing: Haiku for background tasks, user's power model for everything else
    const HAIKU = 'claude-haiku-4-5-20251001'
    const currentModel = context === 'heartbeat' ? HAIKU : settings.powerModel
    const maxTokens = context === 'heartbeat' ? 512 : 16000

    console.log(`[Agent] Starting ${context} on ${currentModel} (max_tokens: ${maxTokens})`)

    // Proactively pre-load tools relevant to the user's latest message
    // Skip for heartbeat — it has fixed tool needs
    const lastUserMsg = this.conversationHistory.filter(m => m.role === 'user').at(-1)
    const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : ''
    const preloaded = (context === 'heartbeat')
      ? []
      : userText ? await searchToolsByEmbedding(userText, searchableTools, 3) : []

    // Cache only truly stable tools (internal tools — never change between messages).
    // Preloaded Composio tools go outside the cache — they change per message based on
    // embedding search, so caching them causes expensive cache writes that never get read.
    // Skip caching for heartbeat — runs too infrequently to benefit.
    const isBackground = context === 'heartbeat'
    const contextTools = getInternalTools(context)
    // Memory tools are now handled by the consolidated 'memory' internal tool — no raw MCP tools sent to Claude
    const stableTools = contextTools.length > 0
      ? contextTools.map((t, i) =>
          i === contextTools.length - 1 && !isBackground ? { ...t, cache_control: { type: 'ephemeral' as const, ttl: '1h' } } : t
        )
      : []
    const dynamicTools: Anthropic.Tool[] = [...preloaded]
    const loadedToolNames = new Set([...stableTools, ...preloaded].map(t => t.name))

    if (preloaded.length > 0) {
      console.log(`[Agent] Pre-loaded ${preloaded.length} tools: ${preloaded.map(t => t.name).join(', ')}`)
    }

    let finalText = ''
    let turn = 0
    let lastText = ''

    this.stopped = false

    while (true) {
      // Check for stop
      if (this.stopped) {
        console.log('[Agent] Stopped by user')
        this.activeStream = null
        return lastText || '_Stopped._'
      }

      // Check for steering — inject into history and continue loop
      if (this.steeringQueue.length > 0) {
        const steering = this.steeringQueue.splice(0)
        const combined = steering.join('\n')
        if (lastText) {
          this.conversationHistory.push({ role: 'assistant', content: lastText })
        }
        this.conversationHistory.push({ role: 'user', content: `[User changed direction]: ${combined}` })
        console.log(`[Agent] Steering injected: "${combined.slice(0, 80)}"`)
        onChunk?.(`\n\n_Redirecting: ${combined}_\n\n`)
        lastText = ''
      }

      let response: Anthropic.Message
      let retryDelay = 60000

      // Rebuild tools each turn: stable (with cache boundary) + dynamic (no cache)
      // This ensures the cache boundary stays on the last stable tool even after search_tools adds more
      const activeTools: Anthropic.Tool[] = [...stableTools, ...dynamicTools]

      turn++
      const t0 = Date.now()
      while (true) {
        try {
          const stream = this.anthropic.messages.stream({
            model: currentModel,
            max_tokens: maxTokens,
            system: isBackground
              ? [{ type: 'text', text: systemPrompt }]
              : [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } as any }],
            tools: activeTools as any,
            messages: this.compactToolResults(this.sanitizeHistory(this.selectHistory(userText))) as any,
            ...(isBackground ? {} : { cache_control: { type: 'ephemeral', ttl: '1h' } as any }),
          } as any)
          this.activeStream = stream
          stream.on('text', (text) => {
            try { onChunk?.(text) } catch (err) { console.error('[Agent] onChunk error:', err) }
          })

          response = await stream.finalMessage()
          this.activeStream = null
          const u = response.usage as any
          const cacheHit = u.cache_read_input_tokens ?? 0
          const cacheWrite = u.cache_creation_input_tokens ?? 0
          const cacheInfo = cacheHit > 0 ? ` (${cacheHit} cached)` : cacheWrite > 0 ? ` (${cacheWrite} cache write)` : ''
          console.log(`[Agent] Turn ${turn} — ${response.stop_reason} — ${Date.now() - t0}ms — ${response.usage.input_tokens} in${cacheInfo} / ${response.usage.output_tokens} out tokens`)
          recordUsage(this.dataDir, {
            category: 'chat',
            model: currentModel,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
            timestamp: new Date().toISOString(),
          }).catch(() => {})
          break
        } catch (err: any) {
          this.activeStream = null
          // Aborted by steer() or stop() — loop back to outer while to check
          if (err?.name === 'APIUserAbortError' || err?.message?.includes('abort')) {
            console.log('[Agent] Stream aborted, checking steering/stop...')
            response = null as any
            break
          }
          const isRateLimit = err?.status === 429 || err?.error?.error?.type === 'rate_limit_error'
          const isOverloaded = err?.status === 529 || err?.error?.error?.type === 'overloaded_error'
          if (isRateLimit || isOverloaded) {
            const retryAfter = parseInt(err?.headers?.['retry-after'] ?? '') * 1000 || retryDelay
            const reason = isOverloaded ? 'API overloaded' : 'Rate limited'
            console.warn(`[Agent] ${reason}, retrying in ${retryAfter / 1000}s...`)
            onChunk?.(`\n\n_${reason} — retrying in ${Math.round(retryAfter / 1000)}s..._`)
            await new Promise(r => setTimeout(r, retryAfter))
            retryDelay = Math.min(retryDelay * 2, 300000)
          } else {
            throw err
          }
        }
      }

      // If stream was aborted, loop back to check steering/stop
      if (!response) continue

      this.conversationHistory.push({ role: 'assistant', content: response.content })

      // Track text for abort recovery
      const turnText = response.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('\n')
      if (turnText) lastText = turnText

      if (response.stop_reason === 'end_turn') {
        finalText = response.content
          .filter(b => b.type === 'text')
          .map(b => (b as { type: 'text'; text: string }).text)
          .join('\n')

        await this.saveHistory()
        break
      }

      if (response.stop_reason === 'tool_use') {
        const toolResults: Anthropic.MessageParam = { role: 'user', content: [] }
        let searchToolCalls = 0

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue

          if (onToolCall) {
            const inputAction = (block.input as Record<string, unknown>).action as string | undefined
            const label = (inputAction && ACTION_LABELS[block.name]?.[inputAction])
              ?? TOOL_LABELS[block.name]
              ?? humanizeToolName(block.name)
            onToolCall(block.name, label)
          }

          let result: string

          if (block.name === 'get_current_time') {
            const now = new Date()
            result = now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })

          } else if (block.name === 'search_tools') {
            searchToolCalls++
            if (searchToolCalls > 3) {
              result = 'You have enough tools loaded. Use what you have.'
              ;(toolResults.content as Anthropic.ToolResultBlockParam[]).push({
                type: 'tool_result', tool_use_id: block.id, content: result
              })
              continue
            }
            const input = block.input as { query: string; context?: string; memory_context?: string }
            const query = input.query
            const matches = await searchToolsByEmbedding(query, searchableTools)

            if (matches.length === 0) {
              result = `No tools found matching "${query}". Available services: ${connectedServices.join(', ')}`
            } else {
              for (const tool of matches) {
                if (!loadedToolNames.has(tool.name)) {
                  dynamicTools.push(tool)
                  loadedToolNames.add(tool.name)
                }
              }
              result = `Found ${matches.length} tools for "${query}" — now available to call:\n` +
                matches.map(t => `- ${t.name}: ${t.description ?? ''}`).join('\n')
            }

            // Run context and memory_context searches in parallel
            const [logResults, memResults] = await Promise.all([
              input.context
                ? searchToolLogs(this.dataDir, input.context)
                : Promise.resolve(null),
              input.memory_context
                ? this.mcpManager.callTool('memory', 'search_memory', { query: input.memory_context, top_k: 3 })
                    .then(raw => {
                      // Trim each result to ~1 line for concise context
                      return raw.split('\n\n')
                        .filter((s: string) => s.trim().length > 0)
                        .slice(0, 3)
                        .map((s: string) => s.length > 150 ? s.slice(0, 150) + '…' : s)
                    })
                    .catch(() => null)
                : Promise.resolve(null),
            ])

            if (logResults && logResults.length > 0) {
              result += `\n\nRecent activity:\n` +
                logResults.map(l => `- ${l}`).join('\n')
            } else if (input.context) {
              result += `\n\nNo recent activity matching "${input.context}".`
            }

            if (memResults && memResults.length > 0) {
              result += `\n\nFrom memory:\n` +
                memResults.map((m: string) => `- ${m}`).join('\n')
            } else if (input.memory_context) {
              result += `\n\nNo memory matches for "${input.memory_context}".`
            }

            console.log(`[Agent] search_tools("${query}"${input.context ? `, context: "${input.context}"` : ''}${input.memory_context ? `, memory: "${input.memory_context}"` : ''}) → ${matches.map(t => t.name).join(', ')}`)

          } else if (block.name === 'queue_approval') {
            this.queue.add(block.input as Parameters<ApprovalQueue['add']>[0])
            result = 'Queued for approval.'

          } else if (block.name === 'add_done_item') {
            this.queue.addDone((block.input as { description: string }).description)
            result = 'Added to done list.'

          } else if (block.name === 'update_settings') {
            const patch = block.input as Partial<AgentSettings>
            await writeSettings(this.dataDir, patch)
            result = 'Settings updated.'
            this.onSettingsChanged?.()

          } else if (block.name === 'calendar') {
            const input = block.input as Record<string, any>
            const action = input.action as string

            if (action === 'create') {
              const entry = this.calendar.create({
                type: input.type || 'task',
                label: input.label || 'Untitled',
                cron: input.cron,
                due: input.due,
                start: input.start,
                end: input.end,
                instruction: input.instruction,
                enabled: input.enabled ?? true,
              })
              result = `Created ${entry.type}: "${entry.label}" (${entry.id})`
              this.onCalendarChanged?.()
            } else if (action === 'update') {
              const { id, action: _, ...patch } = input
              const entry = this.calendar.update(id, patch)
              result = entry ? `Updated: "${entry.label}"` : `Entry ${id} not found.`
              this.onCalendarChanged?.()
            } else if (action === 'delete') {
              const ok = this.calendar.delete(input.id)
              result = ok ? 'Deleted.' : `Entry ${input.id} not found.`
              this.onCalendarChanged?.()
            } else if (action === 'complete') {
              const entry = this.calendar.complete(input.id)
              result = entry ? `Completed: "${entry.label}"` : `Task ${input.id} not found.`
              this.onCalendarChanged?.()
            } else if (action === 'list') {
              const entries = input.filter_type
                ? this.calendar.getByType(input.filter_type)
                : this.calendar.getAll()
              if (entries.length === 0) {
                result = 'No calendar entries.'
              } else {
                result = entries.map((e: any) => {
                  const timing = e.cron || e.due || (e.start && e.end ? `${e.start} → ${e.end}` : e.start) || 'no time'
                  const status = e.completed ? ' ✓' : e.enabled ? '' : ' (disabled)'
                  return `[${e.type}] ${e.label} — ${timing}${status} (${e.id})`
                }).join('\n')
              }
            } else {
              result = `Unknown calendar action: ${action}`
            }

          } else if (block.name === 'files') {
            const input = block.input as { action: string; id?: string; query?: string; folder?: string; limit?: number }
            if (input.action === 'list') {
              const files = await listFiles(this.dataDir)
              const folderLower = input.folder?.toLowerCase()
              const filtered = folderLower
                ? files.filter(f => f.group.toLowerCase() === folderLower || f.group.toLowerCase().startsWith(`${folderLower}/`))
                : files
              console.log(`[Agent] files(list, folder=${input.folder ?? 'all'}) → ${filtered.length}/${files.length} files`)
              result = filtered.length === 0
                ? (input.folder ? `No files in folder "${input.folder}". Available folders: ${[...new Set(files.map(f => f.group).filter(Boolean))].join(', ')}` : 'No files stored yet.')
                : filtered.map(f => `[id:${f.id}] ${f.group ? f.group + '/' : ''}${f.filename} — ${f.summary}`).join('\n')
            } else if (input.action === 'search') {
              const files = await searchFiles(this.dataDir, input.query!, input.limit ?? 5)
              result = files.length === 0 ? 'No files found matching that query.' : files.map(f =>
                `[id:${f.id}] [${f.group}] ${f.filename} — ${f.summary}`
              ).join('\n')
            } else if (input.action === 'read') {
              try { result = await readFileContent(this.dataDir, input.id!) } catch (err: any) { result = `Error reading file: ${err.message}` }
            } else if (input.action === 'delete') {
              await deleteFileEntry(this.dataDir, input.id!)
              result = 'File deleted.'
            } else {
              try {
                const stats = await getStorageStats(this.dataDir)
                const mb = (stats.totalBytes / 1024 / 1024).toFixed(1)
                const largestPart = stats.largestFiles.length > 0
                  ? `\nLargest: ${stats.largestFiles.map(f => `${f.filename} (${(f.sizeBytes / 1024).toFixed(0)}KB)`).join(', ')}`
                  : ''
                result = `${stats.totalFiles} files, ${mb} MB total.${largestPart}`
              } catch (err: any) { result = `Error getting storage stats: ${err.message}` }
            }

          } else if (block.name === 'skills') {
            const input = block.input as { action: string; name?: string; description?: string; instructions?: string }
            if (input.action === 'save') {
              const safeName = input.name!.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')
              if (DEFAULT_SKILL_NAMES.has(safeName)) {
                result = `Cannot overwrite built-in skill @${safeName}. It ships with the app and is read-only.`
              } else {
                await saveSkill(this.dataDir, { name: safeName, description: input.description!, instructions: input.instructions! })
                result = `Skill saved: @${safeName} — "${input.description}"`
                this.onSkillsChanged?.()
              }
            } else if (input.action === 'delete') {
              if (DEFAULT_SKILL_NAMES.has(input.name!)) {
                result = `Cannot delete built-in skill @${input.name}. It ships with the app and is read-only.`
              } else {
                const deleted = await deleteSkill(this.dataDir, input.name!)
                result = deleted ? `Skill @${input.name} deleted.` : `Skill @${input.name} not found.`
                if (deleted) this.onSkillsChanged?.()
              }
            } else {
              const allSkills = await listSkills(this.dataDir)
              result = allSkills.length === 0 ? 'No skills saved yet.' : allSkills.map(s => `@${s.name} — ${s.description}`).join('\n')
            }

          } else if (block.name === 'memory') {
            const input = block.input as Record<string, unknown>
            const action = input.action as string

            if (action === 'grep') {
              // Pattern match within a memory file — returns matching lines + context
              try {
                const fullContent = await this.mcpManager.callTool('memory', 'read_memory', { path: input.file })
                const pattern = input.pattern as string
                const lines = fullContent.split('\n')
                const regex = new RegExp(pattern, 'i')
                const CONTEXT_LINES = 2
                const matchedIndices = new Set<number>()

                for (let i = 0; i < lines.length; i++) {
                  if (regex.test(lines[i])) {
                    for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(lines.length - 1, i + CONTEXT_LINES); j++) {
                      matchedIndices.add(j)
                    }
                  }
                }

                if (matchedIndices.size === 0) {
                  result = `No matches for "${pattern}" in ${input.file}.`
                } else {
                  const sorted = [...matchedIndices].sort((a, b) => a - b)
                  const chunks: string[] = []
                  let chunk: string[] = []
                  let lastIdx = -10
                  for (const idx of sorted) {
                    if (idx > lastIdx + 1 && chunk.length > 0) {
                      chunks.push(chunk.join('\n'))
                      chunk = []
                    }
                    chunk.push(lines[idx])
                    lastIdx = idx
                  }
                  if (chunk.length > 0) chunks.push(chunk.join('\n'))
                  result = chunks.join('\n---\n')
                  console.log(`[Agent] memory grep "${pattern}" in ${input.file} — ${matchedIndices.size} lines matched (${result.length} chars vs ${fullContent.length} full)`)
                }
              } catch (err: any) {
                result = `Memory error: ${err.message}`
              }
            } else {
              const mcpTool = MEMORY_MCP_MAP[action]
              if (!mcpTool) {
                result = `Unknown memory action: ${action}`
              } else {
                try {
                  const params = mapMemoryParams(action, input)
                  result = await this.mcpManager.callTool('memory', mcpTool, params)
                } catch (err: any) {
                  result = `Memory error: ${err.message}`
                }
              }
            }

          } else {
            const serverName = serverMap.get(block.name)
            if (!serverName) {
              result = `Tool "${block.name}" is not loaded. Call search_tools first to find and load it.`
            } else {
              // Resolve CoAgent file IDs → base64 attachments before calling external tools
              const toolInput = { ...(block.input as Record<string, unknown>) }
              const attachFileIds = toolInput.coagent_file_ids as string[] | undefined
              if (attachFileIds && Array.isArray(attachFileIds) && attachFileIds.length > 0) {
                delete toolInput.coagent_file_ids
                try {
                  const attachments = await Promise.all(
                    attachFileIds.map(id => readFileBase64(this.dataDir, id))
                  )
                  // Composio Gmail/Outlook: expects attachment_content_type, attachment_name, attachment_content (base64)
                  // If tool already has an attachments field, append; otherwise set common attachment fields
                  if (attachments.length === 1) {
                    toolInput.attachment_name = attachments[0].filename
                    toolInput.attachment_content = attachments[0].base64
                    toolInput.attachment_content_type = attachments[0].mimeType
                  }
                  // Also set generic attachments array for tools that accept it
                  toolInput.attachments = attachments.map(a => ({
                    filename: a.filename,
                    content: a.base64,
                    content_type: a.mimeType
                  }))
                  console.log(`[Agent] Resolved ${attachments.length} file attachment(s): ${attachments.map(a => a.filename).join(', ')}`)
                } catch (err: any) {
                  console.error(`[Agent] Failed to resolve file attachments:`, err.message)
                }
              }
              {
                const raw = await this.mcpManager.callTool(serverName, block.name, toolInput)
                const MAX_TOOL_RESULT = 4000
                result = raw.length > MAX_TOOL_RESULT
                  ? raw.slice(0, MAX_TOOL_RESULT) + `\n\n[Truncated: ${raw.length - MAX_TOOL_RESULT} chars omitted from history to save context]`
                  : raw
                // Auto-log tool call for pattern extraction (3 AM)
                logToolCall(this.dataDir, serverName, block.name, toolInput)

                // Context for integrations is now provided via search_tools context param
                // (greps tool logs) — no more briefing injection
              }
            }
          }

          ;(toolResults.content as Anthropic.ToolResultBlockParam[]).push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result
          })
        }

        this.conversationHistory.push(toolResults)

        continue
      }

      // max_tokens — response was truncated, treat as end of turn
      if (response.stop_reason === 'max_tokens') {
        console.log('[Agent] Response hit max_tokens limit — ending turn')
      } else {
        console.warn('[Agent] Unexpected stop_reason:', response.stop_reason)
      }
      finalText = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as { type: 'text'; text: string }).text)
        .join('\n')
      await this.saveHistory()
      break
    }

    return finalText
  }

  private buildTriggerMessage(trigger: AgentTrigger): string {
    const time = new Date().toLocaleString('en-US', { timeStyle: 'short', dateStyle: 'medium' })
    if (trigger.source === 'heartbeat') {
      // Only show overdue tasks. Future timed tasks have their own precise timers
      // (task_due trigger) — don't let heartbeat surface them early.
      const due = this.calendar.getTasksDue().filter(t => {
        if (!t.due) return true // untimed tasks always show
        // Only show if actually past due, not just "due today"
        const dueTime = new Date(t.due)
        return dueTime <= new Date()
      })
      const dueSection = due.length > 0
        ? `\n\nOverdue/untimed tasks:\n${due.map(t => `- [${t.id}] ${t.label}${t.due ? ` (due: ${t.due})` : ''}`).join('\n')}`
        : ''
      const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' })
      const hour = new Date().getHours()
      const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'
      return `[Heartbeat triage — Current time: ${time}, ${dayName} ${timeOfDay}]\n\nYou are triaging. DO NOT take action — only assess and report.\n\n1. Use memory tool (action: read, file: routines.md) — only look at sections relevant to this time of day (${timeOfDay}).\n2. Use calendar (action: list) — check for due tasks and active routines.${dueSection}\n3. Check pending queue items.\n\nThe current time is ${time}. Focus on what's relevant RIGHT NOW. Use your judgment — not everything needs to be surfaced.\n\nIf nothing needs attention, reply exactly "All clear."\nOtherwise, reply with a brief summary of what needs to be done. Do NOT take action yourself — a more capable model will handle it.`
    }
    if (trigger.source === 'todo_due' || trigger.source === 'task_due') {
      const payload = trigger.payload as any
      const task = payload?.task ?? payload?.label ?? 'Unknown task'
      const todoId = payload?.todoId ?? payload?.id ?? ''
      const context = payload?.context ?? payload?.instruction ?? ''
      const contextSection = context ? `\n\nContext notes:\n${context}` : ''
      return `[Scheduled task — ${time}] A task is now due. Execute it immediately.\n\nTask: ${task}\nTask ID: ${todoId}${contextSection}\n\n1. Read agent.md and any relevant memory for additional context.\n2. Carry out the task fully — use all available tools.\n3. When done, mark it complete with the calendar tool (action: complete).\n4. Add a done item describing what you did.`
    }
    if (trigger.source === 'webhook') return `[Webhook — ${time}] Event received: ${JSON.stringify(trigger.payload)}. Search memory and handle it.`
    return `[Manual — ${time}] ${trigger.payload?.message ?? ''}`
  }



  /** Select history: just the most recent messages. Memory tools handle long-term context. */
  private selectHistory(_currentQuery: string): Anthropic.MessageParam[] {
    return this.conversationHistory.slice(-RECENT_KEEP)
  }

  /**
   * Compact tool results from older conversation turns to reduce token usage.
   *
   * Strategy: keep a 2-conversation-turn window of full-fidelity tool results.
   * This covers the current tool loop AND the previous user exchange, so the agent
   * can still reference data it recently fetched (e.g. "what was in that email?").
   *
   * Anything older gets truncated to 300 chars — the assistant's text response
   * from that turn already contains the processed information.
   */
  private compactToolResults(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    if (messages.length <= 4) return messages

    // Find the last TWO user messages that contain plain text (not just tool_results).
    // These mark conversation turn boundaries. Everything before the second-to-last
    // user turn is old enough to compact.
    let userTurnCount = 0
    let compactBefore = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'user') {
        const isRealUserMsg = typeof msg.content === 'string' ||
          (Array.isArray(msg.content) && (msg.content as any[]).some(b => b.type === 'text'))
        if (isRealUserMsg) {
          userTurnCount++
          if (userTurnCount >= 2) { compactBefore = i; break }
        }
      }
    }

    if (compactBefore === 0) return messages

    const TRUNCATE_AT = 300
    let compactedCount = 0
    let savedChars = 0

    const result = messages.map((msg, idx) => {
      if (idx >= compactBefore) return msg
      if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg

      const hasToolResult = (msg.content as any[]).some(b => b.type === 'tool_result')
      if (!hasToolResult) return msg

      const compacted = (msg.content as any[]).map(block => {
        if (block.type !== 'tool_result') return block
        const content = typeof block.content === 'string' ? block.content : ''
        if (content.length <= TRUNCATE_AT) return block
        compactedCount++
        savedChars += content.length - TRUNCATE_AT
        return { ...block, content: content.slice(0, TRUNCATE_AT) + '\n[…truncated]' }
      })
      return { ...msg, content: compacted }
    })

    if (compactedCount > 0) {
      console.log(`[Agent] Compacted ${compactedCount} tool result(s) — saved ~${savedChars} chars (~${Math.round(savedChars / 4)} tokens)`)
    }

    return result
  }

  /**
   * Remove orphaned tool_use/tool_result blocks to prevent API 400 errors.
   *
   * Two cases:
   * 1. Orphaned tool_result: no matching tool_use in the window (window sliced through a pair)
   * 2. Orphaned tool_use: assistant message with tool_use blocks but no tool_result in the next
   *    message — happens when history was saved mid-loop due to a crash or concurrent write
   */
  private sanitizeHistory(messages: typeof this.conversationHistory): typeof this.conversationHistory {
    let result = [...messages]

    // Iterate until stable — each pass can orphan new blocks
    let changed = true
    while (changed) {
      changed = false

      // Collect tool_use and tool_result IDs in current window
      const toolUseIds = new Set<string>()
      const toolResultIds = new Set<string>()
      for (const msg of result) {
        if (!Array.isArray(msg.content)) continue
        for (const block of msg.content as any[]) {
          if (block.type === 'tool_use') toolUseIds.add(block.id)
          if (block.type === 'tool_result') toolResultIds.add(block.tool_use_id)
        }
      }

      // Filter orphaned blocks
      const filtered = result.map(msg => {
        if (!Array.isArray(msg.content)) return msg
        const kept = (msg.content as any[]).filter(block => {
          if (block.type === 'tool_result') return toolUseIds.has(block.tool_use_id)
          if (block.type === 'tool_use') return toolResultIds.has(block.id)
          return true
        })
        if (kept.length === 0) return null
        if (kept.length !== (msg.content as any[]).length) changed = true
        return { ...msg, content: kept }
      }).filter(Boolean) as typeof this.conversationHistory

      // Drop leading non-user messages (API requires first message = user)
      let trimmed = filtered
      while (trimmed.length > 0 && trimmed[0].role !== 'user') {
        trimmed = trimmed.slice(1)
        changed = true
      }

      // Drop trailing non-user messages (API requires last message = user)
      while (trimmed.length > 0 && trimmed[trimmed.length - 1].role !== 'user') {
        trimmed = trimmed.slice(0, -1)
        changed = true
      }

      if (trimmed.length !== result.length) changed = true
      result = trimmed
    }

    return result
  }

  clearHistory(): void {
    this.conversationHistory = []
    this.saveHistory().catch(console.error)
  }
}
