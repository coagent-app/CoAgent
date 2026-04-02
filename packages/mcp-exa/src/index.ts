#!/usr/bin/env node
/**
 * CoAgent Exa MCP Server — Powered by Exa
 *
 * 2 tools:
 *   exa      — search, find_similar, get_contents, save_lead_schema
 *   monitor  — create, list, delete, trigger
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { ExaClient } from './exa-client.js'
import type { LeadSchema } from './exa-client.js'
import { homedir } from 'os'
import { join } from 'path'
import { writeFileSync, mkdirSync, existsSync } from 'fs'

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

/** Parse structured contact from Exa summary — returns all fields dynamically (base + lead schema) */
function parseContact(summary: string | undefined, highlights?: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}

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
        for (const [k, v] of Object.entries(parsed)) {
          out[k] = clean(v)
        }
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

// ── Tool definitions ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'exa',
      description: 'Web search powered by Exa. Actions: search, find_similar, get_contents, save_lead_schema. Save important findings to memory after research. $0.007/search, $0.001/page.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'find_similar', 'get_contents', 'save_lead_schema'], description: 'Which Exa operation to run' },
          query: { type: 'string', description: 'Search query (for search action)' },
          type: { type: 'string', enum: ['auto', 'fast', 'deep', 'instant'], description: 'Search type: auto (default), fast (quick broad sweep), deep (structured extraction + query expansion)' },
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
          fields: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'description'] }, description: 'Custom extraction fields (for save_lead_schema)' },
          extractionQuery: { type: 'string', description: 'What to extract in plain English (for save_lead_schema)' },
        },
        required: ['action'],
      },
    },
    {
      name: 'monitor',
      description: 'Manage Exa search monitors — recurring searches that deliver new results via webhook. Actions: create, list, delete, trigger.',
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
            type: a.type,
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
          const lines = results.map((r, i) => {
            const contact = parseContact(r.summary, r.highlights)
            const details = [contact.phone, contact.email, contact.address].filter(Boolean).join(' | ')
            const detailLine = details ? `\n   Contact: ${details}` : ''
            const services = contact.services ? `\n   ${contact.services}` : ''
            const bizInfo = [contact.revenue ? `Rev: ${contact.revenue}` : '', contact.employees ? `Team: ${contact.employees}` : '', contact.has_ads || ''].filter(Boolean)
            const bizLine = bizInfo.length > 0 ? `\n   Biz: ${bizInfo.join(' | ')}` : ''
            return `${i + 1}. ${formatCompact(r)} — ${r.url}${detailLine}${bizLine}${services}`
          })
          return { content: [{ type: 'text', text: `${results.length} results for "${a.query}":\n${lines.join('\n')}` }] }
        }
        case 'find_similar': {
          if (!a.url) return { content: [{ type: 'text', text: 'Missing url.' }] }
          const res = await exa.findSimilar({
            url: a.url,
            numResults: a.numResults,
            includeDomains: a.includeDomains,
            excludeDomains: a.excludeDomains,
            includeText: a.includeText,
            excludeText: a.excludeText,
            startPublishedDate: a.startPublishedDate,
            endPublishedDate: a.endPublishedDate,
          })
          const results = res.results || []
          if (results.length === 0) return { content: [{ type: 'text', text: `No similar pages for ${a.url}.` }] }
          const lines = results.map((r, i) => {
            const contact = parseContact(r.summary, r.highlights)
            const details = [contact.phone, contact.email, contact.address].filter(Boolean).join(' | ')
            const detailLine = details ? `\n   Contact: ${details}` : ''
            return `${i + 1}. ${formatCompact(r)} — ${r.url}${detailLine}`
          })
          return { content: [{ type: 'text', text: `${results.length} similar to ${a.url}:\n${lines.join('\n')}` }] }
        }
        case 'get_contents': {
          if (!a.urls?.length) return { content: [{ type: 'text', text: 'Missing urls.' }] }
          const res = await exa.getContents(a.urls)
          const results = res.results || []
          if (results.length === 0) return { content: [{ type: 'text', text: 'No content retrieved.' }] }
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
        case 'save_lead_schema': {
          if (!a.fields?.length && !a.extractionQuery) return { content: [{ type: 'text', text: 'Need fields and/or extractionQuery.' }] }
          const schema: LeadSchema = {
            fields: a.fields || [],
            extractionQuery: a.extractionQuery || a.fields.map((f: any) => f.description).join(', '),
          }
          const dir = join(DATA_DIR, 'research')
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, 'lead_schema.json'), JSON.stringify(schema, null, 2))
          const fieldNames = schema.fields.map((f: any) => f.name).join(', ')
          return { content: [{ type: 'text', text: `Lead schema saved. Extraction fields: ${fieldNames || '(query only)'}. All future Exa searches will extract these fields automatically.` }] }
        }
        default:
          return { content: [{ type: 'text', text: `Unknown exa action: ${a.action}` }] }
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
          return { content: [{ type: 'text', text: `Monitor ${m.id} created — "${a.query}" every ${interval}${domainNote}.` }] }
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
