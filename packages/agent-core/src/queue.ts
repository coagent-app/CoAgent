import { v4 as uuidv4 } from 'uuid'
import { readFileSync, mkdirSync, existsSync } from 'fs'
import { writeFile, rename } from 'fs/promises'
import { join } from 'path'
import type { ApprovalItem, DoneItem } from '@coagent/shared'

type NewItem = Omit<ApprovalItem, 'id' | 'status' | 'createdAt'>

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

  /** Clear all done items */
  private purgeDone(): void {
    if (this.done.length > 0) {
      this.done = []
      this.save()
    }
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
    const items = JSON.stringify(this.items, null, 2)
    const done = JSON.stringify(this.done, null, 2)
    const tmpQ = this.queuePath + '.tmp'
    const tmpD = this.donePath + '.tmp'
    writeFile(tmpQ, items).then(() => rename(tmpQ, this.queuePath)).catch(console.error)
    writeFile(tmpD, done).then(() => rename(tmpD, this.donePath)).catch(console.error)
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
