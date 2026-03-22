// packages/agent-core/src/settings.ts
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { AgentSettings, ApiKeys, Autonomy, DayName } from '@coagent/shared'

export type { AgentSettings, ApiKeys, Autonomy, DayName }

const DAY_NAMES: DayName[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export const DEFAULT_SETTINGS: AgentSettings = {
  name: '',
  email: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago',
  role: '',
  // end: 24 is intentional — getHours() returns 0–23, so 24 means "active through midnight"
  active_hours: { start: 7, end: 24 },
  active_days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  autonomy: 'balanced',
  powerModel: 'claude-sonnet-4-6',
  apiKeys: { anthropic: '', composio: '', openai: '' }
}

const VALID_DAYS: DayName[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const VALID_AUTONOMY: Autonomy[] = ['ask_first', 'balanced', 'autonomous']

const SETTINGS_FILE = 'settings.json'

export async function readSettings(dataDir: string): Promise<AgentSettings> {
  try {
    const raw = await readFile(join(dataDir, SETTINGS_FILE), 'utf-8')
    const parsed = JSON.parse(raw)
    return {
      name: parsed.name ?? DEFAULT_SETTINGS.name,
      email: parsed.email ?? DEFAULT_SETTINGS.email,
      timezone: parsed.timezone ?? DEFAULT_SETTINGS.timezone,
      role: parsed.role ?? DEFAULT_SETTINGS.role,
      active_hours: { ...DEFAULT_SETTINGS.active_hours, ...parsed.active_hours },
      active_days: parsed.active_days ?? DEFAULT_SETTINGS.active_days,
      autonomy: parsed.autonomy ?? DEFAULT_SETTINGS.autonomy,
      powerModel: parsed.powerModel ?? DEFAULT_SETTINGS.powerModel,
      // apiKeys are NOT stored in settings.json — they live in .env only.
      // Return empty strings so the shape is always complete.
      apiKeys: DEFAULT_SETTINGS.apiKeys
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      console.error('[Settings] Failed to read settings.json:', err?.message)
    }
    return { ...DEFAULT_SETTINGS }
  }
}

export async function writeSettings(dataDir: string, patch: Partial<AgentSettings>): Promise<AgentSettings> {
  await mkdir(dataDir, { recursive: true })
  const current = await readSettings(dataDir)

  const patchHours = patch.active_hours
  const validatedHours = patchHours ? {
    start: Math.max(0, Math.min(23, Math.round(patchHours.start ?? current.active_hours.start))),
    // end can be 24: means "active through midnight" (getHours() returns 0-23, so hour < 24 is always true)
    end: Math.max(0, Math.min(24, Math.round(patchHours.end ?? current.active_hours.end)))
  } : undefined

  const validatedDays = patch.active_days
    ? patch.active_days.filter((d: DayName): d is DayName => VALID_DAYS.includes(d))
    : undefined

  const validatedAutonomy = patch.autonomy && VALID_AUTONOMY.includes(patch.autonomy)
    ? patch.autonomy
    : undefined

  const updated: AgentSettings = {
    name: patch.name !== undefined ? patch.name : current.name,
    email: patch.email !== undefined ? patch.email : current.email,
    timezone: patch.timezone !== undefined ? patch.timezone : current.timezone,
    role: patch.role !== undefined ? patch.role : current.role,
    active_hours: validatedHours ?? current.active_hours,
    active_days: validatedDays !== undefined ? validatedDays : current.active_days,
    autonomy: validatedAutonomy ?? current.autonomy,
    powerModel: patch.powerModel ?? current.powerModel,
    // apiKeys are stored in .env, not settings.json — always return empty shape here
    apiKeys: DEFAULT_SETTINGS.apiKeys
  }

  // Persist everything except apiKeys (those live in .env, managed by auth.ts)
  const { apiKeys: _omitted, ...persistable } = updated
  await writeFile(join(dataDir, SETTINGS_FILE), JSON.stringify(persistable, null, 2), 'utf-8')
  return updated
}

// Uses the process's local timezone. CoAgent runs on the user's own machine, so
// process timezone === user's OS timezone === the timezone they configured. This is intentional.
export function isActiveNow(settings: AgentSettings, now: Date = new Date()): boolean {
  const hour = now.getHours()
  const day = DAY_NAMES[now.getDay()]
  const inHours = hour >= settings.active_hours.start && hour < settings.active_hours.end
  const inDays = settings.active_days.includes(day)
  return inHours && inDays
}
