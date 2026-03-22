// packages/agent-core/src/settings.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readSettings, writeSettings, DEFAULT_SETTINGS, isActiveNow } from './settings'

describe('settings', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'settings-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns defaults when no file exists', async () => {
    const s = await readSettings(tmpDir)
    expect(s.autonomy).toBe('balanced')
    expect(s.active_hours.start).toBe(7)
    expect(s.active_hours.end).toBe(24)
    expect(s.active_days).toEqual(['mon','tue','wed','thu','fri','sat','sun'])
  })

  it('persists and reads back settings', async () => {
    await writeSettings(tmpDir, { autonomy: 'ask_first' })
    const s = await readSettings(tmpDir)
    expect(s.autonomy).toBe('ask_first')
    expect(s.active_hours.start).toBe(7)
  })

  it('merges partial updates', async () => {
    await writeSettings(tmpDir, { active_hours: { start: 9, end: 21 } })
    const s = await readSettings(tmpDir)
    expect(s.active_hours.start).toBe(9)
    expect(s.active_hours.end).toBe(21)
    expect(s.autonomy).toBe('balanced')
  })

  it('isActiveNow returns true inside active window', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      active_hours: { start: 8, end: 22 },
      active_days: ['mon','tue','wed','thu','fri','sat','sun'] as const
    }
    const midday = new Date('2026-02-23T10:00:00') // Monday
    expect(isActiveNow(settings, midday)).toBe(true)
  })

  it('isActiveNow returns false outside active window', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      active_hours: { start: 8, end: 22 },
      active_days: ['mon','tue','wed','thu','fri','sat','sun'] as const
    }
    const night = new Date('2026-02-23T03:00:00')
    expect(isActiveNow(settings, night)).toBe(false)
  })

  it('isActiveNow returns false on inactive day', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      active_hours: { start: 8, end: 22 },
      active_days: ['mon','tue','wed','thu','fri'] as const
    }
    const saturday = new Date('2026-02-21T10:00:00')
    expect(isActiveNow(settings, saturday)).toBe(false)
  })

  it('returns empty defaults for new profile fields', async () => {
    const s = await readSettings(tmpDir)
    expect(s.name).toBe('')
    expect(s.email).toBe('')
    expect(s.role).toBe('')
    expect(s.timezone).toBeTruthy()
  })

  it('persists and reads back profile fields', async () => {
    await writeSettings(tmpDir, { name: 'Brett', email: 'brett@example.com', role: 'real estate agent' })
    const s = await readSettings(tmpDir)
    expect(s.name).toBe('Brett')
    expect(s.email).toBe('brett@example.com')
    expect(s.role).toBe('real estate agent')
  })

  it('partial profile update does not clobber other fields', async () => {
    await writeSettings(tmpDir, { name: 'Brett', email: 'brett@example.com' })
    await writeSettings(tmpDir, { name: 'Brett P' })
    const s = await readSettings(tmpDir)
    expect(s.name).toBe('Brett P')
    expect(s.email).toBe('brett@example.com')
  })
})
