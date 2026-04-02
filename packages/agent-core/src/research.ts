// packages/agent-core/src/research.ts
// Parallel Haiku sub-agent research — Sonnet provides queries, Haiku executes

import Anthropic from '@anthropic-ai/sdk'
import type { MCPManager } from './mcp-manager.js'
import { recordUsage } from './usage-tracker.js'

const HAIKU = 'claude-haiku-4-5-20251001'
const MAX_TOOL_LOOPS = 5

const SEARCH_SYSTEM = `You are a research sub-agent. Cast a wide net and bring back as much raw data as possible. Another AI will deduplicate and filter — you just gather.

Flow:
1. Search with exa (action: search, category: "company" for businesses). Use excludeDomains: ["yelp.com","reddit.com","facebook.com","linkedin.com","yellowpages.com","bbb.org","wikipedia.org","twitter.com","instagram.com","tiktok.com","medium.com","thumbtack.com","angi.com","nextdoor.com"]
2. Pick the 2-3 best matching URLs from results
3. Run find_similar on each — use excludeDomains with ALL domains already found to avoid duplicates
4. Run get_contents on promising URLs to pull contact info
5. Return EVERYTHING — names, URLs, phone, email, address, details. Do not summarize or cut.

Key:
- find_similar is your best expansion tool — one good result leads to 10 more
- ALWAYS pass excludeDomains on find_similar with domains you already have
- get_contents auto-extracts contact info from company websites
- Include location in queries for local businesses
- Use includeText to filter by specific terms (e.g. city name)`

export interface ResearchProgress {
  query: string
  status: 'searching' | 'branching' | 'enriching' | 'done' | 'error'
  loop: number
  detail?: string
}

export async function runResearch(
  queries: string[],
  anthropic: Anthropic,
  mcpManager: MCPManager,
  dataDir?: string,
  onProgress?: (progress: ResearchProgress[]) => void,
): Promise<string> {
  // Get Exa tool schemas (only search tool, not monitor)
  const { tools: allTools } = await mcpManager.getAllTools()
  const exaTools = allTools.filter(t => t.name === 'exa')

  if (exaTools.length === 0) {
    return 'Error: Exa search not available.'
  }

  console.log(`[Research] ${queries.length} parallel sub-agents:`, queries)
  const startTime = Date.now()

  // Track per-query progress
  const progressState: ResearchProgress[] = queries.map(q => ({
    query: q, status: 'searching' as const, loop: 0
  }))

  // Run all queries in parallel via Haiku sub-agents
  const results = await Promise.all(
    queries.map((q, i) => runSubAgent(q, anthropic, mcpManager, exaTools, dataDir, (p) => {
      progressState[i] = p
      onProgress?.(progressState)
    }))
  )

  const succeeded = results.filter(r => !r.startsWith('Error'))
  console.log(`[Research] ${succeeded.length}/${results.length} succeeded`)

  if (succeeded.length === 0) {
    return `Research failed — all sub-agents errored.\n\n${results.join('\n')}`
  }

  // Return labeled results — let the main agent (Sonnet) synthesize
  const combined = results
    .map((r, i) => `--- "${queries[i]}" ---\n${r}`)
    .join('\n\n')

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`[Research] Done in ${elapsed}s — ${combined.length} chars`)

  // Auto-save research report to memory so findings survive compaction
  saveResearchReport(queries, combined, elapsed, mcpManager).catch(err =>
    console.error('[Research] Failed to save report:', err.message)
  )

  return combined
}

async function saveResearchReport(
  queries: string[],
  combined: string,
  elapsed: string,
  mcpManager: MCPManager,
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10)
  const time = new Date().toISOString().slice(11, 16).replace(':', '')
  // Slug from first query for filename
  const slug = queries[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  const path = `research/${date}-${time}-${slug}.md`

  const report = `# Research Report — ${date}

**Queries:** ${queries.map(q => `"${q}"`).join(', ')}
**Duration:** ${elapsed}s | **Sub-agents:** ${queries.length}

---

${combined}
`

  try {
    await mcpManager.callTool('memory', 'write_memory', { path, content: report })
    console.log(`[Research] Report saved: ${path} (${report.length} chars)`)
  } catch (err: any) {
    console.error(`[Research] Report save failed:`, err.message)
  }
}

async function runSubAgent(
  query: string,
  anthropic: Anthropic,
  mcpManager: MCPManager,
  exaTools: Anthropic.Tool[],
  dataDir?: string,
  onProgress?: (p: ResearchProgress) => void,
): Promise<string> {
  console.log(`[Research:sub] Starting: "${query}" with ${exaTools.length} tools: ${exaTools.map(t => t.name).join(', ')}`)
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: query }
  ]

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    try {
      console.log(`[Research:sub] "${query}" loop ${loop + 1}/${MAX_TOOL_LOOPS}`)
      const res = await anthropic.messages.create({
        model: HAIKU,
        max_tokens: 4096,
        system: [{ type: 'text', text: SEARCH_SYSTEM, cache_control: { type: 'ephemeral' } }] as any,
        tools: exaTools.map((t, i) => i === exaTools.length - 1
          ? { ...t, cache_control: { type: 'ephemeral' } }
          : t
        ) as any,
        messages: messages as any
      } as any)

      // Track usage
      if (dataDir && res.usage) {
        recordUsage(dataDir, {
          timestamp: new Date().toISOString(),
          model: HAIKU,
          inputTokens: res.usage.input_tokens || 0,
          outputTokens: res.usage.output_tokens || 0,
          cacheReadTokens: (res.usage as any).cache_read_input_tokens || 0,
          cacheCreationTokens: (res.usage as any).cache_creation_input_tokens || 0,
          category: 'research',
        }).catch(() => {})
      }

      console.log(`[Research:sub] "${query}" loop ${loop + 1} → stop_reason=${res.stop_reason}, blocks=${res.content.length}`)

      // Done — return text
      if (res.stop_reason === 'end_turn') {
        const text = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map(b => b.text).join('\n')
        console.log(`[Research:sub] "${query}" completed: ${text.length} chars`)
        onProgress?.({ query, status: 'done', loop: loop + 1, detail: `${text.length} chars` })
        return text
      }

      // Tool call — execute and loop
      if (res.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: res.content })

        const toolBlocks = res.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
        )

        // Determine status from tool actions
        const actions = toolBlocks.map(b => {
          const input = b.input as Record<string, unknown>
          return (input.action as string) || 'search'
        })
        const status = actions.includes('get_contents') ? 'enriching' as const
          : actions.includes('find_similar') ? 'branching' as const
          : 'searching' as const
        onProgress?.({ query, status, loop: loop + 1, detail: actions.join(', ') })

        console.log(`[Research:sub] "${query}" tool calls: ${toolBlocks.map(b => `${b.name}(${JSON.stringify(b.input).slice(0, 100)})`).join(', ')}`)

        const toolResults = await Promise.all(
          toolBlocks.map(async (block) => {
            try {
              const r = await mcpManager.callTool('exa', block.name, block.input as Record<string, unknown>)
              console.log(`[Research:sub] "${query}" tool ${block.name} → ${r.length} chars`)
              return r
            } catch (err: any) {
              console.error(`[Research:sub] "${query}" tool ${block.name} FAILED:`, err.message)
              return `Error: ${err.message}`
            }
          })
        )

        const resultBlocks: Anthropic.ToolResultBlockParam[] = toolBlocks.map((block, i) => ({
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: toolResults[i]
        }))

        messages.push({ role: 'user', content: resultBlocks })
        continue
      }

      console.warn(`[Research:sub] "${query}" unexpected stop_reason: ${res.stop_reason}`)
      break
    } catch (err: any) {
      console.error(`[Research:sub] "${query}" ERROR:`, err.message, err.status || '')
      onProgress?.({ query, status: 'error', loop: loop + 1, detail: err.message })
      return `Error: ${err.message}`
    }
  }

  onProgress?.({ query, status: 'done', loop: MAX_TOOL_LOOPS, detail: 'max loops reached' })
  return `Search for "${query}" did not complete within ${MAX_TOOL_LOOPS} tool calls.`
}
