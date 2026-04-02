import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { UsageEntry, UsageCategory, UsageSummary } from '@coagent/shared'

const USAGE_FILE = 'usage.json'

// Global data dir — set once at startup, used by recordUsageGlobal
let globalDataDir: string | null = null

export function setUsageDataDir(dir: string): void {
  globalDataDir = dir
}

// Pricing per million tokens (USD) — using 1h ephemeral cache rates (2x base for writes, 0.1x for reads)
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-6':           { input: 15,   output: 75,   cacheRead: 1.50,  cacheWrite: 30 },
  'claude-sonnet-4-6':         { input: 3,    output: 15,   cacheRead: 0.30,  cacheWrite: 6 },
  'claude-haiku-4-5-20251001': { input: 1,    output: 5,    cacheRead: 0.10,  cacheWrite: 2 },
  'claude-haiku-4-5':          { input: 1,    output: 5,    cacheRead: 0.10,  cacheWrite: 2 },
}

// Non-LLM pricing (published rates)
const WHISPER_PER_MINUTE_USD = 0.006       // OpenAI Whisper: $0.006/min
const TTS_PER_MILLION_CHARS_USD = 15_000   // OpenAI tts-1: $15/1M chars → $15000/1M for per-million math
const TTS1_PER_CHAR_USD = 0.000015         // OpenAI tts-1: $15/1M chars = $0.000015/char
const TTS1HD_PER_CHAR_USD = 0.000030       // OpenAI tts-1-hd: $30/1M chars = $0.000030/char
const EMBEDDING_SMALL_PER_MILLION_USD = 0.02  // text-embedding-3-small: $0.02/1M tokens

const DEFAULT_PRICING = PRICING['claude-sonnet-4-6']

function getPricing(model: string) {
  return PRICING[model] || DEFAULT_PRICING
}

function estimateCost(entry: UsageEntry): number {
  switch (entry.category) {
    case 'whisper': {
      // Exact: audioSeconds from Whisper API verbose_json response
      const minutes = (entry.audioSeconds ?? 0) / 60
      return minutes * WHISPER_PER_MINUTE_USD
    }
    case 'tts': {
      // Exact: character count sent to API
      const perChar = entry.model === 'tts-1-hd' ? TTS1HD_PER_CHAR_USD : TTS1_PER_CHAR_USD
      return (entry.characters ?? 0) * perChar
    }
    case 'embedding': {
      // Exact: total_tokens from OpenAI embedding API response
      return (entry.embeddingTokens ?? 0) * EMBEDDING_SMALL_PER_MILLION_USD / 1_000_000
    }
    case 'composio': {
      // Composio pricing is per-plan, not per-action — record count only, cost = 0
      return 0
    }
    default: {
      // LLM token-based pricing
      const p = getPricing(entry.model)
      return (
        (entry.inputTokens * p.input / 1_000_000) +
        (entry.outputTokens * p.output / 1_000_000) +
        (entry.cacheReadTokens * p.cacheRead / 1_000_000) +
        (entry.cacheCreationTokens * p.cacheWrite / 1_000_000)
      )
    }
  }
}

export async function recordUsage(dataDir: string, entry: UsageEntry): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  const filePath = join(dataDir, USAGE_FILE)
  let entries: UsageEntry[] = []
  try {
    entries = JSON.parse(await readFile(filePath, 'utf-8'))
  } catch {}
  entries.push(entry)
  await writeFile(filePath, JSON.stringify(entries), 'utf-8')
}

/** Convenience: record usage using the global data dir (set via setUsageDataDir) */
export async function recordUsageGlobal(entry: UsageEntry): Promise<void> {
  if (!globalDataDir) return
  return recordUsage(globalDataDir, entry)
}

const ALL_CATEGORIES: UsageCategory[] = ['chat', 'file_ingestion', 'nightly_job', 'research', 'whisper', 'tts', 'embedding', 'composio']

export async function getUsageSummary(dataDir: string, periodDays = 30): Promise<UsageSummary> {
  const filePath = join(dataDir, USAGE_FILE)
  let entries: UsageEntry[] = []
  try {
    entries = JSON.parse(await readFile(filePath, 'utf-8'))
  } catch {}

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - periodDays)
  const periodStart = cutoff.toISOString()
  const recent = entries.filter(e => e.timestamp >= periodStart)

  const byCategory = {} as UsageSummary['byCategory']
  for (const cat of ALL_CATEGORIES) {
    byCategory[cat] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 }
  }

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheReadTokens = 0
  let totalCacheCreationTokens = 0
  let estimatedCostUsd = 0

  for (const e of recent) {
    totalInputTokens += e.inputTokens
    totalOutputTokens += e.outputTokens
    totalCacheReadTokens += e.cacheReadTokens
    totalCacheCreationTokens += e.cacheCreationTokens
    const cost = estimateCost(e)
    estimatedCostUsd += cost
    const cat = byCategory[e.category]
    if (cat) {
      cat.inputTokens += e.inputTokens
      cat.outputTokens += e.outputTokens
      cat.cacheReadTokens += e.cacheReadTokens
      cat.cacheCreationTokens += e.cacheCreationTokens
      cat.costUsd += cost
    }
  }

  return { periodStart, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens, estimatedCostUsd, byCategory }
}

export async function pruneOldEntries(dataDir: string, maxAgeDays = 90): Promise<void> {
  const filePath = join(dataDir, USAGE_FILE)
  let entries: UsageEntry[] = []
  try {
    entries = JSON.parse(await readFile(filePath, 'utf-8'))
  } catch { return }

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - maxAgeDays)
  const cutoffStr = cutoff.toISOString()
  const kept = entries.filter(e => e.timestamp >= cutoffStr)
  if (kept.length < entries.length) {
    await writeFile(filePath, JSON.stringify(kept), 'utf-8')
  }
}
