import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library'
import { google, calendar_v3 } from 'googleapis'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes, createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { exec } from 'child_process'
import type { CalendarEntry, GoogleCalendarInfo } from '@coagent/shared'

// Dynamic import for keytar — native module, may not be available in all environments
let keytarModule: typeof import('keytar') | null | undefined = undefined
async function getKeytar() {
  if (keytarModule !== undefined) return keytarModule
  try { keytarModule = await import('keytar') } catch { keytarModule = null }
  return keytarModule
}

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
  private onStoreEvents: ((entries: CalendarEntry[]) => void) | null = null

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

  /** Set callback for storing synced events into the calendar store */
  setStoreCallback(cb: (entries: CalendarEntry[]) => void): void {
    this.onStoreEvents = cb
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
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: CodeChallengeMethod.S256,
      prompt: 'consent',
    })

    // Start listening for the redirect BEFORE opening browser
    const codePromise = this.waitForAuthCode()

    // Open browser (Windows `start` needs empty title before URL)
    const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'
    exec(`${openCmd} "${authUrl}"`)

    // Wait for the redirect
    const code = await codePromise

    // Exchange code for tokens
    const { tokens } = await this.oauth2Client.getToken({ code, codeVerifier: verifier })
    this.oauth2Client.setCredentials(tokens)

    if (tokens.refresh_token) {
      await this.setRefreshToken(tokens.refresh_token)
    }

    await this.fetchCalendarList()
    await this.fullSync()
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
        while (true) {
          const res = await (calendar.events.list({
            calendarId: cal.id,
            syncToken: this.syncState.syncToken ?? undefined,
            pageToken,
          }) as Promise<{ data: calendar_v3.Schema$Events }>)

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
          if (!pageToken) break
        }
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
  async sync(): Promise<{ entries: CalendarEntry[]; changed: boolean; full: boolean; removedIds?: string[] }> {
    try {
      if (!this.syncState.syncToken) {
        const entries = await this.fullSync()
        this.onUpdate?.()
        return { entries, changed: true, full: true }
      }

      const { added, removed } = await this.incrementalSync()
      if (added.length === 0 && removed.length === 0) {
        return { entries: [], changed: false, full: false }
      }
      this.onUpdate?.()
      return { entries: added, changed: true, full: false, removedIds: removed }
    } catch (err: any) {
      console.error('[GoogleCal] Sync error:', err.message)
      return { entries: [], changed: false, full: false }
    }
  }

  /** Start polling every 10 minutes */
  private startPolling(): void {
    this.stopPolling()
    this.pollTimer = setInterval(() => {
      this.sync().then(({ entries, changed }) => {
        if (changed && entries.length > 0 && this.onStoreEvents) {
          this.onStoreEvents(entries)
        }
      }).catch(err => console.error('[GoogleCal] Poll sync error:', err.message))
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
    const keytar = await getKeytar()
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
    const keytar = await getKeytar()
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
    const keytar = await getKeytar()
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
