import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'fs/promises'
import { existsSync } from 'fs'
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
        chunks.push(para)
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
  private dbDir: string
  private db: Awaited<ReturnType<typeof connect>> | null = null
  private table: Table | null = null
  private indexedAt: Map<string, number> = new Map() // path → mtime ms when last indexed

  constructor(baseDir: string) {
    this.memoryDir = join(baseDir, 'memory')
    this.dbDir = join(baseDir, 'embeddings')
  }

  async init(): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true })
    await mkdir(this.dbDir, { recursive: true })
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

    // Incrementally index any .md files that have no chunks in the DB yet
    await this.indexAllFiles()
  }

  // -------------------------------------------------------------------------
  // Public API — signatures unchanged for MCP index.ts compatibility
  // -------------------------------------------------------------------------

  async writeMemory(relativePath: string, content: string): Promise<void> {
    const fullPath = join(this.memoryDir, relativePath)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content, 'utf-8')
    await this.indexFile(relativePath, content)
    this.indexedAt.set(relativePath, Date.now())
  }

  async readMemory(relativePath: string): Promise<string> {
    const fullPath = join(this.memoryDir, relativePath)
    return readFile(fullPath, 'utf-8')
  }

  async listMemories(category?: string): Promise<string[]> {
    const searchDir = category
      ? join(this.memoryDir, category)
      : this.memoryDir

    if (!existsSync(searchDir)) return []

    const files = await readdir(searchDir, { recursive: true })
    return (files as string[])
      .filter(f => f.endsWith('.md'))
      .map(f => category ? `${category}/${f}` : f)
  }

  async deleteMemory(relativePath: string): Promise<void> {
    const fullPath = join(this.memoryDir, relativePath)
    if (!existsSync(fullPath)) throw new Error(`File not found: ${relativePath}`)
    await unlink(fullPath)

    // Remove all chunks from the embeddings DB
    if (this.table) {
      const escaped = relativePath.replace(/'/g, "''")
      await this.table.delete(`path = '${escaped}'`)
    }
    this.indexedAt.delete(relativePath)
  }

  async appendMemory(relativePath: string, content: string): Promise<void> {
    const fullPath = join(this.memoryDir, relativePath)
    await mkdir(dirname(fullPath), { recursive: true })
    const existing = existsSync(fullPath) ? await readFile(fullPath, 'utf-8') : ''
    const updated = existing ? existing.trimEnd() + '\n\n' + content : content
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
  }

  async editSection(relativePath: string, oldContent: string, newContent: string): Promise<boolean> {
    const fullPath = join(this.memoryDir, relativePath)
    if (!existsSync(fullPath)) return false

    const file = await readFile(fullPath, 'utf-8')
    const idx = file.indexOf(oldContent)
    if (idx === -1) return false

    // Replace in file
    const updated = file.slice(0, idx) + newContent + file.slice(idx + oldContent.length)
    await writeFile(fullPath, updated, 'utf-8')

    if (!this.table) return true

    // Delete old chunk from index, embed and add the new one
    const escapedPath = relativePath.replace(/'/g, "''")
    const escapedContent = oldContent.replace(/'/g, "''")
    await this.table.delete(`path = '${escapedPath}' AND content = '${escapedContent}'`)

    const chunks = chunkContent(newContent)
    if (chunks.length > 0) {
      const rows: { path: string; chunkIndex: number; content: string; vector: number[] }[] = []
      for (let i = 0; i < chunks.length; i++) {
        const vector = await this.embed(chunks[i])
        rows.push({ path: relativePath, chunkIndex: 9000 + i, content: chunks[i], vector })
      }
      await this.table.add(rows)
    }
    this.indexedAt.set(relativePath, Date.now())
    return true
  }

  async searchMemory(query: string, topK = 5): Promise<MemorySearchResult[]> {
    if (!this.table) throw new Error('MemoryStore not initialized')

    const embedding = await this.embed(query)
    const results = await this.table
      .vectorSearch(embedding)
      .limit(topK)
      .toArray()

    return results
      .filter(r => r.path && r.content)
      .filter(r => (r._distance as number ?? 999) < 1.0) // drop low-confidence matches
      .map(r => ({
        path: r.path as string,
        chunkIndex: (r.chunkIndex as number) ?? 0,
        content: r.content as string,
        score: (r._distance as number) ?? 0
      }))
  }

  // -------------------------------------------------------------------------
  // Indexing helpers
  // -------------------------------------------------------------------------

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
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async indexFile(relativePath: string, content: string): Promise<void> {
    if (!this.table) return

    const escaped = relativePath.replace(/'/g, "''")

    // Remove ALL existing chunks for this path before re-indexing
    await this.table.delete(`path = '${escaped}'`)

    const chunks = chunkContent(content)
    if (chunks.length === 0) return

    const rows: { path: string; chunkIndex: number; content: string; vector: number[] }[] = []

    for (let i = 0; i < chunks.length; i++) {
      // Sequential embedding to avoid Voyage rate-limit issues
      const vector = await this.embed(chunks[i])
      rows.push({ path: relativePath, chunkIndex: i, content: chunks[i], vector })
    }

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

  private async embed(text: string): Promise<number[]> {
    const embedUrl = getEmbedUrl()
    if (!embedUrl) {
      // Fallback: deterministic hash-based mock (no semantic meaning, but consistent)
      return new Array(EMBED_DIM).fill(0).map((_, i) => (text.charCodeAt(i % text.length) / 255))
    }

    const res = await fetch(embedUrl, {
      method: 'POST',
      headers: {
        'Authorization': getEmbedAuth(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ input: [text], model: EMBED_MODEL, dimensions: EMBED_DIM })
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Embedding failed: ${err}`)
    }

    const json = await res.json() as { data: { embedding: number[] }[] }
    return json.data[0].embedding
  }
}
