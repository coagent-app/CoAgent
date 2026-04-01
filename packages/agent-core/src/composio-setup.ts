import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const CONFIG_DIR = join(homedir(), '.coagent')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const MCP_CONFIG_NAME = 'coagent'

// Read at call time so dotenv / loadApiKeysToEnv has a chance to load first
const getComposioBase = () => process.env.RELAY_URL
  ? `${process.env.RELAY_URL.replace(/\/$/, '')}/v1/composio`
  : 'https://backend.composio.dev/api/v3'

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
  const cfg = readConfig()
  const cacheKey = `composioMcpUrl_${userId}`

  // List existing MCP configs — SDK uses /mcp/servers (plural)
  const listRes = await fetch(`${getComposioBase()}/mcp/servers?name=${encodeURIComponent(MCP_CONFIG_NAME)}`, {
    headers: { 'X-API-KEY': apiKey }
  })
  const listData = await listRes.json() as any
  const existing = (listData?.items ?? []).find((s: any) => s.name === MCP_CONFIG_NAME)

  let mcpBaseUrl: string

  if (existing) {
    // Always update toolkits so newly connected integrations are available
    if (toolkits.length > 0) {
      await fetch(`${getComposioBase()}/mcp/${existing.id}`, {
        method: 'PATCH',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolkits })
      })
      console.log(`[Composio] Updated MCP toolkits: ${toolkits.join(', ')}`)
    }
    mcpBaseUrl = existing.mcp_url
  } else {
    const createRes = await fetch(`${getComposioBase()}/mcp/servers`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: MCP_CONFIG_NAME,
        toolkits: toolkits.length > 0 ? toolkits : ['gmail', 'googlecalendar'],
        manuallyManageConnections: false,
      })
    })
    const created = await createRes.json() as any
    mcpBaseUrl = created.mcp_url
    console.log(`[Composio] Created MCP config: ${created.id}`)
  }

  // MCP URL goes direct to Composio (not relay), so use the resolved numeric user ID
  const { resolveComposioUserId } = await import('./composio-integrations.js')
  const mcpUserId = await resolveComposioUserId(apiKey, userId)
  const url = `${mcpBaseUrl}?user_id=${encodeURIComponent(mcpUserId)}`
  writeConfig({ ...cfg, [cacheKey]: url })
  console.log(`[Composio] MCP URL: ${url}`)
  return { url, apiKey }
}
