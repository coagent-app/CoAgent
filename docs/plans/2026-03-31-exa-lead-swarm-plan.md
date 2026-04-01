# Exa Lead Swarm Protocol Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `leads` built-in tool + system prompt protocol so the agent can run parallel multi-angle Exa searches, dedup results, and auto-save leads to local storage.

**Architecture:** Three changes: (1) leads storage module with save/search/stats, (2) `leads` built-in tool in agent.ts, (3) Lead Swarm Protocol instructions in the system prompt that teach the agent when/how to chain exa_search + exa_find_similar in parallel.

**Tech Stack:** TypeScript, node:fs, existing agent.ts built-in tool pattern

---

### Task 1: Leads Storage Module

**Files:**
- Create: `packages/agent-core/src/leads-store.ts`

**Step 1: Create the leads storage module**

This module handles reading, writing, deduping, and searching leads in `~/.coagent/research/leads.json`.

```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

export interface Lead {
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
  source: string
  query: string
  round: number
  foundAt: string
  notes: string
  tags: string[]
}

function leadsPath(dataDir: string): string {
  return join(dataDir, 'research', 'leads.json')
}

function ensureDir(dataDir: string): void {
  const dir = join(dataDir, 'research')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function readLeads(dataDir: string): Lead[] {
  try {
    return JSON.parse(readFileSync(leadsPath(dataDir), 'utf8'))
  } catch {
    return []
  }
}

function writeLeads(dataDir: string, leads: Lead[]): void {
  ensureDir(dataDir)
  writeFileSync(leadsPath(dataDir), JSON.stringify(leads, null, 2))
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

/**
 * Save leads with dedup by domain. Merges richer data into existing entries.
 * Returns { added, duplicates, total }.
 */
export function saveLeads(dataDir: string, newLeads: Array<Partial<Lead> & { url: string }>): { added: number; duplicates: number; total: number } {
  const existing = readLeads(dataDir)
  const domainMap = new Map(existing.map(l => [l.domain, l]))
  let added = 0
  let duplicates = 0

  for (const raw of newLeads) {
    const domain = extractDomain(raw.url)
    if (domainMap.has(domain)) {
      // Merge: fill in nulls from new data
      const existing = domainMap.get(domain)!
      for (const [k, v] of Object.entries(raw)) {
        if (v != null && (existing as any)[k] == null) {
          (existing as any)[k] = v
        }
      }
      duplicates++
    } else {
      const lead: Lead = {
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
      domainMap.set(domain, lead)
      added++
    }
  }

  const allLeads = [...domainMap.values()]
  writeLeads(dataDir, allLeads)
  return { added, duplicates, total: allLeads.length }
}

/**
 * Search leads by text match on company, domain, industry, summary, tags.
 */
export function searchLeads(dataDir: string, query: string, limit = 20): Lead[] {
  const leads = readLeads(dataDir)
  const q = query.toLowerCase()
  return leads
    .filter(l =>
      l.company.toLowerCase().includes(q) ||
      l.domain.toLowerCase().includes(q) ||
      (l.industry?.toLowerCase().includes(q)) ||
      (l.summary?.toLowerCase().includes(q)) ||
      l.tags.some(t => t.toLowerCase().includes(q))
    )
    .slice(0, limit)
}

/**
 * Get lead stats.
 */
export function getLeadStats(dataDir: string): { total: number; sources: Record<string, number>; recentCount: number; industries: Record<string, number> } {
  const leads = readLeads(dataDir)
  const sources: Record<string, number> = {}
  const industries: Record<string, number> = {}
  const oneDayAgo = Date.now() - 86400000
  let recentCount = 0

  for (const l of leads) {
    sources[l.source] = (sources[l.source] || 0) + 1
    if (l.industry) industries[l.industry] = (industries[l.industry] || 0) + 1
    if (new Date(l.foundAt).getTime() > oneDayAgo) recentCount++
  }

  return { total: leads.length, sources, recentCount, industries }
}
```

**Step 2: Build and verify no errors**

Run: `cd packages/agent-core && pnpm build`
Expected: Clean build

**Step 3: Commit**

```bash
git add packages/agent-core/src/leads-store.ts
git commit -m "feat: add leads storage module with save/search/stats and domain dedup"
```

---

### Task 2: Add `leads` Built-in Tool to Agent

**Files:**
- Modify: `packages/agent-core/src/agent.ts`

**Step 1: Add import at top of agent.ts (near other imports)**

After the existing imports (around line 1-30), add:

```typescript
import { saveLeads, searchLeads, getLeadStats, readLeads } from './leads-store.js'
```

**Step 2: Add `leads` tool to INTERNAL_TOOLS array (after `team_notes` tool, ~line 454)**

```typescript
  {
    name: 'leads',
    description: 'Manage research leads. save: dedup by domain and store. search: find existing leads. stats: overview. list: show all. Powered by Exa.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['save', 'search', 'stats', 'list'] },
        leads: {
          type: 'array',
          description: 'Leads to save (for save action). Each needs url, plus optional: company, phone, email, address, employees, revenue, industry, linkedin, summary, source, query, round, tags.',
          items: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
        },
        query: { type: 'string', description: 'Search query (for search action)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['action']
    }
  },
```

**Step 3: Add tool label (in TOOL_LABELS object, ~line 478)**

```typescript
  leads: 'Managing leads',
```

**Step 4: Add action labels (in ACTION_LABELS object, ~line 497)**

```typescript
  leads: { save: 'Saving leads', search: 'Searching leads', stats: 'Lead stats', list: 'Listing leads' },
```

**Step 5: Add tool handler in the runLoop tool_use block**

Find the pattern of `} else if (block.name === 'files') {` (~line 1304). Before the final `else` block that handles unknown tools (~line 1738), add the leads handler:

```typescript
          } else if (block.name === 'leads') {
            const input = block.input as { action: string; leads?: any[]; query?: string; limit?: number }
            if (input.action === 'save') {
              if (!input.leads || input.leads.length === 0) {
                result = 'No leads provided. Pass an array of leads with at least a url field.'
              } else {
                const res = saveLeads(this.dataDir, input.leads)
                result = `Saved ${res.added} new leads (${res.duplicates} duplicates merged). Total: ${res.total} leads.`
              }
            } else if (input.action === 'search') {
              if (!input.query) { result = 'Missing query for lead search.' }
              else {
                const hits = searchLeads(this.dataDir, input.query, input.limit ?? 20)
                if (hits.length === 0) { result = `No leads found matching "${input.query}".` }
                else {
                  result = hits.map(l =>
                    `${l.company} (${l.domain})${l.industry ? ' — ' + l.industry : ''}${l.phone ? ' | ' + l.phone : ''}${l.email ? ' | ' + l.email : ''}`
                  ).join('\n')
                }
              }
            } else if (input.action === 'stats') {
              const s = getLeadStats(this.dataDir)
              if (s.total === 0) { result = 'No leads stored yet.' }
              else {
                const srcParts = Object.entries(s.sources).map(([k, v]) => `${k}: ${v}`).join(', ')
                const indParts = Object.entries(s.industries).slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(', ')
                result = `${s.total} leads total (${s.recentCount} added in last 24h).\nSources: ${srcParts}\nTop industries: ${indParts}`
              }
            } else if (input.action === 'list') {
              const leads = readLeads(this.dataDir)
              if (leads.length === 0) { result = 'No leads stored yet.' }
              else {
                const limited = leads.slice(0, input.limit ?? 50)
                result = limited.map(l =>
                  `${l.company} (${l.domain})${l.industry ? ' — ' + l.industry : ''}${l.phone ? ' | ' + l.phone : ''}${l.email ? ' | ' + l.email : ''} [${l.source}]`
                ).join('\n') + (leads.length > limited.length ? `\n... and ${leads.length - limited.length} more` : '')
              }
            } else {
              result = `Unknown leads action: ${input.action}`
            }
```

**Step 6: Build and verify**

Run: `cd packages/agent-core && pnpm build`
Expected: Clean build

**Step 7: Commit**

```bash
git add packages/agent-core/src/agent.ts
git commit -m "feat: add leads built-in tool with save/search/stats/list actions"
```

---

### Task 3: Add Lead Swarm Protocol to System Prompt

**Files:**
- Modify: `packages/agent-core/src/agent.ts:576-617` (the `buildSystemPrompt` function)

**Step 1: Add the Lead Swarm Protocol section to the system prompt**

In `buildSystemPrompt()`, add after the `Notifications:` line (line 615) and before the `${onboardingSection}` interpolation:

```typescript
Leads: save/search/stats/list — your lead database. Auto-save after research.

## Lead Swarm Protocol (Powered by Exa)

When user asks to find leads, competitors, businesses, or market research:

**Round 1 — Parallel Seed Swarm:**
1. Generate 3-4 search angles from the user's request (different phrasings, adjacent niches, industry terms)
2. If user gave a URL, add a find_similar call for that URL
3. Fire ALL searches in parallel using call_external_tool with exa_search/EXA_SEARCH + exa_find_similar/EXA_FIND_SIMILAR_SEARCH
4. Dedup results by domain. Present count + cost.
5. Ask: "I can expand by: (1) Find similar to top results, (2) Search more angles, (3) Both (~$X). Which?"

**Round 2 — Chained Expansion (if approved):**
1. Take top 3-5 unique results from Round 1
2. Run find_similar on each — in parallel
3. Final dedup by domain across all results
4. Auto-save ALL leads using the leads tool

**Cost awareness:** Report API calls + estimated cost after each round. Search = $0.007, Find Similar = $0.007.

**What Exa is good at:** Public web data — company profiles, business discovery, press releases, news, court filings, competitor websites, new construction, corporate relocations. Use category: "company" for business searches.

**What Exa is bad at:** Private intent signals — who wants to sell their house, individual buyer/seller intent, personal decisions. Guide users toward public-data queries.

**Always use the leads tool to save results.** Every lead discovered goes into the leads database.
```

**Step 2: Build and verify**

Run: `cd packages/agent-core && pnpm build`
Expected: Clean build

**Step 3: Commit**

```bash
git add packages/agent-core/src/agent.ts
git commit -m "feat: add Lead Swarm Protocol to agent system prompt"
```

---

### Task 4: Test the Full Flow

**Step 1: Restart the dev server**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop && pkill -f "coagent-desktop"; pkill -f "server.js"; sleep 2 && pnpm tauri dev
```

**Step 2: Test in chat**

Send these messages to CoAgent and verify behavior:

1. **Basic search:** "Find auto detailing businesses in Miami"
   - Expected: Agent uses search_tools to find exa_search, fires it, presents results, offers expansion

2. **URL-based:** "Find competitors to https://steadyautogrowth.com"
   - Expected: Agent fires find_similar + multi-angle searches in parallel, dedup, offers expansion

3. **Expansion:** When agent asks about expansion, choose "Both"
   - Expected: Agent runs find_similar on top results in parallel, final dedup, auto-saves with leads tool

4. **Check storage:** "How many leads do I have?"
   - Expected: Agent calls leads(action: "stats"), shows count

5. **Search leads:** "Search my leads for detailing"
   - Expected: Agent calls leads(action: "search", query: "detailing"), shows matches

**Step 3: Verify leads.json was created**

```bash
cat ~/.coagent/research/leads.json | head -50
```

Expected: JSON array of Lead objects with all fields populated

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: lead swarm protocol adjustments from testing"
```
