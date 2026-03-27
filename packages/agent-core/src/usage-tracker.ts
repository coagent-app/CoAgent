import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { UsageEntry, UsageCategory, UsageSummary } from '@coagent/shared'

const USAGE_FILE = 'usage.json'

// Pricing per million tokens (USD)
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-6':           { input: 15,   output: 75,   cacheRead: 1.50,  cacheWrite: 18.75 },
  'claude-sonnet-4-6':         { input: 3,    output: 15,   cacheRead: 0.30,  cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4,    cacheRead: 0.08,  cacheWrite: 1.00 },
  'claude-haiku-4-5':          { input: 0.80, output: 4,    cacheRead: 0.08,  cacheWrite: 1.00 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4,    cacheRead: 0.08,  cacheWrite: 1.00 },
}

const DEFAULT_PRICING = PRICING['claude-sonnet-4-6']

function getPricing(model: string) {
  return PRICING[model] || DEFAULT_PRICING
}

function estimateCost(entry: UsageEntry): number {
  const p = getPricing(entry.model)
  return (
    (entry.inputTokens * p.input / 1_000_000) +
    (entry.outputTokens * p.output / 1_000_000) +
    (entry.cacheReadTokens * p.cacheRead / 1_000_000) +
    (entry.cacheCreationTokens * p.cacheWrite / 1_000_000)
  )
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

  const categories: UsageCategory[] = ['chat', 'file_ingestion', 'nightly_job']
  const byCategory = {} as UsageSummary['byCategory']
  for (const cat of categories) {
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
