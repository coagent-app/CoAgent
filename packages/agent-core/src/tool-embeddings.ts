import Anthropic from '@anthropic-ai/sdk'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

const OPENAI_EMBED_URL = 'https://api.openai.com/v1/embeddings'
const getOpenAIKey = () => process.env.OPENAI_API_KEY ?? ''
const CACHE_FILE = 'tool-embeddings.json'

interface ToolEmbedding {
  name: string
  embedding: number[]
}

interface DiskCache {
  toolKey: string
  embeddings: ToolEmbedding[]
}

let cache: ToolEmbedding[] = []
let cachedToolKey: string | null = null
let dataDir: string | null = null

/** Set the data directory for disk persistence */
export function setToolEmbeddingsDir(dir: string): void {
  dataDir = dir
}

async function loadFromDisk(): Promise<DiskCache | null> {
  if (!dataDir) return null
  const path = join(dataDir, CACHE_FILE)
  if (!existsSync(path)) return null
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as DiskCache
  } catch { return null }
}

async function saveToDisk(toolKey: string, embeddings: ToolEmbedding[]): Promise<void> {
  if (!dataDir) return
  await mkdir(dataDir, { recursive: true })
  const data: DiskCache = { toolKey, embeddings }
  await writeFile(join(dataDir, CACHE_FILE), JSON.stringify(data), 'utf-8')
}

export async function embed(texts: string[]): Promise<number[][]> {
  const key = getOpenAIKey()
  if (!key) return texts.map(() => [])
  const res = await fetch(OPENAI_EMBED_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: texts, model: 'text-embedding-3-small', dimensions: 512 })
  })
  if (!res.ok) throw new Error(`OpenAI embedding error: ${res.status}`)
  const data = await res.json() as { data: { embedding: number[] }[] }
  return data.data.map(d => d.embedding)
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

function humanize(name: string): string {
  return name.toLowerCase().replace(/_/g, ' ')
}

/**
 * Embed tool names + descriptions. Checks disk cache first, only calls OpenAI if tools changed.
 */
export async function embedTools(tools: Anthropic.Tool[]): Promise<void> {
  if (!getOpenAIKey()) return
  const toolKey = tools.map(t => t.name).sort().join(',')

  // Already in memory
  if (toolKey === cachedToolKey && cache.length > 0) return

  // Try disk cache
  const disk = await loadFromDisk()
  if (disk && disk.toolKey === toolKey) {
    cache = disk.embeddings
    cachedToolKey = toolKey
    console.log(`[ToolEmbed] Loaded ${cache.length} tool embeddings from cache`)
    return
  }

  // Embed fresh — combine name + description for much better semantic separation
  const names = tools.map(t => t.name)
  const texts = tools.map(t => {
    const name = humanize(t.name)
    const desc = t.description ? ` — ${t.description}` : ''
    return `${name}${desc}`
  })
  try {
    const embeddings = await embed(texts)
    cache = names.map((name, i) => ({ name, embedding: embeddings[i] }))
    cachedToolKey = toolKey
    await saveToDisk(toolKey, cache)
    console.log(`[ToolEmbed] Embedded ${cache.length} tools with descriptions (saved to disk)`)
  } catch (err) {
    console.warn('[ToolEmbed] Failed to embed tools:', (err as Error).message)
  }
}

/**
 * Search tools by semantic similarity to a query.
 * Falls back to keyword matching if no embeddings available.
 */
export async function searchToolsByEmbedding(
  query: string,
  tools: Anthropic.Tool[],
  limit = 8
): Promise<Anthropic.Tool[]> {
  const toolMap = new Map(tools.map(t => [t.name, t]))

  if (cache.length > 0 && getOpenAIKey()) {
    try {
      const [queryEmb] = await embed([query])
      const scored = cache
        .filter(t => toolMap.has(t.name))
        .map(t => ({ name: t.name, score: cosine(queryEmb, t.embedding) }))
        .sort((a, b) => b.score - a.score)

      // Take top results above threshold, with a gap detector:
      // if there's a sharp score drop (>0.10) between adjacent results, cut there
      const results: Anthropic.Tool[] = []
      for (let i = 0; i < scored.length && results.length < limit; i++) {
        if (scored[i].score < 0.45) break
        // Gap detection: if score drops sharply from previous, stop
        if (i > 0 && results.length >= 2 && (scored[i - 1].score - scored[i].score) > 0.10) break
        const tool = toolMap.get(scored[i].name)
        if (tool) results.push(tool)
      }

      if (results.length > 0) {
        console.log(`[ToolEmbed] Query "${query}" → ${scored.slice(0, results.length).map(s => `${s.name}(${s.score.toFixed(2)})`).join(', ')}`)
        return results
      }
    } catch (err) {
      console.warn('[ToolEmbed] Search failed, falling back to keywords:', (err as Error).message)
    }
  }

  // Fallback: basic keyword match
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  if (words.length === 0) return tools.slice(0, limit)

  const scored = tools.map(tool => {
    const name = tool.name.toLowerCase().replace(/_/g, ' ')
    const desc = (tool.description ?? '').toLowerCase()
    let score = 0
    for (const w of words) {
      if (name.includes(w)) score += 4
      else if (desc.includes(w)) score += 1
    }
    return { tool, score }
  })

  return scored
    .filter(s => s.score >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.tool)
}

/** Clear caches (e.g. when integrations change) */
export function clearToolEmbeddings(): void {
  cache = []
  cachedToolKey = null
}
