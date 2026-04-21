import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

export interface ToolPreference {
  /** Short category slug (e.g. "crm", "email", "sms", "calendar", "invoicing"). */
  category: string
  /** Preferred integration slug or tool prefix (e.g. "gohighlevel", "gmail", "GOHIGHLEVEL_"). */
  preferred: string
  /** Optional short reason. Keep under ~80 chars — this renders into the system prompt. */
  note?: string
}

interface PreferencesFile {
  preferences: ToolPreference[]
}

function prefsPath(dataDir: string): string {
  return join(dataDir, 'memory', 'preferences.json')
}

export function readPreferences(dataDir: string): ToolPreference[] {
  try {
    const raw = readFileSync(prefsPath(dataDir), 'utf-8')
    const parsed = JSON.parse(raw) as PreferencesFile
    return Array.isArray(parsed.preferences) ? parsed.preferences : []
  } catch { return [] }
}

function writePreferences(dataDir: string, prefs: ToolPreference[]): void {
  const memDir = join(dataDir, 'memory')
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true })
  writeFileSync(prefsPath(dataDir), JSON.stringify({ preferences: prefs }, null, 2), 'utf-8')
}

/** Set or replace a preference by category. */
export function setPreference(dataDir: string, pref: ToolPreference): ToolPreference[] {
  const current = readPreferences(dataDir)
  const idx = current.findIndex(p => p.category === pref.category)
  if (idx >= 0) current[idx] = pref
  else current.push(pref)
  writePreferences(dataDir, current)
  return current
}

/** Remove a preference by category. */
export function unsetPreference(dataDir: string, category: string): boolean {
  const current = readPreferences(dataDir)
  const filtered = current.filter(p => p.category !== category)
  if (filtered.length === current.length) return false
  writePreferences(dataDir, filtered)
  return true
}

