# Push Notifications Design

**Goal:** Give the agent a `notify_user` tool that sends push notifications to the user's phone, with smart suppression based on whether the user is at their desktop.

**Architecture:** Agent calls `notify_user(title, body)` → agent-core server sends `push_notification` message over WS → relay checks desktop connection status + user preference → sends push via Expo Push API or suppresses.

---

## 1. The `notify_user` Tool

A new internal tool in agent-core:

```
notify_user({ title: string, body: string })
```

- Agent calls it whenever it wants to ping the user — task done, reminder, follow-up, scheduled event, anything
- The agent writes the title and body like a message to the user
- Available in all tool contexts: chat, heartbeat, webhook, routine
- System prompt instructs the agent on when notifications are appropriate
- **Not automatic** — the agent decides when to notify, nothing is system-triggered

The server sends it over WebSocket as:

```json
{ "type": "push_notification", "title": "...", "body": "..." }
```

## 2. Relay Push Logic

When the relay Durable Object receives `{ type: 'push_notification', title, body }`:

1. **Check user's notification preference** (stored in DO storage):
   - `always` → send push
   - `away_only` → check if any desktop client is connected; skip if yes
   - `never` → drop it

2. **Desktop detection** — clients tag themselves on WS connect via query param: `?client=desktop` or `?client=mobile`. Relay tracks client type per socket. "Away" = no desktop socket connected.

3. **Send push** — relay calls Expo Push API (`https://exp.host/--/api/v2/push/send`) with the stored Expo push token, title, and body. No third-party service needed — Expo handles APNs/FCM routing.

4. **Push token storage** — mobile sends its Expo push token to the relay via `{ type: 'register_push_token', token: string }`. Relay persists it in DO storage.

## 3. Mobile Side

**Push token registration:**
- On app launch, request notification permissions via `expo-notifications`
- Get the Expo push token
- Send to relay over WS: `{ type: 'register_push_token', token: string }`
- Re-send on every WS connect (token can change)

**Notification preferences UI** (settings page):
- **When to notify:** Always / Away only / Never
- Default: Away only
- Stored in relay DO storage so the relay can check it server-side
- Mobile sends preference changes via WS: `{ type: 'update_notification_prefs', mode: 'always' | 'away_only' | 'never' }`

**Notification handling:**
- Tapping a notification opens the app to the Chat tab
- No deep linking for v1

## 4. New Types & Messages

**New WSClientMessage types:**
```typescript
| { type: 'register_push_token'; token: string }
| { type: 'update_notification_prefs'; mode: 'always' | 'away_only' | 'never' }
```

**New WSServerMessage type:**
```typescript
| { type: 'push_notification'; title: string; body: string }
```

**WS connect URL change:**
```
/ws/{userId}?token={token}&client=desktop
/ws/{userId}?token={token}&client=mobile
```

**New relay DO storage keys:**
- `push_token` — Expo push token string
- `notification_mode` — `'always' | 'away_only' | 'never'`

**New agent internal tool:**
- `notify_user` — `{ title: string, body: string }`, available in all tool contexts

## 5. Data Flow

```
Agent decides to notify
  → calls notify_user(title, body)
  → agent-core server sends { type: 'push_notification', title, body } over WS
  → relay DO receives message
  → relay checks notification_mode from DO storage
  → relay checks connected client types (desktop present?)
  → if should_send: POST to Expo Push API with stored push_token
  → Expo routes to APNs/FCM
  → user's phone buzzes
```
