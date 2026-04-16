import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { join } from 'path'
import type { ApprovalItem, DoneItem } from '@coagent/shared'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FileIndexEntry {
  id: string
  type: 'upload' | 'block_document'
  filename: string
  path: string
  addedAt: string
  lastAccessed: string
  summary: string
  group: string
  sizeBytes: number
  embedding: number[]
  transcript?: string
  canvasId?: string
  dirty?: boolean
}

export interface SchedulerEventIds {
  briefed: string[]
  recapped: string[]
  /**
   * Optional map of event id → ISO timestamp of when it was first briefed/recapped.
   * Used by the scheduler to TTL-prune entries. Optional for backward compat with
   * on-disk files written before this field existed.
   */
  seenAt?: Record<string, string>
}

// Conversation messages follow Anthropic.MessageParam shape: content can be a
// string or an array of content blocks. We keep it as unknown so we don't pull
// in the SDK type here — callers cast as needed.
export type ConversationMessage = {
  role: 'user' | 'assistant'
  content: unknown
  _docs?: Array<{ id: string; title: string }>
}

// ── Store keys ────────────────────────────────────────────────────────────────

const KEYS = {
  conversation: 'conversation',
  teamConversation: 'team_conversation',
  queue: 'queue',
  done: 'done',
  fileIndex: 'file_index',
  folderOrder: 'folder_order',
  schedulerEventIds: 'scheduler_event_ids',
  connectedIntegrations: 'connected_integrations',
  composioTriggers: 'composio_triggers',
} as const

// ── Migrations ────────────────────────────────────────────────────────────────

const MIGRATIONS: Array<(db: Database.Database) => void> = [
  // v1: baseline schema — kv_store for all persisted state (blob-per-store approach)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  },
]

const TARGET_VERSION = MIGRATIONS.length // 1

// ── CoAgentDB ─────────────────────────────────────────────────────────────────

export class CoAgentDB {
  private db: Database.Database

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    const dbPath = join(dataDir, 'coagent.db')
    this.db = new Database(dbPath)

    this.db.pragma('journal_mode=WAL')
    this.db.pragma('synchronous=NORMAL')
    this.db.pragma('foreign_keys=ON')

    this.runMigrations()
  }

  private runMigrations(): void {
    // Use SQLite's built-in user_version pragma to track schema version.
    // This is readable even on a completely empty DB (no table required).
    const currentVersion = (this.db.pragma('user_version', { simple: true }) as number) ?? 0

    if (currentVersion >= TARGET_VERSION) return

    for (let i = currentVersion; i < TARGET_VERSION; i++) {
      const applyMigration = this.db.transaction(() => {
        MIGRATIONS[i](this.db)
        this.db.pragma(`user_version=${i + 1}`)
      })
      applyMigration()
    }
  }

  getSchemaVersion(): number {
    return (this.db.pragma('user_version', { simple: true }) as number) ?? 0
  }

  // ── Private KV helpers ───────────────────────────────────────────────────

  private get<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare<[string], { value: string }>('SELECT value FROM kv_store WHERE key = ?')
      .get(key)
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  }

  private set(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
      )
      .run(key, JSON.stringify(value), Date.now())
  }

  /** Returns true if the given key already has a row in kv_store. */
  hasKey(key: string): boolean {
    const row = this.db
      .prepare<[string], { key: string }>('SELECT key FROM kv_store WHERE key = ?')
      .get(key)
    return row !== undefined
  }

  /**
   * Expose the underlying transaction wrapper for use by migrateFromJson.
   * The callback must be synchronous (better-sqlite3 transactions are sync-only).
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  // ── Domain methods ───────────────────────────────────────────────────────

  getConversation(): ConversationMessage[] {
    return this.get<ConversationMessage[]>(KEYS.conversation, [])
  }

  setConversation(msgs: ConversationMessage[]): void {
    this.set(KEYS.conversation, msgs)
  }

  getTeamConversation(): ConversationMessage[] {
    return this.get<ConversationMessage[]>(KEYS.teamConversation, [])
  }

  setTeamConversation(msgs: ConversationMessage[]): void {
    this.set(KEYS.teamConversation, msgs)
  }

  getQueue(): ApprovalItem[] {
    return this.get<ApprovalItem[]>(KEYS.queue, [])
  }

  setQueue(items: ApprovalItem[]): void {
    this.set(KEYS.queue, items)
  }

  getDone(): DoneItem[] {
    return this.get<DoneItem[]>(KEYS.done, [])
  }

  setDone(items: DoneItem[]): void {
    this.set(KEYS.done, items)
  }

  getFileIndex(): FileIndexEntry[] {
    return this.get<FileIndexEntry[]>(KEYS.fileIndex, [])
  }

  setFileIndex(entries: FileIndexEntry[]): void {
    this.set(KEYS.fileIndex, entries)
  }

  getFolderOrder(): string[] {
    return this.get<string[]>(KEYS.folderOrder, [])
  }

  setFolderOrder(order: string[]): void {
    this.set(KEYS.folderOrder, order)
  }

  getSchedulerEventIds(): SchedulerEventIds {
    return this.get<SchedulerEventIds>(KEYS.schedulerEventIds, { briefed: [], recapped: [] })
  }

  setSchedulerEventIds(ids: SchedulerEventIds): void {
    this.set(KEYS.schedulerEventIds, ids)
  }

  getConnectedIntegrations(): string[] {
    return this.get<string[]>(KEYS.connectedIntegrations, [])
  }

  setConnectedIntegrations(slugs: string[]): void {
    this.set(KEYS.connectedIntegrations, slugs)
  }

  getComposioTriggers(): string[] {
    return this.get<string[]>(KEYS.composioTriggers, [])
  }

  setComposioTriggers(slugs: string[]): void {
    this.set(KEYS.composioTriggers, slugs)
  }

  close(): void {
    this.db.close()
  }
}

// Re-export keys for use by migration
export { KEYS as DB_KEYS }
