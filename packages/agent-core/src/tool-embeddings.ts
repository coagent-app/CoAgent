import Anthropic from '@anthropic-ai/sdk'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { createHash } from 'crypto'
import { connect, Table } from '@lancedb/lancedb'
import { getOpenAIProxy } from './auth.js'

const EMBED_DIM = 512
const EMBED_CACHE_MAX = 500

/** In-memory LRU cache: SHA-256(text) → embedding vector */
const embedCache = new Map<string, number[]>()

let table: Table | null = null
let paramTable: Table | null = null
let cachedToolHash: string | null = null
let dataDir: string | null = null

/** Set the data directory for disk persistence */
export function setToolEmbeddingsDir(dir: string): void {
  dataDir = dir
}

export async function embed(texts: string[]): Promise<number[][]> {
  const proxy = getOpenAIProxy()
  if (!proxy) return texts.map(() => [])

  // Check cache for each text
  const keys = texts.map(t => createHash('sha256').update(t).digest('hex'))
  const results: (number[] | null)[] = keys.map(k => embedCache.get(k) ?? null)
  const missIndices = results.map((r, i) => r === null ? i : -1).filter(i => i >= 0)

  if (missIndices.length > 0) {
    const missTexts = missIndices.map(i => texts[i])
    const res = await fetch(`${proxy.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { Authorization: proxy.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: missTexts, model: 'text-embedding-3-small', dimensions: EMBED_DIM })
    })
    if (!res.ok) throw new Error(`Embedding error: ${res.status}`)
    const data = await res.json() as { data: { embedding: number[] }[] }

    for (let j = 0; j < missIndices.length; j++) {
      const i = missIndices[j]
      const vec = data.data[j].embedding
      // Evict oldest entry if at capacity
      if (embedCache.size >= EMBED_CACHE_MAX) {
        embedCache.delete(embedCache.keys().next().value!)
      }
      embedCache.set(keys[i], vec)
      results[i] = vec
    }
  }

  return results as number[][]
}

function humanize(name: string): string {
  return name.toLowerCase().replace(/_/g, ' ')
}

async function getTable(): Promise<Table | null> {
  if (table) return table
  if (!dataDir) return null
  const dbDir = join(dataDir, 'tool-embeddings-db')
  await mkdir(dbDir, { recursive: true })
  const db = await connect(dbDir)
  const tables = await db.tableNames()
  if (tables.includes('tools')) {
    table = await db.openTable('tools')
  }
  return table
}

async function createTable(rows: { name: string; text: string; vector: number[] }[]): Promise<void> {
  if (!dataDir) return
  const dbDir = join(dataDir, 'tool-embeddings-db')
  await mkdir(dbDir, { recursive: true })
  const db = await connect(dbDir)
  // Drop old table if exists
  const tables = await db.tableNames()
  if (tables.includes('tools')) await db.dropTable('tools')
  table = await db.createTable('tools', rows)
}

async function createParamTable(rows: { tool: string; param: string; required: number; text: string; vector: number[] }[]): Promise<void> {
  if (!dataDir) return
  const dbDir = join(dataDir, 'tool-embeddings-db')
  await mkdir(dbDir, { recursive: true })
  const db = await connect(dbDir)
  const tables = await db.tableNames()
  if (tables.includes('params')) await db.dropTable('params')
  paramTable = await db.createTable('params', rows)
}

async function getParamTable(): Promise<Table | null> {
  if (paramTable) return paramTable
  if (!dataDir) return null
  const dbDir = join(dataDir, 'tool-embeddings-db')
  const db = await connect(dbDir)
  const tables = await db.tableNames()
  if (tables.includes('params')) {
    paramTable = await db.openTable('params')
  }
  return paramTable
}

/** Batch embed — OpenAI accepts up to 2048 inputs per call */
async function embedBatched(texts: string[], batchSize = 2000): Promise<number[][]> {
  if (texts.length <= batchSize) return embed(texts)
  const results: number[][] = []
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)
    const batchResults = await embed(batch)
    results.push(...batchResults)
  }
  return results
}

/** Build embeddable text for a tool (tool-level) */
function toolEmbedText(t: Anthropic.Tool): string {
  const name = humanize(t.name)
  const desc = t.description ? ` — ${t.description}` : ''
  const schema = t.input_schema as any
  let paramText = ''
  if (schema?.properties) {
    const parts = Object.entries(schema.properties).map(([k, v]: [string, any]) => {
      const pdesc = v.description ? `: ${v.description.slice(0, 80)}` : ''
      return `${k.replace(/_/g, ' ')}${pdesc}`
    })
    paramText = ` — params: ${parts.join(', ')}`
  }
  return `${name}${desc}${paramText}`
}

/** Build embeddable entries for a tool's params (param-level) */
function paramEmbedEntries(t: Anthropic.Tool): { tool: string; param: string; required: number; text: string }[] {
  const schema = t.input_schema as any
  if (!schema?.properties) return []
  const reqSet = new Set(schema.required || [])
  return Object.entries(schema.properties).map(([k, v]: [string, any]) => {
    const desc = v.description ? ` — ${v.description.slice(0, 120)}` : ''
    const type = v.type ? ` (${v.type})` : ''
    const enumVals = v.enum ? ` [${v.enum.slice(0, 5).join(', ')}]` : ''
    return {
      tool: t.name,
      param: k,
      required: reqSet.has(k) ? 1 : 0,
      text: `${humanize(t.name)} ${k.replace(/_/g, ' ')}${type}${desc}${enumVals}`
    }
  })
}

/**
 * Embed tools and their individual params into two LanceDB tables:
 * - `tools` table: one row per tool (name + desc + param summary) for tool discovery
 * - `params` table: one row per param per tool for precise schema lookup
 *
 * Incremental: only embeds new tools, removes stale ones. Existing embeddings are kept.
 */
export async function embedTools(tools: Anthropic.Tool[]): Promise<void> {
  if (!getOpenAIProxy()) return

  // Content hash includes names + descriptions so changes to either trigger a re-embed
  const toolHash = createHash('sha256')
    .update(tools.map(t => `${t.name}:${t.description ?? ''}`).sort().join('\n'))
    .digest('hex')

  // Already indexed with same tool content
  if (toolHash === cachedToolHash && table && paramTable) {
    console.log('[tool-embeddings] Tools unchanged, skipping re-embed')
    return
  }

  const currentNames = new Set(tools.map(t => t.name))
  const toolsByName = new Map(tools.map(t => [t.name, t]))

  // Try incremental update on existing tables
  const existingToolTable = await getTable()
  const existingParamTable = await getParamTable()

  if (existingToolTable && existingParamTable) {
    try {
      // Quick check: if row count matches tool count, assume same set (cache key handles exact matching)
      const existingCount = await existingToolTable.countRows()
      if (existingCount === tools.length) {
        const paramCount = await existingParamTable.countRows()
        cachedToolHash = toolHash
        console.log(`[ToolEmbed] Loaded ${existingCount} tools + ${paramCount} params from LanceDB`)
        return
      }

      // Row count differs — need to diff. Use filter query to list all tool names.
      const existingRows = await existingToolTable.query().select(['name']).limit(100000).toArray()
      const existingNames = new Set(existingRows.map(r => r.name as string))

      const toAdd = tools.filter(t => !existingNames.has(t.name))
      const toRemove = [...existingNames].filter(n => !currentNames.has(n))

      // Remove stale tools + their params
      for (const name of toRemove) {
        await existingToolTable.delete(`name = '${name.replace(/'/g, "''")}'`)
        await existingParamTable.delete(`tool = '${name.replace(/'/g, "''")}'`)
      }

      // Embed only new tools
      if (toAdd.length > 0) {
        const newToolTexts = toAdd.map(toolEmbedText)
        const newParamEntries = toAdd.flatMap(paramEmbedEntries)

        const [newToolEmbs, newParamEmbs] = await Promise.all([
          embed(newToolTexts),
          newParamEntries.length > 0 ? embedBatched(newParamEntries.map(p => p.text)) : Promise.resolve([])
        ])

        const newToolRows = toAdd.map((t, i) => ({ name: t.name, text: newToolTexts[i], vector: newToolEmbs[i] }))
        const newParamRows = newParamEntries.map((p, i) => ({
          tool: p.tool, param: p.param, required: p.required, text: p.text, vector: newParamEmbs[i]
        }))

        await existingToolTable.add(newToolRows)
        if (newParamRows.length > 0) await existingParamTable.add(newParamRows)

        console.log(`[ToolEmbed] Incremental: +${toAdd.length} tools, -${toRemove.length} tools, ${newParamRows.length} new params`)
      } else {
        console.log(`[ToolEmbed] Incremental: removed ${toRemove.length} stale tools`)
      }

      // Compact fragments to reclaim disk space (LanceDB accumulates .lance files on every delete+add)
      if (toRemove.length > 0 || toAdd.length > 0) {
        try {
          await Promise.all([
            existingToolTable.optimize(),
            existingParamTable.optimize(),
          ])
          console.log('[ToolEmbed] Compacted tables')
        } catch (err) {
          console.warn('[ToolEmbed] Compaction failed (non-critical):', (err as Error).message)
        }
      }

      cachedToolHash = toolHash
      return
    } catch (err) {
      console.warn('[ToolEmbed] Incremental update failed, rebuilding:', (err as Error).message)
    }
  }

  // ── Full rebuild (first run or recovery) ──
  const toolTexts = tools.map(toolEmbedText)
  const paramEntries = tools.flatMap(paramEmbedEntries)

  try {
    const [toolEmbeddings, paramEmbeddings] = await Promise.all([
      embed(toolTexts),
      embedBatched(paramEntries.map(p => p.text))
    ])

    const toolRows = tools.map((t, i) => ({ name: t.name, text: toolTexts[i], vector: toolEmbeddings[i] }))
    const paramRows = paramEntries.map((p, i) => ({
      tool: p.tool, param: p.param, required: p.required, text: p.text, vector: paramEmbeddings[i]
    }))

    await Promise.all([
      createTable(toolRows),
      createParamTable(paramRows)
    ])

    cachedToolHash = toolHash
    console.log(`[ToolEmbed] Full rebuild: ${toolRows.length} tools + ${paramRows.length} params (LanceDB)`)
  } catch (err) {
    console.warn('[ToolEmbed] Failed to embed tools:', (err as Error).message)
  }
}

/** Score helper: L2 squared distance → cosine similarity */
function distToScore(d: number): number { return 1 - (d ?? 999) / 2 }

/**
 * Combined tool + schema search in ONE embed API call.
 *
 * 1. Embeds [query, schema] together (1 API call)
 * 2. Searches tools table with query embedding → candidate tools
 * 3. Searches params table with schema embedding → best params per tool
 * 4. Ranks by max(tool_score, best_param_score) — strongest signal wins
 * 5. Returns matched tools + only the relevant params for the top matches
 *
 * Falls back to keyword matching if no embeddings available.
 */
export async function searchToolsAndSchema(
  query: string,
  schema: string,
  tools: Anthropic.Tool[],
  toolLimit = 5,
  schemaLimit = 2
): Promise<{
  matches: Anthropic.Tool[];
  schemas: { tool: string; params: string[]; score: number }[];
}> {
  const toolMap = new Map(tools.map(t => [t.name, t]))

  if (table && getOpenAIProxy()) {
    try {
      // ONE embed call for both query and schema
      const [queryEmb, schemaEmb] = await embed([query, schema])

      // ── Tool-level search (query embedding) ──
      const toolResults = await table
        .vectorSearch(queryEmb)
        .limit(toolLimit * 3)
        .toArray()

      const toolScored = new Map<string, number>()
      for (const r of toolResults) {
        if (toolMap.has(r.name as string)) {
          toolScored.set(r.name as string, distToScore(r._distance as number))
        }
      }

      // ── Param-level search (schema embedding) ──
      const pTable = await getParamTable()
      const paramBestScore = new Map<string, number>()
      const paramDetails = new Map<string, { param: string; score: number; required: boolean }[]>()

      if (pTable) {
        const paramResults = await pTable
          .vectorSearch(schemaEmb)
          .limit(100)
          .toArray()

        for (const r of paramResults) {
          const tool = r.tool as string
          if (!toolMap.has(tool)) continue
          const score = distToScore(r._distance as number)

          if (!paramBestScore.has(tool) || score > paramBestScore.get(tool)!) {
            paramBestScore.set(tool, score)
          }
          if (!paramDetails.has(tool)) paramDetails.set(tool, [])
          paramDetails.get(tool)!.push({
            param: r.param as string,
            score,
            required: r.required === 1
          })
        }
      }

      // ── Max scoring: strongest signal wins ──
      const allToolNames = new Set([...toolScored.keys(), ...paramBestScore.keys()])
      const maxScored = [...allToolNames]
        .map(name => ({
          name,
          toolScore: toolScored.get(name) ?? 0,
          paramScore: paramBestScore.get(name) ?? 0,
          score: Math.max(toolScored.get(name) ?? 0, paramBestScore.get(name) ?? 0)
        }))
        .sort((a, b) => b.score - a.score)

      // Take top tools above threshold
      const matched: Anthropic.Tool[] = []
      for (let i = 0; i < maxScored.length && matched.length < toolLimit; i++) {
        if (maxScored[i].score < 0.45) break
        if (i > 0 && matched.length >= 2 && (maxScored[i - 1].score - maxScored[i].score) > 0.10) break
        const tool = toolMap.get(maxScored[i].name)
        if (tool) matched.push(tool)
      }

      if (matched.length > 0) {
        console.log(`[ToolEmbed] "${query}" → ${maxScored.slice(0, matched.length).map(s =>
          `${s.name}(max=${s.score.toFixed(2)}, tool=${s.toolScore.toFixed(2)}, param=${s.paramScore.toFixed(2)})`
        ).join(', ')}`)
      }

      // ── Schema results: top tools + filtered params ──
      const schemas: { tool: string; params: string[]; score: number }[] = []
      const topForSchema = maxScored.slice(0, schemaLimit).filter(s => s.score > 0.35)

      // Tools with complex schemas that need all params shown (no filtering)
      const FULL_SCHEMA_PREFIXES = ['GOOGLESHEETS_', 'EXCEL_']

      for (const { name, score } of topForSchema) {
        const showAll = FULL_SCHEMA_PREFIXES.some(p => name.startsWith(p))

        if (showAll) {
          // Return empty params array — formatSchemaForResult shows all params when empty
          console.log(`[ToolEmbed] Schema "${schema}" → ${name}(${score.toFixed(2)}): FULL SCHEMA (complex tool)`)
          schemas.push({ tool: name, params: [], score })
        } else {
          const details = paramDetails.get(name) || []
          const requiredParams = details.filter(d => d.required).map(d => d.param)
          // Always include top params by score so the agent has enough to call the tool
          const topOptional = details
            .filter(d => !d.required)
            .sort((a, b) => b.score - a.score)
            .slice(0, 8)
            .map(d => d.param)
          const allParams = [...new Set([...requiredParams, ...topOptional])]

          console.log(`[ToolEmbed] Schema "${schema}" → ${name}(${score.toFixed(2)}): required=[${requiredParams.join(',')}] top=[${topOptional.join(',')}]`)
          schemas.push({ tool: name, params: allParams, score })
        }
      }

      if (matched.length > 0) return { matches: matched, schemas }
    } catch (err) {
      console.warn('[ToolEmbed] Search failed, falling back to keywords:', (err as Error).message)
    }
  }

  // Fallback: basic keyword match (no schema filtering)
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  if (words.length === 0) return { matches: tools.slice(0, toolLimit), schemas: [] }

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

  const matches = scored
    .filter(s => s.score >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, toolLimit)
    .map(s => s.tool)

  return { matches, schemas: [] }
}

/** Clear caches (e.g. when integrations change) */
export function clearToolEmbeddings(): void {
  table = null
  paramTable = null
  cachedToolHash = null
}
