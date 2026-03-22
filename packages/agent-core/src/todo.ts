import { v4 as uuidv4 } from 'uuid'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { TodoItem } from '@coagent/shared'

type NewTodo = Omit<TodoItem, 'id' | 'createdAt'>

export class TodoList {
  private items: TodoItem[] = []
  private filePath: string

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'todos.json')
    mkdirSync(dataDir, { recursive: true })
    this.items = this.load()
  }

  private load(): TodoItem[] {
    try {
      if (existsSync(this.filePath)) return JSON.parse(readFileSync(this.filePath, 'utf-8'))
    } catch { /* corrupt file — start fresh */ }
    return []
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.items, null, 2))
  }

  add(item: NewTodo): TodoItem {
    const entry: TodoItem = {
      ...item,
      id: uuidv4(),
      createdAt: new Date().toISOString()
    }
    this.items.push(entry)
    this.save()
    return entry
  }

  getAll(): TodoItem[] {
    return [...this.items].sort((a, b) => {
      // High priority first, then by due date
      const prio = { high: 0, normal: 1, low: 2 }
      if (prio[a.priority] !== prio[b.priority]) return prio[a.priority] - prio[b.priority]
      if (a.due && b.due) return a.due.localeCompare(b.due)
      if (a.due) return -1
      if (b.due) return 1
      return 0
    })
  }

  getDue(): TodoItem[] {
    const now = new Date()
    return this.getAll().filter(i => {
      if (!i.due) return true
      // If time is included (YYYY-MM-DDTHH:MM), compare full datetime
      // If date only (YYYY-MM-DD), treat as end of that day
      const due = i.due.includes('T') ? new Date(i.due) : new Date(i.due + 'T23:59:59')
      return due <= now
    })
  }

  complete(id: string): TodoItem | undefined {
    const idx = this.items.findIndex(i => i.id === id)
    if (idx === -1) return undefined
    const [item] = this.items.splice(idx, 1)
    this.save()
    return item
  }

  delete(id: string): void {
    this.items = this.items.filter(i => i.id !== id)
    this.save()
  }
}
