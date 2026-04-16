import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import Anthropic from '@anthropic-ai/sdk'
import { homedir } from 'os'

const VALID_PROP_KEY = /^[a-zA-Z0-9_.\-]{1,64}$/

/** Append extra context to specific Composio tool descriptions (MCP doesn't support server-side overrides) */
const TOOL_DESCRIPTION_APPENDS: Record<string, string> = {
  'GOOGLECALENDAR_CREATE_EVENT': 'Always include a detailed description with context about the event purpose, attendees, and any relevant background.',
  'GOOGLECALENDAR_QUICK_ADD': 'Always include a detailed description with context about the event purpose and any relevant background.',
  'GOOGLECALENDAR_UPDATE_EVENT': 'Include or update the description with context when modifying events.',
}

function safeKey(key: string): string {
  if (VALID_PROP_KEY.test(key)) return key
  return key.replace(/[^a-zA-Z0-9_.\-]/g, '_').slice(0, 64) || '_invalid'
}

// Recursively sanitize JSON schema to satisfy Anthropic's validation:
// - Property keys must match ^[a-zA-Z0-9_.-]{1,64}$
// - `required` arrays are updated to reflect any renamed keys
function sanitizeSchema(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) return schema
  if (Array.isArray(schema)) return schema.map(sanitizeSchema)

  const obj = schema as Record<string, unknown>
  const out: Record<string, unknown> = {}

  // Build key rename map if there are properties
  const keyMap = new Map<string, string>() // old → new
  if (typeof obj.properties === 'object' && obj.properties !== null && !Array.isArray(obj.properties)) {
    for (const propKey of Object.keys(obj.properties as object)) {
      const renamed = safeKey(propKey)
      if (renamed !== propKey) keyMap.set(propKey, renamed)
    }
  }

  for (const [key, val] of Object.entries(obj)) {
    if (key === 'properties' && typeof val === 'object' && val !== null && !Array.isArray(val)) {
      const sanitized: Record<string, unknown> = {}
      for (const [propKey, propVal] of Object.entries(val as Record<string, unknown>)) {
        sanitized[safeKey(propKey)] = sanitizeSchema(propVal)
      }
      out[key] = sanitized
    } else if (key === 'required' && Array.isArray(val) && keyMap.size > 0) {
      // Update required array to use renamed keys
      out[key] = val.map(k => (typeof k === 'string' && keyMap.has(k)) ? keyMap.get(k)! : k)
    } else {
      out[key] = sanitizeSchema(val)
    }
  }
  return out
}

export interface MCPServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

const MAX_STDERR_LINES = 50

/** Default hard ceiling for a single tool call before we consider it hung. */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000

/** Per-tool overrides — longer for known-slow operations (web search, research, sub-agents). */
const TOOL_TIMEOUT_OVERRIDES: Record<string, number> = {
  // Web search / research can legitimately take a while
  'web_search_exa': 90_000,
  'research_paper_search': 90_000,
  'company_research': 90_000,
  // Deep-research style tools
  'deep_research': 180_000,
  // Sub-agents do their own multi-step work
  'spawn_agents': 300_000,
}

export function timeoutForTool(toolName: string): number {
  return TOOL_TIMEOUT_OVERRIDES[toolName] ?? DEFAULT_TOOL_TIMEOUT_MS
}

export class ToolTimeoutError extends Error {
  readonly serverName: string
  readonly toolName: string
  readonly timeoutMs: number
  constructor(serverName: string, toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" on server "${serverName}" timed out after ${timeoutMs}ms`)
    this.name = 'ToolTimeoutError'
    this.serverName = serverName
    this.toolName = toolName
    this.timeoutMs = timeoutMs
  }
}

/**
 * Race a promise against a timeout. If the timer fires first, rejects with the
 * result of errorFactory(). The underlying promise is NOT cancelled — it may
 * still complete in the background. Callers should phrase user-facing errors
 * accordingly ("the operation may still be running").
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorFactory: () => Error
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(errorFactory()), timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export interface LocalHandler {
  tools: Anthropic.Tool[]
  handler: (toolName: string, args: Record<string, unknown>) => Promise<string>
}

type ReconnectInfo =
  | { kind: 'stdio'; config: MCPServerConfig }
  | { kind: 'http'; url: string; bearerToken?: string }

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

export class MCPManager {
  private clients: Map<string, Client> = new Map()
  private localHandlers: Map<string, LocalHandler> = new Map()
  private toolCache: { tools: Anthropic.Tool[]; serverMap: Map<string, string> } | null = null
  private cacheVersion = 0
  private stderrBuffers: Map<string, string[]> = new Map()
  // Pending startup connection promises, keyed by source name (e.g. 'composio', 'stdio').
  // ready() awaits all of these so startup-fired triggers see the full tool list.
  private pendingInits: Map<string, Promise<unknown>> = new Map()
  // Reconnect state — keeps enough info to re-establish each connection if it drops.
  private serverConfigs: Map<string, ReconnectInfo> = new Map()
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map()
  private reconnectAttempts: Map<string, number> = new Map()
  // Dedupe concurrent reconnect attempts for the same server.
  private connectingNow: Map<string, Promise<void>> = new Map()

  /**
   * Register an in-flight MCP connection/init promise so that ready() can await it.
   * Failures are swallowed (wrapped in .catch) so a single failed server doesn't
   * permanently block ready() — callers log their own errors.
   */
  registerPending(name: string, p: Promise<unknown>): void {
    this.pendingInits.set(name, p.catch(() => {}))
  }

  /**
   * Resolves once every registered pending init has settled (fulfilled or rejected).
   * Callers that rely on the full tool set being available (scheduled tasks,
   * webhooks, triggers) should await this before doing any tool-discovery work.
   *
   * IMPORTANT: loops until the pending-init set stops growing. The scheduler's
   * startup IIFE hits `await ready()` at a moment when only the stdio pending has
   * been registered (Agent constructor runs before the Composio/custom blocks in
   * server.ts). A single-snapshot Promise.all would resolve as soon as stdio came
   * up and fire scheduled tasks before Composio finished connecting. The loop
   * ensures we also wait for pendings registered while we were already awaiting.
   */
  async ready(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let prevSize = -1
    while (this.pendingInits.size !== prevSize) {
      prevSize = this.pendingInits.size
      if (prevSize === 0) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        console.warn(`[MCP] ready() timed out after ${timeoutMs}ms — proceeding with available tools`)
        return
      }
      await Promise.race([
        Promise.all([...this.pendingInits.values()]),
        new Promise<void>(resolve => setTimeout(resolve, remaining))
      ])
    }
  }

  async connect(configs: MCPServerConfig[]): Promise<void> {
    // Store configs up-front so failed initial connections can still be retried by the background reconnect loop.
    for (const config of configs) {
      this.serverConfigs.set(config.name, { kind: 'stdio', config })
    }
    const results = await Promise.allSettled(
      configs.map((config) => this.connectStdioOne(config))
    )
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === 'rejected') {
        const name = configs[i].name
        console.error(`[MCP] Initial connect failed for ${name}:`, (r.reason as Error)?.message ?? r.reason)
        // Schedule a background reconnect so the server comes back automatically once the issue clears.
        this.scheduleReconnect(name)
      }
    }
    this.cacheVersion++
    this.toolCache = null
  }

  /** Connect a single stdio MCP server. Stores the config + installs the onclose reconnect trigger. */
  private async connectStdioOne(config: MCPServerConfig): Promise<void> {
    // Close any previous client for this name (e.g. during a reconnect).
    const prev = this.clients.get(config.name)
    if (prev) {
      await prev.close().catch(() => {})
      this.clients.delete(config.name)
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: (config.name.startsWith('custom:')
        ? {
            PATH: process.env.PATH ?? '',
            HOME: homedir(),
            NODE_ENV: process.env.NODE_ENV ?? 'production',
            LANG: process.env.LANG ?? '',
            COAGENT_DATA_DIR: process.env.COAGENT_DATA_DIR ?? '',
            ...config.env,
          }
        : { ...process.env, ...config.env }
      ) as Record<string, string>,
      stderr: 'pipe'
    })

    // Capture stderr for debugging
    const lines: string[] = []
    this.stderrBuffers.set(config.name, lines)
    transport.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      for (const line of text.split('\n').filter(Boolean)) {
        lines.push(line)
        if (lines.length > MAX_STDERR_LINES) lines.shift()
        console.error(`[MCP:${config.name}] ${line}`)
      }
    })

    const client = new Client(
      { name: 'coagent-core', version: '0.0.1' },
      { capabilities: {} }
    )
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Stdio connect timed out for ${config.name}`)), 15_000))
    ])
    this.attachReconnectHooks(config.name, client)
    this.clients.set(config.name, client)
    this.reconnectAttempts.delete(config.name)
    this.cacheVersion++
    this.toolCache = null
    console.log(`[MCP] Connected stdio: ${config.name}`)
  }

  /** Wire up client.onclose/onerror so transport drops trigger a reconnect. */
  private attachReconnectHooks(name: string, client: Client): void {
    client.onclose = () => {
      // Only auto-reconnect if the user hasn't explicitly disconnected this server.
      if (!this.serverConfigs.has(name)) return
      if (this.clients.get(name) !== client) return  // superseded by a newer client
      console.warn(`[MCP] ${name} transport closed — scheduling reconnect`)
      this.clients.delete(name)
      this.cacheVersion++
      this.toolCache = null
      this.scheduleReconnect(name)
    }
    client.onerror = (err: Error) => {
      console.error(`[MCP] ${name} transport error: ${err.message}`)
    }
  }

  /** Schedule a reconnect attempt with exponential backoff. Idempotent. */
  private scheduleReconnect(name: string): void {
    if (!this.serverConfigs.has(name)) return  // disconnected — don't reconnect
    if (this.reconnectTimers.has(name)) return  // already scheduled
    if (this.connectingNow.has(name)) return    // already connecting
    const attempt = this.reconnectAttempts.get(name) ?? 0
    const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]
    this.reconnectAttempts.set(name, attempt + 1)
    console.log(`[MCP] ${name} reconnect scheduled in ${delay}ms (attempt ${attempt + 1})`)
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(name)
      this.reconnectNow(name).catch(() => {
        // reconnectNow already logs; schedule the next backoff step.
        this.scheduleReconnect(name)
      })
    }, delay)
    this.reconnectTimers.set(name, timer)
  }

  /** Reconnect a known server right now (no backoff). Dedupes concurrent callers. */
  private async reconnectNow(name: string): Promise<void> {
    const existing = this.connectingNow.get(name)
    if (existing) return existing
    const info = this.serverConfigs.get(name)
    if (!info) return
    const p = (async () => {
      try {
        if (info.kind === 'stdio') {
          await this.connectStdioOne(info.config)
        } else {
          await this.connectHttpOne(name, info.url, info.bearerToken)
        }
      } catch (err: any) {
        console.error(`[MCP] Reconnect failed for ${name}: ${err?.message ?? err}`)
        throw err
      }
    })()
    this.connectingNow.set(name, p)
    try {
      await p
    } finally {
      this.connectingNow.delete(name)
    }
  }

  /** If the server is known but not connected, try to reconnect right now before a tool call. */
  private async ensureConnected(name: string): Promise<void> {
    if (this.clients.has(name) || this.localHandlers.has(name)) return
    if (!this.serverConfigs.has(name)) return
    // Cancel any pending backoff timer — we're doing it now.
    const timer = this.reconnectTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.reconnectTimers.delete(name)
    }
    try {
      await this.reconnectNow(name)
    } catch {
      // Swallow — caller will see missing client and throw its own error, and backoff will retry.
      this.scheduleReconnect(name)
    }
  }

  /** Register an in-process local tool handler (no subprocess needed) */
  registerLocal(name: string, tools: Anthropic.Tool[], handler: (toolName: string, args: Record<string, unknown>) => Promise<string>): void {
    this.localHandlers.set(name, { tools, handler })
    this.cacheVersion++
    this.toolCache = null
  }

  /** Unregister a local tool handler */
  unregisterLocal(name: string): void {
    if (this.localHandlers.delete(name)) {
      this.cacheVersion++
      this.toolCache = null
    }
  }

  /** Get recent stderr output for a server (for debugging custom MCPs) */
  getStderr(name: string): string | null {
    const lines = this.stderrBuffers.get(name)
    if (!lines || lines.length === 0) return null
    return lines.join('\n')
  }

  async getAllTools(): Promise<{ tools: Anthropic.Tool[]; serverMap: Map<string, string> }> {
    if (this.toolCache) return this.toolCache

    const versionAtStart = this.cacheVersion
    const tools: Anthropic.Tool[] = []
    const serverMap = new Map<string, string>() // tool name → server name

    const results = await Promise.allSettled(
      [...this.clients.entries()].map(async ([serverName, client]) => {
        const result = await client.listTools()
        return { serverName, tools: result.tools }
      })
    )

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { serverName, tools: serverTools } = result.value
        console.log(`[MCP] ${serverName} returned ${serverTools.length} tools: ${serverTools.map(t => t.name).join(', ')}`)
        for (const tool of serverTools) {
          const append = TOOL_DESCRIPTION_APPENDS[tool.name]
          tools.push({
            name: tool.name,
            description: append ? `${tool.description ?? ''} ${append}` : (tool.description ?? ''),
            input_schema: sanitizeSchema(tool.inputSchema) as Anthropic.Tool['input_schema']
          })
          serverMap.set(tool.name, serverName)
        }
      } else {
        console.error(`[MCP] Failed to list tools:`, (result.reason as Error).message)
      }
    }

    // Include local handlers (synchronous — no async needed)
    for (const [serverName, local] of this.localHandlers) {
      for (const tool of local.tools) {
        tools.push(tool)
        serverMap.set(tool.name, serverName)
      }
    }

    // Only cache if no connections changed while we were listing
    if (this.cacheVersion === versionAtStart) {
      this.toolCache = { tools, serverMap }
    }
    return { tools, serverMap }
  }

  invalidateToolCache(): void {
    this.cacheVersion++
    this.toolCache = null
  }

  isConnected(name: string): boolean {
    return this.clients.has(name) || this.localHandlers.has(name)
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const timeoutMs = timeoutForTool(toolName)
    const mkTimeout = () => new ToolTimeoutError(serverName, toolName, timeoutMs)

    // Check local handlers first — these run in-process, no subprocess needed
    const local = this.localHandlers.get(serverName)
    if (local) {
      return withTimeout(local.handler(toolName, args), timeoutMs, mkTimeout)
    }

    // On-demand reconnect: if the client is missing but we know how to connect it, try now.
    if (!this.clients.has(serverName)) {
      await this.ensureConnected(serverName)
    }
    const client = this.clients.get(serverName)
    if (!client) throw new Error(`MCP server not found: ${serverName}`)
    try {
      const result = await withTimeout(
        client.callTool({ name: toolName, arguments: args }),
        timeoutMs,
        mkTimeout
      )
      const content = result.content as Array<{ type: string; text?: string }>
      const text = content
        .filter(c => c.type === 'text')
        .map(c => c.text ?? '')
        .join('\n')
      return text
    } catch (err: any) {
      // Timeouts bubble straight up — reconnecting a slow-but-alive server makes things worse.
      if (err instanceof ToolTimeoutError) throw err
      const code = err?.code
      const isPipeError = code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || err?.message?.includes('EPIPE')
      if (isPipeError) {
        console.error(`[MCP] ${serverName} pipe broken during ${toolName} — server likely crashed, attempting reconnect`)
        // Invalidate tool cache so getAllTools() won't return stale tools for this crashed server
        this.clients.delete(serverName)
        this.cacheVersion++
        this.toolCache = null
        // Try to reconnect immediately and retry the call once.
        try {
          await this.ensureConnected(serverName)
          const retryClient = this.clients.get(serverName)
          if (retryClient) {
            const result = await withTimeout(
              retryClient.callTool({ name: toolName, arguments: args }),
              timeoutMs,
              mkTimeout
            )
            const content = result.content as Array<{ type: string; text?: string }>
            return content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
          }
        } catch (retryErr: any) {
          console.error(`[MCP] ${serverName} retry after reconnect also failed: ${retryErr?.message ?? retryErr}`)
        }
        // Schedule a background reconnect so the next call works even if this one fails.
        this.scheduleReconnect(serverName)
        const stderr = this.getStderr(serverName)
        const detail = stderr ? `\n\nServer stderr:\n${stderr}` : ''
        return `[Error: ${serverName} server crashed during ${toolName}. Reconnecting in background.${detail}]`
      }
      throw err
    }
  }

  async connectHttp(name: string, url: string, bearerToken?: string): Promise<void> {
    this.serverConfigs.set(name, { kind: 'http', url, bearerToken })
    try {
      await this.connectHttpOne(name, url, bearerToken)
    } catch (err) {
      console.error(`[MCP] Initial HTTP connect failed for ${name}:`, (err as Error)?.message ?? err)
      // Schedule background reconnect so the endpoint comes back automatically once reachable.
      this.scheduleReconnect(name)
      throw err
    }
  }

  /** Connect a single HTTP MCP endpoint. Installs the onclose reconnect trigger. */
  private async connectHttpOne(name: string, url: string, bearerToken?: string): Promise<void> {
    // Disconnect existing client for this name if any
    const existing = this.clients.get(name)
    if (existing) {
      await existing.close().catch(() => {})
      this.clients.delete(name)
    }

    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: bearerToken
        ? { headers: { Authorization: `Bearer ${bearerToken}` } }
        : undefined
    })
    const client = new Client(
      { name: 'coagent-core', version: '0.0.1' },
      { capabilities: {} }
    )
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`HTTP connect timed out for ${name}`)), 15_000))
    ])
    this.attachReconnectHooks(name, client)
    this.clients.set(name, client)
    this.reconnectAttempts.delete(name)
    // Invalidate AFTER client is registered so getAllTools() sees the new client
    this.cacheVersion++
    this.toolCache = null
    console.log(`[MCP] Connected HTTP client: ${name} (${url.split('?')[0]})`)
  }

  async disconnect(name: string): Promise<void> {
    // Remove reconnect state first so onclose doesn't kick off a reconnect loop.
    this.serverConfigs.delete(name)
    const timer = this.reconnectTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.reconnectTimers.delete(name)
    }
    this.reconnectAttempts.delete(name)

    // Remove local handler if present
    const hadLocal = this.localHandlers.delete(name)

    const client = this.clients.get(name)
    if (client) {
      await client.close().catch(err => console.warn(`[MCP] Error closing ${name}:`, (err as Error).message))
      this.clients.delete(name)
      this.cacheVersion++
      this.toolCache = null
    } else if (hadLocal) {
      this.cacheVersion++
      this.toolCache = null
    }
  }

  async disconnectAll(): Promise<void> {
    // Clear reconnect state first so in-flight closes don't trigger reconnect loops.
    this.serverConfigs.clear()
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer)
    this.reconnectTimers.clear()
    this.reconnectAttempts.clear()
    for (const [name, client] of this.clients) {
      await client.close().catch(err => console.warn(`[MCP] Error closing ${name}:`, (err as Error).message))
    }
    this.clients.clear()
    this.localHandlers.clear()
    this.cacheVersion++
    this.toolCache = null
  }
}
