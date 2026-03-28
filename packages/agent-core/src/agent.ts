import Anthropic from '@anthropic-ai/sdk'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { MCPManager, MCPServerConfig } from './mcp-manager.js'
import { ApprovalQueue } from './queue.js'
import { CalendarStore } from './calendar-store.js'
import { searchEventStore, markEventsDone, getUnprocessedEvents } from './relay-client.js'
import { readSettings, writeSettings } from './settings.js'
import type { AgentSettings } from './settings.js'
import type { AgentTrigger } from '@coagent/shared'
import { searchFiles, readFileContent, readFileBase64, deleteFileEntry, getStorageStats, listFiles } from './file-store.js'
import { embedTools, searchToolsAndSchema, setToolEmbeddingsDir } from './tool-embeddings.js'
import { logToolCall, extractIntegration, searchToolLogs } from './service-logger.js'
import { recordUsage } from './usage-tracker.js'
import { getRelayConfig } from './auth.js'

const HISTORY_WINDOW = 50        // total pool — recent + TF-IDF ranked

// --- Skills ---
const DEFAULT_SKILL_NAMES = new Set(['skill-creator', 'integration-builder'])
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

// ── Composio S3 file upload for email attachments ──────────────────────────

const COMPOSIO_FILES_URL = process.env.RELAY_URL
  ? `${process.env.RELAY_URL.replace(/\/$/, '')}/v1/composio/files/upload/request`
  : 'https://backend.composio.dev/api/v3/files/upload/request'

/**
 * Upload a file to Composio's S3 via presigned URL.
 * Returns the { name, mimetype, s3key } object needed by email tool `attachment` param.
 */
async function uploadToComposioS3(
  fileBuffer: Buffer,
  filename: string,
  mimeType: string,
  toolSlug: string,
  toolkitSlug: string
): Promise<{ name: string; mimetype: string; s3key: string }> {
  const authKey = process.env.RELAY_TOKEN
  if (!authKey) throw new Error('No RELAY_TOKEN set')

  const md5 = createHash('md5').update(fileBuffer).digest('hex')

  // Step 1: Get presigned upload URL
  const presignRes = await fetch(COMPOSIO_FILES_URL, {
    method: 'POST',
    headers: { 'X-API-KEY': authKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename,
      md5,
      mimetype: mimeType,
      tool_slug: toolSlug,
      toolkit_slug: toolkitSlug,
    })
  })
  if (!presignRes.ok) {
    const body = await presignRes.text()
    throw new Error(`Composio presign failed (${presignRes.status}): ${body}`)
  }
  const presignData = await presignRes.json() as { key: string; new_presigned_url: string }

  // Step 2: PUT file bytes to presigned URL
  const uploadRes = await fetch(presignData.new_presigned_url, {
    method: 'PUT',
    body: fileBuffer,
    headers: {
      'Content-Type': mimeType,
      'Content-Length': fileBuffer.length.toString(),
    }
  })
  if (!uploadRes.ok) {
    throw new Error(`S3 upload failed (${uploadRes.status})`)
  }

  console.log(`[Agent] Uploaded ${filename} to Composio S3: ${presignData.key}`)
  return { name: filename, mimetype: mimeType, s3key: presignData.key }
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

/** Format a tool's schema as readable text, filtered to only the specified params.
 *  If no paramNames provided, includes all params (fallback).
 *  The schema lives in messages (cached), NOT in the tools array — saves thousands of tokens. */
function formatSchemaForResult(tool: Anthropic.Tool, paramNames?: string[]): string {
  const schema = tool.input_schema as any
  if (!schema?.properties) return ''

  const includeSet = paramNames && paramNames.length > 0 ? new Set(paramNames) : null

  const params: string[] = []
  let skipped = 0

  for (const [k, v] of Object.entries(schema.properties) as [string, any][]) {
    if (includeSet && !includeSet.has(k)) { skipped++; continue }

    const type = v.type || 'any'
    const required = new Set(schema.required || [])
    const req = required.has(k) ? ' (required)' : ''
    const rawDesc = v.description || ''
    const desc = rawDesc ? ` — ${rawDesc.length > 120 ? rawDesc.slice(0, 120) + '…' : rawDesc}` : ''
    const enumVals = v.enum ? ` [${v.enum.slice(0, 8).join(', ')}]` : ''
    params.push(`  ${k} (${type}${req})${desc}${enumVals}`)
  }

  const note = skipped > 0 ? `  (${skipped} more params available — search with details to see them)` : ''
  return `\n${tool.name} parameters:\n${params.join('\n')}${note ? '\n' + note : ''}`
}

const INTERNAL_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_current_time',
    description: 'Get the current date and time.',
    input_schema: { type: 'object' as const, properties: {}, required: [] }
  },
  {
    name: 'search_tools',
    description: 'Find tools, gather context, and get the schema for the action you want to take.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'e.g. "send email", "create calendar event"' },
        context: { type: 'string', description: 'Context to look up — names, user IDs, emails, channels, e.g. "Nathan slack" or "email from Alex"' },
        schema: { type: 'string', description: 'Describe the full action including all fields you need, e.g. "send email to recipient with subject, body, CC, and attachment", "create calendar event with title, time, attendees, and location", "fetch emails filtered by sender and subject"' }
      },
      required: ['query', 'context', 'schema']
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
    name: 'schedule',
    description: 'Unified schedule for routines, tasks, and followups. Actions: create (type+label+timing), update (id+fields), delete (id), complete (id — tasks and followups only), list (optional type filter). Type rules: routine = recurring agent action (cron + instruction, fires on schedule and executes), task = one-time to-do (due + instruction, fires at due time and executes), followup = check back on something at due time (due + instruction, fires like a task — agent checks status and asks user what to do next: reschedule, nudge, or mark done). Tasks with a due time MUST have an instruction. Followup instructions must be specific and actionable: who/what to check, where to look, what to do based on the outcome. Example: instead of "Check if Sarah replied" write "Check Gmail for a reply from sarah@acme.com about the Q1 proposal sent March 28. If replied, summarize response and ask user if they want to respond. If not replied, ask user if they want to send a nudge." IMPORTANT: when creating a followup, always ASK the user when they want the followup before creating it — do not assume timing.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete', 'complete', 'list'] },
        type: { type: 'string', enum: ['routine', 'task', 'followup'], description: 'routine = recurring (cron+instruction), task = one-time to-do (due+instruction), followup = check-back (due+instruction, fires like task then asks user what to do next)' },
        id: { type: 'string', description: 'Entry ID (for update/delete/complete)' },
        label: { type: 'string', description: 'Display name' },
        cron: { type: 'string', description: 'Cron expression for routines, e.g. "0 9 * * 1-5"' },
        due: { type: 'string', description: 'ISO datetime for tasks/followups, e.g. "2026-03-28T14:30:00"' },
        instruction: { type: 'string', description: 'What the agent executes when the entry fires. Required for tasks/followups with due time. Must be detailed and actionable.' },
        notes: { type: 'string', description: 'Context/details for any entry type' },
        enabled: { type: 'boolean', description: 'Enable/disable (default true)' },
        filter_type: { type: 'string', enum: ['routine', 'task', 'followup'], description: 'Filter for list action' },
      },
      required: ['action']
    }
  },
  {
    name: 'skills',
    description: 'Manage reusable skills. Actions: save (name/description/instructions required), list, delete (by name), execute (by name — loads and returns full instructions for you to follow). Users invoke with @skill-name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'delete', 'execute'] },
        name: { type: 'string', description: 'Kebab-case name (for save/delete/execute)' },
        description: { type: 'string', description: 'One-line description (for save)' },
        instructions: { type: 'string', description: 'Full instructions (for save)' }
      },
      required: ['action']
    }
  },
  {
    name: 'create_custom_integration',
    description: 'Manage custom MCP integrations. Actions: "propose" shows capability checkboxes, "create" builds the server, "read" returns current code, "update" writes new code and restarts. Always include an icon SVG when creating — 32x32 viewBox, rounded rect background with brand color, white symbol on top.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['propose', 'create', 'read', 'update'], description: '"propose" sends capability card, "create" builds the server, "read" gets current code, "update" replaces code and restarts' },
        name: { type: 'string', description: 'kebab-case name e.g. "notion", "airtable"' },
        display_name: { type: 'string', description: 'Human-readable name e.g. "Notion"' },
        description: { type: 'string', description: 'One-line description of what the integration does' },
        capabilities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' }
            },
            required: ['name', 'description']
          },
          description: 'List of capabilities the integration provides'
        },
        auth_fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'env var name e.g. API_KEY' },
              display_name: { type: 'string' },
              description: { type: 'string' },
              help_url: { type: 'string', description: 'Direct URL where the user can find/create this credential (e.g. https://app.gohighlevel.com/settings/api-keys)' },
              help_text: { type: 'string', description: 'Short step-by-step instruction to find this credential (e.g. "Go to Settings → API Keys → Create New Key")' }
            },
            required: ['name', 'display_name', 'description', 'help_url', 'help_text']
          },
          description: 'Credential fields the user needs to provide'
        },
        code: { type: 'string', description: 'The full index.js MCP server source code' },
        dependencies: { type: 'object', description: 'Additional npm dependencies beyond @modelcontextprotocol/sdk' },
        icon: { type: 'string', description: 'SVG icon string (32x32 viewBox, rounded rect bg + white symbol). Example: <svg viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="7" fill="#FF6B00"/><path d="..." fill="white"/></svg>' }
      },
      required: ['action', 'name']
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
  {
    name: 'call_external_tool',
    description: 'Call an external integration tool discovered via search_tools. Pass the exact tool name and parameters from the schema returned by search_tools.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tool_name: { type: 'string', description: 'Exact tool name from search_tools result, e.g. GMAIL_SEND_EMAIL' },
        parameters: { type: 'object', description: 'Tool parameters as described in the schema', additionalProperties: true }
      },
      required: ['tool_name', 'parameters']
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
  call_external_tool: 'Calling tool',
  create_custom_integration: 'Building custom integration',
}

// Action-specific labels for consolidated tools
const ACTION_LABELS: Record<string, Record<string, string>> = {
  files: { list: 'Listing files', search: 'Searching files', read: 'Reading file', delete: 'Deleting file', stats: 'Checking storage' },
  calendar: { create: 'Adding to calendar', update: 'Updating calendar entry', delete: 'Deleting calendar entry', complete: 'Completing task', list: 'Checking calendar' },
  skills: { save: 'Saving skill', list: 'Listing skills', delete: 'Deleting skill' },
  memory: { search: 'Searching memory', grep: 'Searching memory', read: 'Reading memory', write: 'Writing memory', edit: 'Editing memory', append: 'Updating memory', list: 'Listing memory', delete: 'Cleaning memory' },
  create_custom_integration: { propose: 'Proposing capabilities', create: 'Building integration', read: 'Reading integration code', update: 'Updating integration' },
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
  'get_current_time', 'memory', 'search_tools',
])

// Tools gated behind a skill — only included when the skill has been activated
const SKILL_GATED_TOOLS = new Set(['create_custom_integration'])

function getInternalTools(context: ToolContext, activeSkillTools?: Set<string>): Anthropic.Tool[] {
  if (context === 'heartbeat') return INTERNAL_TOOLS.filter(t => HEARTBEAT_TOOLS.has(t.name))
  return INTERNAL_TOOLS.filter(t => !SKILL_GATED_TOOLS.has(t.name) || activeSkillTools?.has(t.name))
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


function listMemoryFiles(dataDir: string): string[] {
  const memDir = join(dataDir, 'memory')
  try {
    const { readdirSync } = require('fs') as typeof import('fs')
    return readdirSync(memDir)
      .filter((f: string) => f.endsWith('.md'))
      .sort()
  } catch { return [] }
}

function buildSystemPrompt(connectedServices: string[], agentProfilePath: string, settings: AgentSettings, dataDir: string): string {
  const isFirstRun = !existsSync(agentProfilePath)
  const memoryFiles = listMemoryFiles(dataDir)

  const serviceSection = connectedServices.length > 0
    ? `Connected external services: ${connectedServices.join(', ')}. search_tools is how you find tools AND gather context for external services. It has 3 required params:
- query: what you want to do (e.g. "send email", "create calendar event")
- context: look up relevant context (names, user IDs, emails, channels, e.g. "Nathan slack")
- schema: describe the full action with ALL fields you need (e.g. "send email to recipient with subject, body, CC, and attachment") — returns only the relevant parameter schemas
IMPORTANT: After search_tools returns the schema, use call_external_tool(tool_name, parameters) to execute the action. READ the schema in the search_tools result to know exactly what parameters to pass. Use the memory tool separately for contacts and preferences. Act on what you find, don't ask the user to confirm details you already have.`
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
- Heartbeat: ${settings.heartbeat_interval > 0 ? `every ${settings.heartbeat_interval} minutes — processes incoming trigger events (emails, messages, etc.), checks memory for context, and escalates anything that needs action` : 'disabled — you only respond when the user messages you'}
- Autonomy: ${settings.autonomy} — ${AUTONOMY_DESCRIPTIONS[settings.autonomy]}
`

  return `You are CoAgent — a private AI agent running on the user's machine. Help with anything asked. Never refuse by saying something is outside your scope.

CRITICAL — Before responding to ANY request, your FIRST action must be a memory search for relevant info (names, addresses, preferences, contacts, project details). NEVER ask the user for information that might be in memory. When using search_tools, use the context param. Only ask after you've searched and genuinely can't find it.

${serviceSection}
${settingsSection}
Skills: reusable automation workflows (instructions you follow). Users invoke with @skill-name, but you can also use them proactively. When asked to do something unfamiliar, check skills first (skills tool, action: list).
Integrations: connections to external services (Gmail, Slack, etc.). You can build NEW integrations from any API using create_custom_integration — this creates a real tool connection, not a skill. Use @integration-builder skill for the full workflow.

File listings: plain text (e.g. "- report.md — summary"). Only use [filename](coagent-file:FILE_ID) when asked to open a specific file. To attach files to emails, include coagent_file_ids in the tool params — the system handles upload automatically.

Memory: your long-term brain — history only shows recent messages. Use the memory tool directly (NOT search_tools). Prefer search (semantic) or grep (pattern match within a file) over read. Write things down immediately. Your memory files contain info you've already learned — ALWAYS search before asking for ANY info. You can create custom .md files for broad categories (e.g. leads, contacts).
Available files: ${memoryFiles.length > 0 ? memoryFiles.join(', ') : '(none yet)'}

Routine tasks: act, then add_done_item. High-stakes actions: queue_approval with full draft in "detail" and recipient/subject in "metadata".

- **schedule** (create/update/delete/complete/list) — unified schedule for routines (recurring cron), tasks (one-time due), and followups (check-back reminders that fire like tasks then ask user what to do next).
- **Proactive followups**: after sending emails, messages, proposals, etc., ask "Want me to follow up on this? When?" — never auto-create, always ask first.

When you need multiple independent pieces of information, call all the tools in a single response (e.g. read memory + use schedule (action: list) to check routines and tasks + check time in one turn). This is faster and cheaper.

You can search the web — use search_tools("web search") to find the right tool.
${connectedServices.includes('coagent:imessage') ? `\niMessage is connected. search_tools("iMessage") to find tools for reading and sending messages. Queue sends for approval unless autonomy is "autonomous".` : ''}
${connectedServices.includes('coagent:contacts') ? `\nContacts is connected. search_tools("contacts") to find tools for searching and looking up contact details.` : ''}
[voice] = voice input. Reply in 1-2 short spoken sentences, no markdown. Use tools normally.

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
  /** Index of the last scheduled-task message — pinned in selectHistory so it doesn't scroll out */
  private pinnedTaskIdx: number | null = null
  /** Memoized system prompt — only rebuilt when inputs actually change */
  private cachedSystemPrompt: string | null = null
  private cachedPromptKey: string | null = null
  // Briefings removed — context now provided via search_tools context param
  public onSkillsChanged?: () => void
  public onSettingsChanged?: () => void
  public onCalendarChanged?: () => void
  public onCustomIntegration?: (action: string, data: any) => Promise<string>
  public activeSkillTools = new Set<string>()

  async getSkills(): Promise<{ name: string; description: string; instructions: string; builtin: boolean }[]> {
    return (await listSkills(this.dataDir))
      .map(s => ({ name: s.name, description: s.description, instructions: s.instructions, builtin: DEFAULT_SKILL_NAMES.has(s.name) }))
  }

  async updateSkill(name: string, description: string, instructions: string): Promise<void> {
    await saveSkill(this.dataDir, { name, description, instructions })
  }

  async removeSkill(name: string): Promise<boolean> {
    return deleteSkill(this.dataDir, name)
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
    const defaultHeaders: Record<string, string> = {
      'anthropic-beta': 'extended-cache-ttl-2025-04-11',
    }
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

    // Heartbeat: fetch unprocessed events from the event store and inject them
    if (isHeartbeat) {
      const events = await getUnprocessedEvents(this.dataDir)
      trigger = { ...trigger, payload: { ...trigger.payload, events } }
      console.log(`[Agent] Heartbeat: ${events.length} new event(s), ${this.missedEvents.length} missed`)
    }

    const context: ToolContext = isTodoDue ? 'chat'
      : isHeartbeat ? 'heartbeat'
      : trigger.source === 'webhook' ? 'webhook'
      : 'chat'

    const message = trigger.content ?? this.buildTriggerMessage(trigger)
    this.conversationHistory.push({ role: 'user', content: message })

    // Pin scheduled-task messages so they stay in the context window
    if (isTodoDue) {
      this.pinnedTaskIdx = this.conversationHistory.length - 1
    }

    // Haiku triage is silent — no chunks or tool calls shown in UI
    this.runLoopPromise = this.runLoop(undefined, context, undefined)
    try {
      const result = await this.runLoopPromise

      // Heartbeat escalation: Haiku gathered context → pass to Sonnet with full tools
      if (context === 'heartbeat' && result && !result.toLowerCase().includes('all clear')) {
        console.log('[Agent] Heartbeat found action needed — escalating to Sonnet')
        this.conversationHistory.push({ role: 'user', content: `[Heartbeat summary — act on this now]\n\n${result}` })
        this.runLoopPromise = this.runLoop(onChunk, 'chat', onToolCall)
        await this.runLoopPromise
      }
    } finally {
      this.runLoopPromise = null
      if (isTodoDue) this.pinnedTaskIdx = null
    }
  }

  async chat(
    message: string,
    onChunk?: (text: string) => void,
    onToolCall?: (tool: string, label: string) => void,
    fileIds?: string[],
    extraContent?: any[]
  ): Promise<string> {
    const resolved = await resolveSkillMentions(this.dataDir, message)

    // If files were attached, build a multi-part content block so Claude can see them
    if (fileIds?.length || extraContent?.length) {
      const contentParts: any[] = []
      // Add any extra content blocks (e.g. images from WhatsApp)
      if (extraContent) contentParts.push(...extraContent)
      for (const fid of (fileIds || [])) {
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

    // Embed check — no-op if already cached. Actual embedding happens on integration connect.
    embedTools(searchableTools).catch(err => console.warn('[Agent] Tool embedding failed:', err.message))
    const settings = await readSettings(this.dataDir)

    // Memoize system prompt — only rebuild when services or settings actually change
    const memFiles = listMemoryFiles(this.dataDir)
    const promptKey = connectedServices.join(',') + '|' + JSON.stringify(settings) + '|' + memFiles.join(',')
    let systemPrompt: string
    if (this.cachedSystemPrompt && this.cachedPromptKey === promptKey) {
      systemPrompt = this.cachedSystemPrompt
    } else {
      systemPrompt = buildSystemPrompt(connectedServices, this.agentProfilePath, settings, this.dataDir)
      this.cachedSystemPrompt = systemPrompt
      this.cachedPromptKey = promptKey
      console.log('[Agent] System prompt rebuilt (settings or services changed)')
    }


    // Model routing: Haiku for background tasks, user's power model for everything else
    const HAIKU = 'claude-haiku-4-5-20251001'
    const currentModel = context === 'heartbeat' ? HAIKU : settings.powerModel
    const maxTokens = context === 'heartbeat' ? 512 : 16000

    console.log(`[Agent] Starting ${context} on ${currentModel} (max_tokens: ${maxTokens})`)

    const lastUserMsg = this.conversationHistory.filter(m => m.role === 'user').at(-1)
    const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : ''

    // Tools array is 100% stable — external tools go through call_external_tool proxy.
    // This means tools never change between API calls, so the cache prefix stays warm.
    const isBackground = context === 'heartbeat'
    const contextTools = getInternalTools(context, this.activeSkillTools)
    const stableTools = [...contextTools]

    let finalText = ''
    let turn = 0
    let lastText = ''

    // Snapshot the history BEFORE tool loops begin.
    // During tool loops, new messages (tool_use + tool_result) are appended to this snapshot
    // instead of re-calling selectHistory(), which would shift the sliding window.
    // The cache breakpoint stays at a fixed position in the snapshot — the "book" stays frozen.
    const baseMessages = this.compactToolResults(this.sanitizeHistory(this.selectHistory(userText)))
    const cacheBreakpointIdx = baseMessages.length >= 2 ? baseMessages.length - 2 : -1
    // Tool loop messages accumulate here — appended AFTER the breakpoint
    const loopMessages: Anthropic.MessageParam[] = []

    // Dedup search_tools calls within this turn — same query+schema returns cached result
    const searchCache = new Map<string, { matches: Anthropic.Tool[]; schemas: { tool: string; params: string[]; score: number }[] }>()

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
          const steerAssistant: Anthropic.MessageParam = { role: 'assistant', content: lastText }
          this.conversationHistory.push(steerAssistant)
          loopMessages.push(steerAssistant)
        }
        const steerUser: Anthropic.MessageParam = { role: 'user', content: `[User changed direction]: ${combined}` }
        this.conversationHistory.push(steerUser)
        loopMessages.push(steerUser)
        console.log(`[Agent] Steering injected: "${combined.slice(0, 80)}"`)
        onChunk?.(`\n\n_Redirecting: ${combined}_\n\n`)
        lastText = ''
      }

      let response: Anthropic.Message
      let retryDelay = 60000

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
            tools: stableTools as any,
            messages: this.addMessageCacheBreakpoint(
              [...baseMessages, ...loopMessages],
              isBackground,
              cacheBreakpointIdx >= 0 ? cacheBreakpointIdx : undefined
            ) as any,
            // Note: cache_control goes on content blocks (system, tools), not request body
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
          const cacheParts: string[] = []
          if (cacheHit > 0) cacheParts.push(`${cacheHit} cached`)
          if (cacheWrite > 0) cacheParts.push(`${cacheWrite} cache write`)
          const cacheInfo = cacheParts.length > 0 ? ` (${cacheParts.join(', ')})` : ''
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
      loopMessages.push({ role: 'assistant', content: response.content })

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
            if (block.name === 'call_external_tool') {
              const extName = ((block.input as any).tool_name as string) || 'external tool'
              onToolCall(extName, humanizeToolName(extName))
            } else {
              const inputAction = (block.input as Record<string, unknown>).action as string | undefined
              const label = (inputAction && ACTION_LABELS[block.name]?.[inputAction])
                ?? TOOL_LABELS[block.name]
                ?? humanizeToolName(block.name)
              onToolCall(block.name, label)
            }
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
            const input = block.input as { query: string; context?: string; schema?: string }
            const query = input.query
            const schemaQuery = input.schema || query

            // ONE embed call → tool search + schema search + max ranking (deduped within turn)
            const searchKey = `${query}|${schemaQuery}`
            let searchResult = searchCache.get(searchKey)
            if (!searchResult) {
              searchResult = await searchToolsAndSchema(query, schemaQuery, searchableTools)
              searchCache.set(searchKey, searchResult)
            } else {
              console.log(`[Agent] search_tools cache hit for "${query}"`)
            }
            const { matches, schemas } = searchResult

            if (matches.length === 0) {
              result = `No tools found matching "${query}". Available services: ${connectedServices.join(', ')}`
            } else {
              // No dynamic tool injection — external tools go through call_external_tool proxy.
              // The tools array stays stable so the cache prefix is never busted.
              result = `Found ${matches.length} tools for "${query}" — use call_external_tool(tool_name, parameters) to call:\n` +
                matches.map(t => `- ${t.name}: ${t.description ?? ''}`).join('\n')

              // Append filtered schemas from the combined search
              if (schemas.length > 0) {
                const matchMap = new Map(matches.map(t => [t.name, t]))
                for (const { tool: toolName, params: paramNames } of schemas) {
                  const tool = matchMap.get(toolName)
                  if (tool) {
                    result += formatSchemaForResult(tool, paramNames.length > 0 ? paramNames : undefined)
                    console.log(`[Agent] Schema for ${toolName}: ${paramNames.length} filtered params`)
                  }
                }
              } else if (matches.length > 0) {
                // Fallback: show required params only (full schema is too large for context)
                const topTool = matches[0]
                const schema = topTool.input_schema as any
                const reqParams = schema?.required as string[] | undefined
                if (reqParams && reqParams.length > 0) {
                  result += formatSchemaForResult(topTool, reqParams)
                  console.log(`[Agent] Schema fallback for ${topTool.name}: required params only (${reqParams.length})`)
                } else {
                  result += formatSchemaForResult(topTool)
                  console.log(`[Agent] Schema fallback for ${topTool.name}: full schema (no embedding match)`)
                }
              }
            }

            // Look up context (tool logs + memory) — parallel with no extra embed call
            if (input.context) {
              const [logResults, memoryResult] = await Promise.all([
                searchToolLogs(this.dataDir, input.context),
                this.mcpManager.callTool('memory', 'search_memory', { query: input.context, topK: 3 }).catch(() => '')
              ])
              const hasLogs = logResults && logResults.length > 0
              const hasMem = memoryResult && memoryResult.trim()
              if (hasLogs || hasMem) {
                result += `\n\nContext for "${input.context}":`
                if (hasLogs) result += '\n' + logResults.map(l => `- ${l}`).join('\n')
                if (hasMem) result += '\n' + memoryResult
              } else {
                result += `\n\nNo context found for "${input.context}".`
              }
              console.log(`[Agent] Context: ${hasLogs ? logResults!.length + ' logs' : 'no logs'}, ${hasMem ? 'memory found' : 'no memory'}`)
            }

            console.log(`[Agent] search_tools("${query}"${input.context ? `, context: "${input.context}"` : ''}) → ${matches.map(t => t.name).join(', ')}`)

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

          } else if (block.name === 'schedule') {
            const input = block.input as Record<string, any>
            const action = input.action as string

            if (action === 'create') {
              const entry = this.calendar.create({
                type: input.type || 'task',
                label: input.label || 'Untitled',
                cron: input.cron,
                due: input.due,
                instruction: input.instruction,
                notes: input.notes,
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
                  const timing = e.cron || e.due || 'no time'
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
            } else if (input.action === 'execute') {
              const skill = await loadSkill(this.dataDir, input.name!)
              if (!skill) {
                result = `Skill @${input.name} not found. Use skills(action: 'list') to see available skills.`
              } else {
                // Activate any skill-gated tools for this skill
                if (skill.name === 'integration-builder') {
                  this.activeSkillTools.add('create_custom_integration')
                }
                result = `[Skill: ${skill.name}]\n${skill.instructions}\n[/Skill]\n\nFollow these instructions now.`
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

          } else if (block.name === 'call_external_tool') {
            const { tool_name: extToolName, parameters: extParams } = block.input as { tool_name: string; parameters: Record<string, unknown> }
            const serverName = serverMap.get(extToolName)
            if (!serverName) {
              result = `Tool "${extToolName}" not found. Call search_tools first to discover available tools.`
            } else {
              // Resolve CoAgent file IDs → upload to Composio S3 for email attachments
              const toolInput = { ...extParams }

              // Extract coagent_file_ids robustly — the model puts them in various places/formats
              let fileIds: string[] = []
              const extractIds = (val: unknown): string[] => {
                if (Array.isArray(val)) return val.filter(v => typeof v === 'string')
                if (typeof val === 'string') {
                  try { const parsed = JSON.parse(val); if (Array.isArray(parsed)) return parsed.filter((v: any) => typeof v === 'string') } catch {}
                  if (val.match(/^[0-9a-f-]{36}$/i)) return [val]
                }
                if (val && typeof val === 'object') {
                  const obj = val as Record<string, unknown>
                  if (obj.coagent_file_ids) return extractIds(obj.coagent_file_ids)
                }
                return []
              }
              // Check top-level
              if (toolInput.coagent_file_ids) {
                fileIds = extractIds(toolInput.coagent_file_ids)
                delete toolInput.coagent_file_ids
              }
              // Check inside attachment (model sometimes nests it there)
              if (fileIds.length === 0 && toolInput.attachment) {
                const fromAttach = extractIds(toolInput.attachment)
                if (fromAttach.length > 0) {
                  fileIds = fromAttach
                  delete toolInput.attachment
                }
              }
              if (fileIds.length > 0) {
                try {
                  const toolkitSlug = extractIntegration(serverName, extToolName)
                  const files = await Promise.all(
                    fileIds.map((id: string) => readFileBase64(this.dataDir, id))
                  )
                  const uploaded = await Promise.all(
                    files.map((f: { base64: string; filename: string; mimeType: string }) => uploadToComposioS3(
                      Buffer.from(f.base64, 'base64'), f.filename, f.mimeType, extToolName, toolkitSlug
                    ))
                  )
                  const isDraft = extToolName.toUpperCase().includes('DRAFT')
                  if (isDraft) {
                    toolInput.attachments = uploaded
                  } else {
                    toolInput.attachment = uploaded[0]
                    if (uploaded.length > 1) {
                      const extraNames = uploaded.slice(1).map((a: { name: string }) => a.name).join(', ')
                      const body = (toolInput.body as string) || ''
                      toolInput.body = body + `\n\n[Note: Additional file(s) (${extraNames}) could not be attached — only one attachment per direct send. Use create-draft for multiple.]`
                    }
                  }
                  console.log(`[Agent] Uploaded ${uploaded.length} attachment(s): ${uploaded.map((a: { name: string }) => a.name).join(', ')}`)
                } catch (err: any) {
                  console.error(`[Agent] Failed to upload file attachment:`, err.message)
                  const body = (toolInput.body as string) || ''
                  toolInput.body = body + `\n\n[Note: File attachment could not be included due to an upload error.]`
                }
              }
              {
                const raw = await this.mcpManager.callTool(serverName, extToolName, toolInput)
                const MAX_TOOL_RESULT = 4000
                result = raw.length > MAX_TOOL_RESULT
                  ? raw.slice(0, MAX_TOOL_RESULT) + `\n\n[Truncated: ${raw.length - MAX_TOOL_RESULT} chars omitted from history to save context]`
                  : raw
                logToolCall(this.dataDir, serverName, extToolName, toolInput, result)
              }
            }

          } else if (block.name === 'create_custom_integration') {
            const input = block.input as {
              action: string
              name: string
              display_name?: string
              description?: string
              capabilities?: { name: string; description: string }[]
              auth_fields?: { name: string; display_name: string; description: string }[]
              code?: string
              dependencies?: Record<string, string>
              icon?: string
            }
            if (this.onCustomIntegration) {
              result = await this.onCustomIntegration(input.action, input)
            } else {
              result = 'Custom integration handler not configured.'
            }

          } else {
            result = `Unknown tool "${block.name}". For external integrations, use search_tools then call_external_tool.`
          }

          ;(toolResults.content as Anthropic.ToolResultBlockParam[]).push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result
          })
        }

        this.conversationHistory.push(toolResults)
        loopMessages.push(toolResults)

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
      const events = (trigger.payload as any)?.events as { trigger: string; event: Record<string, unknown>; receivedAt: string }[] | undefined
      const eventsSection = events && events.length > 0
        ? `\n\nNew events since last heartbeat (${events.length}):\n${events.map(e => `- [${e.receivedAt}] ${e.trigger}: ${JSON.stringify(e.event)}`).join('\n')}`
        : ''
      const missedSection = this.missedEvents.length > 0
        ? `\n\nMissed events (agent was busy):\n${this.missedEvents.map(e => `- [${e.time}] ${e.source}: ${JSON.stringify(e.payload)}`).join('\n')}`
        : ''
      if (this.missedEvents.length > 0) this.missedEvents = []
      return `[Heartbeat — ${time}]${eventsSection}${missedSection}\n\n1. Read heartbeat.md from memory — it contains custom user instructions for how to handle heartbeats.\n2. Search memory for context on these events (contacts, preferences, projects).\n3. Use search_tools if you need to look up tool capabilities.\n\nThen write a brief actionable summary:\n- What happened and who it involves\n- What action is recommended (with enough detail for another model to execute)\n- If nothing needs attention, reply exactly "All clear."`
    }
    if (trigger.source === 'todo_due' || trigger.source === 'task_due') {
      const payload = trigger.payload as any
      const task = payload?.task ?? payload?.label ?? 'Unknown task'
      const todoId = payload?.todoId ?? payload?.id ?? ''
      const context = payload?.context ?? payload?.instruction ?? ''
      const contextSection = context ? `\n\nContext notes:\n${context}` : ''
      return `[Scheduled task — ${time}] A task is now due. Execute it.\n\nTask: ${task}\nTask ID: ${todoId}${contextSection}\n\n1. Read agent.md and any relevant memory for additional context.\n2. Carry out the task using the correct tools.\n3. When done, mark it complete with the schedule tool (action: complete).\n4. Add a done item describing what you did.\n\nDo not do anything outside the scope of this task.`
    }
    if (trigger.source === 'webhook') return `[Webhook — ${time}] Event received: ${JSON.stringify(trigger.payload)}. Search memory and handle it.`
    return `[Manual — ${time}] ${trigger.payload?.message ?? ''}`
  }



  /** Select history: recent messages + any pinned task message. Memory tools handle long-term context. */
  private selectHistory(_currentQuery: string): Anthropic.MessageParam[] {
    const recent = this.conversationHistory.slice(-RECENT_KEEP)

    // If a scheduled task is pinned and it fell outside the recent window, prepend it
    if (this.pinnedTaskIdx !== null) {
      const windowStart = this.conversationHistory.length - RECENT_KEEP
      if (this.pinnedTaskIdx < windowStart) {
        return [this.conversationHistory[this.pinnedTaskIdx], ...recent]
      }
    }

    return recent
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
  /**
   * Place a cache breakpoint on the second-to-last message so all prior history
   * is cached. Each turn, the cache grows to include the previous turn's messages —
   * only the newest user message is sent as fresh (non-cached) input.
   */
  private addMessageCacheBreakpoint(
    messages: Anthropic.MessageParam[],
    isBackground: boolean,
    fixedIdx?: number
  ): Anthropic.MessageParam[] {
    if (isBackground || messages.length < 2) return messages

    const result = [...messages]
    // Use fixed index if provided (stable breakpoint during tool loops),
    // otherwise default to second-to-last message
    const idx = fixedIdx !== undefined
      ? Math.min(fixedIdx, result.length - 2)
      : result.length - 2

    if (idx < 0) return result

    const msg = result[idx]
    if (typeof msg.content === 'string') {
      result[idx] = {
        ...msg,
        content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral', ttl: '1h' } } as any]
      }
    } else if (Array.isArray(msg.content) && msg.content.length > 0) {
      const blocks = [...msg.content as any[]]
      const last = blocks.length - 1
      blocks[last] = { ...blocks[last], cache_control: { type: 'ephemeral', ttl: '1h' } }
      result[idx] = { ...msg, content: blocks }
    }

    return result
  }

  private compactToolResults(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    if (messages.length <= 4) return messages

    // Find the last TWO user messages that contain plain text (not just tool_results).
    // Keep 2-turn window so users can ask follow-ups about previous results.
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

    const TRUNCATE_AT = 200
    let compactedCount = 0
    let savedChars = 0

    // Build set of tool_use_ids that belong to search_tools — their results contain
    // schemas that the agent needs to reference and must NOT be truncated.
    const schemaToolUseIds = new Set<string>()
    for (let i = 0; i < compactBefore; i++) {
      const msg = messages[i]
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
      for (const block of msg.content as any[]) {
        if (block.type === 'tool_use' && block.name === 'search_tools') {
          schemaToolUseIds.add(block.id)
        }
      }
    }

    const result = messages.map((msg, idx) => {
      if (idx >= compactBefore) return msg
      if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg

      const hasToolResult = (msg.content as any[]).some(b => b.type === 'tool_result')
      if (!hasToolResult) return msg

      const compacted = (msg.content as any[]).map(block => {
        if (block.type !== 'tool_result') return block
        // Never truncate search_tools results — they contain parameter schemas
        if (schemaToolUseIds.has(block.tool_use_id)) return block
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
    this.activeSkillTools.clear()
    this.saveHistory().catch(console.error)
  }
}
