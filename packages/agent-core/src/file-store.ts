import Anthropic from '@anthropic-ai/sdk'
import { readFile, writeFile, mkdir, unlink, rename, readdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join, extname, basename, dirname } from 'path'
import type { FileEntry } from '@coagent/shared'
import { getRelayConfig } from './auth.js'
import { recordUsage } from './usage-tracker.js'

const INDEX_FILE = 'file-index.json'
const FILES_DIR = 'files'
const FOLDER_ORDER_FILE = 'folder-order.json'
const OPENAI_EMBED_URL = 'https://api.openai.com/v1/embeddings'
const getOpenAIKey = () => process.env.OPENAI_API_KEY ?? ''

function createAnthropicClient(): Anthropic {
  const relay = getRelayConfig()
  if (relay) {
    return new Anthropic({ baseURL: relay.url, apiKey: relay.token })
  }
  return new Anthropic()
}

// ── Internal index type (includes embedding, not sent to frontend) ────────────

interface FileIndexEntry extends FileEntry {
  embedding: number[]
  dirty?: boolean
}

// ── Index I/O ────────────────────────────────────────────────────────────────

async function readIndex(dataDir: string): Promise<FileIndexEntry[]> {
  const path = join(dataDir, INDEX_FILE)
  if (!existsSync(path)) return []
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Migration: default missing `type` to 'upload' so existing entries remain valid
    return (parsed as FileIndexEntry[]).map(e => e.type ? e : { ...e, type: 'upload' as const })
  } catch { return [] }
}

async function writeIndex(dataDir: string, entries: FileIndexEntry[]): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, INDEX_FILE), JSON.stringify(entries, null, 2), 'utf-8')
}

// ── Folder management ────────────────────────────────────────────────────────

export async function saveFolderOrder(dataDir: string, order: string[]): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, FOLDER_ORDER_FILE), JSON.stringify(order, null, 2), 'utf-8')
}

export async function loadFolderOrder(dataDir: string): Promise<string[]> {
  const path = join(dataDir, FOLDER_ORDER_FILE)
  if (!existsSync(path)) return []
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

export async function listFolders(dataDir: string): Promise<string[]> {
  const filesDir = join(dataDir, FILES_DIR)
  if (!existsSync(filesDir)) return []

  async function scan(dir: string, prefix: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true })
    const dirs = entries.filter(e => e.isDirectory())
    const result: string[] = []
    for (const d of dirs) {
      const fullPath = prefix ? `${prefix}/${d.name}` : d.name
      result.push(fullPath)
      const children = await scan(join(dir, d.name), fullPath)
      result.push(...children)
    }
    return result
  }

  const allPaths = await scan(filesDir, '')
  const savedOrder = await loadFolderOrder(dataDir)

  // Sort: saved-order items first (in order), remaining alphabetically
  const savedFiltered = savedOrder.filter(n => allPaths.includes(n))
  const remaining = allPaths.filter(n => !savedFiltered.includes(n)).sort()
  return [...savedFiltered, ...remaining]
}

export async function createFolder(dataDir: string, name: string): Promise<void> {
  const safeName = name.replace(/\.\./g, '').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/').trim()
  if (!safeName || safeName === '.' || safeName === '..') throw new Error('Invalid folder name')
  await mkdir(join(dataDir, FILES_DIR, ...safeName.split('/')), { recursive: true })
}

export async function deleteFolder(dataDir: string, name: string): Promise<void> {
  const safeName = name.replace(/\.\./g, '').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/').trim()
  if (!safeName) throw new Error('Invalid folder name')
  const folderPath = join(dataDir, FILES_DIR, ...safeName.split('/'))
  const rootFilesDir = join(dataDir, FILES_DIR)

  const index = await readIndex(dataDir)
  const filesInFolder = index.filter(e => e.group === safeName || e.group.startsWith(`${safeName}/`))

  // Compute resolved destination paths ONCE, before any renames happen
  const resolvedPaths = new Map<string, { path: string; filename: string }>()
  for (const entry of filesInFolder) {
    let destPath = join(rootFilesDir, entry.filename)
    let destFilename = entry.filename
    // Only deduplicate against files NOT in this folder (those will be moved away)
    if (existsSync(destPath) && destPath !== entry.path) {
      const ext = entry.filename.includes('.')
        ? entry.filename.slice(entry.filename.lastIndexOf('.'))
        : ''
      const base = entry.filename.slice(0, entry.filename.length - ext.length)
      destFilename = `${base}_${entry.id.slice(0, 8)}${ext}`
      destPath = join(rootFilesDir, destFilename)
    }
    resolvedPaths.set(entry.id, { path: destPath, filename: destFilename })
  }

  // Now do the physical renames using the precomputed paths
  for (const entry of filesInFolder) {
    const resolved = resolvedPaths.get(entry.id)!
    if (existsSync(entry.path)) {
      try {
        await rename(entry.path, resolved.path)
      } catch (err) {
        console.warn(`[FileStore] Could not move ${entry.filename} to root during folder delete: ${(err as Error).message}`)
      }
    }
  }

  // Update index using the precomputed paths (no existsSync re-evaluation)
  const updated = index.map(e => {
    const resolved = resolvedPaths.get(e.id)
    if (resolved) {
      return { ...e, group: '', path: resolved.path, filename: resolved.filename }
    }
    return e
  })
  await writeIndex(dataDir, updated)

  // Clean up folder-order.json
  const savedOrder = await loadFolderOrder(dataDir)
  const cleanedOrder = savedOrder.filter(p => p !== safeName && !p.startsWith(`${safeName}/`))
  await saveFolderOrder(dataDir, cleanedOrder)

  // Remove the now-empty directory
  if (existsSync(folderPath)) {
    try {
      await rm(folderPath, { recursive: true, force: true })
    } catch (err) {
      console.warn(`[FileStore] rm failed for ${folderPath}: ${(err as Error).message}`)
    }
  }

  console.log(`[FileStore] Deleted folder: ${safeName} (${filesInFolder.length} files moved to root)`)
}

export async function moveFolder(dataDir: string, folderPath: string, newParentPath: string): Promise<void> {
  const safefolderPath = folderPath.replace(/\.\./g, '').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/').trim()
  const safeNewParentPath = newParentPath.replace(/\.\./g, '').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/').trim()
  if (!safefolderPath) throw new Error('Invalid folder path')

  // e.g. safefolderPath="Reports", safeNewParentPath="Work" → moves to "Work/Reports"
  const folderName = safefolderPath.split('/').pop()!
  const newPath = safeNewParentPath ? `${safeNewParentPath}/${folderName}` : folderName

  if (newPath === safefolderPath) return  // no-op

  // Check that newPath is not a descendant of safefolderPath (can't move a folder into itself)
  if (newPath.startsWith(`${safefolderPath}/`)) {
    throw new Error('Cannot move a folder into one of its own subfolders')
  }

  const oldDir = join(dataDir, FILES_DIR, ...safefolderPath.split('/'))
  const newDir = join(dataDir, FILES_DIR, ...newPath.split('/'))
  const parentDir = join(dataDir, FILES_DIR, ...newPath.split('/').slice(0, -1))

  if (!existsSync(oldDir)) {
    throw new Error(`Folder not found: ${safefolderPath}`)
  }
  await mkdir(parentDir, { recursive: true })
  try {
    await rename(oldDir, newDir)
  } catch (err) {
    throw new Error(`Failed to move folder: ${(err as Error).message}`)
  }

  // Update all files whose group starts with safefolderPath
  const index = await readIndex(dataDir)
  const updated = index.map(e => {
    if (e.group === safefolderPath || e.group.startsWith(`${safefolderPath}/`)) {
      const newGroup = newPath + e.group.slice(safefolderPath.length)
      const newFilePath = join(dataDir, FILES_DIR, ...newGroup.split('/'), e.filename)
      return { ...e, group: newGroup, path: newFilePath }
    }
    return e
  })
  await writeIndex(dataDir, updated)

  const savedOrder = await loadFolderOrder(dataDir)
  const updatedOrder = savedOrder.map(p =>
    p === safefolderPath || p.startsWith(`${safefolderPath}/`)
      ? newPath + p.slice(safefolderPath.length)
      : p
  )
  await saveFolderOrder(dataDir, updatedOrder)

  console.log(`[FileStore] Moved folder: ${safefolderPath} → ${newPath}`)
}

export async function moveFile(dataDir: string, id: string, targetGroup: string): Promise<void> {
  const index = await readIndex(dataDir)
  const entry = index.find(e => e.id === id)
  if (!entry) throw new Error(`File ${id} not found`)

  // Sanitize the group path: allow slashes for nesting, but block traversal
  const safeGroup = targetGroup
    ? targetGroup.replace(/\.\./g, '').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/')
    : ''

  const targetDir = safeGroup
    ? join(dataDir, FILES_DIR, ...safeGroup.split('/'))
    : join(dataDir, FILES_DIR)
  await mkdir(targetDir, { recursive: true })
  const newPath = join(targetDir, entry.filename)

  if (entry.path !== newPath && existsSync(entry.path)) {
    try {
      await rename(entry.path, newPath)
    } catch (err) {
      throw new Error(`Failed to move file: ${(err as Error).message}`)
    }
  }

  const updated = index.map(e =>
    e.id === id ? { ...e, path: newPath, group: safeGroup } : e
  )
  await writeIndex(dataDir, updated)
}

// ── OpenAI embedding ──────────────────────────────────────────────────────────

async function embedText(text: string): Promise<number[]> {
  const res = await fetch(OPENAI_EMBED_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getOpenAIKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: [text], model: 'text-embedding-3-small', dimensions: 512 })
  })
  if (!res.ok) throw new Error(`OpenAI embedding error: ${res.status} ${res.statusText}`)
  const data = await res.json() as { data: { embedding: number[] }[] }
  const embedding = data.data?.[0]?.embedding
  if (!embedding) throw new Error('Unexpected OpenAI response shape')
  return embedding
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

// ── File content sampling — handles all file types ───────────────────────────

type SampleResult =
  | { type: 'text'; text: string }
  | { type: 'image'; base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }
  | { type: 'document'; base64: string; mediaType: 'application/pdf' }

async function sampleContent(filename: string, buffer: Buffer, mimeType: string): Promise<SampleResult> {
  const ext = extname(filename).toLowerCase()

  // Images — Claude reads natively
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
  if (mimeType.startsWith('image/') || imageExts.includes(ext)) {
    const mediaTypeMap: Record<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp'
    }
    return { type: 'image', base64: buffer.toString('base64'), mediaType: mediaTypeMap[ext] ?? 'image/jpeg' }
  }

  // PDF — Claude reads natively as a document block
  if (ext === '.pdf') {
    return { type: 'document', base64: buffer.toString('base64'), mediaType: 'application/pdf' }
  }

  // DOCX — extract text via mammoth
  if (ext === '.docx') {
    try {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ buffer })
      return { type: 'text', text: result.value.slice(0, 500) }
    } catch {
      return { type: 'text', text: '[DOCX — could not extract text]' }
    }
  }

  // XLSX / XLS
  if (ext === '.xlsx' || ext === '.xls') {
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(buffer, { type: 'buffer' })
      const sheetName = wb.SheetNames[0]
      if (sheetName) {
        const ws = wb.Sheets[sheetName]
        return { type: 'text', text: XLSX.utils.sheet_to_csv(ws).slice(0, 500) }
      }
    } catch { /* fall through */ }
    return { type: 'text', text: '[Excel — could not extract data]' }
  }

  // Text-based formats
  const textExts = ['.md', '.txt', '.html', '.htm', '.xml', '.yaml', '.yml', '.toml', '.env', '.ts', '.js', '.py', '.rb', '.go', '.rs', '.java', '.cpp', '.c', '.sh', '.csv', '.json']
  if (textExts.includes(ext) || mimeType.startsWith('text/')) {
    return { type: 'text', text: buffer.toString('utf-8').slice(0, 500) }
  }

  // Unknown — try UTF-8
  const sample = buffer.toString('utf-8').slice(0, 500)
  const binaryCharCount = (sample.match(/[\x00-\x08\x0e-\x1f\x7f-\x9f]/g) ?? []).length
  if (binaryCharCount > sample.length * 0.1) {
    return { type: 'text', text: 'Binary file — content not extractable for preview.' }
  }
  return { type: 'text', text: sample }
}

// ── Haiku summary ─────────────────────────────────────────────────────────────

async function generateSummary(
  dataDir: string,
  filename: string,
  sample: SampleResult
): Promise<string> {
  const anthropic = createAnthropicClient()

  const prompt = `You are analyzing a file to generate a brief summary.

File: ${filename}

Write ONE sentence summarizing what this file is. Be concise. Respond with the summary text only, no JSON.`

  const content: any =
    sample.type === 'image'
      ? [
          { type: 'image', source: { type: 'base64', media_type: sample.mediaType, data: sample.base64 } },
          { type: 'text', text: prompt }
        ]
      : sample.type === 'document'
        ? [
            { type: 'document', source: { type: 'base64', media_type: sample.mediaType, data: sample.base64 } },
            { type: 'text', text: prompt }
          ]
        : [{ type: 'text', text: `${prompt}\n\nFile contents (sample):\n${sample.text}` }]

  const response = await anthropic.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 256,
    messages: [{ role: 'user', content }]
  })

  recordUsage(dataDir, {
    category: 'file_ingestion',
    model: 'claude-3-5-haiku-20241022',
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: (response.usage as any).cache_read_input_tokens ?? 0,
    cacheCreationTokens: (response.usage as any).cache_creation_input_tokens ?? 0,
    timestamp: new Date().toISOString(),
  }).catch(() => {})

  const block = response.content[0]
  if (!block || block.type !== 'text') throw new Error('Unexpected Anthropic response content type')
  return block.text.trim().slice(0, 300) || 'No summary available.'
}

// ── K-means clustering ────────────────────────────────────────────────────────

function kmeans(vectors: number[][], k: number, maxIter = 20): number[] {
  const n = vectors.length
  const dim = vectors[0].length

  // Initialize centroids by picking k random points
  const indices = [...Array(n).keys()]
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }
  const centroids = indices.slice(0, k).map(i => [...vectors[i]])
  const assignments = new Array<number>(n).fill(0)

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false
    for (let i = 0; i < n; i++) {
      let bestSim = -Infinity
      let bestCluster = 0
      for (let c = 0; c < k; c++) {
        const sim = cosine(vectors[i], centroids[c])
        if (sim > bestSim) { bestSim = sim; bestCluster = c }
      }
      if (assignments[i] !== bestCluster) { assignments[i] = bestCluster; changed = true }
    }
    if (!changed) break

    // Recompute centroids
    for (let c = 0; c < k; c++) {
      const members = vectors.filter((_, i) => assignments[i] === c)
      if (members.length === 0) continue
      for (let d = 0; d < dim; d++) {
        centroids[c][d] = members.reduce((sum, v) => sum + v[d], 0) / members.length
      }
    }
  }

  return assignments
}

// ── Auto-organize ─────────────────────────────────────────────────────────────

export async function autoOrganizeFiles(
  dataDir: string
): Promise<{ folders: string[]; moved: number }> {
  const index = await readIndex(dataDir)
  // Only organize loose files (not already in a folder)
  const withEmbeddings = index.filter(e => e.embedding.length > 0 && !e.group)

  if (withEmbeddings.length < 3) {
    throw new Error('Need at least 3 loose files to auto-organize')
  }

  const k = Math.max(2, Math.min(10, Math.ceil(withEmbeddings.length / 3)))
  const vectors = withEmbeddings.map(e => e.embedding)
  const assignments = kmeans(vectors, k)

  // Group files by cluster
  const clusters = new Map<number, FileIndexEntry[]>()
  for (let i = 0; i < withEmbeddings.length; i++) {
    const c = assignments[i]
    if (!clusters.has(c)) clusters.set(c, [])
    clusters.get(c)!.push(withEmbeddings[i])
  }

  // Drop empty clusters (k-means can leave some empty)
  for (const [id, files] of clusters) {
    if (files.length === 0) clusters.delete(id)
  }

  // Ask Haiku to name the clusters
  const clusterDescriptions = [...clusters.entries()]
    .map(([id, files]) => {
      const fileList = files.map(f => `  - ${f.filename}: ${f.summary}`).join('\n')
      return `Cluster ${id} (${files.length} files):\n${fileList}`
    })
    .join('\n\n')

  const anthropic = createAnthropicClient()
  const response = await anthropic.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `Name each file cluster with a short, descriptive folder name (1-2 words, Title Case, e.g. "Reports", "Contracts", "Images"). Each name must be unique.\n\nRespond with JSON only, no markdown fences:\n{"clusters":{"0":"FolderName","1":"FolderName"}}\n\n${clusterDescriptions}`
    }]
  })

  recordUsage(dataDir, {
    category: 'file_ingestion',
    model: 'claude-3-5-haiku-20241022',
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: (response.usage as any).cache_read_input_tokens ?? 0,
    cacheCreationTokens: (response.usage as any).cache_creation_input_tokens ?? 0,
    timestamp: new Date().toISOString(),
  }).catch(() => {})

  const rawText = response.content[0]?.type === 'text' ? response.content[0].text : ''
  const cleanText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  let clusterNames: Record<string, string> = {}
  try {
    clusterNames = JSON.parse(cleanText).clusters ?? {}
  } catch {
    // Fallback: generic names
    for (const id of clusters.keys()) clusterNames[String(id)] = `Group ${id + 1}`
  }

  // Batch move: create folders, move files, update index
  const filesDir = join(dataDir, FILES_DIR)
  const folderSet = new Set<string>()
  let moved = 0

  for (const [clusterId, files] of clusters) {
    const folderName = (clusterNames[String(clusterId)] ?? `Group ${clusterId + 1}`)
      .replace(/\.\./g, '').replace(/^\/+|\/+$/g, '').trim()
    if (!folderName) continue
    folderSet.add(folderName)

    const targetDir = join(filesDir, folderName)
    await mkdir(targetDir, { recursive: true })

    for (const file of files) {
      const newPath = join(targetDir, file.filename)
      if (file.path === newPath) continue // already there
      if (existsSync(file.path)) {
        try {
          await rename(file.path, newPath)
          file.path = newPath
          file.group = folderName
          moved++
        } catch (err) {
          console.warn(`[FileStore] Auto-organize move failed for ${file.filename}: ${(err as Error).message}`)
        }
      }
    }
  }

  // Write updated index
  await writeIndex(dataDir, index)

  // Save folder order
  const existingOrder = await loadFolderOrder(dataDir)
  const newFolders = [...folderSet].filter(f => !existingOrder.includes(f))
  if (newFolders.length > 0) {
    await saveFolderOrder(dataDir, [...existingOrder, ...newFolders])
  }

  console.log(`[FileStore] Auto-organized ${moved} files into ${folderSet.size} folders`)
  return { folders: [...folderSet], moved }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function ingestFile(
  dataDir: string,
  filename: string,
  buffer: Buffer,
  mimeType: string,
  group?: string
): Promise<FileEntry> {
  const sample = await sampleContent(filename, buffer, mimeType)
  const summary = await generateSummary(dataDir, filename, sample)

  // Save file to the target folder (or root if no group)
  const safeFilename = basename(filename)
  const safeGroup = group
    ? group.replace(/\.\./g, '').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/')
    : ''
  const targetDir = safeGroup
    ? join(dataDir, FILES_DIR, ...safeGroup.split('/'))
    : join(dataDir, FILES_DIR)
  await mkdir(targetDir, { recursive: true })
  const filePath = join(targetDir, safeFilename)
  await writeFile(filePath, buffer)

  // Embed the summary (fall back gracefully if no Voyage key)
  let embedding: number[] = []
  if (getOpenAIKey()) {
    try {
      embedding = await embedText(`${safeGroup ? safeGroup + '/' : ''}${filename} ${summary}`)
    } catch (err) {
      console.warn('[FileStore] OpenAI embedding failed, falling back to keyword search:', (err as Error).message)
    }
  }

  const entry: FileIndexEntry = {
    id: crypto.randomUUID(),
    type: 'upload',
    filename: safeFilename,
    path: filePath,
    addedAt: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
    summary,
    group: safeGroup,
    sizeBytes: buffer.length,
    embedding
  }

  const index = await readIndex(dataDir)
  index.push(entry)
  await writeIndex(dataDir, index)

  console.log(`[FileStore] Ingested: ${safeFilename} (${buffer.length} bytes)`)

  const { embedding: _, ...fileEntry } = entry
  return fileEntry
}




export async function listFiles(dataDir: string): Promise<FileEntry[]> {
  const index = await readIndex(dataDir)
  // Strip internal-only fields (embedding, dirty) before sending to frontend
  return index.map(({ embedding: _, dirty: __, ...entry }) => entry)
}

function keywordMatch(entry: FileIndexEntry, q: string): boolean {
  const haystack = `${entry.group} ${entry.filename} ${entry.summary}`.toLowerCase()
  // Match if ALL query words appear somewhere in the haystack
  const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 1)
  if (words.length === 0) return false
  return words.some(w => haystack.includes(w))
}

export async function searchFiles(dataDir: string, query: string, limit = 5): Promise<FileEntry[]> {
  if (!getOpenAIKey()) {
    const index = await readIndex(dataDir)
    const q = query.toLowerCase()
    return index
      .filter(e => keywordMatch(e, q))
      .slice(0, limit)
      .map(({ embedding: _, dirty: __, ...entry }) => entry)
  }

  let queryEmb: number[]
  try {
    queryEmb = await embedText(query)
  } catch (err) {
    console.warn('[FileStore] OpenAI search failed, falling back to keyword search:', (err as Error).message)
    const index = await readIndex(dataDir)
    const q = query.toLowerCase()
    return index
      .filter(e => keywordMatch(e, q))
      .slice(0, limit)
      .map(({ embedding: _, dirty: __, ...entry }) => entry)
  }
  const index = await readIndex(dataDir)
  const q = query.toLowerCase()

  const scored = index.map(e => {
    const embScore = e.embedding.length > 0 ? cosine(queryEmb, e.embedding) : 0
    // Hybrid: boost entries with keyword matches in filename/folder/summary
    const kwBoost = keywordMatch(e, q) ? 0.3 : 0
    return { entry: e, score: embScore + kwBoost }
  })
  scored.sort((a, b) => b.score - a.score)

  // Filter out low-relevance results — only return files with meaningful similarity
  const top = scored.filter(s => s.score > 0.15).slice(0, limit)
  const topIds = new Set(top.map(s => s.entry.id))
  const updated = index.map(e => topIds.has(e.id) ? { ...e, lastAccessed: new Date().toISOString() } : e)
  await writeIndex(dataDir, updated)

  return top.map(({ entry: { embedding: _, dirty: __, ...entry } }) => entry)
}

export async function readFileBase64(dataDir: string, id: string): Promise<{ base64: string; filename: string; mimeType: string }> {
  const index = await readIndex(dataDir)
  const entry = index.find(e => e.id === id)
  if (!entry) throw new Error(`File ${id} not found`)
  const buffer = await readFile(entry.path)
  const ext = extname(entry.filename).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.pdf': 'application/pdf', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel', '.csv': 'text/csv',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
    '.html': 'text/html', '.zip': 'application/zip',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  return { base64: buffer.toString('base64'), filename: entry.filename, mimeType: mimeTypes[ext] ?? 'application/octet-stream' }
}

export async function readFileContent(dataDir: string, id: string): Promise<string> {
  const index = await readIndex(dataDir)
  const entry = index.find(e => e.id === id)
  if (!entry) throw new Error(`File ${id} not found`)

  const updated = index.map(e => e.id === id ? { ...e, lastAccessed: new Date().toISOString() } : e)
  await writeIndex(dataDir, updated)

  const buffer = await readFile(entry.path)
  const ext = extname(entry.filename).toLowerCase()

  if (ext === '.pdf') {
    try {
      const pdfParse = (await import('pdf-parse')).default
      const data = await pdfParse(buffer)
      return data.text
    } catch {
      return buffer.toString('utf-8')
    }
  }

  if (ext === '.docx') {
    try {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ buffer })
      return result.value
    } catch {
      return buffer.toString('utf-8')
    }
  }

  if (ext === '.xlsx' || ext === '.xls') {
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(buffer, { type: 'buffer' })
      const sheetName = wb.SheetNames[0]
      if (sheetName) {
        const ws = wb.Sheets[sheetName]
        return XLSX.utils.sheet_to_csv(ws)
      }
    } catch { /* fall through */ }
  }

  return buffer.toString('utf-8')
}

export async function renameFile(dataDir: string, id: string, newName: string): Promise<void> {
  const index = await readIndex(dataDir)
  const entry = index.find(e => e.id === id)
  if (!entry) throw new Error(`File ${id} not found`)

  const safeNewName = basename(newName).trim()
  if (!safeNewName) throw new Error('Invalid filename')

  const newPath = join(dirname(entry.path), safeNewName)
  if (existsSync(entry.path)) {
    try {
      await rename(entry.path, newPath)
    } catch (err) {
      throw new Error(`Failed to rename file: ${(err as Error).message}`)
    }
  }

  const updated = index.map(e => e.id === id ? { ...e, filename: safeNewName, path: newPath } : e)
  await writeIndex(dataDir, updated)
}

export async function renameFolder(dataDir: string, oldName: string, newName: string): Promise<void> {
  const safeOldName = oldName.replace(/\.\./g, '').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/').trim()
  if (!safeOldName) throw new Error('Invalid folder name')

  // Preserve parent path — only rename the leaf segment
  const parentDir = safeOldName.includes('/') ? safeOldName.split('/').slice(0, -1).join('/') : ''
  const safeLeaf = basename(newName).trim()
  if (!safeLeaf || safeLeaf === '.' || safeLeaf === '..') throw new Error('Invalid folder name')
  const safeName = parentDir ? `${parentDir}/${safeLeaf}` : safeLeaf

  const oldPath = join(dataDir, FILES_DIR, ...safeOldName.split('/'))
  const newPath = join(dataDir, FILES_DIR, ...safeName.split('/'))
  if (existsSync(oldPath)) {
    try {
      await rename(oldPath, newPath)
    } catch (err) {
      throw new Error(`Failed to rename folder: ${(err as Error).message}`)
    }
  }

  const index = await readIndex(dataDir)
  const updated = index.map(e => {
    if (e.group === safeOldName || e.group.startsWith(`${safeOldName}/`)) {
      const newGroup = safeName + e.group.slice(safeOldName.length)
      const newFilePath = join(dataDir, FILES_DIR, ...newGroup.split('/'), e.filename)
      return { ...e, group: newGroup, path: newFilePath }
    }
    return e
  })
  await writeIndex(dataDir, updated)

  const savedOrder = await loadFolderOrder(dataDir)
  const updatedOrder = savedOrder.map(p =>
    p === safeOldName || p.startsWith(`${safeOldName}/`)
      ? safeName + p.slice(safeOldName.length)
      : p
  )
  await saveFolderOrder(dataDir, updatedOrder)
}

export async function deleteFileEntry(dataDir: string, id: string): Promise<void> {
  const index = await readIndex(dataDir)
  const entry = index.find(e => e.id === id)
  if (!entry) return

  if (existsSync(entry.path)) {
    await unlink(entry.path).catch(() => {})
  }

  await writeIndex(dataDir, index.filter(e => e.id !== id))
  console.log(`[FileStore] Deleted: ${entry.filename}`)
}

export async function getStorageStats(dataDir: string): Promise<{
  totalFiles: number
  totalBytes: number
  largestFiles: { filename: string; sizeBytes: number }[]
}> {
  const index = await readIndex(dataDir)
  const totalBytes = index.reduce((sum, e) => sum + e.sizeBytes, 0)
  const largestFiles = [...index]
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 5)
    .map(e => ({ filename: e.filename, sizeBytes: e.sizeBytes }))

  return { totalFiles: index.length, totalBytes, largestFiles }
}
