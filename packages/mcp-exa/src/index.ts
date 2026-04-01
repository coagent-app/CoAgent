#!/usr/bin/env node
/**
 * CoAgent Exa MCP Server — Powered by Exa
 *
 * 3 tools:
 *   exa      — search, find_similar, get_contents (auto-saves to research)
 *   research — search, list, stats (read-only local queries)
 *   monitor  — create, list, delete, trigger
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { ExaClient } from './exa-client.js'
import { saveResearch, searchResearch, getResearchStats, readResearch } from './research-store.js'
import { homedir } from 'os'
import { join } from 'path'

// Graceful EPIPE handling (same pattern as mcp-memory)
process.stdout.on('error', (err: any) => {
  if (err?.code === 'EPIPE') process.exit(0)
})
process.on('uncaughtException', (err: any) => {
  if (err?.code === 'EPIPE' || err?.message?.includes('EPIPE')) process.exit(0)
  console.error('[Exa] Uncaught:', err)
  process.exit(1)
})

const DATA_DIR = process.env.COAGENT_DATA_DIR ?? join(homedir(), '.coagent')
const EXA_API_KEY = process.env.EXA_API_KEY
const RELAY_URL = process.env.RELAY_URL
const RELAY_USER_ID = process.env.RELAY_USER_ID ?? 'default'
const WEBHOOK_URL = RELAY_URL ? `${RELAY_URL.replace(/\/$/, '')}/webhook/exa/${RELAY_USER_ID}` : null

if (!EXA_API_KEY) {
  console.error('[Exa] Missing EXA_API_KEY environment variable')
  process.exit(1)
}

const exa = new ExaClient(EXA_API_KEY)

const server = new Server(
  { name: 'coagent-exa', version: '0.0.1' },
  { capabilities: { tools: {} } }
)

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatCompact(r: { url: string; title?: string | null }): string {
  const domain = (() => { try { return new URL(r.url).hostname.replace(/^www\./, '') } catch { return '' } })()
  return r.title?.replace(/\s*[|–—:].{0,50}$/, '') || domain
}

/** Parse structured contact from Exa summary (JSON schema response) or fall back to regex */
function parseContact(summary: string | undefined, highlights?: string[]): { phone?: string; email?: string; address?: string; employees?: string; owner?: string; services?: string } {
  const out: { phone?: string; email?: string; address?: string; employees?: string; owner?: string; services?: string } = {}

  // Try structured JSON parse first (from summary.schema)
  if (summary) {
    try {
      const parsed = JSON.parse(summary)
      if (parsed && typeof parsed === 'object') {
        const clean = (v: unknown) => {
          if (typeof v !== 'string') return undefined
          const s = v.trim()
          if (!s || /^n\/?a$/i.test(s) || /^(not|none|unknown)/i.test(s)) return undefined
          return s
        }
        out.phone = clean(parsed.phone)
        out.email = clean(parsed.email)
        out.address = clean(parsed.address)
        out.employees = clean(parsed.employees)
        out.owner = clean(parsed.owner)
        out.services = clean(parsed.services)
        return out
      }
    } catch {
      // Not JSON — fall through to regex
    }
  }

  // Regex fallback on summary + highlights text
  const text = [summary, ...(highlights || [])].filter(Boolean).join(' ')
  if (!text) return out

  const phoneMatch = text.match(/(?:phone|tel|call)[:\s]*([+\d][\d\s.()\-]{7,18}\d)/i)
    || text.match(/(\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})/)
    || text.match(/(\+1[\s.\-]?\d{3}[\s.\-]?\d{3}[\s.\-]?\d{4})/)
  if (phoneMatch && !/N\/?A/i.test(phoneMatch[1])) out.phone = phoneMatch[1].trim()

  const emailMatch = text.match(/(?:email|e-mail|contact)[:\s]*([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i)
    || text.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/)
  if (emailMatch && !/N\/?A/i.test(emailMatch[1])) out.email = emailMatch[1].trim()

  const addrMatch = text.match(/(?:address|location|located)[:\s]*([^,\n]{5,60}(?:,\s*[A-Z]{2}\s*\d{5})?)/i)
    || text.match(/(\d{1,5}\s+[A-Z][a-zA-Z\s]{3,30}(?:St|Ave|Blvd|Dr|Rd|Ln|Way|Ct|Pl|Pkwy|Hwy)\.?[^,\n]{0,40})/i)
  if (addrMatch && !/N\/?A/i.test(addrMatch[1])) out.address = addrMatch[1].trim()

  const empMatch = text.match(/(?:employees|staff|team)[:\s]*([~\d,+\-\s]{1,20})/i)
  if (empMatch && !/N\/?A/i.test(empMatch[1])) out.employees = empMatch[1].trim()

  return out
}

interface ExaResultLike { url: string; title?: string | null; summary?: string; text?: string; highlights?: string[]; subpages?: ExaResultLike[] }

/** Auto-save search results (+ subpages) to research store. Returns save summary. */
function autoSave(results: ExaResultLike[], source: string, query: string): string {
  if (results.length === 0) return ''
  const entries = results.map(r => {
    // Merge contact info from main result + subpages (contact/about pages)
    const mainContact = parseContact(r.summary, r.highlights)
    const contact = { ...mainContact }

    // Check subpages for contact info we didn't find on the main page
    if (r.subpages?.length) {
      for (const sub of r.subpages) {
        const subContact = parseContact(sub.summary, sub.highlights)
        if (!contact.phone && subContact.phone) contact.phone = subContact.phone
        if (!contact.email && subContact.email) contact.email = subContact.email
        if (!contact.address && subContact.address) contact.address = subContact.address
        if (!contact.employees && subContact.employees) contact.employees = subContact.employees
        if (!contact.owner && subContact.owner) contact.owner = subContact.owner
      }
    }

    // Build display summary from structured data or raw text
    let summaryText: string | undefined
    try {
      const parsed = JSON.parse(r.summary || '')
      if (parsed?.services) summaryText = parsed.services
    } catch {
      summaryText = r.summary || r.text?.slice(0, 300) || undefined
    }

    return {
      url: r.url,
      company: r.title?.replace(/\s*[|–—:].{0,50}$/, '') || undefined,
      summary: summaryText,
      phone: contact.phone,
      email: contact.email,
      address: contact.address,
      employees: contact.employees,
      source,
      query,
    }
  })
  const res = saveResearch(DATA_DIR, entries)
  return `\n[Auto-saved: ${res.added} new, ${res.duplicates} merged, ${res.total} total]`
}

// ── Tool definitions ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'exa',
      description: 'Web search powered by Exa. Actions: search, find_similar, get_contents. Results auto-save to research database. $0.007/search, $0.001/page.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'find_similar', 'get_contents'], description: 'Which Exa operation to run' },
          query: { type: 'string', description: 'Search query (for search action)' },
          url: { type: 'string', description: 'URL (for find_similar action)' },
          urls: { type: 'array', items: { type: 'string' }, description: 'URLs (for get_contents action)' },
          numResults: { type: 'number', description: 'Number of results (1-100, default 10)' },
          category: { type: 'string', enum: ['company', 'research paper', 'news', 'personal site', 'financial report', 'people'], description: 'Filter by category' },
          includeDomains: { type: 'array', items: { type: 'string' }, description: 'Only these domains' },
          excludeDomains: { type: 'array', items: { type: 'string' }, description: 'Exclude these domains' },
          includeText: { type: 'array', items: { type: 'string' }, description: 'Must contain these strings' },
          excludeText: { type: 'array', items: { type: 'string' }, description: 'Must NOT contain these' },
          startPublishedDate: { type: 'string', description: 'ISO date — after this' },
          endPublishedDate: { type: 'string', description: 'ISO date — before this' },
        },
        required: ['action'],
      },
    },
    {
      name: 'research',
      description: 'Query the local research database. Actions: search (text match), list (all entries), stats (overview).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'list', 'stats'], description: 'Which operation' },
          query: { type: 'string', description: 'Search query (for search action)' },
          limit: { type: 'number', description: 'Max results (default 20 for search, 50 for list)' },
        },
        required: ['action'],
      },
    },
    {
      name: 'monitor',
      description: 'Manage Exa search monitors — recurring searches that auto-save new results. Actions: create, list, delete, trigger.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'delete', 'trigger'], description: 'Which operation' },
          query: { type: 'string', description: 'Search query (for create)' },
          name: { type: 'string', description: 'Monitor name (for create)' },
          interval: { type: 'string', enum: ['1h', '6h', '1d', '7d'], description: 'How often (for create, default: 1d)' },
          numResults: { type: 'number', description: 'Results per run (for create, default 10)' },
          includeDomains: { type: 'array', items: { type: 'string' }, description: 'Only monitor these domains (for create)' },
          excludeDomains: { type: 'array', items: { type: 'string' }, description: 'Exclude these domains (for create)' },
          id: { type: 'string', description: 'Monitor ID (for delete/trigger)' },
        },
        required: ['action'],
      },
    },
  ],
}))

// ── Tool handlers ───────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const a = args as Record<string, any>

  try {
    if (name === 'exa') {
      switch (a.action) {
        case 'search': {
          if (!a.query) return { content: [{ type: 'text', text: 'Missing query.' }] }
          const res = await exa.search({
            query: a.query,
            numResults: a.numResults,
            category: a.category,
            includeDomains: a.includeDomains,
            excludeDomains: a.excludeDomains,
            includeText: a.includeText,
            excludeText: a.excludeText,
            startPublishedDate: a.startPublishedDate,
            endPublishedDate: a.endPublishedDate,
          })
          const results = res.results || []
          if (results.length === 0) return { content: [{ type: 'text', text: `No results for "${a.query}".` }] }
          const saved = autoSave(results, 'search', a.query)
          const lines = results.map((r, i) => {
            const contact = parseContact(r.summary, r.highlights)
            const details = [contact.phone, contact.email, contact.address].filter(Boolean).join(' | ')
            const detailLine = details ? `\n   Contact: ${details}` : ''
            const services = contact.services ? `\n   ${contact.services}` : ''
            return `${i + 1}. ${formatCompact(r)} — ${r.url}${detailLine}${services}`
          })
          return { content: [{ type: 'text', text: `${results.length} results for "${a.query}":\n${lines.join('\n')}${saved}` }] }
        }
        case 'find_similar': {
          if (!a.url) return { content: [{ type: 'text', text: 'Missing url.' }] }
          const res = await exa.findSimilar({
            url: a.url,
            numResults: a.numResults,
            includeDomains: a.includeDomains,
            excludeDomains: a.excludeDomains,
          })
          const results = res.results || []
          if (results.length === 0) return { content: [{ type: 'text', text: `No similar pages for ${a.url}.` }] }
          const saved = autoSave(results, 'find_similar', a.url)
          const lines = results.map((r, i) => {
            const contact = parseContact(r.summary, r.highlights)
            const details = [contact.phone, contact.email, contact.address].filter(Boolean).join(' | ')
            const detailLine = details ? `\n   Contact: ${details}` : ''
            return `${i + 1}. ${formatCompact(r)} — ${r.url}${detailLine}`
          })
          return { content: [{ type: 'text', text: `${results.length} similar to ${a.url}:\n${lines.join('\n')}${saved}` }] }
        }
        case 'get_contents': {
          if (!a.urls?.length) return { content: [{ type: 'text', text: 'Missing urls.' }] }
          const res = await exa.getContents(a.urls)
          const results = res.results || []
          if (results.length === 0) return { content: [{ type: 'text', text: 'No content retrieved.' }] }
          autoSave(results, 'contents', '')
          const text = results.map(r => {
            const domain = (() => { try { return new URL(r.url).hostname.replace(/^www\./, '') } catch { return '' } })()
            const name = r.title?.replace(/\s*[|–—:].{0,50}$/, '') || domain
            const contact = parseContact(r.summary, r.highlights)
            const details = [contact.phone, contact.email, contact.address].filter(Boolean).join(' | ')
            const contactLine = details ? `\nContact: ${details}` : ''
            const services = contact.services || r.text?.slice(0, 400) || '(no content)'
            return `${name} — ${r.url}${contactLine}\n${services}`
          }).join('\n\n')
          return { content: [{ type: 'text', text }] }
        }
        default:
          return { content: [{ type: 'text', text: `Unknown exa action: ${a.action}` }] }
      }
    }

    if (name === 'research') {
      switch (a.action) {
        case 'search': {
          if (!a.query) return { content: [{ type: 'text', text: 'Missing query.' }] }
          const hits = searchResearch(DATA_DIR, a.query, a.limit ?? 20)
          if (hits.length === 0) return { content: [{ type: 'text', text: `No entries matching "${a.query}".` }] }
          const text = hits.map(e =>
            `${e.company} (${e.domain})${e.industry ? ' — ' + e.industry : ''}${e.phone ? ' | ' + e.phone : ''}${e.email ? ' | ' + e.email : ''}`
          ).join('\n')
          return { content: [{ type: 'text', text }] }
        }
        case 'list': {
          const entries = readResearch(DATA_DIR)
          if (entries.length === 0) return { content: [{ type: 'text', text: 'No research entries yet.' }] }
          const limit = a.limit ?? 50
          const limited = entries.slice(0, limit)
          const text = limited.map(e =>
            `${e.company} (${e.domain})${e.industry ? ' — ' + e.industry : ''}${e.phone ? ' | ' + e.phone : ''} [${e.source}]`
          ).join('\n') + (entries.length > limit ? `\n... and ${entries.length - limit} more` : '')
          return { content: [{ type: 'text', text }] }
        }
        case 'stats': {
          const s = getResearchStats(DATA_DIR)
          if (s.total === 0) return { content: [{ type: 'text', text: 'No research entries yet.' }] }
          const srcParts = Object.entries(s.sources).map(([k, v]) => `${k}: ${v}`).join(', ')
          const indParts = Object.entries(s.industries).slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(', ')
          return { content: [{ type: 'text', text: `${s.total} entries (${s.recentCount} last 24h). Sources: ${srcParts}. Industries: ${indParts}` }] }
        }
        default:
          return { content: [{ type: 'text', text: `Unknown research action: ${a.action}` }] }
      }
    }

    if (name === 'monitor') {
      switch (a.action) {
        case 'create': {
          if (!a.query) return { content: [{ type: 'text', text: 'Missing query.' }] }
          if (!WEBHOOK_URL) return { content: [{ type: 'text', text: 'Requires RELAY_URL for webhook delivery.' }] }
          const interval = a.interval ?? '1d'
          const search: any = {
              query: a.query,
              numResults: a.numResults ?? 10,
              contents: { text: { maxCharacters: 500 }, highlights: true, summary: { query: a.query } },
            }
          if (a.includeDomains?.length) search.includeDomains = a.includeDomains
          if (a.excludeDomains?.length) search.excludeDomains = a.excludeDomains
          const m = await exa.createMonitor({
            name: a.name,
            search,
            webhook: { url: WEBHOOK_URL },
            trigger: { type: 'interval', period: interval },
          })
          const domainNote = a.includeDomains?.length ? ` (watching: ${a.includeDomains.join(', ')})` : ''
          return { content: [{ type: 'text', text: `Monitor ${m.id} created — "${a.query}" every ${interval}${domainNote}. Auto-saves to research.` }] }
        }
        case 'list': {
          const res = await exa.listMonitors()
          const monitors = res.monitors || []
          if (monitors.length === 0) return { content: [{ type: 'text', text: 'No monitors.' }] }
          const text = monitors.map(m =>
            `${m.name || m.id} — "${m.search.query}" every ${m.trigger?.period ?? '?'} [${m.status}]`
          ).join('\n')
          return { content: [{ type: 'text', text }] }
        }
        case 'delete': {
          if (!a.id) return { content: [{ type: 'text', text: 'Missing id.' }] }
          await exa.deleteMonitor(a.id)
          return { content: [{ type: 'text', text: `Monitor ${a.id} deleted.` }] }
        }
        case 'trigger': {
          if (!a.id) return { content: [{ type: 'text', text: 'Missing id.' }] }
          const run = await exa.triggerMonitor(a.id)
          return { content: [{ type: 'text', text: `Triggered run ${run.id} — ${run.status}` }] }
        }
        default:
          return { content: [{ type: 'text', text: `Unknown monitor action: ${a.action}` }] }
      }
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
  } catch (err: any) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }] }
  }
})

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[Exa] MCP server running')
}

main().catch((err) => {
  console.error('[Exa] Fatal:', err)
  process.exit(1)
})
