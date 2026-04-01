/**
 * Local research storage — deduped by domain, searchable, persistent.
 * Stores results in ~/.coagent/research/research.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

export interface ResearchEntry {
  id: string
  company: string
  domain: string
  url: string
  phone: string | null
  email: string | null
  address: string | null
  employees: string | null
  revenue: string | null
  industry: string | null
  linkedin: string | null
  summary: string | null
  source: string          // 'search' | 'find_similar' | 'contents'
  query: string           // the query that found this
  round: number           // 1 = seed, 2 = expansion
  foundAt: string         // ISO timestamp
  notes: string
  tags: string[]
}

function researchPath(dataDir: string): string {
  return join(dataDir, 'research', 'research.json')
}

function ensureDir(dataDir: string): void {
  const dir = join(dataDir, 'research')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function readResearch(dataDir: string): ResearchEntry[] {
  try {
    return JSON.parse(readFileSync(researchPath(dataDir), 'utf8'))
  } catch {
    return []
  }
}

function writeResearch(dataDir: string, entries: ResearchEntry[]): void {
  ensureDir(dataDir)
  writeFileSync(researchPath(dataDir), JSON.stringify(entries, null, 2))
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}



/** Save with dedup by domain. Merges richer data into existing entries. */
export function saveResearch(
  dataDir: string,
  newEntries: Array<Partial<ResearchEntry> & { url: string }>
): { added: number; duplicates: number; total: number } {
  const existing = readResearch(dataDir)
  const domainMap = new Map(existing.map(e => [e.domain, e]))
  let added = 0
  let duplicates = 0

  for (const raw of newEntries) {
    const domain = extractDomain(raw.url)

    // Skip junk domains
    if (/yelp|reddit|facebook|youtube|twitter|linkedin\.com|instagram|tiktok|medium\.com|forbes|entrepreneur|wikipedia/i.test(domain)) {
      continue
    }

    if (domainMap.has(domain)) {
      // Merge: fill in nulls from new data
      const entry = domainMap.get(domain)!
      for (const [k, v] of Object.entries(raw)) {
        if (v != null && v !== '' && (entry as any)[k] == null) {
          (entry as any)[k] = v
        }
      }
      duplicates++
    } else {
      const entry: ResearchEntry = {
        id: randomUUID(),
        company: raw.company || domain,
        domain,
        url: raw.url,
        phone: raw.phone ?? null,
        email: raw.email ?? null,
        address: raw.address ?? null,
        employees: raw.employees ?? null,
        revenue: raw.revenue ?? null,
        industry: raw.industry ?? null,
        linkedin: raw.linkedin ?? null,
        summary: raw.summary ?? null,
        source: raw.source || 'search',
        query: raw.query || '',
        round: raw.round ?? 1,
        foundAt: new Date().toISOString(),
        notes: raw.notes || '',
        tags: raw.tags || [],
      }
      domainMap.set(domain, entry)
      added++
    }
  }

  const all = [...domainMap.values()]
  writeResearch(dataDir, all)
  return { added, duplicates, total: all.length }
}

/** Fuzzy relevance search — tokenizes query, scores entries by term matches across all fields. */
export function searchResearch(dataDir: string, query: string, limit = 20): ResearchEntry[] {
  const entries = readResearch(dataDir)
  const q = query.toLowerCase()

  // Tokenize: split on spaces, drop short words, dedupe
  const terms = [...new Set(q.split(/\s+/).filter(t => t.length > 2))]
  if (terms.length === 0) return entries.slice(0, limit)

  const scored = entries.map(e => {
    // Build searchable text blob per entry
    const text = [
      e.company, e.company, // double-weight company name
      e.domain,
      e.industry,
      e.summary,
      e.query,
      e.notes,
      e.tags.join(' '),
      e.address,
    ].filter(Boolean).join(' ').toLowerCase()

    let score = 0

    // Exact full query match — big bonus
    if (text.includes(q)) score += 10

    // Per-term scoring
    for (const term of terms) {
      // Count occurrences (capped at 3 to avoid one-field dominance)
      const matches = text.split(term).length - 1
      score += Math.min(matches, 3)

      // Bonus: term appears in company name or tags (high-signal fields)
      if (e.company.toLowerCase().includes(term)) score += 2
      if (e.tags.some(t => t.toLowerCase().includes(term))) score += 2
      if (e.industry?.toLowerCase().includes(term)) score += 1
    }

    // Bonus: % of query terms matched (rewards broader coverage)
    const termsMatched = terms.filter(t => text.includes(t)).length
    score += (termsMatched / terms.length) * 5

    return { entry: e, score }
  })

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.entry)
}

/** Stats overview. */
export function getResearchStats(dataDir: string): {
  total: number
  sources: Record<string, number>
  recentCount: number
  industries: Record<string, number>
} {
  const entries = readResearch(dataDir)
  const sources: Record<string, number> = {}
  const industries: Record<string, number> = {}
  const oneDayAgo = Date.now() - 86400000
  let recentCount = 0

  for (const e of entries) {
    sources[e.source] = (sources[e.source] || 0) + 1
    if (e.industry) industries[e.industry] = (industries[e.industry] || 0) + 1
    if (new Date(e.foundAt).getTime() > oneDayAgo) recentCount++
  }

  return { total: entries.length, sources, recentCount, industries }
}
