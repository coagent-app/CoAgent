import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

// ── Feature flag: useSqlite ───────────────────────────────────────────────────
//
// Stored in <dataDir>/config.json as { "useSqlite": true }.
// Defaults to false — the flag must be explicitly opted in.
// This file is intentionally NOT imported by any production code yet;
// PR 2 will wire it into the appropriate startup paths.

const CONFIG_FILE = 'config.json'

interface CoAgentConfig {
  useSqlite?: boolean
}

/**
 * Returns true only when config.json in `dataDir` contains `useSqlite: true`.
 * Returns false on any read or parse error (fail-safe default).
 */
export function isSqliteEnabled(dataDir: string): boolean {
  const configPath = join(dataDir, CONFIG_FILE)
  if (!existsSync(configPath)) return false
  try {
    const raw = readFileSync(configPath, 'utf-8')
    const config = JSON.parse(raw) as CoAgentConfig
    return config.useSqlite === true
  } catch {
    return false
  }
}
