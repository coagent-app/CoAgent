import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import type { TeamMessage } from '@coagent/shared'

export class TeamLog {
  private logPath: string
  private messagesDir: string

  constructor(dataDir: string) {
    this.logPath = join(dataDir, 'team-log.json')
    this.messagesDir = join(dataDir, 'team-messages')
  }

  async init(): Promise<void> {
    await mkdir(this.messagesDir, { recursive: true })
    if (!existsSync(this.logPath)) {
      await writeFile(this.logPath, '[]', 'utf-8')
    }
  }

  async append(message: TeamMessage): Promise<void> {
    const log = await this.readLog()
    log.push(message)
    await writeFile(this.logPath, JSON.stringify(log, null, 2), 'utf-8')
  }

  async readLog(): Promise<TeamMessage[]> {
    if (!existsSync(this.logPath)) return []
    const raw = await readFile(this.logPath, 'utf-8')
    try { return JSON.parse(raw) } catch { return [] }
  }

  async clearLog(): Promise<void> {
    await writeFile(this.logPath, '[]', 'utf-8')
  }
}
