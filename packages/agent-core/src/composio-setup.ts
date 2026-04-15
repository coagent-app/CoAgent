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
    headers: { 'X-API-KEY': apiKey },
    signal: AbortSignal.timeout(15_000)
  })
  const listData = await listRes.json() as any
  const existing = (listData?.items ?? []).find((s: any) => s.name === MCP_CONFIG_NAME)

  let mcpBaseUrl = ''

  if (existing) {
    const existingToolkits: string[] = existing.toolkits ?? existing.apps ?? []

    // MERGE with existing toolkits — never shrink. Multiple agents share this
    // MCP server; a sub-agent with fewer integrations must not clobber the
    // primary agent's toolkit list.
    const mergedToolkits = [...new Set([...existingToolkits, ...toolkits])]
    console.log(`[Composio] Existing MCP server ${existing.id} has ${existingToolkits.length} toolkits: ${JSON.stringify(existingToolkits)}`)
    console.log(`[Composio] Requested: ${toolkits.length}, merged: ${mergedToolkits.length}`)

    // Only PATCH if we're actually adding new toolkits
    const needsPatch = mergedToolkits.length > existingToolkits.length
    if (needsPatch && mergedToolkits.length > 0) {
      const patchRes = await fetch(`${getComposioBase()}/mcp/${existing.id}`, {
        method: 'PATCH',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolkits: mergedToolkits }),
        signal: AbortSignal.timeout(15_000)
      })
      if (patchRes.ok) {
        console.log(`[Composio] Updated MCP toolkits (${mergedToolkits.length}): ${mergedToolkits.join(', ')}`)
      } else {
        const errText = await patchRes.text().catch(() => '')
        console.error(`[Composio] PATCH failed (${patchRes.status}): ${errText.slice(0, 300)} — recreating MCP server`)

        // Delete and recreate if PATCH fails
        await fetch(`${getComposioBase()}/mcp/${existing.id}`, {
          method: 'DELETE',
          headers: { 'X-API-KEY': apiKey },
          signal: AbortSignal.timeout(15_000)
        }).catch(() => {})

        const createRes = await fetch(`${getComposioBase()}/mcp/servers`, {
          method: 'POST',
          headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: MCP_CONFIG_NAME, toolkits: mergedToolkits, manuallyManageConnections: false }),
          signal: AbortSignal.timeout(15_000)
        })
        const created = await createRes.json() as any
        mcpBaseUrl = created.mcp_url
        console.log(`[Composio] Recreated MCP config: ${created.id} with ${mergedToolkits.length} toolkits`)
      }
    } else if (!needsPatch) {
      console.log(`[Composio] Toolkits already up to date (${existingToolkits.length})`)
    }
    if (!mcpBaseUrl) mcpBaseUrl = existing.mcp_url
  } else {
    const createRes = await fetch(`${getComposioBase()}/mcp/servers`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: MCP_CONFIG_NAME,
        toolkits: toolkits.length > 0 ? toolkits : ['gmail', 'googlecalendar'],
        manuallyManageConnections: false,
      }),
      signal: AbortSignal.timeout(15_000)
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
