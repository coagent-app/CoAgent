# Google Calendar Integration Design

**Goal:** Sync Google Calendar events into CoAgent's calendar so users see everything in one place and the agent is aware of their schedule.

**Approach:** Read-only one-way sync (Google → Local). Google events merge into calendar.json with `source: 'google'`. Auto-syncs every 10 minutes using Google's incremental sync tokens.

---

## Data Model

Add `'event'` to `CalendarEntryType`:

```typescript
export type CalendarEntryType = 'routine' | 'task' | 'followup' | 'event'
```

New fields on `CalendarEntry`:

```typescript
source?: 'local' | 'google'    // undefined = local (backward compat)
googleEventId?: string          // Google's event ID for sync
googleCalendarId?: string       // which Google calendar it came from
start?: string                  // ISO datetime for events
end?: string                    // ISO datetime for events
location?: string               // Google event location
```

Google events are read-only in the app. No complete/delete/edit actions.

---

## Auth Flow

1. User clicks "Sync Google Calendar" in CalendarPane header
2. Connect modal opens with "Connect with Google" button
3. Backend generates PKCE codes, spins up temp HTTP server on `localhost:7831/oauth/callback`
4. Opens default browser to Google consent screen (scope: `calendar.readonly`)
5. User authorizes → Google redirects to localhost with auth code
6. Backend exchanges code for tokens, kills temp server
7. Refresh token stored in OS keychain via `keytar` (`CoAgent / google_refresh_token`)
8. Access token rotation handled automatically by `google-auth-library`
9. First sync begins immediately

**Credentials:** App-level Client ID + Secret loaded from project `.env`. Start in Google's "testing" mode (100 users), verify when we grow.

**Disconnect:** Revoke token with Google, delete from keychain, remove all `source: 'google'` entries from calendar.json, broadcast update.

---

## Sync Engine

**File:** `packages/agent-core/src/google-calendar.ts`

**Initial sync:** Fetch next 3 months + past 1 week of events. Save Google's `syncToken` to `~/.coagent/google-sync-token.json`.

**Incremental sync (every 10 min):** Use sync token — Google returns only changes since last sync. Typically 0 events, very lightweight (~144 API calls/day, Google limit is 1,000,000).

**Field mapping:**

| Google Event | CalendarEntry |
|-------------|---------------|
| `summary` | `label` |
| `start.dateTime` / `start.date` | `start` |
| `end.dateTime` / `end.date` | `end` |
| `location` | `location` |
| `description` | `notes` (truncated 500 chars) |
| `id` | `googleEventId` |
| `calendarId` | `googleCalendarId` |

**Stale cleanup:** Deleted/moved events come back as `status: 'cancelled'` in incremental sync — remove from calendar.json.

**Calendar selection:** Stored in `~/.coagent/google-calendars.json`:
```json
[
  { "id": "primary", "name": "Work", "enabled": true, "color": "darkblue" },
  { "id": "abc123", "name": "Personal", "enabled": true, "color": "green" }
]
```

**Agent awareness:** Google events in calendar.json are automatically picked up by the existing MemoryStore file watcher → indexed to LanceDB → available via auto-inject. No extra work needed.

---

## UI Changes

### CalendarPane Header

- "Sync Google Calendar" button (Google icon + text) in header near view switcher
- Once connected, becomes a Google icon that opens the manage modal

### Connect Modal (first time)

Clean, simple modal:
- Brief copy: "Connect your Google Calendar to see events alongside your schedule"
- Single "Connect with Google" button
- Opens browser for OAuth

### Manage Modal (after connected)

- List of Google calendars with enable/disable checkboxes
- Color dot next to each calendar — click to pick from palette
- Last synced timestamp
- Disconnect button

### Color Palette

**Reserved (existing types):**
- Sky blue → Routines
- Amber → Tasks
- Purple → Followups

**Available for Google calendars:**
- Dark blue (default for first calendar)
- Green
- Red
- Pink
- Teal
- Orange
- Indigo

Default assigns in order: first calendar = dark blue, second = green, etc.

### Google Events in Calendar Views

- Rendered with user-chosen color
- Small "G" badge or Google icon to distinguish from local entries
- Detail panel shows event info (time, location, notes) but NO action buttons
- Subtle "Synced from Google Calendar" label in detail panel

---

## WebSocket Messages

| Direction | Type | Payload |
|-----------|------|---------|
| Client → Server | `google_calendar_connect` | — |
| Client → Server | `google_calendar_disconnect` | — |
| Client → Server | `google_calendar_toggle` | `{ calendarId, enabled }` |
| Client → Server | `google_calendar_color` | `{ calendarId, color }` |
| Server → Client | `google_calendar_status` | `{ connected, calendars, lastSync }` |

Existing `calendar_update` message carries Google events alongside local entries — no new message type needed for event data.

---

## New Dependencies

- `googleapis` — Google Calendar API client
- `google-auth-library` — OAuth2 with PKCE
- `keytar` — OS keychain for token storage

---

## Files

**New:**
- `packages/agent-core/src/google-calendar.ts` — OAuth flow, sync engine, polling timer

**Modified:**
- `packages/shared/src/index.ts` — CalendarEntry type changes
- `packages/agent-core/src/server.ts` — New WebSocket message handlers
- `packages/agent-core/src/calendar-store.ts` — Read/write Google events, protect read-only entries
- `apps/desktop/src/components/CalendarPane.tsx` — Sync button, connect/manage modals, event rendering
