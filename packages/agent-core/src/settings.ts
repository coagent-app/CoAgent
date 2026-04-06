// packages/agent-core/src/settings.ts
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { join } from 'path'
import type { AgentSettings, Autonomy, DayName } from '@coagent/shared'
import { getEdition } from './edition.js'

export type { AgentSettings, Autonomy, DayName }

const DAY_NAMES: DayName[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function getDefaultSettings(): AgentSettings {
  const { preset } = getEdition()
  return {
    name: '',
    email: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago',
    role: preset.defaultRole,
    what_you_do: '',
    active_hours: { ...preset.activeHours },
    active_days: [...preset.activeDays],
    autonomy: preset.defaultAutonomy,
    heartbeat_interval: 60,
    powerModel: 'kimi-k2.5',
    voice_enabled: false,
    voice_response: false,
    voice_hotkey: 'Control+Alt+Space',
    voice_voice: 'alloy',
    voice_volume: 0.5,
    onboarded: false,
    custom_instructions: '',
    brand_company: '',
    brand_color: '',
    brand_logo: '',
    auto_brief_meetings: false,
    auto_brief_minutes: 30,
    agent_name: '',
  }
}

export const DEFAULT_SETTINGS: AgentSettings = getDefaultSettings()

const VALID_DAYS: DayName[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const VALID_AUTONOMY: Autonomy[] = ['ask_first', 'balanced', 'agent', 'autonomous']

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
      what_you_do: parsed.what_you_do ?? DEFAULT_SETTINGS.what_you_do,
      active_hours: { ...DEFAULT_SETTINGS.active_hours, ...parsed.active_hours },
      active_days: parsed.active_days ?? DEFAULT_SETTINGS.active_days,
      autonomy: parsed.autonomy ?? DEFAULT_SETTINGS.autonomy,
      heartbeat_interval: parsed.heartbeat_interval ?? DEFAULT_SETTINGS.heartbeat_interval,
      powerModel: (parsed.powerModel === 'moonshotai/kimi-k2.5' ? 'kimi-k2.5' : parsed.powerModel) ?? DEFAULT_SETTINGS.powerModel,
      voice_enabled: parsed.voice_enabled ?? DEFAULT_SETTINGS.voice_enabled,
      voice_response: parsed.voice_response ?? DEFAULT_SETTINGS.voice_response,
      voice_hotkey: parsed.voice_hotkey ?? DEFAULT_SETTINGS.voice_hotkey,
      voice_voice: parsed.voice_voice ?? DEFAULT_SETTINGS.voice_voice,
      voice_volume: parsed.voice_volume ?? DEFAULT_SETTINGS.voice_volume,
      onboarded: parsed.onboarded ?? DEFAULT_SETTINGS.onboarded,
      custom_instructions: parsed.custom_instructions ?? DEFAULT_SETTINGS.custom_instructions,
      brand_company: parsed.brand_company ?? DEFAULT_SETTINGS.brand_company,
      brand_color: parsed.brand_color ?? DEFAULT_SETTINGS.brand_color,
      brand_logo: parsed.brand_logo ?? DEFAULT_SETTINGS.brand_logo,
      auto_brief_meetings: parsed.auto_brief_meetings ?? DEFAULT_SETTINGS.auto_brief_meetings,
      auto_brief_minutes: parsed.auto_brief_minutes ?? DEFAULT_SETTINGS.auto_brief_minutes,
      agent_name: parsed.agent_name ?? DEFAULT_SETTINGS.agent_name,
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
    what_you_do: patch.what_you_do !== undefined ? patch.what_you_do : current.what_you_do,
    active_hours: validatedHours ?? current.active_hours,
    active_days: validatedDays !== undefined ? validatedDays : current.active_days,
    autonomy: validatedAutonomy ?? current.autonomy,
    heartbeat_interval: patch.heartbeat_interval !== undefined
      ? Math.max(0, Math.min(1440, Math.round(patch.heartbeat_interval)))
      : current.heartbeat_interval,
    powerModel: patch.powerModel ?? current.powerModel,
    voice_enabled: patch.voice_enabled !== undefined ? patch.voice_enabled : current.voice_enabled,
    voice_response: patch.voice_response !== undefined ? patch.voice_response : current.voice_response,
    voice_hotkey: patch.voice_hotkey !== undefined ? patch.voice_hotkey : current.voice_hotkey,
    voice_voice: patch.voice_voice !== undefined ? patch.voice_voice : current.voice_voice,
    voice_volume: patch.voice_volume !== undefined ? Math.max(0, Math.min(1, patch.voice_volume)) : current.voice_volume,
    onboarded: patch.onboarded !== undefined ? patch.onboarded : current.onboarded,
    custom_instructions: patch.custom_instructions !== undefined ? patch.custom_instructions : current.custom_instructions,
    brand_company: patch.brand_company !== undefined ? patch.brand_company : current.brand_company,
    brand_color: patch.brand_color !== undefined ? patch.brand_color : current.brand_color,
    brand_logo: patch.brand_logo !== undefined ? patch.brand_logo : current.brand_logo,
    auto_brief_meetings: patch.auto_brief_meetings !== undefined ? patch.auto_brief_meetings : current.auto_brief_meetings,
    auto_brief_minutes: patch.auto_brief_minutes !== undefined
      ? Math.max(5, Math.min(120, Math.round(patch.auto_brief_minutes)))
      : current.auto_brief_minutes,
    agent_name: patch.agent_name !== undefined ? patch.agent_name : current.agent_name,
  }

  const target = join(dataDir, SETTINGS_FILE)
  const tmp = target + '.tmp'
  await writeFile(tmp, JSON.stringify(updated, null, 2), 'utf-8')
  await rename(tmp, target)
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
