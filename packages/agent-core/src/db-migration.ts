import { readFileSync, renameSync, existsSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import type { CoAgentDB } from './db.js'

// ── Minimal Zod schemas ───────────────────────────────────────────────────────
//
// PR 1 is a transport swap — data shapes are preserved exactly as they exist
// on disk. We validate only the TOP-LEVEL container type (array vs object)
// because real user data has drifted from the strict shapes declared in code
// (missing fields, extra types, mixed metadata value types, etc.). Migration
// must accept whatever the app has been writing; schema enforcement belongs
// in a later normalization pass, not here.

const ArraySchema = z.array(z.unknown())

const SchedulerEventIdsSchema = z.object({
  briefed: z.array(z.string()),
  recapped: z.array(z.string()),
}).passthrough()

const ConversationSchema = ArraySchema
const QueueSchema = ArraySchema
const DoneSchema = ArraySchema
const FileIndexSchema = ArraySchema
const FolderOrderSchema = ArraySchema
const StringArraySchema = z.array(z.string())

// ── File descriptors ──────────────────────────────────────────────────────────

interface StoreDescriptor {
  key: string
  filename: string
  read: (raw: unknown) => void
}

function buildDescriptors(db: CoAgentDB): StoreDescriptor[] {
  return [
    {
      key: 'conversation',
      filename: 'conversation.json',
      read: (raw) => {
        const msgs = ConversationSchema.parse(raw)
        db.setConversation(msgs as any)
      },
    },
    {
      key: 'team_conversation',
      filename: 'team-history.json',
      read: (raw) => {
        const msgs = ConversationSchema.parse(raw)
        db.setTeamConversation(msgs as any)
      },
    },
    {
      key: 'queue',
      filename: 'queue.json',
      read: (raw) => {
        const items = QueueSchema.parse(raw)
        db.setQueue(items as any)
      },
    },
    {
      key: 'done',
      filename: 'done.json',
      read: (raw) => {
        const items = DoneSchema.parse(raw)
        db.setDone(items as any)
      },
    },
    {
      key: 'file_index',
      filename: 'file-index.json',
      read: (raw) => {
        const entries = FileIndexSchema.parse(raw)
        db.setFileIndex(entries as any)
      },
    },
    {
      key: 'folder_order',
      filename: 'folder-order.json',
      read: (raw) => {
        const order = FolderOrderSchema.parse(raw)
        db.setFolderOrder(order as any)
      },
    },
    {
      key: 'scheduler_event_ids',
      filename: 'scheduler-event-ids.json',
      read: (raw) => {
        const ids = SchedulerEventIdsSchema.parse(raw)
        db.setSchedulerEventIds(ids)
      },
    },
    {
      key: 'connected_integrations',
      filename: 'connected-integrations.json',
      read: (raw) => {
        const slugs = StringArraySchema.parse(raw)
        db.setConnectedIntegrations(slugs)
      },
    },
    {
      key: 'composio_triggers',
      filename: 'triggers.json',
      read: (raw) => {
        const slugs = StringArraySchema.parse(raw)
        db.setComposioTriggers(slugs)
      },
    },
  ]
}

// ── Result types ──────────────────────────────────────────────────────────────

export type MigrateResult =
  | { ok: true; migrated: string[]; skipped: string[] }
  | { ok: false; error: unknown }

// ── migrateFromJson ───────────────────────────────────────────────────────────

/**
 * One-shot, idempotent migration from legacy JSON files into kv_store.
 *
 * Rules:
 * - If a key is already present in kv_store → skip it (return in `skipped`).
 * - For each JSON that exists on disk, parse it (minimal Zod validation), write
 *   to DB — all inside a single transaction (all-or-nothing).
 * - After the transaction commits, rename each source JSON to
 *   `<name>.pre-sqlite.bak` using renameSync. Never deletes.
 * - On any error: transaction rolled back, JSON files untouched.
 */
export function migrateFromJson(dataDir: string, db: CoAgentDB): MigrateResult {
  const descriptors = buildDescriptors(db)
  const migrated: string[] = []
  const skipped: string[] = []
  const toRename: Array<{ from: string; to: string }> = []

  try {
    // Collect which stores to migrate (outside transaction: read-only checks)
    const toMigrate: Array<{ descriptor: StoreDescriptor; raw: unknown }> = []

    for (const descriptor of descriptors) {
      if (db.hasKey(descriptor.key)) {
        skipped.push(descriptor.key)
        continue
      }

      const filePath = join(dataDir, descriptor.filename)
      if (!existsSync(filePath)) {
        // File absent — nothing to migrate for this key
        continue
      }

      // Parse JSON (may throw on corrupt input — will abort entire migration)
      const content = readFileSync(filePath, 'utf-8')
      const raw = JSON.parse(content) // throws SyntaxError on corrupt JSON

      toMigrate.push({ descriptor, raw })
      toRename.push({
        from: filePath,
        to: filePath + '.pre-sqlite.bak',
      })
    }

    // Write all stores in a single transaction — all or nothing
    db.transaction(() => {
      for (const { descriptor, raw } of toMigrate) {
        descriptor.read(raw) // validates with Zod and calls db.set*()
        migrated.push(descriptor.key)
      }
    })

    // Transaction committed — now rename legacy files (non-transactional but
    // safe: even if a rename fails partway, the DB data is already durable and
    // the idempotency check will skip already-present keys on a re-run).
    for (const { from, to } of toRename) {
      renameSync(from, to)
    }

    return { ok: true, migrated, skipped }
  } catch (error) {
    console.error('[db-migration] Migration failed — transaction rolled back, JSON files untouched:', error)
    return { ok: false, error }
  }
}
