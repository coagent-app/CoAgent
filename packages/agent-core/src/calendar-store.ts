import { v4 as uuidv4 } from 'uuid'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { CalendarEntry, TodoItem } from '@coagent/shared'

type NewCalendarEntry = Omit<CalendarEntry, 'id' | 'createdAt'>

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
    return [...this.entries].sort((a, b) => {
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
        const due = e.due.includes('T') ? new Date(e.due) : new Date(e.due + 'T23:59:59')
        return due <= now
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
    this.pruneOldGoogleEvents()
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
    this.pruneOldGoogleEvents()
    this.save()
  }

  /** Drop Google events that ended more than 1 hour ago */
  private pruneOldGoogleEvents(): void {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const before = this.entries.length
    this.entries = this.entries.filter(e => {
      if (e.source !== 'google') return true
      const end = e.end || e.start
      if (!end) return true
      return end >= cutoff
    })
    const pruned = before - this.entries.length
    if (pruned > 0) console.log(`[Calendar] Pruned ${pruned} past Google events`)
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
      const due = entry.due.includes('T') ? new Date(entry.due) : new Date(entry.due + 'T00:00:00')
      if (due > now && (nearest === null || due < nearest)) nearest = due
    }
    return nearest
  }
}
