import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { connect, Table } from '@lancedb/lancedb'
import type { TeamMessage } from '@coagent/shared'

const EMBED_MODEL = 'text-embedding-3-small'
const EMBED_DIM = 512

export interface TeamSearchResult {
  id: string
  from: string
  timestamp: string
  content: string
  score: number
}

export class TeamLog {
  private logPath: string
  private messagesDir: string
  private dbDir: string
  private relayUrl: string | null
  private relayToken: string | null
  private db: Awaited<ReturnType<typeof connect>> | null = null
  private table: Table | null = null

  constructor(dataDir: string, relayUrl?: string, relayToken?: string) {
    this.logPath = join(dataDir, 'team-log.json')
    this.messagesDir = join(dataDir, 'team-messages')
    this.dbDir = join(dataDir, 'team-embeddings')
    this.relayUrl = relayUrl?.replace(/\/$/, '') || null
    this.relayToken = relayToken || null
  }

  async init(): Promise<void> {
    await mkdir(this.messagesDir, { recursive: true })
    if (!existsSync(this.logPath)) {
      await writeFile(this.logPath, '[]', 'utf-8')
    }

    // Initialize LanceDB for embeddings
    try {
      await mkdir(this.dbDir, { recursive: true })
      this.db = await connect(this.dbDir)
      const tables = await this.db.tableNames()
      if (tables.includes('team_messages')) {
        this.table = await this.db.openTable('team_messages')
      } else {
        this.table = await this.db.createTable('team_messages', [
          { id: '', fromUserId: '', fromName: '', timestamp: '', to: '', content: '', vector: new Array(EMBED_DIM).fill(0) }
        ])
      }
    } catch (err) {
      console.warn('[TeamLog] Failed to init embeddings, semantic search disabled:', err)
    }
  }

  async append(message: TeamMessage): Promise<void> {
    const log = await this.readLog()
    // Skip duplicate (e.g. relay echo or double-append)
    if (log.some(m => m.id === message.id)) return
    log.push(message)
    await writeFile(this.logPath, JSON.stringify(log, null, 2), 'utf-8')

    // Embed in background — don't block on failure
    this.embedMessage(message).catch(err => {
      console.warn('[TeamLog] Failed to embed message:', err)
    })
  }

  async readLog(): Promise<TeamMessage[]> {
    if (!existsSync(this.logPath)) return []
    const raw = await readFile(this.logPath, 'utf-8')
    try { return JSON.parse(raw) } catch { return [] }
  }

  async clearLog(): Promise<void> {
    await writeFile(this.logPath, '[]', 'utf-8')
  }

  /**
   * Get the last N messages, optionally filtered by channel.
   * - broadcast: true → only messages with to=null
   * - dmWith + myUserId → messages between me and that agent/user
   */
  async getRecentMessages(n: number, filter?: { broadcast?: boolean; dmWith?: string; myUserId?: string }): Promise<TeamMessage[]> {
    const log = await this.readLog()
    let filtered = log

    if (filter?.broadcast) {
      filtered = log.filter(m => !m.to)
    } else if (filter?.dmWith && filter?.myUserId) {
      const dmId = filter.dmWith
      const dmBase = dmId.replace('-agent', '')
      const myId = filter.myUserId
      filtered = log.filter(m => {
        if (!m.to) return false
        const targets = Array.isArray(m.to) ? m.to : [m.to]
        const fromMe = m.from.userId === myId
        const fromThem = m.from.userId === dmBase || m.from.userId === dmId
        const toMe = targets.some(t => t === myId || t === `${myId}-agent`)
        const toThem = targets.some(t => t === dmId || t === dmBase)
        return (fromMe && toThem) || (fromThem && toMe)
      })
    }

    return filtered.slice(-n)
  }

  /**
   * Semantic search over embedded team messages.
   * Returns top-K results ranked by relevance, excluding messages with IDs in excludeIds.
   */
  async searchMessages(query: string, topK: number = 5, excludeIds?: Set<string>): Promise<TeamSearchResult[]> {
    if (!this.table) return []

    try {
      const vector = await this.embed(query)
      const results = await this.table
        .vectorSearch(vector)
        .limit(topK + (excludeIds?.size || 0))
        .toArray()

      return results
        .filter(r => r.id && r.content)
        .filter(r => !excludeIds?.has(r.id as string))
        .filter(r => (r._distance as number ?? 999) < 1.5)
        .slice(0, topK)
        .map(r => ({
          id: r.id as string,
          from: r.fromName as string,
          timestamp: r.timestamp as string,
          content: r.content as string,
          score: r._distance as number
        }))
    } catch (err) {
      console.warn('[TeamLog] Semantic search failed:', err)
      return []
    }
  }

  private async embedMessage(message: TeamMessage): Promise<void> {
    if (!this.table || !this.relayUrl) return

    const content = [message.visible, message.agentContext].filter(Boolean).join('\n')
    if (content.trim().length < 10) return

    const vector = await this.embed(content)
    const toStr = message.to ? (Array.isArray(message.to) ? message.to.join(',') : message.to) : ''

    await this.table.add([{
      id: message.id,
      fromUserId: message.from.userId,
      fromName: message.from.name,
      timestamp: message.timestamp,
      to: toStr,
      content,
      vector
    }])
  }

  private async embed(text: string): Promise<number[]> {
    const embedUrl = this.relayUrl ? `${this.relayUrl}/v1/embeddings` : null
    if (!embedUrl) {
      throw new Error('No relay URL — cannot embed')
    }

    const res = await fetch(embedUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.relayToken ?? ''}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ input: [text], model: EMBED_MODEL, dimensions: EMBED_DIM })
    })

    if (!res.ok) {
      throw new Error(`Embedding failed: ${await res.text()}`)
    }

    const json = await res.json() as { data: { embedding: number[] }[] }
    return json.data[0].embedding
  }
}
