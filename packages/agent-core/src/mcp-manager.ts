import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import Anthropic from '@anthropic-ai/sdk'

const VALID_PROP_KEY = /^[a-zA-Z0-9_.\-]{1,64}$/

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

export class MCPManager {
  private clients: Map<string, Client> = new Map()
  private toolCache: { tools: Anthropic.Tool[]; serverMap: Map<string, string> } | null = null
  private cacheVersion = 0
  private stderrBuffers: Map<string, string[]> = new Map()

  async connect(configs: MCPServerConfig[]): Promise<void> {
    for (const config of configs) {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: { ...process.env, ...config.env } as Record<string, string>,
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
      await client.connect(transport)
      this.clients.set(config.name, client)
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

    for (const [serverName, client] of this.clients) {
      try {
        const result = await client.listTools()
        for (const tool of result.tools) {
          tools.push({
            name: tool.name,
            description: tool.description ?? '',
            input_schema: sanitizeSchema(tool.inputSchema) as Anthropic.Tool['input_schema']
          })
          serverMap.set(tool.name, serverName)
        }
      } catch (err) {
        console.error(`[MCP] Failed to list tools from ${serverName}:`, (err as Error).message)
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
    return this.clients.has(name)
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const client = this.clients.get(serverName)
    if (!client) throw new Error(`MCP server not found: ${serverName}`)
    try {
      const result = await client.callTool({ name: toolName, arguments: args })
      const content = result.content as Array<{ type: string; text?: string }>
      const text = content
        .filter(c => c.type === 'text')
        .map(c => c.text ?? '')
        .join('\n')
      return text
    } catch (err: any) {
      const code = err?.code
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || err?.message?.includes('EPIPE')) {
        console.error(`[MCP] ${serverName} pipe broken during ${toolName} — server likely crashed`)
        const stderr = this.getStderr(serverName)
        const detail = stderr ? `\n\nServer stderr:\n${stderr}` : ''
        return `[Error: ${serverName} server crashed during ${toolName}.${detail}]`
      }
      throw err
    }
  }

  async connectHttp(name: string, url: string, bearerToken?: string): Promise<void> {
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
    await client.connect(transport)
    this.clients.set(name, client)
    // Invalidate AFTER client is registered so getAllTools() sees the new client
    this.cacheVersion++
    this.toolCache = null
    console.log(`[MCP] Connected HTTP client: ${name} (${url.split('?')[0]})`)
  }

  async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name)
    if (client) {
      await client.close().catch(err => console.warn(`[MCP] Error closing ${name}:`, (err as Error).message))
      this.clients.delete(name)
      this.cacheVersion++
      this.toolCache = null
    }
  }

  async disconnectAll(): Promise<void> {
    for (const [name, client] of this.clients) {
      await client.close().catch(err => console.warn(`[MCP] Error closing ${name}:`, (err as Error).message))
    }
    this.clients.clear()
    this.cacheVersion++
    this.toolCache = null
  }
}
