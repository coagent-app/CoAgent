export interface Env {
  TUNNEL_SECRET: string
  ANTHROPIC_API_KEY: string
  OPENAI_API_KEY: string
  COMPOSIO_API_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  TOKENS: KVNamespace
  USER_SESSION: DurableObjectNamespace
  TEAM_CHANNEL: DurableObjectNamespace
}

// --- Token data stored in KV ---

interface UsageData {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  llmCostUsd: number
  embeddingTokens: number
  embeddingCostUsd: number
  composioActions: number
  composioCostUsd: number
  ttsCharacters: number
  ttsCostUsd: number
  whisperSeconds: number
  whisperCostUsd: number
  totalCostUsd: number
  periodStart: string   // ISO date — resets monthly
}

interface TokenData {
  userId: number          // numeric user ID for Composio isolation
  stripeCustomerId: string
  model: string           // chosen model id e.g. 'claude-sonnet-4-6'
  supportAmount: number   // monthly support amount in cents
  usage: UsageData
  createdAt: string
  active: boolean
  admin?: boolean
}

// --- Model configs ---

interface ChatRequest {
  model?: string         // override model for this request (optional, uses token default)
  messages: { role: string; content: string }[]
  max_tokens?: number
  stream?: boolean
  system?: string
  tools?: unknown[]
}

interface ModelConfig {
  provider: 'anthropic'
  apiModel: string
  label: string
  description: string
  inputPer1k: number
  outputPer1k: number
  cacheWritePer1k: number   // cache creation: 1.25x input
  cacheReadPer1k: number    // cache read: 0.1x input
}

const MODELS: Record<string, ModelConfig> = {
  'claude-opus-4-6': {
    provider: 'anthropic',
    apiModel: 'claude-opus-4-6-20250205',
    label: 'Claude Opus 4.6',
    description: 'Most powerful — deep reasoning',
    inputPer1k: 0.005,
    outputPer1k: 0.025,
    cacheWritePer1k: 0.00625,
    cacheReadPer1k: 0.0005,
  },
  'claude-sonnet-4-6': {
    provider: 'anthropic',
    apiModel: 'claude-sonnet-4-6-20250620',
    label: 'Claude Sonnet 4.6',
    description: 'Best balance of quality and cost',
    inputPer1k: 0.003,
    outputPer1k: 0.015,
    cacheWritePer1k: 0.00375,
    cacheReadPer1k: 0.0003,
  },
  'claude-haiku-4-5': {
    provider: 'anthropic',
    apiModel: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    description: 'Fast and cheap — conversation and simple tasks',
    inputPer1k: 0.001,
    outputPer1k: 0.005,
    cacheWritePer1k: 0.00125,
    cacheReadPer1k: 0.0001,
  },
}

/** Calculate LLM cost from Anthropic usage object, accounting for cache pricing */
function calcAnthropicCost(
  usage: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
  config: ModelConfig,
): number {
  const input = (usage.input_tokens || 0) / 1000
  const output = (usage.output_tokens || 0) / 1000
  const cacheWrite = (usage.cache_creation_input_tokens || 0) / 1000
  const cacheRead = (usage.cache_read_input_tokens || 0) / 1000
  return input * config.inputPer1k
    + output * config.outputPer1k
    + cacheWrite * config.cacheWritePer1k
    + cacheRead * config.cacheReadPer1k
}

// --- Helpers ---

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, anthropic-version, anthropic-beta, x-api-key',
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  })
}

function generateToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

// OpenAI embeddings pricing: $0.02 per 1M tokens (text-embedding-3-small)
const OPENAI_EMBED_COST_PER_TOKEN = 0.00000002
// OpenAI TTS-1 pricing: $15 per 1M characters
const TTS_COST_PER_CHAR = 0.000015
// OpenAI Whisper pricing: $0.006 per minute
const WHISPER_COST_PER_SECOND = 0.0001
// Composio pricing: $0.02 per 1,000 actions
const COMPOSIO_COST_PER_ACTION = 0.00002

function freshUsage(): UsageData {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    llmCostUsd: 0,
    embeddingTokens: 0,
    embeddingCostUsd: 0,
    composioActions: 0,
    composioCostUsd: 0,
    ttsCharacters: 0,
    ttsCostUsd: 0,
    whisperSeconds: 0,
    whisperCostUsd: 0,
    totalCostUsd: 0,
    periodStart: new Date().toISOString(),
  }
}

async function getToken(env: Env, token: string): Promise<TokenData | null> {
  const raw = await env.TOKENS.get(token)
  if (!raw) return null
  return JSON.parse(raw) as TokenData
}

async function saveToken(env: Env, token: string, data: TokenData): Promise<void> {
  await env.TOKENS.put(token, JSON.stringify(data))
}

/** Scan a tee'd SSE stream for Anthropic usage events and save to KV (best-effort, background). */
async function scanStreamForUsage(
  stream: ReadableStream<Uint8Array>,
  bodyText: string,
  token: string,
  data: TokenData,
  env: Env,
): Promise<void> {
  try {
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value

      // Process complete lines
      const lines = buffer.split('\n')
      buffer = lines.pop()! // keep incomplete last line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const json = line.slice(6).trim()
        if (json === '[DONE]') continue

        try {
          const event = JSON.parse(json)
          if (event.type === 'message_start' && event.message?.usage) {
            const u = event.message.usage
            usage.input_tokens += u.input_tokens || 0
            usage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0
            usage.cache_read_input_tokens += u.cache_read_input_tokens || 0
          } else if (event.type === 'message_delta' && event.usage) {
            usage.output_tokens += event.usage.output_tokens || 0
          }
        } catch {
          // Skip unparseable lines
        }
      }
    }

    if (usage.input_tokens > 0 || usage.output_tokens > 0 || usage.cache_read_input_tokens > 0 || usage.cache_creation_input_tokens > 0) {
      const modelId = (() => {
        try { return (JSON.parse(bodyText) as { model?: string }).model || '' } catch { return '' }
      })()
      const modelConfig = MODELS[modelId as keyof typeof MODELS]
        || Object.values(MODELS).find(m => m.apiModel === modelId)
        || MODELS['claude-sonnet-4-6']

      // Re-read token data to avoid stale overwrites
      const freshData = await getToken(env, token) || data
      freshData.usage.inputTokens += usage.input_tokens
      freshData.usage.outputTokens += usage.output_tokens
      freshData.usage.cacheWriteTokens = (freshData.usage.cacheWriteTokens || 0) + usage.cache_creation_input_tokens
      freshData.usage.cacheReadTokens = (freshData.usage.cacheReadTokens || 0) + usage.cache_read_input_tokens
      const callCost = calcAnthropicCost(usage, modelConfig)
      freshData.usage.llmCostUsd += callCost
      freshData.usage.totalCostUsd += callCost
      await saveToken(env, token, freshData)
    }
  } catch {
    // Usage tracking is best-effort — never fail the client stream
  }
}

async function validateRequest(request: Request, env: Env): Promise<{ token: string; data: TokenData } | Response> {
  const auth = request.headers.get('Authorization')
  const xApiKey = request.headers.get('x-api-key')
  const url = new URL(request.url)
  const queryToken = url.searchParams.get('token')
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : xApiKey ?? queryToken ?? null
  if (!token) {
    return jsonResponse({ error: 'Missing auth' }, 401)
  }
  const data = await getToken(env, token)
  if (!data) {
    return jsonResponse({ error: 'Invalid token' }, 401)
  }
  if (!data.active) {
    return jsonResponse({ error: 'Token revoked — subscription cancelled' }, 403)
  }

  return { token, data }
}

// --- Provider proxies ---

async function proxyAnthropic(body: ChatRequest, model: ModelConfig, env: Env): Promise<Response> {
  const anthropicBody: Record<string, unknown> = {
    model: model.apiModel,
    max_tokens: body.max_tokens || 4096,
    messages: body.messages,
  }
  if (body.system) anthropicBody.system = body.system
  if (body.tools) anthropicBody.tools = body.tools
  if (body.stream) anthropicBody.stream = true

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(anthropicBody),
  })

  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'application/json',
      ...corsHeaders(),
    },
  })
}

// --- OpenAI embedding proxy ---

async function proxyOpenAIEmbeddings(request: Request, env: Env, token: string, data: TokenData): Promise<Response> {
  const body = await request.json() as { input: string | string[]; model?: string; dimensions?: number }
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      input: body.input,
      model: body.model || 'text-embedding-3-small',
      ...(body.dimensions ? { dimensions: body.dimensions } : {}),
    }),
  })
  if (res.status === 200) {
    try {
      const clone = res.clone()
      const resBody = await clone.json() as { usage?: { total_tokens?: number } }
      const tokens = resBody.usage?.total_tokens || 0
      const cost = tokens * OPENAI_EMBED_COST_PER_TOKEN
      data.usage.embeddingTokens += tokens
      data.usage.embeddingCostUsd += cost
      data.usage.totalCostUsd += cost
      saveToken(env, token, data).catch(() => {})
    } catch {}
  }
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  })
}

// --- OpenAI audio proxy (TTS + transcription) ---

async function proxyOpenAITts(request: Request, env: Env, token: string, data: TokenData): Promise<Response> {
  const body = await request.clone().json() as { input?: string }
  const chars = (body.input || '').length

  const headers = new Headers(request.headers)
  headers.set('Authorization', `Bearer ${env.OPENAI_API_KEY}`)
  headers.delete('host')
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers,
    body: request.body,
  })

  if (res.ok && chars > 0) {
    const cost = chars * TTS_COST_PER_CHAR
    data.usage.ttsCharacters += chars
    data.usage.ttsCostUsd += cost
    data.usage.totalCostUsd += cost
    saveToken(env, token, data).catch(() => {})
  }

  const respHeaders: Record<string, string> = { ...corsHeaders() }
  const ct = res.headers.get('content-type')
  if (ct) respHeaders['Content-Type'] = ct
  return new Response(res.body, { status: res.status, headers: respHeaders })
}

async function proxyOpenAITranscription(request: Request, env: Env, token: string, data: TokenData): Promise<Response> {
  const headers = new Headers(request.headers)
  headers.set('Authorization', `Bearer ${env.OPENAI_API_KEY}`)
  headers.delete('host')
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers,
    body: request.body,
  })

  if (res.ok) {
    // Estimate audio duration from content-length (rough: ~16KB/s for ogg/opus)
    const contentLength = parseInt(request.headers.get('content-length') || '0')
    const estimatedSeconds = contentLength > 0 ? Math.max(1, contentLength / 16000) : 5
    const cost = estimatedSeconds * WHISPER_COST_PER_SECOND
    data.usage.whisperSeconds += estimatedSeconds
    data.usage.whisperCostUsd += cost
    data.usage.totalCostUsd += cost
    saveToken(env, token, data).catch(() => {})
  }

  const respHeaders: Record<string, string> = { ...corsHeaders() }
  const ct = res.headers.get('content-type')
  if (ct) respHeaders['Content-Type'] = ct
  return new Response(res.body, { status: res.status, headers: respHeaders })
}

// --- Composio proxy (whitelisted endpoints only) ---

const COMPOSIO_ALLOWED: { method: string; pattern: RegExp }[] = [
  { method: 'POST', pattern: /^\/connected_accounts$/ },
  { method: 'POST', pattern: /^\/connected_accounts\/link$/ },
  { method: 'GET', pattern: /^\/connected_accounts$/ },
  { method: 'DELETE', pattern: /^\/connected_accounts\/[a-zA-Z0-9_-]+$/ },
  { method: 'POST', pattern: /^\/trigger_instances\/[a-zA-Z0-9_-]+\/upsert$/ },
  { method: 'POST', pattern: /^\/actions\/[a-zA-Z0-9_-]+\/execute$/ },
  { method: 'GET', pattern: /^\/toolkits\/[a-zA-Z0-9_-]+$/ },
  { method: 'GET', pattern: /^\/auth_configs$/ },
  { method: 'POST', pattern: /^\/auth_configs$/ },
  { method: 'GET', pattern: /^\/mcp\/servers$/ },
  { method: 'POST', pattern: /^\/mcp\/servers$/ },
  { method: 'PATCH', pattern: /^\/mcp\/[a-zA-Z0-9_-]+$/ },
  { method: 'POST', pattern: /^\/files\/upload\/request$/ },
  { method: 'GET', pattern: /^\/triggers_types$/ },
  { method: 'GET', pattern: /^\/triggers_types\/list\/enum$/ },
  { method: 'GET', pattern: /^\/triggers_types\/[a-zA-Z0-9_-]+$/ },
  { method: 'GET', pattern: /^\/webhook_subscriptions$/ },
  { method: 'POST', pattern: /^\/webhook_subscriptions$/ },
  { method: 'DELETE', pattern: /^\/webhook_subscriptions\/[a-zA-Z0-9_-]+$/ },
]

async function proxyComposio(request: Request, env: Env, token: string, data: TokenData): Promise<Response> {
  const url = new URL(request.url)
  const composioPath = url.pathname.slice('/v1/composio'.length)

  // Guard against path traversal
  if (composioPath.includes('..')) {
    return jsonResponse({ error: 'Invalid path' }, 400)
  }

  // Whitelist check
  const allowed = COMPOSIO_ALLOWED.some(
    r => r.method === request.method && r.pattern.test(composioPath)
  )
  if (!allowed) {
    return jsonResponse({ error: 'Composio endpoint not allowed' }, 403)
  }

  // For GET requests: strip any client-supplied user_ids and replace with the authenticated user's ID
  const forwardSearch = new URLSearchParams(url.search)
  if (request.method === 'GET' || request.method === 'HEAD') {
    forwardSearch.delete('user_ids')
    forwardSearch.append('user_ids', String(data.userId))
  }
  const searchString = forwardSearch.toString() ? `?${forwardSearch.toString()}` : ''

  const composioUrl = `https://backend.composio.dev/api/v3${composioPath}${searchString}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': env.COMPOSIO_API_KEY,
  }

  const init: RequestInit = {
    method: request.method,
    headers,
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // Override user_id in body to prevent impersonation
    let bodyText = await request.text()
    if (bodyText) {
      try {
        const bodyJson = JSON.parse(bodyText)
        bodyJson.user_id = String(data.userId)
        bodyText = JSON.stringify(bodyJson)
      } catch {
        // Not JSON — pass through as-is
      }
    }
    init.body = bodyText
  }

  const res = await fetch(composioUrl, init)

  // Track action executions
  if (res.status === 200 && request.method === 'POST' && composioPath.includes('/execute')) {
    data.usage.composioActions += 1
    data.usage.composioCostUsd += COMPOSIO_COST_PER_ACTION
    data.usage.totalCostUsd += COMPOSIO_COST_PER_ACTION
    saveToken(env, token, data).catch(() => {})
  }

  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'application/json',
      ...corsHeaders(),
    },
  })
}

// --- Stripe signature verification ---

async function verifyStripeSignature(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(
    sigHeader.split(',').map(p => {
      const [k, v] = p.split('=')
      return [k, v]
    })
  )
  const timestamp = parts['t']
  const signature = parts['v1']
  if (!timestamp || !signature) return false

  // Reject if timestamp is older than 5 minutes (replay protection)
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp)
  if (age > 300) return false

  const signedPayload = `${timestamp}.${payload}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload))
  const expected = Array.from(new Uint8Array(mac), b => b.toString(16).padStart(2, '0')).join('')

  return expected === signature
}

// --- Stripe webhook handler ---

async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text()

  const sig = request.headers.get('stripe-signature')
  if (!sig) return jsonResponse({ error: 'Missing signature' }, 400)

  const valid = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET)
  if (!valid) return jsonResponse({ error: 'Invalid signature' }, 401)

  const event = JSON.parse(body)

  switch (event.type) {
    // New subscription → generate token
    case 'checkout.session.completed': {
      const session = event.data.object
      const token = generateToken()

      // Assign a numeric user ID (atomic increment via KV)
      const prevId = parseInt(await env.TOKENS.get('_next_user_id') || '0')
      const userId = prevId + 1
      await env.TOKENS.put('_next_user_id', String(userId))

      const tokenData: TokenData = {
        userId,
        stripeCustomerId: session.customer,
        model: 'claude-sonnet-4-6',
        supportAmount: 0,
        usage: freshUsage(),
        createdAt: new Date().toISOString(),
        active: true,
      }
      await saveToken(env, token, tokenData)

      // Store reverse lookup: stripeCustomerId → token
      await env.TOKENS.put(`stripe:${session.customer}`, token)

      console.log(`New user #${userId} for ${session.customer}: ${token}`)

      return jsonResponse({ ok: true, token, userId })
    }

    // Subscription cancelled → revoke token
    case 'customer.subscription.deleted': {
      const sub = event.data.object
      const token = await env.TOKENS.get(`stripe:${sub.customer}`)
      if (token) {
        const data = await getToken(env, token)
        if (data) {
          data.active = false
          await saveToken(env, token, data)
        }
      }
      return jsonResponse({ ok: true })
    }

    default:
      return jsonResponse({ ok: true, ignored: true })
  }
}

// --- Transparent Anthropic SDK proxy ---
// Accepts requests in Anthropic Messages API format and forwards to Anthropic.
// The agent-core SDK points its baseURL here, so this must be a drop-in proxy.

async function handleMessagesProxy(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const result = await validateRequest(request, env)
  if (result instanceof Response) return result

  const { token, data } = result

  // Reset usage if new billing period (monthly)
  const periodStart = new Date(data.usage.periodStart)
  const now = new Date()
  if (now.getMonth() !== periodStart.getMonth() || now.getFullYear() !== periodStart.getFullYear()) {
    data.usage = freshUsage()
    await saveToken(env, token, data)
  }

  // Forward to Anthropic, replacing auth with the real API key
  const body = await request.text()
  const isStream = body.includes('"stream":true') || body.includes('"stream": true')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': env.ANTHROPIC_API_KEY,
    'anthropic-version': request.headers.get('anthropic-version') || '2023-06-01',
  }
  const beta = request.headers.get('anthropic-beta')
  if (beta) headers['anthropic-beta'] = beta

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body,
  })

  // Track usage for streaming responses — tee the stream so client gets data AND we scan for usage
  if (isStream && res.status === 200 && res.body) {
    const [clientStream, usageStream] = res.body.tee()
    // Background: scan usage stream after response is sent
    ctx.waitUntil(scanStreamForUsage(usageStream, body, token, data, env))
    return new Response(clientStream, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('Content-Type') || 'text/event-stream',
        ...corsHeaders(),
      },
    })
  }

  // Track usage for non-streaming responses
  if (!isStream && res.status === 200) {
    try {
      const clone = res.clone()
      const resBody = await clone.json() as Record<string, unknown>
      const usage = resBody.usage as { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined
      const modelId = (JSON.parse(body) as { model?: string }).model || ''
      // Find matching model config for cost calculation (fall back to Sonnet pricing)
      const modelConfig = MODELS[modelId as keyof typeof MODELS]
        || Object.values(MODELS).find(m => m.apiModel === modelId)
        || MODELS['claude-sonnet-4-6']
      if (usage && modelConfig) {
        data.usage.inputTokens += usage.input_tokens || 0
        data.usage.outputTokens += usage.output_tokens || 0
        data.usage.cacheWriteTokens = (data.usage.cacheWriteTokens || 0) + (usage.cache_creation_input_tokens || 0)
        data.usage.cacheReadTokens = (data.usage.cacheReadTokens || 0) + (usage.cache_read_input_tokens || 0)
        const callCost = calcAnthropicCost(usage, modelConfig)
        data.usage.llmCostUsd += callCost
        data.usage.totalCostUsd += callCost
        await saveToken(env, token, data)
      }
    } catch {
      // Usage tracking is best-effort
    }
  }

  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'application/json',
      ...corsHeaders(),
    },
  })
}

// --- UserSession Durable Object ---

export class UserSession {
  private state: DurableObjectState
  private env: Env
  private cachedChatHistory: string | null = null

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
    this.state.blockConcurrencyWhile(async () => {
      this.state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS webhook_queue (
          id TEXT PRIMARY KEY,
          trigger_name TEXT NOT NULL,
          payload TEXT NOT NULL,
          received_at TEXT NOT NULL
        )
      `)
      // Restore cached chat history from storage
      this.cachedChatHistory = (await this.state.storage.get<string>('chat_history')) ?? null
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // WebSocket upgrade — queued events flush on first client ping, not during handshake
    if (request.headers.get('Upgrade') === 'websocket') {
      // Notify existing sockets that a new client connected (triggers state dump from agent)
      const existing = this.state.getWebSockets()
      if (existing.length > 0) {
        const notify = JSON.stringify({ type: 'client_connected' })
        for (const s of existing) {
          try { s.send(notify) } catch { /* stale */ }
        }
      }
      const pair = new WebSocketPair()
      // Tag socket with client type so we can distinguish desktop/mobile later
      const clientType = url.searchParams.get('client') || 'unknown'
      this.state.acceptWebSocket(pair[1], [clientType])
      // Send cached chat history directly to new client — no round-trip needed
      if (this.cachedChatHistory) {
        try { pair[1].send(this.cachedChatHistory) } catch { /* ignore */ }
      }
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    // POST /push — receive a webhook payload and deliver or queue it
    if (request.method === 'POST' && url.pathname === '/push') {
      const payload = await request.json()
      const sockets = this.state.getWebSockets()
      if (sockets.length > 0) {
        const msg = JSON.stringify({ type: 'webhook', payload })
        for (const ws of sockets) {
          ws.send(msg)
        }
      } else {
        const id = crypto.randomUUID()
        const receivedAt = new Date().toISOString()
        this.state.storage.sql.exec(
          `INSERT INTO webhook_queue (id, trigger_name, payload, received_at) VALUES (?, ?, ?, ?)`,
          id,
          (payload as { trigger_name?: string }).trigger_name ?? 'unknown',
          JSON.stringify(payload),
          receivedAt,
        )
      }
      return new Response('OK', { status: 200 })
    }

    return new Response('Not found', { status: 404 })
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message === 'ping') {
      // Flush any queued webhooks on ping (no-op when queue is empty)
      this.flushQueue(ws)
      ws.send('pong')
      return
    }

    const data = typeof message === 'string' ? message : new TextDecoder().decode(message)

    // Intercept push-management messages from mobile — handle in relay, don't forward
    try {
      const parsed = JSON.parse(data)
      if (parsed?.type === 'register_push_token') {
        this.state.storage.put('push_token', parsed.token)
        console.log('[UserSession] Push token registered')
        return
      }
      if (parsed?.type === 'update_notification_prefs') {
        this.state.storage.put('notification_mode', parsed.mode)
        console.log('[UserSession] Notification prefs updated:', parsed.mode)
        return
      }

      // Intercept push_notification from agent — send Expo push + broadcast to clients
      if (parsed?.type === 'push_notification') {
        void this.maybeSendPush(parsed.title, parsed.body)
        // Still broadcast so connected mobile clients can show in-app notification
      }

      // Cache chat_history and chat_response so new clients get history instantly
      if (parsed?.type === 'chat_history') {
        this.cachedChatHistory = data
        this.state.storage.put('chat_history', data)
      } else if (parsed?.type === 'chat_response') {
        // Append new message to cached history
        if (this.cachedChatHistory) {
          try {
            const cached = JSON.parse(this.cachedChatHistory)
            cached.messages.push(parsed.message)
            // Keep last 50 messages
            if (cached.messages.length > 50) cached.messages = cached.messages.slice(-50)
            this.cachedChatHistory = JSON.stringify(cached)
            this.state.storage.put('chat_history', this.cachedChatHistory)
          } catch { /* ignore parse errors */ }
        }
      }
    } catch { /* non-JSON, skip caching */ }

    // Broadcast to all OTHER connected sockets (agent ↔ mobile relay)
    const sockets = this.state.getWebSockets()
    for (const s of sockets) {
      if (s !== ws) {
        try { s.send(data) } catch { /* stale socket, ignore */ }
      }
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    ws.close(code, reason)
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    ws.close(1011, 'WebSocket error')
  }

  /**
   * Send an Expo push notification if conditions allow.
   * Modes: always, away_only (default), never
   */
  private async maybeSendPush(title: string, body: string): Promise<void> {
    const pushToken = await this.state.storage.get<string>('push_token')
    if (!pushToken) return

    const mode = (await this.state.storage.get<string>('notification_mode')) || 'away_only'
    if (mode === 'never') return

    // For 'away_only', check if a desktop client is connected
    if (mode === 'away_only') {
      const desktopSockets = this.state.getWebSockets('desktop')
      if (desktopSockets.length > 0) return
    }

    try {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: pushToken,
          title,
          body,
          sound: 'default',
        }),
      })
      console.log('[UserSession] Push sent:', title)
    } catch (err) {
      console.error('[UserSession] Push failed:', err)
    }
  }

  private flushQueue(ws: WebSocket): void {
    // Delete events older than 48 hours
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    this.state.storage.sql.exec(`DELETE FROM webhook_queue WHERE received_at < ?`, cutoff)

    // Send remaining queued events in order
    const rows = this.state.storage.sql.exec(
      `SELECT id, payload, received_at FROM webhook_queue ORDER BY received_at ASC`
    ).toArray()

    for (const row of rows) {
      ws.send(JSON.stringify({
        type: 'webhook',
        payload: JSON.parse(row.payload as string),
        queued: true,
        receivedAt: row.received_at,
      }))
    }

    // Clear queue after flushing
    this.state.storage.sql.exec(`DELETE FROM webhook_queue`)
  }
}

// --- TeamChannel Durable Object ---

export class TeamChannel {
  private state: DurableObjectState
  private env: Env

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        from_user_id TEXT NOT NULL,
        from_name TEXT NOT NULL,
        from_role TEXT NOT NULL,
        is_agent INTEGER NOT NULL DEFAULT 1,
        visible TEXT NOT NULL,
        agent_context TEXT NOT NULL DEFAULT '',
        to_target TEXT,
        attachments TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `)
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS offline_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `)
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS team_notes (
        key TEXT PRIMARY KEY DEFAULT 'main',
        content TEXT NOT NULL DEFAULT '',
        updated_by TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.headers.get('Upgrade') === 'websocket') {
      const userId = url.searchParams.get('userId') || 'unknown'
      const pair = new WebSocketPair()
      this.state.acceptWebSocket(pair[1], [userId])

      const queued = this.state.storage.sql.exec(
        `SELECT message_json FROM offline_queue WHERE user_id = ? ORDER BY created_at ASC`, userId
      ).toArray()
      for (const row of queued) {
        pair[1].send(row.message_json as string)
      }
      this.state.storage.sql.exec(`DELETE FROM offline_queue WHERE user_id = ?`, userId)

      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    if (request.method === 'POST' && url.pathname === '/message') {
      const msg = await request.json() as any

      this.state.storage.sql.exec(
        `INSERT INTO messages (id, timestamp, from_user_id, from_name, from_role, is_agent, visible, agent_context, to_target, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        msg.id, msg.timestamp, msg.from.userId, msg.from.name, msg.from.role,
        msg.from.isAgent ? 1 : 0, msg.visible, msg.agentContext || '',
        JSON.stringify(msg.to), JSON.stringify(msg.attachments || [])
      )

      this.state.storage.sql.exec(
        `DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY created_at DESC LIMIT 500)`
      )

      const msgJson = JSON.stringify({ type: 'team_message', message: msg })

      const sockets = this.state.getWebSockets()
      const connectedUserIds = new Set<string>()
      for (const ws of sockets) {
        const tags = this.state.getTags(ws)
        const uid = tags[0] || 'unknown'
        connectedUserIds.add(uid)
        if (uid !== msg.from.userId) {
          ws.send(msgJson)
        }
      }

      const teamKey = url.searchParams.get('teamId')
      if (teamKey) {
        const membersJson = await this.env.TOKENS.get(`team:${teamKey}:members`)
        if (membersJson) {
          const members = JSON.parse(membersJson) as { userId: string }[]
          for (const member of members) {
            if (!connectedUserIds.has(member.userId) && member.userId !== msg.from.userId) {
              this.state.storage.sql.exec(
                `INSERT INTO offline_queue (user_id, message_json) VALUES (?, ?)`,
                member.userId, msgJson
              )
            }
          }
        }
      }

      return new Response('OK', { status: 200 })
    }

    if (request.method === 'GET' && url.pathname === '/history') {
      const limit = parseInt(url.searchParams.get('limit') || '50')
      const rows = this.state.storage.sql.exec(
        `SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`, limit
      ).toArray()

      const messages = rows.reverse().map((r: any) => ({
        id: r.id,
        teamId: url.searchParams.get('teamId') || '',
        timestamp: r.timestamp,
        from: { userId: r.from_user_id, name: r.from_name, role: r.from_role, isAgent: r.is_agent === 1 },
        visible: r.visible,
        agentContext: r.agent_context,
        to: JSON.parse(r.to_target || 'null'),
        attachments: JSON.parse(r.attachments)
      }))

      return new Response(JSON.stringify(messages), {
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // GET /notes — read shared team notes
    if (request.method === 'GET' && url.pathname === '/notes') {
      const row = this.state.storage.sql.exec(
        `SELECT content, updated_by, updated_at FROM team_notes WHERE key = 'main'`
      ).toArray()[0]
      const result = row
        ? { content: row.content as string, updatedBy: row.updated_by as string, updatedAt: row.updated_at as number }
        : { content: '', updatedBy: '', updatedAt: 0 }
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // PUT /notes — update shared team notes
    if (request.method === 'PUT' && url.pathname === '/notes') {
      const body = await request.json() as { content: string; userId: string }
      this.state.storage.sql.exec(
        `INSERT INTO team_notes (key, content, updated_by, updated_at) VALUES ('main', ?, ?, unixepoch())
         ON CONFLICT(key) DO UPDATE SET content = ?, updated_by = ?, updated_at = unixepoch()`,
        body.content, body.userId, body.content, body.userId
      )

      // Broadcast update notification to all connected team members
      const notification = JSON.stringify({ type: 'team_notes_updated', updatedBy: body.userId })
      for (const ws of this.state.getWebSockets()) {
        ws.send(notification)
      }

      return new Response('OK', { status: 200 })
    }

    return new Response('Not found', { status: 404 })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === 'ping') { ws.send('pong'); return }
  }

  async webSocketClose(_ws: WebSocket) {}
}

// --- Main router ---

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    // --- Stripe webhook ---
    if (request.method === 'POST' && url.pathname === '/stripe/webhook') {
      return handleStripeWebhook(request, env)
    }

    // --- Team endpoints ---

    if (url.pathname.startsWith('/team/')) {
      const token = request.headers.get('Authorization')?.replace('Bearer ', '') || request.headers.get('x-api-key') || ''
      const authResult = await validateRequest(request, env)
      if (authResult instanceof Response) return authResult
      const tokenData = authResult.data
      const userId = String((tokenData as any).userId)

      // POST /team/create — create a new team
      if (request.method === 'POST' && url.pathname === '/team/create') {
        const body = await request.json() as { name?: string; memberName?: string; memberRole?: string; memberHandles?: string; userId?: string }
        const teamId = crypto.randomUUID()
        const inviteCode = generateToken().slice(0, 16)

        const memberUserId = body.userId || String(userId)
        const teamMeta = {
          teamId,
          name: body.name || 'My Team',
          createdBy: memberUserId,
          createdAt: new Date().toISOString(),
        }
        await env.TOKENS.put(`team:${teamId}:meta`, JSON.stringify(teamMeta))

        const members = [{ userId: memberUserId, name: body.memberName || 'Owner', role: body.memberRole || 'owner', handles: body.memberHandles || '', joinedAt: new Date().toISOString() }]
        await env.TOKENS.put(`team:${teamId}:members`, JSON.stringify(members))
        await env.TOKENS.put(`team:invite:${inviteCode}`, teamId)

        // Associate user token with team
        ;(tokenData as any).teamId = teamId
        await saveToken(env, token, tokenData)

        return jsonResponse({ ok: true, teamId, inviteCode, team: teamMeta })
      }

      // POST /team/join — join a team via invite code
      if (request.method === 'POST' && url.pathname === '/team/join') {
        const body = await request.json() as { inviteCode?: string; userId?: string; memberName?: string; memberRole?: string; memberHandles?: string }
        if (!body.inviteCode) return jsonResponse({ error: 'Missing inviteCode' }, 400)

        const teamId = await env.TOKENS.get(`team:invite:${body.inviteCode}`)
        if (!teamId) return jsonResponse({ error: 'Invalid invite code' }, 404)

        const memberUserId = body.userId || String(userId)
        const membersJson = await env.TOKENS.get(`team:${teamId}:members`)
        const members: { userId: string; name: string; role: string; handles: string; joinedAt: string }[] = membersJson ? JSON.parse(membersJson) : []

        // Avoid duplicate membership
        if (!members.find(m => m.userId === memberUserId)) {
          members.push({ userId: memberUserId, name: body.memberName || 'Member', role: body.memberRole || 'member', handles: body.memberHandles || '', joinedAt: new Date().toISOString() })
          await env.TOKENS.put(`team:${teamId}:members`, JSON.stringify(members))
        }

        ;(tokenData as any).teamId = teamId
        await saveToken(env, token, tokenData)

        const metaJson = await env.TOKENS.get(`team:${teamId}:meta`)
        const meta = metaJson ? JSON.parse(metaJson) : { teamId }
        return jsonResponse({ ok: true, teamId, team: meta, members })
      }

      // GET /team/roster — get team info and members
      if (request.method === 'GET' && url.pathname === '/team/roster') {
        const teamId = url.searchParams.get('teamId') || (tokenData as any).teamId
        if (!teamId) return jsonResponse({ error: 'No team associated with this token' }, 404)

        const [metaJson, membersJson] = await Promise.all([
          env.TOKENS.get(`team:${teamId}:meta`),
          env.TOKENS.get(`team:${teamId}:members`),
        ])
        if (!metaJson) return jsonResponse({ error: 'Team not found' }, 404)

        const meta = JSON.parse(metaJson)
        const members = membersJson ? JSON.parse(membersJson) : []
        return jsonResponse({ team: meta, members })
      }

      // POST /team/invite — generate a new invite code
      if (request.method === 'POST' && url.pathname === '/team/invite') {
        const teamId = (tokenData as any).teamId
        if (!teamId) return jsonResponse({ error: 'No team associated with this token' }, 404)

        const inviteCode = generateToken().slice(0, 16)
        await env.TOKENS.put(`team:invite:${inviteCode}`, teamId)
        return jsonResponse({ ok: true, inviteCode })
      }

      // GET /team/ws — WebSocket upgrade to TeamChannel DO
      if (request.headers.get('Upgrade') === 'websocket' && url.pathname === '/team/ws') {
        const teamId = url.searchParams.get('teamId') || (tokenData as any).teamId
        if (!teamId) return new Response('No team associated with this token', { status: 404 })

        const doId = env.TEAM_CHANNEL.idFromName(teamId)
        const stub = env.TEAM_CHANNEL.get(doId)
        // Forward with the client-supplied userId (RELAY_USER_ID) so the DO
        // tags the socket with the same id used in message from.userId.
        // This ensures the echo-exclusion check (uid !== msg.from.userId) works.
        const doUrl = new URL(request.url)
        const clientUserId = url.searchParams.get('userId') || userId
        doUrl.searchParams.set('userId', clientUserId)
        return stub.fetch(new Request(doUrl.toString(), request))
      }

      // POST /team/message — send message via REST to TeamChannel DO
      if (request.method === 'POST' && url.pathname === '/team/message') {
        const teamId = url.searchParams.get('teamId') || (tokenData as any).teamId
        if (!teamId) return jsonResponse({ error: 'No team associated with this token' }, 404)

        const doId = env.TEAM_CHANNEL.idFromName(teamId)
        const stub = env.TEAM_CHANNEL.get(doId)
        const doUrl = `https://internal/message?teamId=${teamId}`
        return stub.fetch(new Request(doUrl, {
          method: 'POST',
          body: request.body,
          headers: { 'Content-Type': 'application/json' },
        }))
      }

      // GET /team/history — get message history from TeamChannel DO
      if (request.method === 'GET' && url.pathname === '/team/history') {
        const teamId = url.searchParams.get('teamId') || (tokenData as any).teamId
        if (!teamId) return jsonResponse({ error: 'No team associated with this token' }, 404)

        const limit = url.searchParams.get('limit') || '50'
        const doId = env.TEAM_CHANNEL.idFromName(teamId)
        const stub = env.TEAM_CHANNEL.get(doId)
        const doUrl = `https://internal/history?teamId=${teamId}&limit=${limit}`
        const res = await stub.fetch(new Request(doUrl))
        return new Response(res.body, {
          status: res.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        })
      }

      // GET /team/notes — read shared team notes
      if (request.method === 'GET' && url.pathname === '/team/notes') {
        const teamId = url.searchParams.get('teamId') || (tokenData as any).teamId
        if (!teamId) return jsonResponse({ error: 'No team associated with this token' }, 404)

        const doId = env.TEAM_CHANNEL.idFromName(teamId)
        const stub = env.TEAM_CHANNEL.get(doId)
        const res = await stub.fetch(new Request('https://internal/notes'))
        return new Response(res.body, {
          status: res.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        })
      }

      // PUT /team/notes — update shared team notes
      if (request.method === 'PUT' && url.pathname === '/team/notes') {
        const teamId = url.searchParams.get('teamId') || (tokenData as any).teamId
        if (!teamId) return jsonResponse({ error: 'No team associated with this token' }, 404)

        const doId = env.TEAM_CHANNEL.idFromName(teamId)
        const stub = env.TEAM_CHANNEL.get(doId)
        const res = await stub.fetch(new Request('https://internal/notes', {
          method: 'PUT',
          body: request.body,
          headers: { 'Content-Type': 'application/json' },
        }))
        return new Response(res.body, {
          status: res.status,
          headers: { ...corsHeaders() },
        })
      }

      return jsonResponse({ error: 'Not found' }, 404)
    }

    // WebSocket connection
    if (request.headers.get('Upgrade') === 'websocket' && url.pathname.startsWith('/ws/')) {
      const userId = url.pathname.split('/')[2]
      const token = url.searchParams.get('token')
      if (!token) return new Response('Missing token', { status: 401 })
      const data = await getToken(env, token)
      if (!data || !data.active) return new Response('Invalid token', { status: 401 })
      // Use the token's userId — the URL path userId is for backwards compat only
      const resolvedUserId = String(data.userId)
      const doId = env.USER_SESSION.idFromName(resolvedUserId)
      const stub = env.USER_SESSION.get(doId)
      return stub.fetch(request)
    }

    // Exa monitor webhook → route to user's DO (userId in URL)
    const exaMatch = url.pathname.match(/^\/webhook\/exa\/(.+)$/)
    if (request.method === 'POST' && exaMatch) {
      const userId = exaMatch[1]
      const payload = await request.json() as Record<string, any>
      const doId = env.USER_SESSION.idFromName(userId)
      const stub = env.USER_SESSION.get(doId)
      ctx.waitUntil(
        stub.fetch(new Request('https://internal/push', {
          method: 'POST',
          body: JSON.stringify({ type: 'exa_monitor', data: payload }),
          headers: { 'Content-Type': 'application/json' },
        }))
      )
      return new Response('OK', { status: 200, headers: corsHeaders() })
    }

    // Composio webhook → route to user's DO (metadata-based resolution only)
    if (request.method === 'POST' && url.pathname === '/webhook') {
      const payload = await request.json() as Record<string, any>

      // Resolve userId from Composio payload metadata only
      let userId: string | null = null

      // Try metadata.user_id → relay userId mapping from KV
      const composioUserId = payload?.metadata?.user_id
      if (composioUserId) {
        const mapped = await env.TOKENS.get(`composio_user:${composioUserId}`)
        if (mapped) userId = mapped
      }
      // Fallback: try connected_account_id → relay userId mapping
      if (!userId) {
        const connAccountId = payload?.metadata?.connected_account_id
        if (connAccountId) {
          const mapped = await env.TOKENS.get(`composio_account:${connAccountId}`)
          if (mapped) userId = mapped
        }
      }

      if (!userId) {
        console.log('[Relay] Webhook dropped: could not resolve userId from payload')
        return new Response('OK', { status: 200, headers: corsHeaders() })
      }

      const doId = env.USER_SESSION.idFromName(userId)
      const stub = env.USER_SESSION.get(doId)
      ctx.waitUntil(
        stub.fetch(new Request('https://internal/push', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'Content-Type': 'application/json' },
        }))
      )
      return new Response('OK', { status: 200, headers: corsHeaders() })
    }

    // Register Composio entity → relay userId mapping (called by agent on boot)
    if (request.method === 'POST' && url.pathname === '/v1/webhook-route') {
      const result = await validateRequest(request, env)
      if (result instanceof Response) return result
      const body = await request.json() as { composioUserId?: string; connectedAccountId?: string }
      const relayUserId = String(result.data.userId)
      if (body.composioUserId) {
        // Prevent a user from overwriting another user's existing mapping
        const existingOwner = await env.TOKENS.get(`composio_user:${body.composioUserId}`)
        if (existingOwner !== null && existingOwner !== relayUserId) {
          return jsonResponse({ error: 'Composio entity already registered to a different user' }, 403)
        }
        await env.TOKENS.put(`composio_user:${body.composioUserId}`, relayUserId)
      }
      if (body.connectedAccountId) {
        await env.TOKENS.put(`composio_account:${body.connectedAccountId}`, relayUserId)
      }
      return jsonResponse({ ok: true, relayUserId })
    }

    // --- Available models (public, no auth) ---
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      const models = Object.entries(MODELS).map(([id, config]) => ({
        id,
        provider: config.provider,
        label: config.label,
        description: config.description,
        inputPer1k: config.inputPer1k,
        outputPer1k: config.outputPer1k,
      }))
      return jsonResponse({ models })
    }

    // --- Update chosen model ---
    if (request.method === 'POST' && url.pathname === '/v1/model') {
      const result = await validateRequest(request, env)
      if (result instanceof Response) return result

      const { model } = (await request.json()) as { model: string }
      if (!MODELS[model]) {
        return jsonResponse({ error: `Unknown model: ${model}`, available: Object.keys(MODELS) }, 400)
      }

      result.data.model = model
      await saveToken(env, result.token, result.data)
      return jsonResponse({ ok: true, model })
    }

    // --- Get usage / account info ---
    if (request.method === 'GET' && url.pathname === '/v1/account') {
      const result = await validateRequest(request, env)
      if (result instanceof Response) return result

      const { data } = result
      return jsonResponse({
        userId: data.userId,
        model: data.model,
        supportAmount: data.supportAmount,
        usage: data.usage,
        createdAt: data.createdAt,
        admin: data.admin || false,
      })
    }

    // --- Anthropic SDK pass-through proxy ---
    if (request.method === 'POST' && url.pathname === '/v1/messages') {
      return handleMessagesProxy(request, env, ctx)
    }

    // --- OpenAI embedding proxy ---
    if (request.method === 'POST' && url.pathname === '/v1/embeddings') {
      const result = await validateRequest(request, env)
      if (result instanceof Response) return result
      return proxyOpenAIEmbeddings(request, env, result.token, result.data)
    }

    // --- OpenAI TTS proxy ---
    if (request.method === 'POST' && url.pathname === '/v1/audio/speech') {
      const result = await validateRequest(request, env)
      if (result instanceof Response) return result
      return proxyOpenAITts(request, env, result.token, result.data)
    }

    // --- OpenAI transcription proxy ---
    if (request.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
      const result = await validateRequest(request, env)
      if (result instanceof Response) return result
      return proxyOpenAITranscription(request, env, result.token, result.data)
    }

    // --- Admin endpoints (admin token required) ---
    if (url.pathname === '/admin/create-token' && request.method === 'POST') {
      const result = await validateRequest(request, env)
      if (result instanceof Response) return result
      const adminData = result.data
      if (!adminData.admin) return jsonResponse({ error: 'Admin access required' }, 403)

      const body = await request.json() as { label?: string }
      const token = generateToken()
      const prevId = parseInt(await env.TOKENS.get('_next_user_id') || '0')
      const userId = prevId + 1
      await env.TOKENS.put('_next_user_id', String(userId))

      const tokenData: TokenData = {
        userId,
        stripeCustomerId: body.label || `admin-created-${userId}`,
        model: 'claude-sonnet-4-6',
        supportAmount: 0,
        usage: freshUsage(),
        createdAt: new Date().toISOString(),
        active: true,
      }
      await saveToken(env, token, tokenData)
      return jsonResponse({ ok: true, token, userId })
    }

    if (url.pathname === '/admin/list-tokens' && request.method === 'GET') {
      const result = await validateRequest(request, env)
      if (result instanceof Response) return result
      if (!result.data.admin) return jsonResponse({ error: 'Admin access required' }, 403)

      // List all tokens from KV (scan with prefix)
      const list = await env.TOKENS.list()
      const users: any[] = []
      for (const key of list.keys) {
        if (key.name.startsWith('_') || key.name.startsWith('stripe:')) continue
        try {
          const data = await getToken(env, key.name)
          if (data) {
            users.push({
              token: key.name.slice(0, 8) + '...',
              fullToken: key.name,
              userId: data.userId,
              model: data.model,
              active: data.active,
              admin: data.admin || false,
              createdAt: data.createdAt,
              label: data.stripeCustomerId,
              totalCostUsd: data.usage?.totalCostUsd ?? 0,
            })
          }
        } catch (e) {
          // Skip malformed token entries
          console.error(`Skipping malformed token ${key.name}:`, e)
        }
      }
      return jsonResponse({ users })
    }

    if (url.pathname === '/admin/revoke-token' && request.method === 'POST') {
      const result = await validateRequest(request, env)
      if (result instanceof Response) return result
      if (!result.data.admin) return jsonResponse({ error: 'Admin access required' }, 403)

      const body = await request.json() as { token: string }
      const data = await getToken(env, body.token)
      if (!data) return jsonResponse({ error: 'Token not found' }, 404)
      data.active = !data.active
      await saveToken(env, body.token, data)
      return jsonResponse({ ok: true, active: data.active })
    }

    // --- Composio proxy (all methods) ---
    if (url.pathname.startsWith('/v1/composio/')) {
      const result = await validateRequest(request, env)
      if (result instanceof Response) return result
      return proxyComposio(request, env, result.token, result.data)
    }

    return new Response('Not found', { status: 404, headers: corsHeaders() })
  },
}
