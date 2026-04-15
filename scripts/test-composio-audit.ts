#!/usr/bin/env bun
/**
 * Composio MCP Audit Script
 * Tests the full Composio integration pipeline to diagnose tool discovery issues.
 */

const RELAY_URL = 'https://coagent-relay.brettponters.workers.dev'
const RELAY_TOKEN = process.env.RELAY_TOKEN || ''

// Load from .env if not in env
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

let apiKey = RELAY_TOKEN
if (!apiKey) {
  try {
    const envFile = readFileSync(join(homedir(), '.coagent', '.env'), 'utf-8')
    const match = envFile.match(/RELAY_TOKEN=(.+)/)
    if (match) apiKey = match[1].trim()
  } catch {}
}

if (!apiKey) {
  console.error('No RELAY_TOKEN found')
  process.exit(1)
}

const BASE = `${RELAY_URL}/v1/composio`

async function fetchJson(url: string, opts?: RequestInit) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'X-API-KEY': apiKey, ...((opts?.headers as any) || {}) },
    signal: AbortSignal.timeout(15_000)
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, ok: res.ok, data: json }
}

console.log('\n=== COMPOSIO MCP AUDIT ===\n')

// 1. Check connected accounts
console.log('--- Step 1: Connected Accounts ---')
const accounts = await fetchJson(`${BASE}/connected_accounts?limit=100&user_ids=default`)
console.log(`Status: ${accounts.status}`)
const items = accounts.data?.items || []
console.log(`Total accounts: ${items.length}`)
for (const a of items) {
  const slug = a.toolkit?.slug ?? a.toolkitSlug ?? a.appName ?? 'unknown'
  console.log(`  ${slug}: status=${a.status}, id=${a.id}`)
}

// 2. List MCP servers
console.log('\n--- Step 2: MCP Servers ---')
const servers = await fetchJson(`${BASE}/mcp/servers?name=coagent`)
console.log(`Status: ${servers.status}`)
const serverItems = servers.data?.items || []
console.log(`Found ${serverItems.length} MCP server(s)`)
for (const s of serverItems) {
  console.log(`  ID: ${s.id}`)
  console.log(`  Name: ${s.name}`)
  console.log(`  MCP URL: ${s.mcp_url}`)
  console.log(`  Toolkits: ${JSON.stringify(s.toolkits || s.apps || 'none')}`)
  console.log(`  Created: ${s.createdAt || s.created_at || 'unknown'}`)
}

if (serverItems.length === 0) {
  console.log('No MCP server found — nothing more to test')
  process.exit(0)
}

const server = serverItems.find((s: any) => s.name === 'coagent') || serverItems[0]

// 3. Try PATCH on both endpoints
console.log('\n--- Step 3: Test PATCH Endpoints ---')
const localConns = JSON.parse(readFileSync(join(homedir(), '.coagent', 'connected-integrations.json'), 'utf-8'))
const allToolkits = [...new Set(['composio_search', 'text_to_pdf', ...localConns])]
console.log(`Requested toolkits (${allToolkits.length}): ${allToolkits.join(', ')}`)

for (const path of [`/mcp/servers/${server.id}`, `/mcp/${server.id}`]) {
  console.log(`\nTrying PATCH ${path}...`)
  const patchRes = await fetchJson(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' } as any,
    body: JSON.stringify({ toolkits: allToolkits })
  })
  console.log(`  Status: ${patchRes.status} (${patchRes.ok ? 'OK' : 'FAILED'})`)
  console.log(`  Response: ${JSON.stringify(patchRes.data).slice(0, 500)}`)
}

// 4. Re-read server to see if toolkits changed
console.log('\n--- Step 4: Verify Toolkits After PATCH ---')
const serversAfter = await fetchJson(`${BASE}/mcp/servers?name=coagent`)
const serverAfter = (serversAfter.data?.items || []).find((s: any) => s.name === 'coagent')
if (serverAfter) {
  console.log(`Toolkits now: ${JSON.stringify(serverAfter.toolkits || serverAfter.apps || 'none')}`)
} else {
  console.log('Server not found after PATCH')
}

// 5. Try connecting to the MCP endpoint and listing tools
console.log('\n--- Step 5: Connect to MCP and List Tools ---')
try {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')

  // Use user_id from config
  const config = JSON.parse(readFileSync(join(homedir(), '.coagent', 'config.json'), 'utf-8'))
  const mcpUrl = config.composioMcpUrl_1 || config.composioMcpUrl_default || `${server.mcp_url}?user_id=1`
  console.log(`MCP URL: ${mcpUrl}`)

  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } }
  })
  const client = new Client({ name: 'audit', version: '1.0.0' }, { capabilities: {} })

  await Promise.race([
    client.connect(transport),
    new Promise((_, reject) => setTimeout(() => reject(new Error('MCP connect timeout')), 15_000))
  ])

  const result = await client.listTools()
  const tools = result.tools
  console.log(`Total tools returned: ${tools.length}`)

  // Group by prefix
  const groups = new Map<string, string[]>()
  for (const t of tools) {
    const prefix = t.name.split('_').slice(0, 1).join('_').toUpperCase()
    if (!groups.has(prefix)) groups.set(prefix, [])
    groups.get(prefix)!.push(t.name)
  }

  console.log('\nTool groups:')
  for (const [prefix, names] of [...groups.entries()].sort()) {
    console.log(`  ${prefix}: ${names.length} tools`)
    if (names.length <= 5) {
      for (const n of names) console.log(`    - ${n}`)
    }
  }

  // Check for expected integrations
  console.log('\nExpected integration coverage:')
  for (const slug of localConns) {
    const prefix = slug.toUpperCase().replace(/_/g, '')
    const matching = tools.filter(t => t.name.toUpperCase().startsWith(slug.toUpperCase().replace(/_/g, '')))
    const altMatch = tools.filter(t => t.name.toUpperCase().includes(slug.toUpperCase().replace(/_/g, '')))
    const count = matching.length || altMatch.length
    console.log(`  ${slug}: ${count > 0 ? `${count} tools` : '❌ MISSING'}`)
  }

  await client.close()
} catch (err: any) {
  console.error(`MCP connection failed: ${err.message}`)
}

// 6. Check custom MCPs
console.log('\n--- Step 6: Custom MCPs ---')
const registryPath = join(homedir(), '.coagent', 'custom-mcps', 'registry.json')
try {
  const registry = JSON.parse(readFileSync(registryPath, 'utf-8'))
  for (const entry of registry) {
    const envPath = join(homedir(), '.coagent', 'custom-mcps', entry.name, '.env')
    const hasEnv = (() => { try { return readFileSync(envPath, 'utf-8').trim().length > 0 } catch { return false } })()
    const indexPath = join(homedir(), '.coagent', 'custom-mcps', entry.name, 'index.js')
    const hasIndex = (() => { try { readFileSync(indexPath); return true } catch { return false } })()
    console.log(`  ${entry.displayName} (${entry.name}):`)
    console.log(`    connected: ${entry.connected}, hasEnv: ${hasEnv}, hasIndex: ${hasIndex}`)

    if (entry.connected && hasEnv && hasIndex) {
      // Try running it
      console.log(`    Testing MCP launch...`)
      try {
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
        const envContent = readFileSync(envPath, 'utf-8')
        const env: Record<string, string> = { PATH: process.env.PATH || '', HOME: homedir(), NODE_ENV: 'production' }
        for (const line of envContent.split('\n')) {
          const m = line.match(/^([^=]+)="?(.*?)"?$/)
          if (m) env[m[1]] = m[2]
        }
        const transport = new StdioClientTransport({
          command: 'node',
          args: [indexPath],
          env,
          stderr: 'pipe'
        })
        const client = new Client({ name: 'audit', version: '1.0.0' }, { capabilities: {} })
        await Promise.race([
          client.connect(transport),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000))
        ])
        const result = await client.listTools()
        console.log(`    ✅ ${result.tools.length} tools: ${result.tools.map(t => t.name).join(', ')}`)
        await client.close()
      } catch (err: any) {
        console.log(`    ❌ Launch failed: ${err.message}`)
      }
    }
  }
} catch {
  console.log('  No custom MCP registry found')
}

console.log('\n=== AUDIT COMPLETE ===\n')
