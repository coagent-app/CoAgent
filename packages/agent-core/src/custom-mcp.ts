import { readFile, writeFile, mkdir, rm } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { parse as dotenvParse } from 'dotenv'
import type { MCPServerConfig } from './mcp-manager.js'

export interface CustomMCPEntry {
  name: string           // kebab-case slug e.g. "notion"
  displayName: string    // "Notion"
  description: string
  capabilities: string[] // ["Create pages", "Search databases"]
  createdAt: string      // ISO
  connected: boolean
  authFields: { name: string; displayName: string; description: string; helpUrl?: string; helpText?: string }[]
  icon?: string          // SVG string for the integration icon
  domain?: string        // website domain for favicon (e.g. "rentcast.io")
}

const CUSTOM_MCP_DIR = join(homedir(), '.coagent', 'custom-mcps')
const REGISTRY_PATH = join(CUSTOM_MCP_DIR, 'registry.json')

export async function ensureCustomMcpDir(): Promise<void> {
  await mkdir(CUSTOM_MCP_DIR, { recursive: true })
}

export async function readRegistry(): Promise<CustomMCPEntry[]> {
  await ensureCustomMcpDir()
  if (!existsSync(REGISTRY_PATH)) return []
  const raw = await readFile(REGISTRY_PATH, 'utf-8')
  try {
    return JSON.parse(raw)
  } catch {
    console.error('[Custom MCP] registry.json corrupted, starting fresh')
    return []
  }
}

export async function writeRegistry(entries: CustomMCPEntry[]): Promise<void> {
  await ensureCustomMcpDir()
  await writeFile(REGISTRY_PATH, JSON.stringify(entries, null, 2), 'utf-8')
}

export async function addCustomMcp(entry: CustomMCPEntry, indexJs: string, packageJson: string): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(entry.name)) throw new Error(`Invalid custom MCP name: ${entry.name}`)
  const dir = join(CUSTOM_MCP_DIR, entry.name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'index.js'), indexJs, 'utf-8')
  await writeFile(join(dir, 'package.json'), packageJson, 'utf-8')
  await writeFile(join(dir, 'config.json'), JSON.stringify(entry, null, 2), 'utf-8')

  const registry = await readRegistry()
  const existing = registry.findIndex(e => e.name === entry.name)
  if (existing >= 0) registry[existing] = entry
  else registry.push(entry)
  await writeRegistry(registry)
}

export async function writeCustomMcpCredentials(name: string, credentials: Record<string, string>): Promise<void> {
  const dir = join(CUSTOM_MCP_DIR, name)
  if (!existsSync(dir)) throw new Error(`Custom MCP not found: ${name}`)
  const envContent = Object.entries(credentials)
    .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
    .join('\n')
  await writeFile(join(dir, '.env'), envContent, 'utf-8')

  // Mark as connected in registry
  const registry = await readRegistry()
  const entry = registry.find(e => e.name === name)
  if (entry) {
    entry.connected = true
    await writeRegistry(registry)
  }
}

export async function disconnectCustomMcp(name: string): Promise<void> {
  const registry = await readRegistry()
  const entry = registry.find(e => e.name === name)
  if (entry) {
    entry.connected = false
    await writeRegistry(registry)
  }
}

export async function deleteCustomMcp(name: string): Promise<void> {
  const dir = join(CUSTOM_MCP_DIR, name)
  if (existsSync(dir)) await rm(dir, { recursive: true })
  const registry = await readRegistry()
  await writeRegistry(registry.filter(e => e.name !== name))
}

export function hasCredentials(name: string): boolean {
  const envPath = join(CUSTOM_MCP_DIR, name, '.env')
  if (!existsSync(envPath)) return false
  try {
    const content = readFileSync(envPath, 'utf-8')
    return content.trim().length > 0
  } catch { return false }
}

export function getCustomMcpDir(name: string): string {
  return join(CUSTOM_MCP_DIR, name)
}

/** Load .env for a custom MCP and return as env vars record (no side effects) */
export function loadCustomMcpEnv(name: string): Record<string, string> {
  const envPath = join(CUSTOM_MCP_DIR, name, '.env')
  if (!existsSync(envPath)) return {}
  try {
    return dotenvParse(readFileSync(envPath, 'utf-8')) as Record<string, string>
  } catch { return {} }
}

/** Read the current index.js source for a custom MCP */
export function readCustomMcpCode(name: string): string | null {
  const codePath = join(CUSTOM_MCP_DIR, name, 'index.js')
  if (!existsSync(codePath)) return null
  return readFileSync(codePath, 'utf-8')
}

/** Overwrite index.js for an existing custom MCP */
export async function updateCustomMcpCode(name: string, code: string): Promise<void> {
  const dir = join(CUSTOM_MCP_DIR, name)
  if (!existsSync(dir)) throw new Error(`Custom MCP not found: ${name}`)
  await writeFile(join(dir, 'index.js'), code, 'utf-8')
}

/** Build MCPServerConfig for all connected custom MCPs */
export async function getCustomMcpConfigs(): Promise<MCPServerConfig[]> {
  const registry = await readRegistry()
  const configs: MCPServerConfig[] = []
  for (const entry of registry) {
    if (!entry.connected || !hasCredentials(entry.name)) continue
    const dir = getCustomMcpDir(entry.name)
    const indexPath = join(dir, 'index.js')
    if (!existsSync(indexPath)) continue
    configs.push({
      name: `custom:${entry.name}`,
      command: 'node',
      args: [indexPath],
      env: loadCustomMcpEnv(entry.name)
    })
  }
  return configs
}

/** Get Integration objects for the integrations modal */
export async function getCustomIntegrations(): Promise<Array<{
  slug: string; name: string; connected: boolean; category: string;
  description: string; capabilities: string; custom: boolean; icon?: string; domain?: string
}>> {
  const registry = await readRegistry()
  return registry.map(e => ({
    slug: `custom:${e.name}`,
    name: e.displayName,
    connected: e.connected && hasCredentials(e.name),
    category: 'Custom',
    description: e.description,
    capabilities: e.capabilities.join(', '),
    custom: true,
    ...(e.icon ? { icon: e.icon } : {}),
    ...(e.domain ? { domain: e.domain } : {})
  }))
}
