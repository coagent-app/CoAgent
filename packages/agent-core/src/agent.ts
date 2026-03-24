import Anthropic from '@anthropic-ai/sdk'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { MCPManager, MCPServerConfig } from './mcp-manager.js'
import { ApprovalQueue } from './queue.js'
import { TodoList } from './todo.js'
import { searchEventStore, markEventsDone } from './relay-client.js'
import { readSettings, writeSettings } from './settings.js'
import type { AgentSettings } from './settings.js'
import type { AgentTrigger } from '@coagent/shared'
import { searchFiles, readFileContent, readFileBase64, deleteFileEntry, getStorageStats, createDocument, updateDocumentContent, readDocumentContent, listFiles } from './file-store.js'
import { embedTools, searchToolsByEmbedding, clearToolEmbeddings, setToolEmbeddingsDir } from './tool-embeddings.js'
import { getRelayConfig } from './auth.js'

const HISTORY_WINDOW = 50        // total pool — recent + TF-IDF ranked

// --- Skills ---
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
const MAX_RANKED = 10            // max older messages TF-IDF can add from the remaining pool

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
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPick)
    .map(s => s.msg)
}

const INTERNAL_TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_tools',
    description: 'Find tools by description. Use before calling any external service.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'e.g. "send email", "create calendar event"' }
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
        title: { type: 'string' },
        description: { type: 'string' },
        detail: { type: 'string' },
        notes: { type: 'string' },
        action: { type: 'string' },
        metadata: { type: 'object' }
      },
      required: ['type', 'title', 'description', 'notes', 'action']
    }
  },
  {
    name: 'add_done_item',
    description: 'Log a completed action.',
    input_schema: {
      type: 'object' as const,
      properties: {
        description: { type: 'string' }
      },
      required: ['description']
    }
  },
  {
    name: 'add_todo',
    description: 'Add a task to the to-do list.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task: { type: 'string' },
        due: { type: 'string', description: 'YYYY-MM-DD or YYYY-MM-DDTHH:MM' },
        priority: { type: 'string', enum: ['high', 'normal', 'low'] }
      },
      required: ['task']
    }
  },
  {
    name: 'complete_todo',
    description: 'Complete a to-do item by ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'list_todos',
    description: 'List all current to-do items.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  },
  {
    name: 'update_settings',
    description: 'Update user profile or agent settings.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        timezone: { type: 'string' },
        role: { type: 'string' },
        active_hours: {
          type: 'object',
          properties: { start: { type: 'number' }, end: { type: 'number' } }
        },
        active_days: {
          type: 'array',
          items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }
        },
        autonomy: { type: 'string', enum: ['ask_first', 'balanced', 'autonomous'] }
      }
    }
  },
  {
    name: 'list_files',
    description: 'List all files, optionally filtered by folder. Returns id, filename, folder, and summary for each file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        folder: { type: 'string', description: 'Filter by folder name (e.g. "Reports" or "Reports/Q1"). Omit to list all files.' }
      }
    }
  },
  {
    name: 'search_files',
    description: 'Search user files by query. Searches filenames, summaries, and folder names.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_file',
    description: 'Read file content by ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'delete_file',
    description: 'Delete a file by ID. Only when user asks.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'get_storage_stats',
    description: 'Get file count, total size, largest files.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  },
  {
    name: 'create_document',
    description: 'Create a document. Opens in side panel.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown content' },
        group: { type: 'string' }
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'open_document',
    description: 'Open a document by ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'update_document',
    description: 'Update a document. Pass "content" for full rewrite or "edits" for find-and-replace.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        content: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { old_text: { type: 'string' }, new_text: { type: 'string' } },
            required: ['old_text', 'new_text']
          }
        }
      },
      required: ['id']
    }
  },
  {
    name: 'save_skill',
    description: 'Create or update a reusable skill. Users invoke skills with @skill-name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Lowercase kebab-case name (e.g. "weekly-report")' },
        description: { type: 'string', description: 'One-line description shown when listing skills' },
        instructions: { type: 'string', description: 'Full instructions/prompt the agent follows when this skill is invoked' },
      },
      required: ['name', 'description', 'instructions']
    }
  },
  {
    name: 'list_skills',
    description: 'List all saved skills.',
    input_schema: { type: 'object' as const, properties: {} }
  },
  {
    name: 'delete_skill',
    description: 'Delete a skill by name.',
    input_schema: {
      type: 'object' as const,
      properties: { name: { type: 'string' } },
      required: ['name']
    }
  },
]

// --- Tool filtering by trigger context ---

type ToolContext = 'heartbeat' | 'cleanup' | 'chat' | 'webhook'

const TOOL_LABELS: Record<string, string> = {
  search_tools: 'Searching for tools',
  queue_approval: 'Adding to queue',
  add_done_item: 'Marking done',
  add_todo: 'Adding to-do',
  complete_todo: 'Completing to-do',
  list_todos: 'Checking to-dos',
  update_settings: 'Updating settings',
  search_files: 'Searching files',
  read_file: 'Reading file',
  delete_file: 'Deleting file',
  get_storage_stats: 'Checking storage',
  create_document: 'Creating document',
  open_document: 'Opening document',
  update_document: 'Updating document',
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
  'add_done_item', 'add_todo', 'complete_todo', 'list_todos', 'queue_approval', 'list_skills',
])

function getInternalTools(context: ToolContext): Anthropic.Tool[] {
  if (context === 'cleanup') return []
  if (context === 'heartbeat') return INTERNAL_TOOLS.filter(t => HEARTBEAT_TOOLS.has(t.name))
  return INTERNAL_TOOLS
}

function extractContentField(json: string, fieldName: string): string | null {
  const marker = json.indexOf(`"${fieldName}"`)
  if (marker === -1) return null
  const colonPos = json.indexOf(':', marker + fieldName.length + 2)
  if (colonPos === -1) return null
  const quotePos = json.indexOf('"', colonPos + 1)
  if (quotePos === -1) return null
  return unescapePartialJsonString(json.slice(quotePos + 1))
}

function unescapePartialJsonString(s: string): string {
  let result = '', i = 0
  while (i < s.length) {
    if (s[i] === '\\') {
      if (i + 1 >= s.length) break
      const c = s[i + 1]
      if (c === 'n') { result += '\n'; i += 2 }
      else if (c === 't') { result += '\t'; i += 2 }
      else if (c === '"') { result += '"'; i += 2 }
      else if (c === '\\') { result += '\\'; i += 2 }
      else if (c === '/') { result += '/'; i += 2 }
      else if (c === 'r') { result += '\r'; i += 2 }
      else if (c === 'u' && i + 5 < s.length) {
        result += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 6
      } else break
    } else if (s[i] === '"') break
    else { result += s[i]; i++ }
  }
  return result
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

  const connectedList = connectedServices.filter(s => s !== 'composio').join(', ')

  const onboardingSection = isFirstRun ? `

ONBOARDING — this user has not set up their profile yet.

Start with this exact opening, then immediately ask the first question:
"Hey, I'm CoAgent — your personal AI agent running privately on your machine. I work best once I know a bit about you, so let me ask a few quick questions.

What do you do for work?"

Then ask follow-up questions ONE AT A TIME based on what they share. Cover:
1. What they do and who they work with (clients, team, solo?)
2. What takes up most of their time or causes the most friction day-to-day
3. What they'd most want an AI agent handling for them automatically${connectedList ? `\n4. Which of their connected tools (${connectedList}) they actually use daily and want monitored` : ''}
5. How hands-off they want it — what should CoAgent just handle vs. always ask first

Do NOT ask all questions at once. One question per message. Listen to their answers and ask smarter follow-ups — if they mention clients, ask about that. If they mention email overload, dig into that.

When you have a clear picture, write their profile to agent.md and confirm you're set up:
# [their name if given, otherwise "You"]
**About**: [what they do, in their words]
**Focus**: [top 1-2 things they want help with]

## How I work
- Handle automatically: [list]
- Always ask first: [list]

## What to monitor
- [tool]: [what to watch for]

End with: "Got it. I'll run in the background and surface anything that needs you."` : ''

  const formatHour = (h: number) => h === 24 ? 'midnight' : h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`

  const settingsSection = `
Current settings:
- Name: ${settings.name || '(not set)'}
- Email: ${settings.email || '(not set)'}
- Role: ${settings.role || '(not set)'}
- Timezone: ${settings.timezone || '(not set)'}
- Active hours: ${formatHour(settings.active_hours.start)}–${formatHour(settings.active_hours.end)}
- Active days: ${settings.active_days.join(', ')}
- Autonomy: ${settings.autonomy} — ${AUTONOMY_DESCRIPTIONS[settings.autonomy]}
`

  return `You are CoAgent — a private AI agent running on the user's machine. Help with anything asked. Never refuse by saying something is outside your scope.

File references: When listing files from list_files or search_files, show them as a plain text list (e.g. "- report.md — summary"). Do NOT use coagent-file: links for listings. Only use [filename](coagent-file:FILE_ID) when the user asks to open or view a specific single file. Don't paste file content unless asked.

File attachments: To attach files to emails/messages, add "coagent_file_ids": ["FILE_ID"] to the tool input. The system resolves these to base64 automatically.

Skills: Users invoke skills with @skill-name. When invoked, the skill's instructions appear in the message. You can create skills with save_skill when the user asks (e.g. "make a skill that drafts weekly reports"). Keep skill instructions clear and specific.

Document tools: Use create_document for substantial content (emails, reports). Use update_document to revise — always pushes to the editing panel. Don't use for short answers.

${serviceSection}

${settingsSection}

External tools: If the user's request could involve an external service (email, calendar, search, social media, presentations, CRM, etc.) and you don't already have the right tool loaded, call search_tools FIRST before responding. Never guess a tool name. When in doubt, search.

Memory is your long-term brain — history only shows the last few messages. Anything not saved to memory will be forgotten.

WRITE THINGS DOWN. Err on the side of saving too much rather than too little. If the user mentions a name, date, preference, project detail, decision, or anything that might matter later — write it to memory immediately. Don't wait to be asked. If you're unsure whether something is worth saving, save it. When you start working on a task, save what you're doing to projects.md so you can pick it up if context is lost.

When you don't know something or lack context — SEARCH MEMORY FIRST before saying you don't know. Read the relevant memory file before responding. Never say "I don't have enough context" without checking memory first.

Your memory files:
- setup.md — what you are and how you work (read-only reference)
- agent.md — the user's profile, who they are, how they like things
- routines.md — your heartbeat schedule: what to check and when
- preferences.md — user's preferences for tone, format, behavior
- contacts.md — key people and how to handle their messages
- projects.md — active projects, context, deadlines
Read these on startup and heartbeats. When the user shares anything worth remembering — preferences, contacts, project details, decisions, instructions, corrections — save it to the relevant file immediately. Delete stale or resolved files with delete_memory.

Routine tasks: act, then add_done_item. High-stakes actions: queue_approval instead.
When queuing emails/messages: put the full draft body in "detail", and put recipient, subject, etc. in "metadata" so the user can review everything before approving.
On heartbeat: read routines.md, check due tasks, check pending queue. If nothing needs attention, reply "All clear." immediately.

Keep responses concise. No emojis. Markdown only when helpful.${onboardingSection}`
}

export class Agent {
  private anthropic: Anthropic
  public mcpManager: MCPManager
  public queue: ApprovalQueue
  public todos: TodoList
  public onDocumentEvent?: (event:
    | { type: 'opened'; id: string; filename: string; content: string }
    | { type: 'updated'; id: string; content: string }
  ) => void
  public onDocumentStream?: (event:
    | { type: 'start'; filename: string }
    | { type: 'chunk'; text: string }
  ) => void
  private conversationHistory: Anthropic.MessageParam[] = []
  private historyPath: string
  private agentProfilePath: string
  private dataDir: string
  private runLoopPromise: Promise<string> | null = null
  private activeStream: { abort: () => void } | null = null
  private stopped = false
  private missedEvents: { source: string; payload: unknown; time: string }[] = []
  private steeringQueue: string[] = []
  public onSkillsChanged?: () => void

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
    this.todos = new TodoList(dataDir)
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

  async handleTrigger(trigger: AgentTrigger & { content?: string }): Promise<void> {
    const isHeartbeat = trigger.source === 'heartbeat'
    const isCleanup = trigger.source === 'memory_cleanup'

    // If agent is busy, queue webhook/incoming events for later — don't drop them
    if (this.runLoopPromise) {
      if (!isHeartbeat && !isCleanup) {
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

    const context: ToolContext = isHeartbeat ? 'heartbeat'
      : isCleanup ? 'cleanup'
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
    this.runLoopPromise = this.runLoop(undefined, context)
    try {
      const result = await this.runLoopPromise

      // Heartbeat escalation: if Haiku found work to do, hand off to Sonnet
      if (context === 'heartbeat' && result && !result.toLowerCase().includes('all clear')) {
        console.log('[Agent] Heartbeat found action needed — escalating to Sonnet')
        this.runLoopPromise = null
        this.conversationHistory.push({ role: 'user', content: `[Escalated from heartbeat triage] Haiku identified the following. Take action now:\n\n${result}` })
        this.runLoopPromise = this.runLoop(undefined, 'webhook')
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
    const systemPrompt = buildSystemPrompt(connectedServices, this.agentProfilePath, settings)

    // Model routing: Haiku for background tasks, user's power model for everything else
    const HAIKU = 'claude-haiku-4-5-20251001'
    const currentModel = (context === 'heartbeat' || context === 'cleanup') ? HAIKU : settings.powerModel
    const maxTokens = (context === 'heartbeat' || context === 'cleanup') ? 512 : 16000

    console.log(`[Agent] Starting ${context} on ${currentModel} (max_tokens: ${maxTokens})`)

    // Proactively pre-load tools relevant to the user's latest message
    // Skip for heartbeat/cleanup — they have fixed tool needs
    const lastUserMsg = this.conversationHistory.filter(m => m.role === 'user').at(-1)
    const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : ''
    const preloaded = (context === 'heartbeat' || context === 'cleanup')
      ? []
      : userText ? await searchToolsByEmbedding(userText, searchableTools, 5) : []

    // Cache the stable prefix (system prompt + memory tools + internal tools).
    // Preloaded tools are dynamic — they come after the cache boundary.
    // Skip caching for heartbeat/cleanup — they run too infrequently to benefit.
    const isBackground = context === 'heartbeat' || context === 'cleanup'
    const contextTools = getInternalTools(context)
    const stableTools = [
      ...memoryTools,
      ...(contextTools.length > 0
        ? contextTools.map((t, i) =>
            i === contextTools.length - 1 && !isBackground ? { ...t, cache_control: { type: 'ephemeral' as const, ttl: '1h' } } : t
          )
        : [])
    ]
    // If no internal tools, put cache boundary on last memory tool instead
    if (!isBackground && contextTools.length === 0 && stableTools.length > 0) {
      stableTools[stableTools.length - 1] = { ...stableTools[stableTools.length - 1], cache_control: { type: 'ephemeral' as const, ttl: '1h' } } as any
    }
    const dynamicTools: Anthropic.Tool[] = [...preloaded]
    const loadedToolNames = new Set([...stableTools, ...preloaded].map(t => t.name))

    if (preloaded.length > 0) {
      console.log(`[Agent] Pre-loaded ${preloaded.length} tools: ${preloaded.map(t => t.name).join(', ')}`)
    }

    let finalText = ''
    let turn = 0
    let lastText = ''
    const filenameLookup = new Map((await listFiles(this.dataDir)).map(f => [f.id, f.filename]))

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
            messages: this.sanitizeHistory(this.selectHistory(userText)) as any,
            ...(isBackground ? {} : { cache_control: { type: 'ephemeral', ttl: '1h' } as any }),
          } as any)
          this.activeStream = stream
          stream.on('text', (text) => {
            try { onChunk?.(text) } catch (err) { console.error('[Agent] onChunk error:', err) }
          })

          // Document streaming — detect create/update tool blocks and stream content
          let docBlockIndex = -1
          let docJson = ''
          let docContentSent = 0
          let docStartSent = false

          stream.on('streamEvent', (event: any) => {
            if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
              const name = event.content_block.name
              console.log(`[DocStream] content_block_start: tool_use name=${name}`)
              if (name === 'create_document' || name === 'update_document') {
                docBlockIndex = event.index
                docJson = ''
                docContentSent = 0
                docStartSent = false
                // Open the panel immediately with a placeholder name
                this.onDocumentStream?.({ type: 'start', filename: 'Document' })
                docStartSent = true
                console.log('[DocStream] Sent document_stream_start')
              }
            }

            if (event.type === 'content_block_delta' &&
                event.index === docBlockIndex &&
                event.delta?.type === 'input_json_delta') {
              docJson += event.delta.partial_json

              // Refine the filename once we can extract title or id
              if (docStartSent && docContentSent === 0) {
                const titleField = extractContentField(docJson, 'title')
                const idField = extractContentField(docJson, 'id')
                if (titleField) {
                  this.onDocumentStream?.({ type: 'start', filename: titleField + '.md' })
                  console.log(`[DocStream] Refined filename: ${titleField}.md`)
                } else if (idField) {
                  const fn = filenameLookup.get(idField) ?? 'Document'
                  this.onDocumentStream?.({ type: 'start', filename: fn })
                  console.log(`[DocStream] Refined filename by id: ${fn}`)
                }
              }

              const content = extractContentField(docJson, 'content')
              if (content && content.length > docContentSent) {
                const chunk = content.slice(docContentSent)
                console.log(`[DocStream] Sending chunk: +${chunk.length} chars (total ${content.length})`)
                this.onDocumentStream?.({ type: 'chunk', text: chunk })
                docContentSent = content.length
              }
            }

            if (event.type === 'content_block_stop' && event.index === docBlockIndex) {
              console.log(`[DocStream] content_block_stop — total content streamed: ${docContentSent} chars`)
              docBlockIndex = -1
            }
          })

          response = await stream.finalMessage()
          this.activeStream = null
          const u = response.usage as any
          const cacheHit = u.cache_read_input_tokens ?? 0
          const cacheWrite = u.cache_creation_input_tokens ?? 0
          const cacheInfo = cacheHit > 0 ? ` (${cacheHit} cached)` : cacheWrite > 0 ? ` (${cacheWrite} cache write)` : ''
          console.log(`[Agent] Turn ${turn} — ${response.stop_reason} — ${Date.now() - t0}ms — ${response.usage.input_tokens} in${cacheInfo} / ${response.usage.output_tokens} out tokens`)
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
            const label = TOOL_LABELS[block.name] ?? humanizeToolName(block.name)
            onToolCall(block.name, label)
          }

          let result: string

          if (block.name === 'search_tools') {
            searchToolCalls++
            if (searchToolCalls > 3) {
              result = 'You have enough tools loaded. Use what you have.'
              ;(toolResults.content as Anthropic.ToolResultBlockParam[]).push({
                type: 'tool_result', tool_use_id: block.id, content: result
              })
              continue
            }
            const query = (block.input as { query: string }).query
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
            console.log(`[Agent] search_tools("${query}") → ${matches.map(t => t.name).join(', ')}`)

          } else if (block.name === 'queue_approval') {
            this.queue.add(block.input as Parameters<ApprovalQueue['add']>[0])
            result = 'Queued for approval.'

          } else if (block.name === 'add_done_item') {
            this.queue.addDone((block.input as { description: string }).description)
            result = 'Added to done list.'

          } else if (block.name === 'add_todo') {
            const input = block.input as { task: string; due?: string; priority?: 'high' | 'normal' | 'low' }
            const item = this.todos.add({ task: input.task, due: input.due, priority: input.priority ?? 'normal' })
            result = `Added to-do: "${item.task}" (id: ${item.id})`

          } else if (block.name === 'complete_todo') {
            const { id } = block.input as { id: string }
            const item = this.todos.complete(id)
            result = item ? `Completed: "${item.task}"` : `Todo ${id} not found.`

          } else if (block.name === 'list_todos') {
            const items = this.todos.getAll()
            if (items.length === 0) {
              result = 'No to-do items.'
            } else {
              result = items.map(t =>
                `[${t.id}] ${t.task}${t.due ? ` (due: ${t.due})` : ''}${t.priority !== 'normal' ? ` [${t.priority}]` : ''}`
              ).join('\n')
            }

          } else if (block.name === 'update_settings') {
            const patch = block.input as Partial<AgentSettings>
            await writeSettings(this.dataDir, patch)
            result = 'Settings updated.'

          } else if (block.name === 'list_files') {
            const { folder } = block.input as { folder?: string }
            const files = await listFiles(this.dataDir)
            const folderLower = folder?.toLowerCase()
            const filtered = folderLower
              ? files.filter(f => f.group.toLowerCase() === folderLower || f.group.toLowerCase().startsWith(`${folderLower}/`))
              : files
            console.log(`[Agent] list_files(folder=${folder ?? 'all'}) → ${filtered.length}/${files.length} files`)
            if (filtered.length === 0) {
              result = folder ? `No files in folder "${folder}". Available folders: ${[...new Set(files.map(f => f.group).filter(Boolean))].join(', ')}` : 'No files stored yet.'
            } else {
              result = filtered.map(f =>
                `[id:${f.id}] ${f.group ? f.group + '/' : ''}${f.filename} — ${f.summary}`
              ).join('\n')
            }

          } else if (block.name === 'search_files') {
            const { query, limit } = block.input as { query: string; limit?: number }
            const files = await searchFiles(this.dataDir, query, limit ?? 5)
            if (files.length === 0) {
              result = 'No files found matching that query.'
            } else {
              result = files.map(f =>
                `[id:${f.id}] [${f.group}] ${f.filename} — ${f.summary}`
              ).join('\n')
            }

          } else if (block.name === 'read_file') {
            const { id } = block.input as { id: string }
            try {
              result = await readFileContent(this.dataDir, id)
            } catch (err: any) {
              result = `Error reading file: ${err.message}`
            }

          } else if (block.name === 'delete_file') {
            const { id } = block.input as { id: string }
            await deleteFileEntry(this.dataDir, id)
            result = 'File deleted.'

          } else if (block.name === 'get_storage_stats') {
            try {
              const stats = await getStorageStats(this.dataDir)
              const mb = (stats.totalBytes / 1024 / 1024).toFixed(1)
              const largestPart = stats.largestFiles.length > 0
                ? `\nLargest: ${stats.largestFiles.map(f => `${f.filename} (${(f.sizeBytes / 1024).toFixed(0)}KB)`).join(', ')}`
                : ''
              result = `${stats.totalFiles} files, ${mb} MB total.${largestPart}`
            } catch (err: any) {
              result = `Error getting storage stats: ${err.message}`
            }

          } else if (block.name === 'create_document') {
            try {
              const { title, content, group } = block.input as { title: string; content: string; group?: string }
              const entry = await createDocument(this.dataDir, title, content, group)
              const docContent = await readDocumentContent(this.dataDir, entry.id)
              this.onDocumentEvent?.({ type: 'opened', id: entry.id, filename: entry.filename, content: docContent })
              result = `Document created: ${entry.filename} (id: ${entry.id})`
            } catch (err: any) {
              result = `Error creating document: ${err.message}`
            }

          } else if (block.name === 'open_document') {
            try {
              const { id } = block.input as { id: string }
              const docContent = await readDocumentContent(this.dataDir, id)
              const files = await listFiles(this.dataDir)
              const file = files.find(f => f.id === id)
              this.onDocumentEvent?.({ type: 'opened', id, filename: file?.filename ?? 'Document', content: docContent })
              result = `Opened document: ${file?.filename ?? id}`
            } catch (err: any) {
              result = `Error opening document: ${err.message}`
            }

          } else if (block.name === 'update_document') {
            try {
              const { id, content, edits } = block.input as { id: string; content?: string; edits?: { old_text: string; new_text: string }[] }
              let finalContent: string
              if (edits && edits.length > 0) {
                // Surgical edit mode — read current content and apply find-and-replace
                const current = await readDocumentContent(this.dataDir, id)
                finalContent = current
                let editError = ''
                for (const edit of edits) {
                  if (!finalContent.includes(edit.old_text)) {
                    editError = `Edit failed: could not find "${edit.old_text.slice(0, 60)}..." in document`
                    break
                  }
                  finalContent = finalContent.replace(edit.old_text, edit.new_text)
                }
                if (editError) {
                  result = editError
                } else {
                  const entry = await updateDocumentContent(this.dataDir, id, finalContent)
                  this.onDocumentEvent?.({ type: 'opened', id: entry.id, filename: entry.filename, content: finalContent })
                  result = `Document updated (${edits.length} edit${edits.length > 1 ? 's' : ''} applied): ${entry.filename}`
                }
              } else if (content) {
                finalContent = content
                const entry = await updateDocumentContent(this.dataDir, id, finalContent)
                this.onDocumentEvent?.({ type: 'opened', id: entry.id, filename: entry.filename, content: finalContent })
                result = `Document updated: ${entry.filename}`
              } else {
                result = 'Error: provide either "content" or "edits"'
              }
            } catch (err: any) {
              result = `Error updating document: ${err.message}`
            }

          } else if (block.name === 'save_skill') {
            const { name, description, instructions } = block.input as { name: string; description: string; instructions: string }
            const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')
            await saveSkill(this.dataDir, { name: safeName, description, instructions })
            result = `Skill saved: @${safeName} — "${description}"`
            this.onSkillsChanged?.()

          } else if (block.name === 'list_skills') {
            const skills = await listSkills(this.dataDir)
            result = skills.length === 0
              ? 'No skills saved yet.'
              : skills.map(s => `@${s.name} — ${s.description}`).join('\n')

          } else if (block.name === 'delete_skill') {
            const { name } = block.input as { name: string }
            const deleted = await deleteSkill(this.dataDir, name)
            result = deleted ? `Skill @${name} deleted.` : `Skill @${name} not found.`
            if (deleted) this.onSkillsChanged?.()

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
      const due = this.todos.getDue()
      const dueSection = due.length > 0
        ? `\n\nDue tasks:\n${due.map(t => `- [${t.id}] ${t.task}${t.due ? ` (due: ${t.due})` : ''}`).join('\n')}`
        : ''
      return `[Heartbeat triage — ${time}] You are triaging. DO NOT take action — only assess and report.\n\n1. Read routines.md for what's expected at this time.\n2. Read agent.md for user context.\n3. Check due tasks.${dueSection}\n4. Check pending queue items.\n\nIf nothing needs attention, reply exactly "All clear."\nOtherwise, reply with a brief summary of what needs to be done. Do NOT take action yourself — a more capable model will handle it.`
    }
    if (trigger.source === 'memory_cleanup') return `[Memory cleanup — ${time}] Review all memory files with list_memories, then read each one. Delete or rewrite files that are stale, resolved, or no longer relevant. Consolidate duplicates. Keep only what is actively useful. Reply with a brief summary of what you cleaned up.`
    if (trigger.source === 'webhook') return `[Webhook — ${time}] Event received: ${JSON.stringify(trigger.payload)}. Search memory and handle it.`
    return `[Manual — ${time}] ${trigger.payload?.message ?? ''}`
  }



  /**
   * Select history messages: always keep the most recent RECENT_KEEP,
   * then TF-IDF rank older messages and include only relevant ones.
   */
  private selectHistory(currentQuery: string): Anthropic.MessageParam[] {
    const all = this.conversationHistory
    if (all.length <= RECENT_KEEP) return [...all]

    const recent = all.slice(-RECENT_KEEP)
    const older = all.slice(-HISTORY_WINDOW, -RECENT_KEEP)

    if (older.length === 0) return recent

    const relevant = rankByRelevance(currentQuery, older, MAX_RANKED)

    // Preserve chronological order by sorting by original index
    const olderIndexMap = new Map(older.map((m, i) => [m, i]))
    relevant.sort((a, b) => (olderIndexMap.get(a) ?? 0) - (olderIndexMap.get(b) ?? 0))

    const selected = [...relevant, ...recent]
    console.log(`[Agent] History: ${recent.length} recent + ${relevant.length}/${older.length} ranked = ${selected.length} messages (was ${Math.min(all.length, HISTORY_WINDOW)})`)
    return selected
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
