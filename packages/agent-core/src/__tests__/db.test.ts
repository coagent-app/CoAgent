import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'coagent-db-test-'))
}

function cleanTmp(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

// ── imports (after tmp helpers so vi.mock hoisting is not needed) ─────────────

import { CoAgentDB } from '../db.js'
import { migrateFromJson } from '../db-migration.js'
import { isSqliteEnabled } from '../sqlite-flag.js'

// ── CoAgentDB round-trip tests ────────────────────────────────────────────────

describe('CoAgentDB — round-trips', () => {
  let tmpDir: string
  let db: CoAgentDB

  beforeEach(() => {
    tmpDir = makeTmp()
    db = new CoAgentDB(tmpDir)
  })

  afterEach(() => {
    db.close()
    cleanTmp(tmpDir)
  })

  it('conversation: write → read returns same value', () => {
    const msgs = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi there' },
    ]
    db.setConversation(msgs)
    expect(db.getConversation()).toEqual(msgs)
  })

  it('conversation: empty array on fresh DB', () => {
    expect(db.getConversation()).toEqual([])
  })

  it('teamConversation: write → read returns same value', () => {
    const msgs = [{ role: 'user' as const, content: 'team msg' }]
    db.setTeamConversation(msgs)
    expect(db.getTeamConversation()).toEqual(msgs)
  })

  it('queue: write → read returns same ApprovalItems', () => {
    const items = [
      {
        id: 'abc',
        type: 'task' as const,
        title: 'Do thing',
        description: 'desc',
        detail: '',
        notes: '',
        action: 'run',
        metadata: {},
        status: 'pending' as const,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]
    db.setQueue(items)
    expect(db.getQueue()).toEqual(items)
  })

  it('queue: empty array on fresh DB', () => {
    expect(db.getQueue()).toEqual([])
  })

  it('done: write → read returns same DoneItems', () => {
    const items = [
      { id: 'done-1', description: 'finished it', completedAt: '2026-01-02T00:00:00.000Z' },
    ]
    db.setDone(items)
    expect(db.getDone()).toEqual(items)
  })

  it('fileIndex: write → read round-trips including embedding arrays', () => {
    const entries = [
      {
        id: 'f1',
        type: 'upload' as const,
        filename: 'test.txt',
        path: '/tmp/test.txt',
        addedAt: '2026-01-01T00:00:00.000Z',
        lastAccessed: '2026-01-01T00:00:00.000Z',
        summary: 'A test file',
        group: '',
        sizeBytes: 42,
        embedding: [0.1, 0.2, 0.3],
      },
    ]
    db.setFileIndex(entries)
    expect(db.getFileIndex()).toEqual(entries)
  })

  it('folderOrder: write → read returns same array', () => {
    const order = ['Contracts', 'Reports', 'Misc']
    db.setFolderOrder(order)
    expect(db.getFolderOrder()).toEqual(order)
  })

  it('folderOrder: empty array on fresh DB', () => {
    expect(db.getFolderOrder()).toEqual([])
  })

  it('schedulerEventIds: write → read returns same shape', () => {
    const ids = { briefed: ['evt-1', 'evt-2'], recapped: ['evt-3'] }
    db.setSchedulerEventIds(ids)
    expect(db.getSchedulerEventIds()).toEqual(ids)
  })

  it('schedulerEventIds: default on fresh DB', () => {
    expect(db.getSchedulerEventIds()).toEqual({ briefed: [], recapped: [] })
  })

  it('connectedIntegrations: write → read returns slug array', () => {
    const slugs = ['gmail', 'slack', 'github']
    db.setConnectedIntegrations(slugs)
    expect(db.getConnectedIntegrations()).toEqual(slugs)
  })

  it('connectedIntegrations: empty array on fresh DB', () => {
    expect(db.getConnectedIntegrations()).toEqual([])
  })

  it('composioTriggers: write → read returns slug array', () => {
    const slugs = ['GMAIL_NEW_EMAIL', 'SLACK_MESSAGE']
    db.setComposioTriggers(slugs)
    expect(db.getComposioTriggers()).toEqual(slugs)
  })

  it('overwrite: second write replaces first', () => {
    db.setConversation([{ role: 'user', content: 'first' }])
    db.setConversation([{ role: 'user', content: 'second' }])
    expect(db.getConversation()).toEqual([{ role: 'user', content: 'second' }])
  })

  it('content blocks: nested array content round-trips', () => {
    const msgs = [
      {
        role: 'user' as const,
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
        ],
      },
    ]
    db.setConversation(msgs as any)
    expect(db.getConversation()).toEqual(msgs)
  })
})

// ── Schema version ────────────────────────────────────────────────────────────

describe('CoAgentDB — schema version', () => {
  let tmpDir: string
  let db: CoAgentDB

  beforeEach(() => {
    tmpDir = makeTmp()
    db = new CoAgentDB(tmpDir)
  })

  afterEach(() => {
    db.close()
    cleanTmp(tmpDir)
  })

  it('fresh DB has schema version 1', () => {
    expect(db.getSchemaVersion()).toBe(1)
  })
})

// ── Migration tests ───────────────────────────────────────────────────────────

describe('migrateFromJson — basic migration', () => {
  let tmpDir: string
  let db: CoAgentDB

  beforeEach(() => {
    tmpDir = makeTmp()
  })

  afterEach(() => {
    db?.close()
    cleanTmp(tmpDir)
  })

  it('migrates all present JSON files into kv_store', () => {
    writeFileSync(join(tmpDir, 'queue.json'), JSON.stringify([]))
    writeFileSync(join(tmpDir, 'done.json'), JSON.stringify([]))
    writeFileSync(join(tmpDir, 'conversation.json'), JSON.stringify([{ role: 'user', content: 'hi' }]))
    writeFileSync(join(tmpDir, 'scheduler-event-ids.json'), JSON.stringify({ briefed: ['a'], recapped: [] }))
    writeFileSync(join(tmpDir, 'connected-integrations.json'), JSON.stringify(['gmail']))
    writeFileSync(join(tmpDir, 'triggers.json'), JSON.stringify(['GMAIL_NEW_EMAIL']))

    db = new CoAgentDB(tmpDir)
    const result = migrateFromJson(tmpDir, db)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.migrated.length).toBeGreaterThan(0)

    // Values readable back via domain methods
    expect(db.getConversation()).toEqual([{ role: 'user', content: 'hi' }])
    expect(db.getConnectedIntegrations()).toEqual(['gmail'])
    expect(db.getSchedulerEventIds()).toEqual({ briefed: ['a'], recapped: [] })
  })

  it('renames legacy JSON to .pre-sqlite.bak after migration', () => {
    writeFileSync(join(tmpDir, 'queue.json'), JSON.stringify([]))
    writeFileSync(join(tmpDir, 'conversation.json'), JSON.stringify([]))

    db = new CoAgentDB(tmpDir)
    const result = migrateFromJson(tmpDir, db)
    expect(result.ok).toBe(true)

    // Original files gone, bak files present
    expect(existsSync(join(tmpDir, 'queue.json'))).toBe(false)
    expect(existsSync(join(tmpDir, 'queue.json.pre-sqlite.bak'))).toBe(true)
    expect(existsSync(join(tmpDir, 'conversation.json'))).toBe(false)
    expect(existsSync(join(tmpDir, 'conversation.json.pre-sqlite.bak'))).toBe(true)
  })

  it('skips files that do not exist on disk', () => {
    // Only write queue.json; conversation.json is absent
    writeFileSync(join(tmpDir, 'queue.json'), JSON.stringify([]))

    db = new CoAgentDB(tmpDir)
    const result = migrateFromJson(tmpDir, db)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // queue migrated; conversation absent so not in migrated list
    expect(result.migrated).toContain('queue')
    expect(result.migrated).not.toContain('conversation')
  })
})

// ── Migration idempotency ─────────────────────────────────────────────────────

describe('migrateFromJson — idempotency', () => {
  let tmpDir: string
  let db: CoAgentDB

  beforeEach(() => {
    tmpDir = makeTmp()
  })

  afterEach(() => {
    db?.close()
    cleanTmp(tmpDir)
  })

  it('second call is a no-op: skipped contains already-present keys', () => {
    writeFileSync(join(tmpDir, 'queue.json'), JSON.stringify([]))
    writeFileSync(join(tmpDir, 'conversation.json'), JSON.stringify([]))

    db = new CoAgentDB(tmpDir)
    const first = migrateFromJson(tmpDir, db)
    expect(first.ok).toBe(true)

    // Re-write originals (as if someone restored them) — but the bak files now
    // exist, so the second call should detect keys already in DB and skip.
    // Actually in the real flow, bak files exist and originals are gone; the
    // idempotency check is: keys already in kv_store → skip without touching disk.
    // Simulate by writing originals back then running again.
    writeFileSync(join(tmpDir, 'queue.json'), JSON.stringify([{ id: 'new' }]))

    const second = migrateFromJson(tmpDir, db)
    expect(second.ok).toBe(true)
    if (!second.ok) return

    // Key was already present — must be in skipped, not migrated
    expect(second.skipped).toContain('queue')
    expect(second.migrated).not.toContain('queue')

    // DB value unchanged (the new queue.json is ignored)
    expect(db.getQueue()).toEqual([])
  })
})

// ── Migration atomicity ───────────────────────────────────────────────────────

describe('migrateFromJson — atomicity', () => {
  let tmpDir: string
  let db: CoAgentDB

  beforeEach(() => {
    tmpDir = makeTmp()
  })

  afterEach(() => {
    db?.close()
    cleanTmp(tmpDir)
  })

  it('rolls back on corrupt JSON: DB has zero migrated rows and JSON files are NOT renamed', () => {
    // Write a valid file and a corrupt file
    writeFileSync(join(tmpDir, 'queue.json'), JSON.stringify([]))
    writeFileSync(join(tmpDir, 'conversation.json'), 'NOT_VALID_JSON{{{')

    db = new CoAgentDB(tmpDir)
    const result = migrateFromJson(tmpDir, db)
    expect(result.ok).toBe(false)

    // DB should have no kv_store rows written by this migration
    // (transaction rolled back — queue was not committed either)
    expect(db.getQueue()).toEqual([])

    // Legacy JSON files must NOT be renamed — originals preserved
    expect(existsSync(join(tmpDir, 'queue.json'))).toBe(true)
    expect(existsSync(join(tmpDir, 'conversation.json'))).toBe(true)
    expect(existsSync(join(tmpDir, 'queue.json.pre-sqlite.bak'))).toBe(false)
    expect(existsSync(join(tmpDir, 'conversation.json.pre-sqlite.bak'))).toBe(false)
  })
})

// ── Crash recovery ────────────────────────────────────────────────────────────

describe('migrateFromJson — crash recovery', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmp()
  })

  afterEach(() => {
    cleanTmp(tmpDir)
  })

  it('re-opening after DB delete re-runs migration cleanly', () => {
    writeFileSync(join(tmpDir, 'queue.json'), JSON.stringify([{ id: 'q1', type: 'task', title: 'T', description: '', detail: '', notes: '', action: '', metadata: {}, status: 'pending', createdAt: '2026-01-01T00:00:00.000Z' }]))

    // First open + migrate
    let db = new CoAgentDB(tmpDir)
    const first = migrateFromJson(tmpDir, db)
    expect(first.ok).toBe(true)
    db.close()

    // Simulate crash: delete the DB file
    const dbPath = join(tmpDir, 'coagent.db')
    rmSync(dbPath, { force: true })
    // Also restore the json from bak so migration has something to read
    const bakPath = join(tmpDir, 'queue.json.pre-sqlite.bak')
    if (existsSync(bakPath)) {
      // rename bak back to json to simulate pre-migration state
      renameSync(bakPath, join(tmpDir, 'queue.json'))
    }

    // Re-open and re-migrate
    db = new CoAgentDB(tmpDir)
    const second = migrateFromJson(tmpDir, db)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.migrated).toContain('queue')
    expect(db.getQueue()).toHaveLength(1)
    db.close()
  })
})

// ── isSqliteEnabled flag ──────────────────────────────────────────────────────

describe('isSqliteEnabled', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmp()
  })

  afterEach(() => {
    cleanTmp(tmpDir)
  })

  it('returns false when config.json does not exist', () => {
    expect(isSqliteEnabled(tmpDir)).toBe(false)
  })

  it('returns false when useSqlite is not present in config', () => {
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ someOtherFlag: true }))
    expect(isSqliteEnabled(tmpDir)).toBe(false)
  })

  it('returns false when useSqlite is explicitly false', () => {
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ useSqlite: false }))
    expect(isSqliteEnabled(tmpDir)).toBe(false)
  })

  it('returns true when useSqlite is true', () => {
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ useSqlite: true }))
    expect(isSqliteEnabled(tmpDir)).toBe(true)
  })
})
