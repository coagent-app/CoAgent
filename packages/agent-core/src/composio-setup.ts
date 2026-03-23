import { Composio } from '@composio/core'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const CONFIG_DIR = join(homedir(), '.coagent')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const MCP_CONFIG_NAME = 'coagent'

function readConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_FILE)) return {}
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch { return {} }
}

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

export async function setupComposioMcp(
  apiKey: string,
  toolkits: string[],
  userId = 'default',
  forceRefresh = false
): Promise<{ url: string; apiKey: string }> {
  const composio = new Composio({ apiKey })
  const cfg = readConfig()
  const cacheKey = `composioMcpUrl_${userId}`
  const cachedUrl = cfg[cacheKey] as string | undefined

  const listResult = await (composio.mcp as any).list({ name: MCP_CONFIG_NAME })
  const existing = (listResult as any)?.items?.find((s: any) => s.name === MCP_CONFIG_NAME)

  let mcpBaseUrl: string

  if (existing) {
    // Always update toolkits so newly connected integrations are available
    if (toolkits.length > 0) {
      await composio.mcp.update(existing.id, { toolkits } as any)
      console.log(`[Composio] Updated MCP toolkits: ${toolkits.join(', ')}`)
    }
    mcpBaseUrl = existing.MCPUrl
  } else {
    const created = await composio.mcp.create(MCP_CONFIG_NAME, {
      toolkits: toolkits.length > 0 ? toolkits : ['gmail', 'googlecalendar'],
      manuallyManageConnections: false,
    })
    mcpBaseUrl = (created as any).MCPUrl
    console.log(`[Composio] Created MCP config: ${(created as any).id}`)
  }

  const url = `${mcpBaseUrl}?user_id=${encodeURIComponent(userId)}`
  writeConfig({ ...cfg, [cacheKey]: url })
  console.log(`[Composio] MCP URL: ${url}`)
  return { url, apiKey }
}
