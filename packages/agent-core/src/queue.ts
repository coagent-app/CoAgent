import { v4 as uuidv4 } from 'uuid'
import { readFileSync, mkdirSync, existsSync } from 'fs'
import { writeFile, rename } from 'fs/promises'
import { join } from 'path'
import type { ApprovalItem, DoneItem } from '@coagent/shared'

type NewItem = Omit<ApprovalItem, 'id' | 'status' | 'createdAt'>

// ---------------------------------------------------------------------------
// In-process async mutex — serialises all read-modify-write cycles so that
// two simultaneous triggers cannot corrupt queue.json or done.json.
// ---------------------------------------------------------------------------
let writeLock: Promise<void> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock
  let resolve!: () => void
  writeLock = new Promise(r => { resolve = r })
  return prev.then(fn).finally(() => resolve())
}

export class ApprovalQueue {
  private items: ApprovalItem[] = []
  private done: DoneItem[] = []
  private queuePath: string
  private donePath: string
  private purgeTimer: ReturnType<typeof setTimeout> | null = null
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(dataDir: string) {
    this.queuePath = join(dataDir, 'queue.json')
    this.donePath = join(dataDir, 'done.json')
    mkdirSync(dataDir, { recursive: true })
    this.items = this.load(this.queuePath, [])
    this.done = this.load(this.donePath, [])
    this.purgeDone()
    this.scheduleDailyPurge()
  }

  /** Remove done items older than 7 days (keeps recent history visible to users) */
  private purgeDone(): void {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    const before = this.done.length
    this.done = this.done.filter(d => new Date(d.completedAt).getTime() >= cutoff)
    if (this.done.length !== before) this.save()
  }

  /** Schedule purge at 3am every night */
  private scheduleDailyPurge(): void {
    const now = new Date()
    const next3am = new Date(now)
    next3am.setHours(3, 0, 0, 0)
    if (next3am <= now) next3am.setDate(next3am.getDate() + 1)
    const ms = next3am.getTime() - now.getTime()

    this.purgeTimer = setTimeout(() => {
      this.purgeDone()
      // Re-schedule for next night
      this.scheduleDailyPurge()
    }, ms)
  }

  /** Call on shutdown to clean up timer */
  destroy(): void {
    if (this.purgeTimer) clearTimeout(this.purgeTimer)
    if (this.saveDebounceTimer) { clearTimeout(this.saveDebounceTimer); this.saveDebounceTimer = null; this.flushSave() }
  }

  private load<T>(path: string, fallback: T): T {
    try {
      if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8'))
    } catch { /* corrupt file — start fresh */ }
    return fallback
  }

  private flushSave(): void {
    const tmpQ = this.queuePath + '.tmp'
    const tmpD = this.donePath + '.tmp'
    // Acquire the lock so concurrent flush calls are serialised. The snapshot
    // of this.items / this.done is taken *inside* the lock so we always write
    // the latest in-memory state rather than a stale copy captured before we
    // queued up behind a previous writer.
    withLock(async () => {
      const items = JSON.stringify(this.items, null, 2)
      const done = JSON.stringify(this.done, null, 2)
      await writeFile(tmpQ, items)
      await rename(tmpQ, this.queuePath)
      await writeFile(tmpD, done)
      await rename(tmpD, this.donePath)
    }).catch(console.error)
  }

  private save(): void {
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer)
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null
      this.flushSave()
    }, 200)
  }

  add(item: NewItem): ApprovalItem {
    const entry: ApprovalItem = {
      ...item,
      id: uuidv4(),
      status: 'pending',
      createdAt: new Date().toISOString()
    }
    this.items.push(entry)
    this.save()
    return entry
  }

  getPending(): ApprovalItem[] {
    return this.items.filter(i => i.status === 'pending')
  }

  approve(id: string): ApprovalItem | undefined {
    const item = this.items.find(i => i.id === id)
    if (item) {
      item.status = 'approved'
      this.save()
    }
    return item
  }

  reject(id: string): ApprovalItem | undefined {
    const item = this.items.find(i => i.id === id)
    if (item) {
      item.status = 'rejected'
      this.save()
    }
    return item
  }

  getDone(): DoneItem[] {
    return this.done
  }

  addDone(description: string): void {
    this.done.push({ id: uuidv4(), description, completedAt: new Date().toISOString() })
    this.save()
  }

  editDetail(id: string, detail: string): ApprovalItem | undefined {
    const item = this.items.find(i => i.id === id)
    if (item) {
      item.detail = detail
      this.save()
    }
    return item
  }
}
