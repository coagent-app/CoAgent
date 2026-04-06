/**
 * Thin Exa API client. Calls Exa directly for now.
 * Future: route through relay for usage tracking + billing.
 */

const EXA_BASE = 'https://api.exa.ai'

export interface ExaContentsOptions {
  text?: { maxCharacters?: number }
  highlights?: boolean | { query?: string; maxCharacters?: number }
  summary?: { query?: string; schema?: Record<string, unknown> }
  subpages?: number
  subpageTarget?: string[]
}

export interface ExaSearchParams {
  query: string
  type?: 'neural' | 'fast' | 'auto' | 'deep' | 'deep-reasoning' | 'instant'
  numResults?: number
  category?: 'company' | 'research paper' | 'news' | 'personal site' | 'financial report' | 'people'
  includeDomains?: string[]
  excludeDomains?: string[]
  includeText?: string[]
  excludeText?: string[]
  startPublishedDate?: string
  endPublishedDate?: string
  startCrawlDate?: string
  endCrawlDate?: string
  contents?: ExaContentsOptions
}

export interface ExaFindSimilarParams {
  url: string
  numResults?: number
  includeDomains?: string[]
  excludeDomains?: string[]
  includeText?: string[]
  excludeText?: string[]
  startPublishedDate?: string
  endPublishedDate?: string
  contents?: ExaContentsOptions
}

export interface ExaResult {
  url: string
  title: string | null
  text?: string
  summary?: string
  highlights?: string[]
  publishedDate?: string
  author?: string
  score?: number
  subpages?: ExaResult[]
}

export interface ExaSearchResponse {
  results: ExaResult[]
  autopromptString?: string
  requestId?: string
}

export interface ExaMonitorCreateParams {
  name?: string
  search: {
    query: string
    numResults?: number
    includeDomains?: string[]
    excludeDomains?: string[]
    contents?: ExaContentsOptions
  }
  webhook: {
    url: string
    events?: string[]
  }
  trigger?: {
    type: 'interval'
    period: string // '1h' | '6h' | '1d' | '7d'
  }
  outputSchema?: {
    type: 'text' | 'object'
    description?: string
    properties?: Record<string, unknown>
    required?: string[]
  }
}

export interface ExaMonitor {
  id: string
  name?: string
  status: string
  search: { query: string; numResults?: number }
  trigger?: { type: string; period: string }
  webhook: { url: string }
  createdAt: string
  updatedAt: string
}

export interface ExaMonitorRun {
  id: string
  status: string
  createdAt: string
}

// Baseline contact fields — always extracted
const BASE_CONTACT_PROPERTIES: Record<string, { type: string; description: string }> = {
  company_name: { type: 'string', description: 'Company or business name' },
  phone: { type: 'string', description: 'Primary phone number' },
  email: { type: 'string', description: 'Primary contact email address' },
  address: { type: 'string', description: 'Physical street address' },
  owner: { type: 'string', description: 'Owner, founder, or primary contact name' },
  employees: { type: 'string', description: 'Number of employees or team size' },
  services: { type: 'string', description: 'Main services or products offered' },
}

/**
 * Lead schema — agent writes this during onboarding based on "what makes a good lead?"
 * File: ~/.coagent/research/lead_schema.json
 * Format: { fields: [{ name: string, description: string }], extractionQuery: string }
 */
export interface LeadSchema {
  fields: { name: string; description: string }[]
  extractionQuery: string  // e.g. "Extract revenue, ad spend evidence, and whether they run paid ads"
}

import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

function loadLeadSchema(): LeadSchema | null {
  const dataDir = process.env.COAGENT_DATA_DIR ?? join(homedir(), '.coagent')
  try {
    return JSON.parse(readFileSync(join(dataDir, 'research', 'lead_schema.json'), 'utf8'))
  } catch { return null }
}

function buildContactSchema(): { schema: Record<string, unknown>; query: string } {
  const lead = loadLeadSchema()

  const properties: Record<string, { type: string; description: string }> = { ...BASE_CONTACT_PROPERTIES }
  const extraFields: string[] = []

  if (lead?.fields) {
    for (const f of lead.fields) {
      const key = f.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
      if (!properties[key]) {
        properties[key] = { type: 'string', description: f.description }
        extraFields.push(f.description)
      }
    }
  }

  const baseQuery = 'Extract contact and business information: phone, email, address, owner name, employee count, services.'
  const query = lead?.extractionQuery
    ? `${baseQuery} Also extract: ${lead.extractionQuery}`
    : baseQuery

  return {
    schema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties,
      required: ['company_name'],
    },
    query,
  }
}

/** Build default contents options — merges base contact fields with user's lead schema */
function getDefaultContents(): ExaContentsOptions {
  const { schema, query } = buildContactSchema()
  return {
    text: { maxCharacters: 400 },
    highlights: { query: 'phone number email address contact information', maxCharacters: 3000 },
    summary: { query, schema },
    subpages: 2,
    subpageTarget: ['contact', 'about'],
  }
}

export class ExaClient {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'Content-Type': 'application/json',
    }
  }

  async search(params: ExaSearchParams): Promise<ExaSearchResponse> {
    const body: Record<string, unknown> = {
      query: params.query,
      type: params.type || 'auto',
      numResults: params.numResults || 10,
    }

    if (params.category) body.category = params.category
    if (params.includeDomains?.length) body.includeDomains = params.includeDomains
    if (params.excludeDomains?.length) body.excludeDomains = params.excludeDomains
    if (params.includeText?.length) body.includeText = params.includeText
    if (params.excludeText?.length) body.excludeText = params.excludeText
    if (params.startPublishedDate) body.startPublishedDate = params.startPublishedDate
    if (params.endPublishedDate) body.endPublishedDate = params.endPublishedDate
    if (params.startCrawlDate) body.startCrawlDate = params.startCrawlDate
    if (params.endCrawlDate) body.endCrawlDate = params.endCrawlDate

    body.contents = params.contents ?? getDefaultContents()

    const res = await fetch(`${EXA_BASE}/search`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Exa search failed (${res.status}): ${err}`)
    }

    return res.json() as Promise<ExaSearchResponse>
  }

  async findSimilar(params: ExaFindSimilarParams): Promise<ExaSearchResponse> {
    const body: Record<string, unknown> = {
      url: params.url,
      numResults: params.numResults || 10,
    }

    if (params.includeDomains?.length) body.includeDomains = params.includeDomains
    if (params.excludeDomains?.length) body.excludeDomains = params.excludeDomains
    if (params.includeText?.length) body.includeText = params.includeText
    if (params.excludeText?.length) body.excludeText = params.excludeText
    if (params.startPublishedDate) body.startPublishedDate = params.startPublishedDate
    if (params.endPublishedDate) body.endPublishedDate = params.endPublishedDate

    body.contents = params.contents ?? getDefaultContents()

    const res = await fetch(`${EXA_BASE}/findSimilar`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Exa findSimilar failed (${res.status}): ${err}`)
    }

    return res.json() as Promise<ExaSearchResponse>
  }

  async getContents(urls: string[], options?: ExaContentsOptions): Promise<ExaSearchResponse> {
    const body: Record<string, unknown> = {
      ids: urls,
      contents: options ?? getDefaultContents(),
    }

    const res = await fetch(`${EXA_BASE}/contents`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Exa contents failed (${res.status}): ${err}`)
    }

    return res.json() as Promise<ExaSearchResponse>
  }

  // ── Search Monitors ──────────────────────────────────────────────────────

  async createMonitor(params: ExaMonitorCreateParams): Promise<ExaMonitor & { webhookSecret?: string }> {
    const res = await fetch(`${EXA_BASE}/monitors`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(params),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Exa createMonitor failed (${res.status}): ${err}`)
    }
    return res.json() as Promise<ExaMonitor & { webhookSecret?: string }>
  }

  async listMonitors(status?: string): Promise<{ monitors: ExaMonitor[] }> {
    const url = status ? `${EXA_BASE}/monitors?status=${status}` : `${EXA_BASE}/monitors`
    const res = await fetch(url, { headers: this.headers() })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Exa listMonitors failed (${res.status}): ${err}`)
    }
    const json = await res.json() as any
    // Exa returns { data: [...] } but we normalize to { monitors: [...] }
    return { monitors: json.data ?? json.monitors ?? [] }
  }

  async deleteMonitor(id: string): Promise<void> {
    const res = await fetch(`${EXA_BASE}/monitors/${id}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Exa deleteMonitor failed (${res.status}): ${err}`)
    }
  }

  async triggerMonitor(id: string): Promise<ExaMonitorRun> {
    const res = await fetch(`${EXA_BASE}/monitors/${id}/trigger`, {
      method: 'POST',
      headers: this.headers(),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Exa triggerMonitor failed (${res.status}): ${err}`)
    }
    return res.json() as Promise<ExaMonitorRun>
  }

}
