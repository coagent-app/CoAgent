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

// JSON schema for structured contact extraction from Exa summaries
const CONTACT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    company_name: { type: 'string', description: 'Company or business name' },
    phone: { type: 'string', description: 'Primary phone number' },
    email: { type: 'string', description: 'Primary contact email address' },
    address: { type: 'string', description: 'Physical street address' },
    owner: { type: 'string', description: 'Owner, founder, or primary contact name' },
    employees: { type: 'string', description: 'Number of employees or team size' },
    services: { type: 'string', description: 'Main services or products offered' },
  },
  required: ['company_name'],
}

/** Default contents options: structured schema + contact page crawling + targeted highlights */
const DEFAULT_CONTENTS: ExaContentsOptions = {
  text: { maxCharacters: 1500 },
  highlights: { query: 'phone number email address contact information', maxCharacters: 3000 },
  summary: {
    query: 'Extract contact information for this company: phone, email, address, owner name, employee count, services.',
    schema: CONTACT_SCHEMA,
  },
  subpages: 2,
  subpageTarget: ['contact', 'about'],
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

    body.contents = params.contents ?? DEFAULT_CONTENTS

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

    body.contents = params.contents ?? DEFAULT_CONTENTS

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
      contents: options ?? DEFAULT_CONTENTS,
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
    const res = await fetch(`${EXA_BASE}/search-monitors`, {
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
    const url = status ? `${EXA_BASE}/search-monitors?status=${status}` : `${EXA_BASE}/search-monitors`
    const res = await fetch(url, { headers: this.headers() })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Exa listMonitors failed (${res.status}): ${err}`)
    }
    return res.json() as Promise<{ monitors: ExaMonitor[] }>
  }

  async deleteMonitor(id: string): Promise<void> {
    const res = await fetch(`${EXA_BASE}/search-monitors/${id}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Exa deleteMonitor failed (${res.status}): ${err}`)
    }
  }

  async triggerMonitor(id: string): Promise<ExaMonitorRun> {
    const res = await fetch(`${EXA_BASE}/search-monitors/${id}/trigger`, {
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
