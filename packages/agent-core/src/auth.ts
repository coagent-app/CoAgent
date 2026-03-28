// packages/agent-core/src/auth.ts
import { readFile, writeFile, mkdir, chmod } from 'fs/promises'
import { join } from 'path'

const ENV_FILE = '.env'
const RELAY_TOKEN_VAR = 'RELAY_TOKEN'
const RELAY_URL_VAR = 'RELAY_URL'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readEnvLines(dataDir: string): Promise<string[]> {
  try {
    const raw = await readFile(join(dataDir, ENV_FILE), 'utf-8')
    return raw.split('\n')
  } catch (err: any) {
    if (err?.code === 'ENOENT') return []
    throw err
  }
}

async function writeEnvLines(dataDir: string, lines: string[]): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  const filePath = join(dataDir, ENV_FILE)
  await writeFile(filePath, lines.join('\n'), 'utf-8')
  if (process.platform !== 'win32') await chmod(filePath, 0o600)
}

function upsertEnvLine(lines: string[], key: string, value?: string): string[] {
  const prefix = `${key}=`
  const filtered = lines.filter(line => !line.startsWith(prefix))

  if (value !== undefined) {
    const originalIndex = lines.findIndex(line => line.startsWith(prefix))
    if (originalIndex !== -1) {
      filtered.splice(originalIndex, 0, `${prefix}${value}`)
    } else {
      if (filtered.length > 0 && filtered[filtered.length - 1] !== '') {
        filtered.push('')
      }
      filtered.push(`${prefix}${value}`)
    }
  }

  return filtered
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Persist relay credentials to ~/.coagent/.env (0600 permissions).
 * Configures process.env so the Anthropic SDK can be pointed at the relay.
 */
export async function writeRelayCredentials(
  dataDir: string,
  token: string,
  relayUrl: string
): Promise<void> {
  let lines = await readEnvLines(dataDir)
  lines = upsertEnvLine(lines, RELAY_TOKEN_VAR, token)
  lines = upsertEnvLine(lines, RELAY_URL_VAR, relayUrl)

  await writeEnvLines(dataDir, lines)

  process.env[RELAY_TOKEN_VAR] = token
  process.env[RELAY_URL_VAR] = relayUrl
}

/**
 * Returns relay configuration from process.env, or null if not configured.
 */
export function getRelayConfig(): { token: string; url: string } | null {
  const token = process.env[RELAY_TOKEN_VAR]
  const url = process.env[RELAY_URL_VAR]
  if (!token || !url) return null
  return { token, url }
}

/**
 * Returns base URL and auth header for OpenAI-compatible calls (embeddings, TTS, transcription).
 * Routes through relay when configured, returns null if no relay is available.
 */
export function getOpenAIProxy(): { baseUrl: string; authHeader: string } | null {
  const relay = getRelayConfig()
  if (!relay) return null
  return {
    baseUrl: relay.url.replace(/\/$/, ''),
    authHeader: `Bearer ${relay.token}`,
  }
}

/**
 * Read ~/.coagent/.env and load relay credentials into process.env.
 * Call this once on startup before creating the agent so saved keys are active.
 */
export function loadApiKeysToEnv(dataDir: string): void {
  // Use synchronous read so this can safely run before the event loop starts
  // taking async work. The file is small so this is fine.
  try {
    const { readFileSync } = require('fs') as typeof import('fs')
    const raw = readFileSync(join(dataDir, ENV_FILE), 'utf-8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const value = trimmed.slice(eqIdx + 1).trim()
      // Only set keys that are not already set by the environment
      if (key && value && !process.env[key]) {
        process.env[key] = value
      }
    }
  } catch (err: any) {
    // ENOENT is expected on first run — any other error is worth logging
    if (err?.code !== 'ENOENT') {
      console.error('[Auth] Failed to load .env file:', err.message)
    }
  }
}

