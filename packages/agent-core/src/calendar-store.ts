import { v4 as uuidv4 } from 'uuid'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { CalendarEntry, TodoItem } from '@coagent/shared'

type NewCalendarEntry = Omit<CalendarEntry, 'id' | 'createdAt'>

/**
 * Parse a naive datetime string (e.g., "2026-04-01T10:00:00") as local time.
 * For date-only strings, defaults to 9:00 AM local (start of business).
 * JS `new Date(isoWithTime)` already treats no-zone strings as local, but
 * date-only strings ("2026-04-01") are treated as UTC — this normalizes both.
 */
export function parseLocalDate(dateStr: string, fallbackTime = '09:00:00'): Date {
  if (dateStr.includes('T')) return new Date(dateStr)
  // Date-only: append time so JS treats it as local, not UTC
  return new Date(dateStr + 'T' + fallbackTime)
}

export class CalendarStore {
  private entries: CalendarEntry[] = []
  private filePath: string
  private dataDir: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.filePath = join(dataDir, 'calendar.json')
    mkdirSync(dataDir, { recursive: true })
    this.entries = this.load()
    this.migrate()
    this.purgeCompleted()
  }

  private load(): CalendarEntry[] {
    try {
      if (existsSync(this.filePath)) return JSON.parse(readFileSync(this.filePath, 'utf-8'))
    } catch { /* corrupt file — start fresh */ }
    return []
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2))
  }

  /** One-time migration: convert todos.json → calendar entries */
  private migrate(): void {
    const todosPath = join(this.dataDir, 'todos.json')
    if (!existsSync(todosPath)) return
    if (this.entries.length > 0) return

    try {
      const todos: TodoItem[] = JSON.parse(readFileSync(todosPath, 'utf-8'))
      for (const todo of todos) {
        this.entries.push({
          id: todo.id,
          type: 'task',
          label: todo.task,
          due: todo.due,
          instruction: todo.context,
          enabled: true,
          completed: false,
          createdAt: todo.createdAt,
        })
      }
      if (this.entries.length > 0) {
        this.save()
        console.log(`[Calendar] Migrated ${this.entries.length} todos to calendar.json`)
      }
    } catch (err: any) {
      console.error('[Calendar] Migration failed:', err.message)
    }
  }

  create(entry: NewCalendarEntry): CalendarEntry {
    const item: CalendarEntry = {
      ...entry,
      id: uuidv4(),
      createdAt: new Date().toISOString(),
    }
    this.entries.push(item)
    this.save()
    return item
  }

  update(id: string, patch: Partial<Omit<CalendarEntry, 'id' | 'createdAt'>>): CalendarEntry | undefined {
    const entry = this.entries.find(e => e.id === id)
    if (!entry) return undefined
    Object.assign(entry, patch)
    this.save()
    return entry
  }

  delete(id: string): boolean {
    const entry = this.entries.find(e => e.id === id)
    if (entry?.source === 'google') return false
    const before = this.entries.length
    this.entries = this.entries.filter(e => e.id !== id)
    if (this.entries.length < before) { this.save(); return true }
    return false
  }

  complete(id: string): CalendarEntry | undefined {
    const entry = this.entries.find(e => e.id === id)
    if (entry?.source === 'google') return undefined
    if (!entry || (entry.type !== 'task' && entry.type !== 'followup')) return undefined
    entry.completed = true
    this.save()
    return entry
  }

  getAll(): CalendarEntry[] {
    // Google events filtered to current week only; local entries always included
    const now = new Date()
    const weekStart = new Date(now)
    weekStart.setDate(now.getDate() - now.getDay()) // Sunday
    weekStart.setHours(0, 0, 0, 0)
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekStart.getDate() + 7)

    return [...this.entries]
      .filter(e => {
        if (e.source !== 'google') return true
        const start = e.start || e.end
        if (!start) return true
        const d = new Date(start)
        return d >= weekStart && d < weekEnd
      })
      .sort((a, b) => {
        const typeOrder: Record<string, number> = { routine: 0, task: 1, followup: 2, event: 3 }
        const aOrder = typeOrder[a.type] ?? 4
        const bOrder = typeOrder[b.type] ?? 4
        if (aOrder !== bOrder) return aOrder - bOrder
        const aTime = a.start || a.due || a.cron || ''
        const bTime = b.start || b.due || b.cron || ''
        return aTime.localeCompare(bTime)
      })
  }

  getByType(type: CalendarEntry['type']): CalendarEntry[] {
    return this.getAll().filter(e => e.type === type)
  }

  /** Tasks and followups past due or with no due time (and not completed) */
  getTasksDue(): CalendarEntry[] {
    const now = new Date()
    return this.entries
      .filter(e => (e.type === 'task' || e.type === 'followup') && !e.completed && e.enabled)
      .filter(e => {
        if (!e.due) return true
        return parseLocalDate(e.due) <= now
      })
  }

  /** Get all enabled routines */
  getRoutines(): CalendarEntry[] {
    return this.entries.filter(e => e.type === 'routine' && e.enabled)
  }

  /** Replace all Google events with new set */
  setGoogleEvents(events: CalendarEntry[]): void {
    this.entries = this.entries.filter(e => e.source !== 'google')
    this.entries.push(...events)
    this.save()
  }

  /** Apply incremental sync — remove cancelled, upsert changed */
  applyGoogleSync(added: CalendarEntry[], removedGoogleEventIds: string[]): void {
    const removeIds = new Set(removedGoogleEventIds.map(id => `gcal-${id}`))
    this.entries = this.entries.filter(e => !removeIds.has(e.id))
    for (const event of added) {
      const idx = this.entries.findIndex(e => e.id === event.id)
      if (idx >= 0) this.entries[idx] = event
      else this.entries.push(event)
    }
    this.save()
  }

  /** Get entries filtered for agent context — excludes Google events that ended more than 1 hour ago */
  getAgentView(): CalendarEntry[] {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    return this.entries.filter(e => {
      if (e.source !== 'google') return true
      const end = e.end || e.start
      if (!end) return true
      return end >= cutoff
    })
  }

  /** Remove all Google events (for disconnect) */
  clearGoogleEvents(): void {
    this.entries = this.entries.filter(e => e.source !== 'google')
    this.save()
  }

  /** Next fire time for tasks and followups (for wake scheduling) */
  getNextTaskTime(): Date | null {
    const now = new Date()
    let nearest: Date | null = null
    for (const entry of this.entries) {
      if ((entry.type !== 'task' && entry.type !== 'followup') || entry.completed || !entry.due) continue
      const due = parseLocalDate(entry.due)
      if (due > now && (nearest === null || due < nearest)) nearest = due
    }
    return nearest
  }

  /** Remove completed tasks/followups older than 7 days */
  private purgeCompleted(): void {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    const before = this.entries.length
    this.entries = this.entries.filter(e => {
      if (!e.completed) return true
      const created = new Date(e.createdAt).getTime()
      return created > cutoff
    })
    const removed = before - this.entries.length
    if (removed > 0) {
      this.save()
      console.log(`[Calendar] Purged ${removed} completed entries older than 7 days`)
    }
  }
}
