import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import WebSocket from 'ws'

const EVENT_STORE_FILE = 'event-store.json'
// Read at call time so dotenv has a chance to load first
const getVoyageKey = () => process.env.VOYAGE_API_KEY ?? ''
const EVENT_TTL_MS = 60 * 60 * 1000 // 1h

// ── Pre-processor constants ──────────────────────────────────────────────────

const TRIGGER_DENY_PATTERNS = [
  '_READ', '_VIEWED', '_OPENED', '_SYNC', '_DELETED',
  '_MODIFIED', '_BOUNCED', '_UNSUBSCRIBED'
]

const SYSTEM_SENDER_PATTERNS = [
  'no-reply', 'noreply', 'donotreply', 'do-not-reply',
  'notifications@', 'notification@', 'automated@',
  'bot@', 'digest@', 'mailer@', 'bounce@', 'support+auto'
]

// Gmail labels that indicate non-Primary inbox tabs
const GMAIL_NON_PRIMARY_CATEGORIES = [
  'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'
]

const CONTENT_FIELDS = [
  'subject', 'message', 'snippet', 'description',
  'title', 'body', 'content', 'text', 'note', 'summary'
]

const KEEP_FIELDS = [
  'trigger_name', 'from', 'sender', 'organizer', 'user', 'username',
  'name', 'email', 'subject', 'snippet', 'title', 'description',
  'text', 'body', 'note', 'source', 'stage', 'dealName', 'topic', 'contact'
]

// ── Store types ──────────────────────────────────────────────────────────────

interface StoreEntry {
  id: string
  receivedAt: string
  trigger: string
  event: Record<string, unknown>
  embedding: number[]
  retrieved: boolean
  done: boolean
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function embedText(text: string): Promise<number[]> {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getVoyageKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: [text], model: 'voyage-3-lite' })
  })
  const data = await res.json() as { data: { embedding: number[] }[] }
  return data.data[0].embedding
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function getSender(payload: Record<string, unknown>): string {
  return ((payload.from ?? payload.sender ?? payload.email ?? payload.organizer ?? '') as string).toLowerCase()
}

function hasHumanContent(obj: unknown, depth = 0): boolean {
  if (depth > 3 || typeof obj !== 'object' || obj === null) return false
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (CONTENT_FIELDS.includes(key.toLowerCase())) {
      if (typeof val === 'string' && val.trim().length > 5) return true
    }
    if (typeof val === 'object' && hasHumanContent(val, depth + 1)) return true
  }
  return false
}

function shouldKeepEvent(trigger: string, payload: Record<string, unknown>): boolean {
  if (TRIGGER_DENY_PATTERNS.some(p => trigger.toUpperCase().includes(p))) return false
  if (payload.bot_id) return false
  const sender = getSender(payload)
  if (sender && SYSTEM_SENDER_PATTERNS.some(p => sender.includes(p))) return false
  if (!hasHumanContent(payload)) return false

  // Gmail: only keep emails in the Primary tab (filter out Promotions, Social, Updates, Forums)
  if (trigger.includes('GMAIL')) {
    const labelIds = (payload.label_ids ?? payload.labelIds) as string[] | undefined
    if (Array.isArray(labelIds) && GMAIL_NON_PRIMARY_CATEGORIES.some(cat => labelIds.includes(cat))) {
      return false
    }
  }

  // Outlook: only keep emails from the Inbox folder (not Junk, Newsletters, etc.)
  if (trigger.includes('OUTLOOK')) {
    const folder = ((payload.folder_name ?? payload.parentFolderName ?? '') as string).toLowerCase()
    if (folder && folder !== 'inbox') return false
  }

  return true
}

function trimEvent(trigger: string, payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { trigger_name: trigger }
  for (const field of KEEP_FIELDS) {
    if (field === 'trigger_name') continue
    if (payload[field] != null) {
      const val = payload[field]
      out[field] = typeof val === 'string' && val.length > 200 ? val.slice(0, 200) : val
    }
  }
  return out
}

function eventToText(trigger: string, payload: Record<string, unknown>): string {
  return [
    trigger,
    payload.from && ('from:' + payload.from),
    payload.subject,
    payload.snippet,
    payload.title,
    typeof payload.description === 'string' ? payload.description.slice(0, 100) : undefined,
    typeof payload.text === 'string' ? payload.text.slice(0, 100) : undefined,
    payload.name,
    payload.body && typeof payload.body === 'string' ? payload.body.slice(0, 100) : undefined
  ].filter(Boolean).join(' | ')
}

// ── Store I/O ────────────────────────────────────────────────────────────────

async function readStore(dataDir: string): Promise<StoreEntry[]> {
  const path = join(dataDir, EVENT_STORE_FILE)
  if (!existsSync(path)) return []
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

async function writeStore(dataDir: string, entries: StoreEntry[]): Promise<void> {
  await mkdir(dataDir, { recursive: true }).catch(() => {})
  await writeFile(join(dataDir, EVENT_STORE_FILE), JSON.stringify(entries, null, 2), 'utf-8')
}

// ── Event store public API ───────────────────────────────────────────────────

async function appendToEventStore(dataDir: string, trigger: string, payload: Record<string, unknown>): Promise<void> {
  if (!shouldKeepEvent(trigger, payload)) {
    console.log(`[EventStore] Dropped (noise): ${trigger}`)
    return
  }
  if (!getVoyageKey()) {
    console.warn('[EventStore] getVoyageKey() not set — event not stored')
    return
  }

  const text = eventToText(trigger, payload)
  const embedding = await embedText(text)

  const entries = await readStore(dataDir)
  // Expire events older than 24h
  const cutoff = Date.now() - EVENT_TTL_MS
  const fresh = entries.filter(e => new Date(e.receivedAt).getTime() > cutoff)

  fresh.push({
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    trigger,
    event: trimEvent(trigger, payload),
    embedding,
    retrieved: false,
    done: false
  })
  await writeStore(dataDir, fresh)
  console.log(`[EventStore] Stored: ${trigger} "${text.slice(0, 60)}"`)
}

export async function searchEventStore(
  dataDir: string,
  query: string,
  limit = 5
): Promise<{ id: string; trigger: string; event: Record<string, unknown>; receivedAt: string; score: number }[]> {
  if (!getVoyageKey()) return []
  const queryEmb = await embedText(query)
  const entries = await readStore(dataDir)

  const active = entries.filter(e => !e.done)
  const scored = active.map(e => ({ ...e, score: cosine(queryEmb, e.embedding) }))
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, limit)

  // Mark returned events as retrieved
  const topIds = new Set(top.map(e => e.id))
  const updated = entries.map(e => topIds.has(e.id) ? { ...e, retrieved: true } : e)
  await writeStore(dataDir, updated)

  return top.map(e => ({ id: e.id, trigger: e.trigger, event: e.event, receivedAt: e.receivedAt, score: e.score }))
}

export async function markEventsDone(dataDir: string, ids: string[]): Promise<void> {
  const entries = await readStore(dataDir)
  const idSet = new Set(ids)
  await writeStore(dataDir, entries.map(e => idSet.has(e.id) ? { ...e, done: true } : e))
}

export async function hasUnreadEvents(dataDir: string): Promise<boolean> {
  const entries = await readStore(dataDir)
  const cutoff = Date.now() - EVENT_TTL_MS
  return entries.some(e => !e.done && !e.retrieved && new Date(e.receivedAt).getTime() > cutoff)
}

export async function purgeEventStore(dataDir: string): Promise<void> {
  const entries = await readStore(dataDir)
  const cutoff = Date.now() - EVENT_TTL_MS
  const kept = entries.filter(e => !e.done && new Date(e.receivedAt).getTime() > cutoff)
  await writeStore(dataDir, kept)
  const dropped = entries.length - kept.length
  if (dropped > 0) console.log(`[EventStore] Purged ${dropped} done/expired event(s)`)
}

// ── RelayClient ──────────────────────────────────────────────────────────────
// Acts as a transparent proxy: pipes messages between the Cloudflare relay
// and the local WS server (localhost:PORT) so remote clients (phone) get
// full agent functionality without any special handling.

const MIN_BACKOFF_MS = 2_000
const MAX_BACKOFF_MS = 30_000
const LOCAL_PORT = parseInt(process.env.COAGENT_PORT ?? '7830')

export class RelayClient {
  private dataDir: string
  private relayUrl: string | null
  private relayWs: WebSocket | null = null
  private localWs: WebSocket | null = null
  private backoffMs = MIN_BACKOFF_MS
  private stopped = false

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.relayUrl = this.buildRelayUrl()
  }

  private buildRelayUrl(): string | null {
    const base = process.env.RELAY_URL
    if (!base) return null
    const userId = process.env.RELAY_USER_ID ?? ''
    const token = process.env.RELAY_TOKEN ?? ''
    let url = `${base.replace(/\/$/, '')}/agent/${userId}`
    if (token) url += `?token=${encodeURIComponent(token)}`
    return url
  }

  connect(): void {
    if (!this.relayUrl) return
    this.stopped = false
    this.openRelayConnection()
  }

  stop(): void {
    this.stopped = true
    this.relayWs?.terminate()
    this.localWs?.terminate()
    this.relayWs = null
    this.localWs = null
  }

  private openRelayConnection(): void {
    if (this.stopped || !this.relayUrl) return
    console.log(`[Relay] Connecting to ${this.relayUrl.replace(/token=[^&]+/, 'token=***')}`)

    const ws = new WebSocket(this.relayUrl)
    this.relayWs = ws

    ws.on('open', () => {
      console.log('[Relay] Connected')
      this.backoffMs = MIN_BACKOFF_MS
      this.openLocalConnection()
    })

    ws.on('message', (raw) => {
      const str = raw.toString()
      // Webhook payloads go to the event store, everything else → local agent
      try {
        const msg = JSON.parse(str)
        if (msg?.type === 'webhook') {
          const payload = msg.payload as Record<string, unknown>
          // Composio v3 structure: { metadata: { trigger_slug }, data: { sender, subject, message_text, ... } }
          const meta = payload?.metadata as Record<string, unknown> | undefined
          const data = payload?.data as Record<string, unknown> | undefined
          const preview = data?.preview as Record<string, unknown> | undefined
          const trigger = (meta?.trigger_slug ?? payload?.trigger_name ?? 'UNKNOWN') as string
          const event: Record<string, unknown> = {
            trigger_name: trigger,
            from: data?.sender,
            subject: data?.subject ?? preview?.subject,
            text: typeof data?.message_text === 'string' ? data.message_text.slice(0, 500) : undefined,
            snippet: typeof preview?.body === 'string' ? preview.body.slice(0, 200) : undefined,
            to: data?.to,
            thread_id: data?.thread_id,
            label_ids: data?.label_ids ?? (data as any)?.labelIds,
          }
          appendToEventStore(this.dataDir, trigger, event).catch((err) =>
            console.error('[Relay] Failed to store event:', err.message)
          )
          return
        }
      } catch { /* non-JSON — pass through */ }

      // Forward to local WS server for processing
      if (this.localWs?.readyState === WebSocket.OPEN) {
        this.localWs.send(str)
      }
    })

    ws.on('close', () => {
      if (this.stopped) return
      console.log('[Relay] Disconnected')
      this.localWs?.terminate()
      this.localWs = null
      this.scheduleReconnect()
    })

    ws.on('error', (err) => console.error(`[Relay] Error: ${err.message}`))
  }

  private openLocalConnection(): void {
    const ws = new WebSocket(`ws://localhost:${LOCAL_PORT}`)
    this.localWs = ws

    ws.on('message', (raw) => {
      // Forward agent responses back to the relay (→ phone)
      if (this.relayWs?.readyState === WebSocket.OPEN) {
        this.relayWs.send(raw.toString())
      }
    })

    ws.on('error', (err) => console.error(`[Relay] Local WS error: ${err.message}`))
    ws.on('close', () => {
      if (!this.stopped) console.log('[Relay] Local WS disconnected')
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const delay = this.backoffMs
    console.log(`[Relay] Reconnecting in ${Math.round(delay / 1000)}s`)
    setTimeout(() => {
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
      this.openRelayConnection()
    }, delay)
  }
}
