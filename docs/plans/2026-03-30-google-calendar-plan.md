# Google Calendar Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Sync Google Calendar events (read-only) into CoAgent's local calendar so users see everything in one place and the agent is aware of their Google events.

**Architecture:** OAuth2 with PKCE for desktop auth, polling with sync tokens every 10 minutes, Google events merged into calendar.json with `source: 'google'`. Refresh tokens stored in OS keychain via keytar. UI gets a sync button + modal in CalendarPane.

**Tech Stack:** googleapis, google-auth-library, keytar, React (existing CalendarPane)

---

### Task 1: Install Dependencies

**Files:**
- Modify: `packages/agent-core/package.json`

**Step 1: Add googleapis, google-auth-library, and keytar**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core
pnpm add googleapis google-auth-library keytar
```

**Step 2: Verify installation**

```bash
cd /Users/brettponters/AI-Projects/CoAgent
pnpm install
```

Expected: Clean install, no errors.

**Step 3: Commit**

```bash
git add packages/agent-core/package.json pnpm-lock.yaml
git commit -m "feat: add googleapis, google-auth-library, keytar dependencies"
```

---

### Task 2: Update Shared Types

**Files:**
- Modify: `packages/shared/src/index.ts:64-77` (CalendarEntry types)
- Modify: `packages/shared/src/index.ts:118-182` (WSClientMessage)
- Modify: `packages/shared/src/index.ts:184-234` (WSServerMessage)

**Step 1: Add 'event' to CalendarEntryType and new fields to CalendarEntry**

In `packages/shared/src/index.ts`, replace lines 64-77:

```typescript
export type CalendarEntryType = 'routine' | 'task' | 'followup' | 'event'

export interface CalendarEntry {
  id: string
  type: CalendarEntryType
  label: string
  cron?: string         // routine: "0 9 * * 1-5"
  due?: string          // task/followup: ISO datetime "2026-03-28T14:30:00"
  start?: string        // event: ISO datetime start
  end?: string          // event: ISO datetime end
  location?: string     // event: location string
  instruction?: string  // what the agent executes when entry fires
  notes?: string        // contextual info for any entry type
  enabled: boolean
  completed?: boolean   // for tasks and followups
  createdAt: string
  source?: 'local' | 'google'     // undefined = local (backward compat)
  googleEventId?: string           // Google's event ID for sync
  googleCalendarId?: string        // which Google calendar it came from
}
```

**Step 2: Add new WebSocket message types to WSClientMessage**

Add these to the WSClientMessage union (after the `get_chat_history` line):

```typescript
  | { type: 'google_calendar_connect' }
  | { type: 'google_calendar_disconnect' }
  | { type: 'google_calendar_toggle'; calendarId: string; enabled: boolean }
  | { type: 'google_calendar_color'; calendarId: string; color: string }
  | { type: 'get_google_calendar_status' }
```

**Step 3: Add GoogleCalendarInfo type and new WSServerMessage types**

Add this interface before WSServerMessage:

```typescript
export interface GoogleCalendarInfo {
  id: string
  name: string
  enabled: boolean
  color: string
}
```

Add to WSServerMessage union:

```typescript
  | { type: 'google_calendar_status'; connected: boolean; calendars: GoogleCalendarInfo[]; lastSync: string | null }
```

**Step 4: Verify types compile**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/shared
npx tsc --noEmit
```

Expected: No errors.

**Step 5: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat: add event type and Google Calendar fields to shared types"
```

---

### Task 3: Create Google Calendar Service

**Files:**
- Create: `packages/agent-core/src/google-calendar.ts`

This is the core service: OAuth flow, token management, event fetching, and sync engine.

**Step 1: Create the file with OAuth and sync implementation**

Create `packages/agent-core/src/google-calendar.ts`:

```typescript
import { OAuth2Client } from 'google-auth-library'
import { google, calendar_v3 } from 'googleapis'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes, createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { exec } from 'child_process'
import type { CalendarEntry, GoogleCalendarInfo } from '@coagent/shared'
import { v4 as uuidv4 } from 'uuid'

// Try to import keytar — optional, falls back to file storage
let keytar: typeof import('keytar') | null = null
try { keytar = require('keytar') } catch { /* keytar not available */ }

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly']
const REDIRECT_PORT = 7831
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth/callback`
const KEYTAR_SERVICE = 'CoAgent'
const KEYTAR_ACCOUNT = 'google_refresh_token'

const DEFAULT_COLORS = ['#1e3a5f', '#16a34a', '#dc2626', '#ec4899', '#0d9488', '#ea580c', '#4f46e5']

interface SyncState {
  syncToken: string | null
  lastSync: string | null
}

interface CalendarConfig {
  id: string
  name: string
  enabled: boolean
  color: string
}

export class GoogleCalendarService {
  private oauth2Client: OAuth2Client | null = null
  private dataDir: string
  private syncState: SyncState = { syncToken: null, lastSync: null }
  private calendars: CalendarConfig[] = []
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private onUpdate: (() => void) | null = null

  constructor(
    private clientId: string,
    private clientSecret: string,
    dataDir: string,
  ) {
    this.dataDir = dataDir
    mkdirSync(dataDir, { recursive: true })
    this.loadSyncState()
    this.loadCalendars()
  }

  /** Set callback for when Google events change */
  setUpdateCallback(cb: () => void): void {
    this.onUpdate = cb
  }

  /** Check if user has connected Google Calendar */
  async isConnected(): Promise<boolean> {
    const token = await this.getRefreshToken()
    return !!token
  }

  /** Get current status for frontend */
  async getStatus(): Promise<{ connected: boolean; calendars: GoogleCalendarInfo[]; lastSync: string | null }> {
    return {
      connected: await this.isConnected(),
      calendars: this.calendars.map(c => ({ id: c.id, name: c.name, enabled: c.enabled, color: c.color })),
      lastSync: this.syncState.lastSync,
    }
  }

  // ── OAuth Flow ────────────────────────────────────────────────

  /** Start OAuth flow — opens browser, returns when auth is complete */
  async connect(): Promise<void> {
    this.oauth2Client = new OAuth2Client(this.clientId, this.clientSecret, REDIRECT_URI)

    // PKCE
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'consent',
    })

    // Wait for the redirect with the auth code
    const code = await this.waitForAuthCode()
      .then(async (waitPromise) => {
        // Open browser
        const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
        exec(`${openCmd} "${authUrl}"`)
        return waitPromise
      })

    // Exchange code for tokens
    const { tokens } = await this.oauth2Client.getToken({ code, codeVerifier: verifier })
    this.oauth2Client.setCredentials(tokens)

    // Store refresh token
    if (tokens.refresh_token) {
      await this.setRefreshToken(tokens.refresh_token)
    }

    // Fetch available calendars
    await this.fetchCalendarList()

    // Initial full sync
    await this.fullSync()

    // Start polling
    this.startPolling()
  }

  /** Wait for auth code via localhost redirect */
  private waitForAuthCode(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || '', `http://localhost:${REDIRECT_PORT}`)
        if (url.pathname === '/oauth/callback') {
          const code = url.searchParams.get('code')
          const error = url.searchParams.get('error')

          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<html><body><h2>Authorization failed</h2><p>You can close this tab.</p></body></html>')
            server.close()
            reject(new Error(`OAuth error: ${error}`))
            return
          }

          if (code) {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<html><body><h2>Connected!</h2><p>You can close this tab and return to CoAgent.</p></body></html>')
            server.close()
            resolve(code)
            return
          }
        }
        res.writeHead(404)
        res.end()
      })

      server.listen(REDIRECT_PORT, () => {
        console.log(`[GoogleCal] OAuth callback server listening on port ${REDIRECT_PORT}`)
      })

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close()
        reject(new Error('OAuth timeout — no response within 5 minutes'))
      }, 300_000)
    })
  }

  /** Disconnect — revoke token, clear data, stop polling */
  async disconnect(): Promise<void> {
    this.stopPolling()

    // Revoke token with Google
    try {
      const client = await this.getAuthClient()
      if (client) {
        await client.revokeCredentials()
      }
    } catch (err: any) {
      console.warn('[GoogleCal] Token revocation failed (may already be revoked):', err.message)
    }

    // Clear stored token
    await this.clearRefreshToken()

    // Clear local state
    this.syncState = { syncToken: null, lastSync: null }
    this.calendars = []
    this.saveSyncState()
    this.saveCalendars()
    this.oauth2Client = null
  }

  // ── Sync Engine ───────────────────────────────────────────────

  /** Initialize — call on server startup to resume polling if connected */
  async init(): Promise<void> {
    if (await this.isConnected()) {
      console.log('[GoogleCal] Connected — starting sync polling')
      this.startPolling()
    }
  }

  /** Full sync — fetch next 3 months + past 1 week */
  private async fullSync(): Promise<CalendarEntry[]> {
    const client = await this.getAuthClient()
    if (!client) return []

    const calendar = google.calendar({ version: 'v3', auth: client })
    const now = new Date()
    const timeMin = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const timeMax = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString()

    const allEvents: CalendarEntry[] = []
    const enabledCalendars = this.calendars.filter(c => c.enabled)

    for (const cal of enabledCalendars) {
      let pageToken: string | undefined
      do {
        const res = await calendar.events.list({
          calendarId: cal.id,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 2500,
          pageToken,
        })

        if (res.data.items) {
          for (const event of res.data.items) {
            const entry = this.googleEventToEntry(event, cal.id)
            if (entry) allEvents.push(entry)
          }
        }

        pageToken = res.data.nextPageToken ?? undefined

        // Save sync token from last page
        if (!pageToken && res.data.nextSyncToken) {
          this.syncState.syncToken = res.data.nextSyncToken
        }
      } while (pageToken)
    }

    this.syncState.lastSync = new Date().toISOString()
    this.saveSyncState()
    console.log(`[GoogleCal] Full sync complete: ${allEvents.length} events`)
    return allEvents
  }

  /** Incremental sync — uses sync token, returns changes only */
  private async incrementalSync(): Promise<{ added: CalendarEntry[]; removed: string[] }> {
    const client = await this.getAuthClient()
    if (!client || !this.syncState.syncToken) {
      // Fallback to full sync
      const events = await this.fullSync()
      return { added: events, removed: [] }
    }

    const calendar = google.calendar({ version: 'v3', auth: client })
    const added: CalendarEntry[] = []
    const removed: string[] = []
    const enabledCalendars = this.calendars.filter(c => c.enabled)

    for (const cal of enabledCalendars) {
      try {
        let pageToken: string | undefined
        do {
          const res = await calendar.events.list({
            calendarId: cal.id,
            syncToken: this.syncState.syncToken,
            pageToken,
          })

          if (res.data.items) {
            for (const event of res.data.items) {
              if (event.status === 'cancelled') {
                if (event.id) removed.push(event.id)
              } else {
                const entry = this.googleEventToEntry(event, cal.id)
                if (entry) added.push(entry)
              }
            }
          }

          pageToken = res.data.nextPageToken ?? undefined
          if (!pageToken && res.data.nextSyncToken) {
            this.syncState.syncToken = res.data.nextSyncToken
          }
        } while (pageToken)
      } catch (err: any) {
        // Sync token expired — do full sync
        if (err.code === 410) {
          console.log('[GoogleCal] Sync token expired, doing full sync')
          this.syncState.syncToken = null
          const events = await this.fullSync()
          return { added: events, removed: [] }
        }
        throw err
      }
    }

    this.syncState.lastSync = new Date().toISOString()
    this.saveSyncState()
    return { added, removed }
  }

  /** Run a sync cycle and return updated Google events */
  async sync(): Promise<{ entries: CalendarEntry[]; changed: boolean }> {
    try {
      if (!this.syncState.syncToken) {
        const entries = await this.fullSync()
        this.onUpdate?.()
        return { entries, changed: true }
      }

      const { added, removed } = await this.incrementalSync()
      if (added.length === 0 && removed.length === 0) {
        return { entries: [], changed: false }
      }
      this.onUpdate?.()
      return { entries: added, changed: true }
    } catch (err: any) {
      console.error('[GoogleCal] Sync error:', err.message)
      return { entries: [], changed: false }
    }
  }

  /** Start polling every 10 minutes */
  private startPolling(): void {
    this.stopPolling()
    this.pollTimer = setInterval(() => {
      this.sync().catch(err => console.error('[GoogleCal] Poll sync error:', err.message))
    }, 10 * 60 * 1000)
    console.log('[GoogleCal] Polling started (every 10 min)')
  }

  /** Stop polling */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  // ── Calendar Management ───────────────────────────────────────

  /** Fetch list of user's Google calendars */
  private async fetchCalendarList(): Promise<void> {
    const client = await this.getAuthClient()
    if (!client) return

    const calendar = google.calendar({ version: 'v3', auth: client })
    const res = await calendar.calendarList.list()

    const existing = new Map(this.calendars.map(c => [c.id, c]))
    this.calendars = (res.data.items || []).map((cal, idx) => {
      const prev = existing.get(cal.id!)
      return {
        id: cal.id!,
        name: cal.summary || 'Untitled',
        enabled: prev?.enabled ?? true,
        color: prev?.color ?? DEFAULT_COLORS[idx % DEFAULT_COLORS.length],
      }
    })
    this.saveCalendars()
  }

  /** Toggle a calendar on/off */
  toggleCalendar(calendarId: string, enabled: boolean): void {
    const cal = this.calendars.find(c => c.id === calendarId)
    if (cal) {
      cal.enabled = enabled
      this.saveCalendars()
    }
  }

  /** Set calendar color */
  setCalendarColor(calendarId: string, color: string): void {
    const cal = this.calendars.find(c => c.id === calendarId)
    if (cal) {
      cal.color = color
      this.saveCalendars()
    }
  }

  /** Get the color for a Google calendar */
  getCalendarColor(calendarId: string): string {
    return this.calendars.find(c => c.id === calendarId)?.color ?? DEFAULT_COLORS[0]
  }

  // ── Conversion ────────────────────────────────────────────────

  /** Convert a Google Calendar event to a CalendarEntry */
  private googleEventToEntry(event: calendar_v3.Schema$Event, calendarId: string): CalendarEntry | null {
    if (!event.id || !event.summary) return null

    const start = event.start?.dateTime || event.start?.date
    const end = event.end?.dateTime || event.end?.date
    if (!start) return null

    return {
      id: `gcal-${event.id}`,
      type: 'event',
      label: event.summary,
      start,
      end: end || undefined,
      location: event.location || undefined,
      notes: event.description ? event.description.slice(0, 500) : undefined,
      enabled: true,
      createdAt: event.created || new Date().toISOString(),
      source: 'google',
      googleEventId: event.id,
      googleCalendarId: calendarId,
    }
  }

  // ── Token Storage ─────────────────────────────────────────────

  private async getRefreshToken(): Promise<string | null> {
    // Try keytar first (OS keychain)
    if (keytar) {
      try {
        return await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT)
      } catch { /* fall through to file */ }
    }
    // Fallback: file-based (less secure, but works everywhere)
    const tokenPath = join(this.dataDir, 'google-token.json')
    try {
      if (existsSync(tokenPath)) {
        const data = JSON.parse(readFileSync(tokenPath, 'utf-8'))
        return data.refresh_token || null
      }
    } catch { /* corrupt */ }
    return null
  }

  private async setRefreshToken(token: string): Promise<void> {
    if (keytar) {
      try {
        await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, token)
        return
      } catch { /* fall through */ }
    }
    const tokenPath = join(this.dataDir, 'google-token.json')
    writeFileSync(tokenPath, JSON.stringify({ refresh_token: token }))
  }

  private async clearRefreshToken(): Promise<void> {
    if (keytar) {
      try { await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT) } catch { /* ok */ }
    }
    const tokenPath = join(this.dataDir, 'google-token.json')
    try { if (existsSync(tokenPath)) writeFileSync(tokenPath, '{}') } catch { /* ok */ }
  }

  /** Get an authenticated OAuth2 client */
  private async getAuthClient(): Promise<OAuth2Client | null> {
    const refreshToken = await this.getRefreshToken()
    if (!refreshToken) return null

    if (!this.oauth2Client) {
      this.oauth2Client = new OAuth2Client(this.clientId, this.clientSecret, REDIRECT_URI)
    }
    this.oauth2Client.setCredentials({ refresh_token: refreshToken })
    return this.oauth2Client
  }

  // ── Persistence ───────────────────────────────────────────────

  private loadSyncState(): void {
    const path = join(this.dataDir, 'google-sync-state.json')
    try {
      if (existsSync(path)) this.syncState = JSON.parse(readFileSync(path, 'utf-8'))
    } catch { /* start fresh */ }
  }

  private saveSyncState(): void {
    const path = join(this.dataDir, 'google-sync-state.json')
    writeFileSync(path, JSON.stringify(this.syncState, null, 2))
  }

  private loadCalendars(): void {
    const path = join(this.dataDir, 'google-calendars.json')
    try {
      if (existsSync(path)) this.calendars = JSON.parse(readFileSync(path, 'utf-8'))
    } catch { /* start fresh */ }
  }

  private saveCalendars(): void {
    const path = join(this.dataDir, 'google-calendars.json')
    writeFileSync(path, JSON.stringify(this.calendars, null, 2))
  }
}
```

**Step 2: Verify it compiles**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core
npx tsc --noEmit
```

Expected: No errors (may need to adjust imports based on actual googleapis types).

**Step 3: Commit**

```bash
git add packages/agent-core/src/google-calendar.ts
git commit -m "feat: add GoogleCalendarService with OAuth, sync, and token management"
```

---

### Task 4: Update CalendarStore for Google Events

**Files:**
- Modify: `packages/agent-core/src/calendar-store.ts`

**Step 1: Add methods to support Google event merging and read-only protection**

The CalendarStore needs:
1. A method to bulk-set Google events (replace all `source: 'google'` entries)
2. Protection so `complete()` and `delete()` reject Google events
3. Sorting that includes 'event' type
4. A method to remove all Google events (for disconnect)

Update `calendar-store.ts`:

After the existing imports, the `complete` method (line 87-93) should reject Google events:

```typescript
  complete(id: string): CalendarEntry | undefined {
    const entry = this.entries.find(e => e.id === id)
    if (!entry || entry.source === 'google') return undefined
    if (entry.type !== 'task' && entry.type !== 'followup') return undefined
    entry.completed = true
    this.save()
    return entry
  }
```

The `delete` method (line 80-84) should reject Google events:

```typescript
  delete(id: string): boolean {
    const entry = this.entries.find(e => e.id === id)
    if (entry?.source === 'google') return false
    const before = this.entries.length
    this.entries = this.entries.filter(e => e.id !== id)
    if (this.entries.length < before) { this.save(); return true }
    return false
  }
```

Add these new methods after `getRoutines()`:

```typescript
  /** Replace all Google events with new set */
  setGoogleEvents(events: CalendarEntry[]): void {
    this.entries = this.entries.filter(e => e.source !== 'google')
    this.entries.push(...events)
    this.save()
  }

  /** Apply incremental sync — remove cancelled, upsert changed */
  applyGoogleSync(added: CalendarEntry[], removedGoogleEventIds: string[]): void {
    // Remove cancelled events
    const removeIds = new Set(removedGoogleEventIds.map(id => `gcal-${id}`))
    this.entries = this.entries.filter(e => !removeIds.has(e.id))

    // Upsert added/updated events
    for (const event of added) {
      const idx = this.entries.findIndex(e => e.id === event.id)
      if (idx >= 0) {
        this.entries[idx] = event
      } else {
        this.entries.push(event)
      }
    }
    this.save()
  }

  /** Remove all Google events (for disconnect) */
  clearGoogleEvents(): void {
    this.entries = this.entries.filter(e => e.source !== 'google')
    this.save()
  }
```

Update `getAll()` sorting to include 'event' (line 97):

```typescript
  getAll(): CalendarEntry[] {
    return [...this.entries].sort((a, b) => {
      const typeOrder: Record<string, number> = { routine: 0, task: 1, followup: 2, event: 3 }
      const aOrder = typeOrder[a.type] ?? 4
      const bOrder = typeOrder[b.type] ?? 4
      if (aOrder !== bOrder) return aOrder - bOrder
      const aTime = a.start || a.due || a.cron || ''
      const bTime = b.start || b.due || b.cron || ''
      return aTime.localeCompare(bTime)
    })
  }
```

**Step 2: Verify it compiles**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add packages/agent-core/src/calendar-store.ts
git commit -m "feat: add Google event support to CalendarStore with read-only protection"
```

---

### Task 5: Wire Up Server WebSocket Handlers

**Files:**
- Modify: `packages/agent-core/src/server.ts`

**Step 1: Import GoogleCalendarService and load env**

Near the top of `server.ts` (after existing imports around line 34), add:

```typescript
import { GoogleCalendarService } from './google-calendar.js'
```

Also load the project root `.env` for Google credentials. After line 41 (`config({ path: join(_envDir, '.env') })`), add:

```typescript
// Also load project-root .env for app-level credentials (Google Calendar)
config({ path: join(__dirname, '..', '..', '..', '.env') })
```

**Step 2: Initialize GoogleCalendarService**

After the agent is created (search for where `new Agent(` or `agent =` is), add:

```typescript
// Google Calendar
const googleCal = (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
  ? new GoogleCalendarService(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      dataDir,
    )
  : null

if (googleCal) {
  googleCal.setUpdateCallback(async () => {
    const status = await googleCal.getStatus()
    broadcast({ type: 'google_calendar_status', ...status } as any)
    broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() })
  })
  googleCal.init().catch(err => console.error('[Server] Google Calendar init error:', err.message))
}
```

**Step 3: Add WebSocket message handlers**

In the WebSocket message handler (the big `if/else` chain), add these handlers:

```typescript
    if (msg.type === 'get_google_calendar_status') {
      if (googleCal) {
        const status = await googleCal.getStatus()
        send(ws, { type: 'google_calendar_status', ...status } as any)
      } else {
        send(ws, { type: 'google_calendar_status', connected: false, calendars: [], lastSync: null } as any)
      }
    }

    if (msg.type === 'google_calendar_connect') {
      if (!googleCal) {
        send(ws, { type: 'error', message: 'Google Calendar not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' })
        return
      }
      try {
        send(ws, { type: 'agent_thinking' })
        await googleCal.connect()

        // Full sync — get all events and merge into calendar
        const { entries } = await googleCal.sync()
        agent.calendar.setGoogleEvents(entries)

        const status = await googleCal.getStatus()
        broadcast({ type: 'google_calendar_status', ...status } as any)
        broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() })
      } catch (err: any) {
        console.error('[Server] Google Calendar connect error:', err.message)
        send(ws, { type: 'error', message: `Google Calendar connection failed: ${err.message}` })
      }
    }

    if (msg.type === 'google_calendar_disconnect') {
      if (googleCal) {
        await googleCal.disconnect()
        agent.calendar.clearGoogleEvents()
        const status = await googleCal.getStatus()
        broadcast({ type: 'google_calendar_status', ...status } as any)
        broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() })
      }
    }

    if (msg.type === 'google_calendar_toggle') {
      if (googleCal) {
        googleCal.toggleCalendar(msg.calendarId, msg.enabled)

        // Re-sync to reflect change
        const { entries } = await googleCal.sync()
        if (entries.length > 0) {
          agent.calendar.setGoogleEvents(entries)
        }
        const status = await googleCal.getStatus()
        broadcast({ type: 'google_calendar_status', ...status } as any)
        broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() })
      }
    }

    if (msg.type === 'google_calendar_color') {
      if (googleCal) {
        googleCal.setCalendarColor(msg.calendarId, msg.color)
        const status = await googleCal.getStatus()
        broadcast({ type: 'google_calendar_status', ...status } as any)
      }
    }
```

**Step 4: Send Google Calendar status in sendFullState**

In the `sendFullState` function (around line 1356), add after the calendar_update line:

```typescript
  if (googleCal) {
    const gcalStatus = await googleCal.getStatus()
    send(ws, { type: 'google_calendar_status', ...gcalStatus } as any)
  }
```

**Step 5: Hook up sync callback to update CalendarStore**

The `setUpdateCallback` in Step 2 handles broadcasts, but we also need the polling sync to update the CalendarStore. Update the callback:

```typescript
  googleCal.setUpdateCallback(async () => {
    // The sync already ran — now merge results into calendar store
    // We do a full re-sync to keep it simple
    const { entries, changed } = await googleCal.sync()
    if (changed && entries.length > 0) {
      agent.calendar.setGoogleEvents(entries)
    }
    const status = await googleCal.getStatus()
    broadcast({ type: 'google_calendar_status', ...status } as any)
    broadcast({ type: 'calendar_update', entries: agent.calendar.getAll() })
  })
```

**Step 6: Verify it compiles**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core
npx tsc --noEmit
```

**Step 7: Commit**

```bash
git add packages/agent-core/src/server.ts
git commit -m "feat: wire up Google Calendar WebSocket handlers and sync"
```

---

### Task 6: Update CalendarPane UI

**Files:**
- Modify: `apps/desktop/src/components/CalendarPane.tsx`

This is the frontend work: sync button, connect/manage modals, event colors, read-only detail panel.

**Step 1: Add event color to TYPE_COLORS and Google Calendar state**

Update the TYPE_COLORS constant (line 23-27) to include events:

```typescript
const TYPE_COLORS = {
  routine:  { bg: 'bg-sky-100 dark:bg-sky-900/30',    text: 'text-sky-700 dark:text-sky-300',    dot: 'bg-sky-400' },
  task:     { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-400' },
  followup: { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-300', dot: 'bg-purple-500' },
  event:    { bg: 'bg-blue-100 dark:bg-blue-900/30',   text: 'text-blue-700 dark:text-blue-300',   dot: 'bg-blue-800' },
} as const
```

**Step 2: Add props for Google Calendar**

Update the CalendarPaneProps interface:

```typescript
interface GoogleCalendarInfo {
  id: string
  name: string
  enabled: boolean
  color: string
}

interface CalendarPaneProps {
  entries: CalendarEntry[]
  onComplete: (id: string) => void
  onDelete: (id: string) => void
  activeHours?: { start: number; end: number }
  googleCalendarStatus?: { connected: boolean; calendars: GoogleCalendarInfo[]; lastSync: string | null }
  onGoogleConnect?: () => void
  onGoogleDisconnect?: () => void
  onGoogleToggle?: (calendarId: string, enabled: boolean) => void
  onGoogleColor?: (calendarId: string, color: string) => void
}
```

**Step 3: Add the Google Calendar button and modal to the header**

In the CalendarPane component, add state for the modal:

```typescript
const [showGoogleModal, setShowGoogleModal] = useState(false)
```

Add a button in the header (inside the left side `div`, after the Today button area, around line 87):

```typescript
{/* Google Calendar sync button */}
<button
  onClick={() => setShowGoogleModal(true)}
  className="ml-auto flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-600 dark:text-neutral-400"
>
  <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="currentColor">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
  </svg>
  {googleCalendarStatus?.connected ? 'Google Calendar' : 'Sync Google Calendar'}
</button>
```

**Step 4: Create the Google Calendar Modal component**

Add a new component after the CalendarPane function:

```typescript
const GOOGLE_COLORS = [
  { name: 'Dark Blue', value: '#1e3a5f' },
  { name: 'Green', value: '#16a34a' },
  { name: 'Red', value: '#dc2626' },
  { name: 'Pink', value: '#ec4899' },
  { name: 'Teal', value: '#0d9488' },
  { name: 'Orange', value: '#ea580c' },
  { name: 'Indigo', value: '#4f46e5' },
]

function GoogleCalendarModal({
  status,
  onConnect,
  onDisconnect,
  onToggle,
  onColor,
  onClose,
}: {
  status: { connected: boolean; calendars: GoogleCalendarInfo[]; lastSync: string | null }
  onConnect: () => void
  onDisconnect: () => void
  onToggle: (calendarId: string, enabled: boolean) => void
  onColor: (calendarId: string, color: string) => void
  onClose: () => void
}) {
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-neutral-900 rounded-xl shadow-xl w-[360px] max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 pt-5 pb-3 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">Google Calendar</h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300">
            <X size={16} />
          </button>
        </div>

        {!status.connected ? (
          /* Connect view */
          <div className="px-5 pb-6 text-center">
            <p className="text-[13px] text-neutral-500 dark:text-neutral-400 mb-5">
              Connect your Google Calendar to see events alongside your schedule.
            </p>
            <button
              onClick={() => { onConnect(); onClose() }}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-medium rounded-lg transition-colors"
            >
              Connect with Google
            </button>
          </div>
        ) : (
          /* Manage view */
          <div>
            <div className="px-5 pb-4 space-y-2">
              {status.calendars.map(cal => (
                <div key={cal.id} className="flex items-center gap-3 py-1.5">
                  <input
                    type="checkbox"
                    checked={cal.enabled}
                    onChange={() => onToggle(cal.id, !cal.enabled)}
                    className="rounded border-neutral-300 dark:border-neutral-600"
                  />
                  <span className="flex-1 text-[13px] text-neutral-800 dark:text-neutral-200 truncate">{cal.name}</span>
                  <div className="relative">
                    <button
                      onClick={() => setColorPickerFor(colorPickerFor === cal.id ? null : cal.id)}
                      className="w-4 h-4 rounded-full border border-neutral-200 dark:border-neutral-700"
                      style={{ backgroundColor: cal.color }}
                    />
                    {colorPickerFor === cal.id && (
                      <div className="absolute right-0 top-6 z-10 bg-white dark:bg-neutral-800 rounded-lg shadow-lg p-2 flex gap-1.5">
                        {GOOGLE_COLORS.map(c => (
                          <button
                            key={c.value}
                            onClick={() => { onColor(cal.id, c.value); setColorPickerFor(null) }}
                            className={cn('w-5 h-5 rounded-full border-2', cal.color === c.value ? 'border-neutral-900 dark:border-white' : 'border-transparent')}
                            style={{ backgroundColor: c.value }}
                            title={c.name}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="px-5 py-3 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
              <span className="text-[11px] text-neutral-400">
                {status.lastSync ? `Last synced: ${formatTime(status.lastSync)}` : 'Not synced yet'}
              </span>
              <button
                onClick={() => { onDisconnect(); onClose() }}
                className="text-[12px] text-red-500 hover:text-red-600 font-medium"
              >
                Disconnect
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
```

**Step 5: Render the modal and pass props**

In the CalendarPane component's return, add before the closing `</div>`:

```typescript
{showGoogleModal && (
  <GoogleCalendarModal
    status={googleCalendarStatus || { connected: false, calendars: [], lastSync: null }}
    onConnect={onGoogleConnect || (() => {})}
    onDisconnect={onGoogleDisconnect || (() => {})}
    onToggle={onGoogleToggle || (() => {})}
    onColor={onGoogleColor || (() => {})}
    onClose={() => setShowGoogleModal(false)}
  />
)}
```

**Step 6: Update EntryDetailPanel for read-only Google events**

In EntryDetailPanel (line 127-236), update the actions section to hide buttons for Google events:

```typescript
{/* Actions — hide for Google events (read-only) */}
{entry.source !== 'google' && (
  <div className="px-4 py-3 border-t border-neutral-100 dark:border-neutral-800 flex flex-col gap-2">
    {canComplete && !entry.completed && (
      <button ...>Mark complete</button>
    )}
    <button ...>Delete</button>
  </div>
)}
{entry.source === 'google' && (
  <div className="px-4 py-3 border-t border-neutral-100 dark:border-neutral-800">
    <p className="text-[10px] text-neutral-400 dark:text-neutral-500 text-center">Synced from Google Calendar</p>
  </div>
)}
```

Also add location display in the detail panel body (after the Timing section):

```typescript
{/* Location (events) */}
{entry.location && (
  <div>
    <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-1">
      Location
    </p>
    <p className="text-[12px] text-neutral-700 dark:text-neutral-300">{entry.location}</p>
  </div>
)}

{/* Time range (events) */}
{entry.start && entry.end && (
  <div>
    <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-1">
      Time
    </p>
    <p className="text-[12px] text-neutral-700 dark:text-neutral-300">
      {formatTime(entry.start)} — {formatTime(entry.end)}
    </p>
  </div>
)}
```

**Step 7: Update getEntriesForDay and getEntriesForHour helpers to handle events**

Update `getEntriesForDay` (line 551-558):

```typescript
function getEntriesForDay(entries: CalendarEntry[], day: Date): CalendarEntry[] {
  return entries.filter(e => {
    if (e.completed) return false
    if (e.start) return isSameDay(parseISO(e.start), day)
    if (e.due) return isSameDay(parseISO(e.due), day)
    if (e.cron) return cronMatchesDay(e.cron, day)
    return false
  })
}
```

Update `getEntriesForHour` (line 560-572):

```typescript
function getEntriesForHour(entries: CalendarEntry[], day: Date, hour: number): CalendarEntry[] {
  return entries.filter(e => {
    if (e.completed) return false
    if (e.start && e.start.includes('T')) {
      const d = parseISO(e.start)
      return isSameDay(d, day) && getHours(d) === hour
    }
    if (e.due && e.due.includes('T')) {
      const d = parseISO(e.due)
      return isSameDay(d, day) && getHours(d) === hour
    }
    if (e.cron) {
      return cronMatchesDay(e.cron, day) && cronMatchesHour(e.cron, hour)
    }
    return false
  })
}
```

**Step 8: Update AgendaView to include Events section**

In `AgendaView` (line 254-257), add events:

```typescript
const events = uncompleted.filter(e => e.type === 'event')
```

And in the JSX, add:

```typescript
{events.length > 0 && <AgendaSection title="Events" entries={events} onComplete={onComplete} onDelete={onDelete} onSelect={onSelect} selectedId={selectedId} />}
```

**Step 9: Commit**

```bash
git add apps/desktop/src/components/CalendarPane.tsx
git commit -m "feat: add Google Calendar UI — sync button, modals, event rendering"
```

---

### Task 7: Wire Frontend WebSocket to CalendarPane

**Files:**
- Modify: The parent component that renders CalendarPane (find where `<CalendarPane` is used)

**Step 1: Find the parent component**

Search for where CalendarPane is rendered — likely in `App.tsx` or a layout component. Add state for Google Calendar status and WebSocket message handling:

```typescript
const [googleCalendarStatus, setGoogleCalendarStatus] = useState<{ connected: boolean; calendars: any[]; lastSync: string | null }>({ connected: false, calendars: [], lastSync: null })

// In WebSocket message handler:
case 'google_calendar_status':
  setGoogleCalendarStatus(msg)
  break
```

**Step 2: Pass props to CalendarPane**

```typescript
<CalendarPane
  entries={calendarEntries}
  onComplete={id => ws.send(JSON.stringify({ type: 'complete_calendar_entry', id }))}
  onDelete={id => ws.send(JSON.stringify({ type: 'delete_calendar_entry', id }))}
  activeHours={settings.active_hours}
  googleCalendarStatus={googleCalendarStatus}
  onGoogleConnect={() => ws.send(JSON.stringify({ type: 'google_calendar_connect' }))}
  onGoogleDisconnect={() => ws.send(JSON.stringify({ type: 'google_calendar_disconnect' }))}
  onGoogleToggle={(calendarId, enabled) => ws.send(JSON.stringify({ type: 'google_calendar_toggle', calendarId, enabled }))}
  onGoogleColor={(calendarId, color) => ws.send(JSON.stringify({ type: 'google_calendar_color', calendarId, color }))}
/>
```

**Step 3: Request status on connect**

In the WebSocket `onopen` handler, add:

```typescript
ws.send(JSON.stringify({ type: 'get_google_calendar_status' }))
```

**Step 4: Commit**

```bash
git add <parent-component-file>
git commit -m "feat: wire Google Calendar WebSocket messages to CalendarPane"
```

---

### Task 8: Test End-to-End

**Step 1: Build and start**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop
pnpm tauri dev
```

**Step 2: Verify no Google Calendar state (before connecting)**

- Calendar UI should show "Sync Google Calendar" button in header
- Clicking it should show the connect modal
- Existing entries (routines, tasks, followups) should render as before

**Step 3: Connect Google Calendar**

- Click "Connect with Google" in the modal
- Browser should open to Google's consent screen
- After authorizing, browser shows "Connected!" page
- App should show Google events in calendar views
- Manage modal should list calendars with color dots

**Step 4: Verify agent awareness**

- Send a chat message: "what do I have this week?"
- Agent should mention Google Calendar events (they're auto-indexed via MemoryStore's calendar.json watcher)

**Step 5: Verify read-only**

- Click a Google event in the calendar
- Detail panel should show "Synced from Google Calendar" instead of Complete/Delete buttons
- Location and time range should display

**Step 6: Test disconnect**

- Open manage modal → Disconnect
- All Google events should disappear
- "Sync Google Calendar" button should return

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: Google Calendar integration — complete"
```
