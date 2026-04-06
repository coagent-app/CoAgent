import { readFile, writeFile, mkdir, readdir, stat, unlink, rmdir } from 'fs/promises'
import { existsSync, watch, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { connect, Table } from '@lancedb/lancedb'

const getEmbedUrl = () => {
  const relay = process.env.RELAY_URL?.replace(/\/$/, '')
  return relay ? `${relay}/v1/embeddings` : null
}
const getEmbedAuth = () => `Bearer ${process.env.RELAY_TOKEN ?? ''}`
const EMBED_MODEL = 'text-embedding-3-small'
const EMBED_DIM = 512
const MAX_CHUNK_CHARS = 800

function simpleHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return h.toString(36)
}

export interface MemorySearchResult {
  path: string
  chunkIndex: number
  content: string
  score: number
}

// ---------------------------------------------------------------------------
// Chunking helpers
// ---------------------------------------------------------------------------

/**
 * Split markdown content into self-contained chunks.
 *
 * Priority:
 *  1. Split on "\n## " (level-2 headings) — each heading + its body is one chunk
 *  2. If a section exceeds MAX_CHUNK_CHARS, further split on "\n\n" (paragraphs)
 *  3. Skip chunks that are blank or shorter than 20 chars after trimming
 */
export function chunkContent(content: string): string[] {
  const chunks: string[] = []

  // Split on level-2 headings. Keep the "## " prefix in the resulting chunk
  // by splitting on the newline *before* "## " and prepending it back.
  const sections: string[] = []
  const parts = content.split(/(?=\n## )/)
  for (const part of parts) {
    const trimmed = part.trimStart()
    if (trimmed.length > 0) {
      sections.push(trimmed)
    }
  }

  // If the file has no ## headings we get a single section equal to the whole file
  for (const section of sections) {
    if (section.length <= MAX_CHUNK_CHARS) {
      chunks.push(section)
    } else {
      // Further split on paragraph breaks
      const paragraphs = section.split(/\n\n+/)
      for (const para of paragraphs) {
        if (para.length <= MAX_CHUNK_CHARS) {
          chunks.push(para)
        } else {
          // Paragraph still too long — split on sentence boundaries first, then hard-cap
          const sentences = para.split(/(?<=[.!?])\s+/)
          let current = ''
          for (const sentence of sentences) {
            if (current.length + sentence.length + 1 > MAX_CHUNK_CHARS) {
              if (current) chunks.push(current.trim())
              current = sentence
            } else {
              current = current ? current + ' ' + sentence : sentence
            }
          }
          if (current) chunks.push(current.trim())
          // Hard-cap any remaining oversized pieces (e.g. no sentence breaks at all)
          const lastIdx = chunks.length - 1
          if (lastIdx >= 0 && chunks[lastIdx].length > MAX_CHUNK_CHARS) {
            const oversized = chunks.pop()!
            for (let i = 0; i < oversized.length; i += MAX_CHUNK_CHARS) {
              chunks.push(oversized.slice(i, i + MAX_CHUNK_CHARS))
            }
          }
        }
      }
    }
  }

  // Filter out blank / too-short chunks
  return chunks
    .map(c => c.trim())
    .filter(c => c.length >= 20)
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  private memoryDir: string
  private baseDir: string
  private dbDir: string
  private db: Awaited<ReturnType<typeof connect>> | null = null
  private table: Table | null = null
  private indexedAt: Map<string, number> = new Map() // path → mtime ms when last indexed
  private indexedAtPath: string  // persisted to disk so restarts don't re-index everything
  private scheduleHashes: Map<string, string> = new Map() // id → content hash
  private scheduleSyncTimer: ReturnType<typeof setTimeout> | null = null
  private syncInProgress = false
  private syncPending = false
  private scheduleIndexPath: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
    this.memoryDir = join(baseDir, 'memory')
    this.dbDir = join(baseDir, 'embeddings')
    this.scheduleIndexPath = join(baseDir, 'schedule-index.json')
    this.indexedAtPath = join(baseDir, 'embeddings', 'indexed-at.json')
  }

  async init(): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true })
    await mkdir(this.dbDir, { recursive: true })
    this.loadScheduleIndex()
    this.db = await connect(this.dbDir)

    const tables = await this.db.tableNames()
    if (tables.includes('memories')) {
      const existing = await this.db.openTable('memories')
      const schema = await existing.schema()

      const vectorField = schema.fields.find(f => f.name === 'vector')
      const currentDim = (vectorField?.type as any)?.listSize ?? 0
      const hasChunkIndex = schema.fields.some(f => f.name === 'chunkIndex')

      if (currentDim !== EMBED_DIM || !hasChunkIndex) {
        const reason = currentDim !== EMBED_DIM
          ? `dim mismatch (${currentDim} → ${EMBED_DIM})`
          : 'missing chunkIndex field'
        console.log(`[Memory] Schema migration required (${reason}), recreating table`)
        await this.db.dropTable('memories')
        this.table = await this.db.createTable('memories', [
          { path: '', chunkIndex: 0, content: '', vector: new Array(EMBED_DIM).fill(0) }
        ])
      } else {
        this.table = existing
      }
    } else {
      this.table = await this.db.createTable('memories', [
        { path: '', chunkIndex: 0, content: '', vector: new Array(EMBED_DIM).fill(0) }
      ])
    }

    // Clean up seed row (required for table creation but pollutes search)
    try { await this.table.delete("path = ''") } catch { /* may not exist */ }

    // Load persisted indexedAt timestamps so we don't re-index unchanged files on restart
    this.loadIndexedAt()

    // Incrementally index any .md files that have no chunks in the DB yet
    await this.indexAllFiles()

    // Purge orphaned DB entries (files deleted externally, stale schedule items)
    await this.purgeOrphans()

    // Watch calendar.json and auto-index schedule items
    await this.syncSchedule()
    this.watchCalendar()
  }

  // -------------------------------------------------------------------------
  // Public API — signatures unchanged for MCP index.ts compatibility
  // -------------------------------------------------------------------------

  private assertSafePath(relativePath: string): string {
    const fullPath = join(this.memoryDir, relativePath)
    if (!fullPath.startsWith(this.memoryDir + '/')) {
      throw new Error(`Path traversal blocked: ${relativePath}`)
    }
    return fullPath
  }

  async writeMemory(relativePath: string, content: string): Promise<void> {
    const fullPath = this.assertSafePath(relativePath)
    await mkdir(dirname(fullPath), { recursive: true })
    // Auto-stamp created/updated time so the agent can see when memories were made
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const hasTimestamp = /^<!-- (created|updated):/.test(content)
    const stamped = hasTimestamp
      ? content.replace(/<!-- updated: .* -->/, `<!-- updated: ${now} -->`)
      : `<!-- created: ${now} -->\n${content}`
    await writeFile(fullPath, stamped, 'utf-8')
    await this.indexFile(relativePath, stamped)
    this.indexedAt.set(relativePath, Date.now())
    this.saveIndexedAt()
  }

  async readMemory(relativePath: string): Promise<string> {
    const fullPath = this.assertSafePath(relativePath)
    return readFile(fullPath, 'utf-8')
  }

  async listMemories(category?: string): Promise<string[]> {
    const searchDir = category
      ? join(this.memoryDir, category)
      : this.memoryDir

    if (!existsSync(searchDir)) return []

    const entries = await readdir(searchDir, { recursive: true, withFileTypes: true })
    const dirs = new Set<string>()
    const files: string[] = []
    for (const entry of entries) {
      const rel = entry.parentPath
        ? join(entry.parentPath.replace(searchDir, ''), entry.name)
        : entry.name
      const path = category ? `${category}/${rel}` : rel
      if (entry.isDirectory()) {
        dirs.add(path + '/')
      } else if (entry.name.endsWith('.md')) {
        files.push(path)
        // Track parent dirs that have files (non-empty)
        const parent = entry.parentPath?.replace(searchDir, '')
        if (parent) dirs.delete((category ? `${category}/${parent}` : parent) + '/')
      }
    }
    // Only include dirs that contain .md files
    const nonEmptyDirs = [...dirs].filter(d => files.some(f => f.startsWith(d)))
    return [...nonEmptyDirs, ...files]
  }

  async deleteMemory(relativePath: string): Promise<void> {
    // Virtual entries (_schedule/) live only in LanceDB — no file on disk
    const isVirtual = relativePath.startsWith('_schedule/')

    if (!isVirtual) {
      const fullPath = this.assertSafePath(relativePath)
      if (!existsSync(fullPath)) throw new Error(`File not found: ${relativePath}`)
      await unlink(fullPath)

      // Clean up empty parent directories
      let dir = dirname(fullPath)
      while (dir !== this.memoryDir && dir.startsWith(this.memoryDir)) {
        try {
          const contents = await readdir(dir)
          if (contents.length === 0) { await rmdir(dir).catch(() => {}) }
          else break
        } catch { break }
        dir = dirname(dir)
      }
    }

    // Remove all chunks from the embeddings DB
    if (this.table) {
      const escaped = relativePath.replace(/'/g, "''")
      await this.table.delete(`path = '${escaped}'`)
    }
    this.indexedAt.delete(relativePath)

    // Also clear schedule hash if it was a virtual entry
    if (isVirtual) {
      const id = relativePath.replace('_schedule/', '')
      this.scheduleHashes.delete(id)
    }
  }

  async appendMemory(relativePath: string, content: string): Promise<void> {
    const fullPath = this.assertSafePath(relativePath)
    await mkdir(dirname(fullPath), { recursive: true })
    const existing = existsSync(fullPath) ? await readFile(fullPath, 'utf-8') : ''
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const timestampedContent = `<!-- appended: ${now} -->\n${content}`
    let updated: string
    if (existing) {
      // Update the top-level updated timestamp if present
      let base = existing.trimEnd()
      if (/<!-- updated: .* -->/.test(base)) {
        base = base.replace(/<!-- updated: .* -->/, `<!-- updated: ${now} -->`)
      } else if (/<!-- created: .* -->/.test(base)) {
        // Add updated timestamp after created
        base = base.replace(/(<!-- created: .* -->)/, `$1\n<!-- updated: ${now} -->`)
      }
      updated = base + '\n\n' + timestampedContent
    } else {
      updated = `<!-- created: ${now} -->\n${timestampedContent}`
    }
    await writeFile(fullPath, updated, 'utf-8')

    if (!this.table) return

    // Only embed the new content — don't re-index the whole file
    const chunks = chunkContent(content)
    if (chunks.length === 0) return

    // Get current max chunkIndex for this path
    const escaped = relativePath.replace(/'/g, "''")
    let maxIndex = -1
    try {
      const existing = await this.table.query()
        .where(`path = '${escaped}'`)
        .select(['chunkIndex'])
        .toArray()
      for (const row of existing) {
        if ((row.chunkIndex as number) > maxIndex) maxIndex = row.chunkIndex as number
      }
    } catch { /* empty table */ }

    const rows: { path: string; chunkIndex: number; content: string; vector: number[] }[] = []
    for (let i = 0; i < chunks.length; i++) {
      const vector = await this.embed(chunks[i])
      rows.push({ path: relativePath, chunkIndex: maxIndex + 1 + i, content: chunks[i], vector })
    }
    await this.table.add(rows)
    this.indexedAt.set(relativePath, Date.now())
    this.saveIndexedAt()
  }

  async editSection(relativePath: string, oldContent: string, newContent: string): Promise<boolean> {
    const fullPath = join(this.memoryDir, relativePath)
    if (!existsSync(fullPath)) return false

    const file = await readFile(fullPath, 'utf-8')
    const idx = file.indexOf(oldContent)
    if (idx === -1) return false

    if (!this.table) {
      // No DB — just write the file
      const updated = file.slice(0, idx) + newContent + file.slice(idx + oldContent.length)
      await writeFile(fullPath, updated, 'utf-8')
      return true
    }

    // Embed ALL new chunks FIRST — prevents file/DB split if embedding fails
    const chunks = chunkContent(newContent)
    const newRows: { path: string; chunkIndex: number; content: string; vector: number[] }[] = []
    if (chunks.length > 0) {
      const escapedForMax = relativePath.replace(/'/g, "''")
      let maxIndex = -1
      try {
        const existing = await this.table.query()
          .where(`path = '${escapedForMax}'`)
          .select(['chunkIndex'])
          .toArray()
        for (const row of existing) {
          if ((row.chunkIndex as number) > maxIndex) maxIndex = row.chunkIndex as number
        }
      } catch { /* empty table */ }

      for (let i = 0; i < chunks.length; i++) {
        const vector = await this.embed(chunks[i])
        newRows.push({ path: relativePath, chunkIndex: maxIndex + 1 + i, content: chunks[i], vector })
      }
    }

    // Embeddings succeeded — now atomically update DB then write file
    const escapedPath = relativePath.replace(/'/g, "''")
    const escapedContent = oldContent.replace(/'/g, "''")
    await this.table.delete(`path = '${escapedPath}' AND content = '${escapedContent}'`)
    if (newRows.length > 0) await this.table.add(newRows)

    const updated = file.slice(0, idx) + newContent + file.slice(idx + oldContent.length)
    await writeFile(fullPath, updated, 'utf-8')
    this.indexedAt.set(relativePath, Date.now())
    this.saveIndexedAt()
    return true
  }

  async searchMemory(query: string, topK = 5): Promise<MemorySearchResult[]> {
    if (!this.table) throw new Error('MemoryStore not initialized')

    // 1. Vector (semantic) search
    const embedding = await this.embed(query)
    const vectorResults = await this.table
      .vectorSearch(embedding)
      .limit(topK)
      .toArray()

    const valid = vectorResults.filter(r => r.path && r.content)
    if (valid.length > 0) {
      console.error(`[Memory] Search distances: ${valid.map(r => `${(r.path as string).split('/').pop()}=${(r._distance as number).toFixed(3)}`).join(', ')}`)
    }

    const semantic = valid
      .filter(r => (r._distance as number ?? 999) < 1.8)
      .map(r => ({
        path: r.path as string,
        chunkIndex: (r.chunkIndex as number) ?? 0,
        content: r.content as string,
        score: (r._distance as number) ?? 0
      }))

    // 2. Keyword fallback — catches proper nouns, names, emails that embed poorly.
    // Only run the full-table scan when semantic search genuinely failed (< 2 hits)
    // to avoid loading all rows into memory on every query.
    const queryLower = query.toLowerCase()
    const keywords = queryLower.split(/\s+/).filter(w => w.length >= 2)

    let keywordResults: MemorySearchResult[] = []
    if (keywords.length > 0 && semantic.length < 2) {
      try {
        const allRows = await this.table.query().select(['path', 'chunkIndex', 'content']).toArray()
        keywordResults = allRows
          .filter(r => r.path && r.content && keywords.some(kw => (r.content as string).toLowerCase().includes(kw)))
          .map(r => ({
            path: r.path as string,
            chunkIndex: (r.chunkIndex as number) ?? 0,
            content: r.content as string,
            score: 0.5 // keyword matches get a good score
          }))
          .slice(0, topK)
      } catch { /* table may be empty */ }
    }

    // 3. Merge: dedupe by path+chunkIndex, semantic results take priority
    const seen = new Set(semantic.map(r => `${r.path}:${r.chunkIndex}`))
    for (const kr of keywordResults) {
      const key = `${kr.path}:${kr.chunkIndex}`
      if (!seen.has(key)) {
        semantic.push(kr)
        seen.add(key)
      }
    }

    if (semantic.length === 0) {
      console.error(`[Memory] Search returned 0 results for "${query}" (vector + keyword)`)
    }

    return semantic.slice(0, topK)
  }

  // -------------------------------------------------------------------------
  // Orphan cleanup
  // -------------------------------------------------------------------------

  /**
   * Remove LanceDB entries whose backing file no longer exists on disk.
   * Virtual paths (_schedule/) are left alone — they're managed by syncSchedule().
   */
  private async purgeOrphans(): Promise<void> {
    if (!this.table) return

    const indexed = await this.getIndexedPaths()
    const orphans: string[] = []

    for (const path of indexed) {
      // Virtual entries are managed separately
      if (path.startsWith('_schedule/')) continue
      // Seed row artifact
      if (path === '') continue

      const fullPath = join(this.memoryDir, path)
      if (!existsSync(fullPath)) {
        orphans.push(path)
      }
    }

    if (orphans.length === 0) return

    console.log(`[Memory] Purging ${orphans.length} orphaned DB entries: ${orphans.join(', ')}`)
    for (const path of orphans) {
      const escaped = path.replace(/'/g, "''")
      try {
        await this.table.delete(`path = '${escaped}'`)
      } catch (err: any) {
        console.error(`[Memory] Failed to purge ${path}:`, err.message)
      }
      this.indexedAt.delete(path)
    }
  }

  // -------------------------------------------------------------------------
  // Indexing helpers
  // -------------------------------------------------------------------------

  private loadIndexedAt(): void {
    try {
      if (existsSync(this.indexedAtPath)) {
        const raw = readFileSync(this.indexedAtPath, 'utf-8')
        const entries: [string, number][] = JSON.parse(raw)
        this.indexedAt = new Map(entries)
      }
    } catch { /* start fresh if corrupt */ }
  }

  private saveIndexedAt(): void {
    try {
      writeFile(this.indexedAtPath, JSON.stringify([...this.indexedAt]), 'utf-8').catch(() => {})
    } catch { /* best effort */ }
  }

  /**
   * Index all .md files that are new or changed since last indexed.
   * Checks file mtime against last indexed time to catch external edits.
   */
  async indexAllFiles(): Promise<void> {
    if (!this.table) return

    const allFiles = await this.listAllMdFiles()
    if (allFiles.length === 0) return

    const indexed = await this.getIndexedPaths()
    const toIndex: string[] = []

    for (const relativePath of allFiles) {
      if (!indexed.has(relativePath)) {
        toIndex.push(relativePath)
        continue
      }
      // Check if file changed since we last indexed it
      try {
        const fileStat = await stat(join(this.memoryDir, relativePath))
        const lastIndexed = this.indexedAt.get(relativePath) ?? 0
        if (fileStat.mtimeMs > lastIndexed) {
          toIndex.push(relativePath)
        }
      } catch { /* file may have been deleted */ }
    }

    if (toIndex.length === 0) return

    console.log(`[Memory] Indexing ${toIndex.length} file(s)…`)
    for (const relativePath of toIndex) {
      try {
        const content = await readFile(join(this.memoryDir, relativePath), 'utf-8')
        await this.indexFile(relativePath, content)
        this.indexedAt.set(relativePath, Date.now())
      } catch (err) {
        console.warn(`[Memory] Failed to index ${relativePath}:`, err)
      }
    }
    this.saveIndexedAt()
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async indexFile(relativePath: string, content: string): Promise<void> {
    if (!this.table) return

    const chunks = chunkContent(content)
    if (chunks.length === 0) return

    // Embed ALL chunks BEFORE deleting old ones — prevents data loss if embedding fails
    const rows: { path: string; chunkIndex: number; content: string; vector: number[] }[] = []
    for (let i = 0; i < chunks.length; i++) {
      const vector = await this.embed(chunks[i])
      rows.push({ path: relativePath, chunkIndex: i, content: chunks[i], vector })
    }

    const escaped = relativePath.replace(/'/g, "''")
    await this.table.delete(`path = '${escaped}'`)
    await this.table.add(rows)
  }

  /** Recursively list all .md files under memoryDir as relative paths. */
  private async listAllMdFiles(): Promise<string[]> {
    if (!existsSync(this.memoryDir)) return []
    const files = await readdir(this.memoryDir, { recursive: true })
    return (files as string[]).filter(f => f.endsWith('.md'))
  }

  /** Return the set of relative paths that already have at least one chunk in the DB. */
  private async getIndexedPaths(): Promise<Set<string>> {
    if (!this.table) return new Set()

    try {
      const rows = await this.table.query().select(['path']).toArray()
      const paths = new Set<string>()
      for (const row of rows) {
        if (row.path) paths.add(row.path as string)
      }
      return paths
    } catch {
      // Table may be empty — that's fine
      return new Set()
    }
  }

  // -------------------------------------------------------------------------
  // Schedule auto-indexing
  // -------------------------------------------------------------------------

  private watchCalendar(): void {
    const calendarPath = join(this.baseDir, 'calendar.json')
    if (!existsSync(calendarPath)) return

    try {
      watch(calendarPath, () => {
        // Debounce — CalendarStore may write rapidly
        if (this.scheduleSyncTimer) clearTimeout(this.scheduleSyncTimer)
        this.scheduleSyncTimer = setTimeout(() => this.syncSchedule().catch(err =>
          console.error('[Memory] Schedule sync failed:', err.message)
        ), 500)
      })
      console.error('[Memory] Watching calendar.json for schedule changes')
    } catch (err: any) {
      console.error('[Memory] Failed to watch calendar.json:', err.message)
    }
  }

  private async syncSchedule(): Promise<void> {
    if (this.syncInProgress) {
      // A sync is already running — record that another is needed when it finishes
      this.syncPending = true
      return
    }

    this.syncInProgress = true
    try {
      await this._syncScheduleImpl()
    } finally {
      this.syncInProgress = false
      if (this.syncPending) {
        this.syncPending = false
        // Run the deferred sync outside this call stack so the mutex is clear
        setImmediate(() => this.syncSchedule().catch(err =>
          console.error('[Memory] Deferred schedule sync failed:', err.message)
        ))
      }
    }
  }

  private async _syncScheduleImpl(): Promise<void> {
    if (!this.table) return

    const calendarPath = join(this.baseDir, 'calendar.json')
    if (!existsSync(calendarPath)) return

    let entries: any[]
    try {
      entries = JSON.parse(readFileSync(calendarPath, 'utf-8'))
    } catch { return }

    const now = new Date()

    // Only index active items: not completed, not past
    const active = entries.filter((e: any) => {
      if (e.completed) return false
      if (!e.enabled) return false
      // Filter overdue tasks/followups
      if (e.type === 'task' || e.type === 'followup') {
        if (e.due) {
          const due = e.due.includes('T') ? new Date(e.due) : new Date(e.due + 'T23:59:59')
          if (due < now) return false
        }
      }
      // Filter past events
      if (e.type === 'event') {
        const end = e.end || e.start
        if (end) {
          const endDate = end.includes('T') ? new Date(end) : new Date(end + 'T23:59:59')
          if (endDate < now) return false
        }
      }
      return true
    })

    // Build content for each active item
    const activeItems = new Map<string, string>()
    for (const e of active) {
      const parts = [`[${e.type}] ${e.label}`]
      if (e.start) parts.push(`Start: ${e.start}`)
      if (e.end) parts.push(`End: ${e.end}`)
      if (e.due) parts.push(`Due: ${e.due}`)
      if (e.cron) parts.push(`Cron: ${e.cron}`)
      if (e.location) parts.push(`Location: ${e.location}`)
      if (e.instruction) parts.push(e.instruction)
      if (e.notes) parts.push(e.notes)
      activeItems.set(e.id, parts.join('\n'))
    }

    // Diff against what's indexed
    const toAdd: { id: string; content: string }[] = []
    const toRemove: string[] = []

    // Find items to remove (no longer active)
    for (const [id] of this.scheduleHashes) {
      if (!activeItems.has(id)) toRemove.push(id)
    }

    // Find items to add/update (new or changed)
    for (const [id, content] of activeItems) {
      const hash = simpleHash(content)
      if (this.scheduleHashes.get(id) !== hash) {
        toRemove.push(id) // remove old version first
        toAdd.push({ id, content })
      }
    }

    if (toRemove.length === 0 && toAdd.length === 0) return

    // Remove
    for (const id of toRemove) {
      const escaped = `_schedule/${id}`.replace(/'/g, "''")
      try { await this.table.delete(`path = '${escaped}'`) } catch { /* may not exist */ }
      this.scheduleHashes.delete(id)
    }

    // Add
    for (const { id, content } of toAdd) {
      try {
        const vector = await this.embed(content)
        await this.table.add([{
          path: `_schedule/${id}`,
          chunkIndex: 0,
          content,
          vector
        }])
        this.scheduleHashes.set(id, simpleHash(content))
      } catch (err: any) {
        console.error(`[Memory] Failed to index schedule item ${id}:`, err.message)
      }
    }

    console.error(`[Memory] Schedule sync: ${toRemove.length} removed, ${toAdd.length} indexed (${activeItems.size} active)`)
    this.saveScheduleIndex()
  }

  private loadScheduleIndex(): void {
    if (!existsSync(this.scheduleIndexPath)) return
    try {
      const entries: [string, string][] = JSON.parse(readFileSync(this.scheduleIndexPath, 'utf-8'))
      this.scheduleHashes = new Map(entries)
      console.log(`[Memory] Loaded schedule index: ${this.scheduleHashes.size} entries`)
    } catch { /* corrupt file, start fresh */ }
  }

  private saveScheduleIndex(): void {
    try {
      const json = JSON.stringify(Array.from(this.scheduleHashes.entries()))
      writeFile(this.scheduleIndexPath, json, 'utf-8').catch(() => {})
    } catch { /* best effort */ }
  }

  private async embed(text: string): Promise<number[]> {
    const embedUrl = getEmbedUrl()
    if (!embedUrl) {
      // Fallback: deterministic hash-based mock (no semantic meaning, but consistent)
      return new Array(EMBED_DIM).fill(0).map((_, i) => (text.charCodeAt(i % text.length) / 255))
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15_000)

    let res: Response
    try {
      res = await fetch(embedUrl, {
        method: 'POST',
        headers: {
          'Authorization': getEmbedAuth(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ input: [text], model: EMBED_MODEL, dimensions: EMBED_DIM }),
        signal: controller.signal
      })
    } catch (err: any) {
      if (err.name === 'AbortError') throw new Error('Embedding request timed out after 15s')
      throw err
    } finally {
      clearTimeout(timeoutId)
    }

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Embedding failed: ${err}`)
    }

    const json = await res.json() as { data: { embedding: number[] }[] }
    return json.data[0].embedding
  }
}
