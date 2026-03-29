# Push Notifications Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the agent a `notify_user` tool that sends push notifications to the user's phone, with smart suppression based on desktop connection status and user preferences.

**Architecture:** Agent calls `notify_user(title, body)` → server sends `push_notification` over WS → relay checks client connections + user preference → sends push via Expo Push API or suppresses.

**Tech Stack:** expo-notifications (mobile), Cloudflare Durable Objects (relay), TypeScript

---

### Task 1: Add shared types for push notifications

**Files:**
- Modify: `packages/shared/src/index.ts`

**Step 1: Add new WSClientMessage types**

Add to the `WSClientMessage` union (after `get_chat_history` on line 164):

```typescript
  | { type: 'register_push_token'; token: string }
  | { type: 'update_notification_prefs'; mode: 'always' | 'away_only' | 'never' }
```

**Step 2: Add new WSServerMessage type**

Add to the `WSServerMessage` union (after `relay_credentials` on line 202):

```typescript
  | { type: 'push_notification'; title: string; body: string }
  | { type: 'notification_prefs'; mode: 'always' | 'away_only' | 'never' }
```

**Step 3: Add NotificationMode type export**

Add after the `Autonomy` type on line 1:

```typescript
export type NotificationMode = 'always' | 'away_only' | 'never'
```

**Step 4: Verify build**

Run: `cd packages/shared && pnpm build`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat: add push notification shared types"
```

---

### Task 2: Add `notify_user` tool to agent-core

**Files:**
- Modify: `packages/agent-core/src/agent.ts`

**Step 1: Add the tool definition to INTERNAL_TOOLS**

Add after the `call_external_tool` definition (after line 405):

```typescript
  {
    name: 'notify_user',
    description: 'Send a push notification to the user\'s phone. Use this to alert the user about completed tasks, reminders, follow-ups, or anything they should know when they\'re away from their computer. Write the title and body like a helpful message.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short notification title, e.g. "Invoice Ready"' },
        body: { type: 'string', description: 'Notification body message, e.g. "Drafted the invoice for Acme Corp — ready for your review."' }
      },
      required: ['title', 'body']
    }
  },
```

**Step 2: Add tool label**

Add to `TOOL_LABELS` (after `create_custom_integration` on line 441):

```typescript
  notify_user: 'Sending notification',
```

**Step 3: Add to HEARTBEAT_TOOLS**

The agent needs to be able to notify during heartbeats and scheduled tasks. Add `'notify_user'` to the `HEARTBEAT_TOOLS` set on line 476:

```typescript
const HEARTBEAT_TOOLS = new Set([
  'get_current_time', 'memory', 'search_tools', 'notify_user',
])
```

**Step 4: Add a callback for notifications**

Add a new callback property to the Agent class. Find the existing callbacks (around line 693-696, near `onSettingsChanged`, `onCalendarChanged`, etc.):

```typescript
  onNotifyUser?: (title: string, body: string) => void
```

**Step 5: Add tool handler in runLoop**

In the `runLoop` method, find the tool handler chain (the `if/else if` block starting around line 1002). Add before the final `else` (the `call_external_tool` handler):

```typescript
          } else if (block.name === 'notify_user') {
            const input = block.input as { title: string; body: string }
            this.onNotifyUser?.(input.title, input.body)
            result = 'Notification sent.'
```

**Step 6: Verify build**

Run: `cd packages/agent-core && pnpm build`
Expected: PASS

**Step 7: Commit**

```bash
git add packages/agent-core/src/agent.ts
git commit -m "feat: add notify_user tool to agent"
```

---

### Task 3: Wire `notify_user` callback in server.ts to broadcast over WS

**Files:**
- Modify: `packages/agent-core/src/server.ts`

**Step 1: Set up the onNotifyUser callback**

Find where other agent callbacks are wired up (around line 623-632, where `onSettingsChanged` and `onSkillsChanged` are set). Add:

```typescript
agent.onNotifyUser = (title: string, body: string) => {
  broadcast({ type: 'push_notification', title, body } as any)
}
```

Note: Using `as any` because `push_notification` is a new WSServerMessage type. The relay will intercept this message and handle push delivery.

**Step 2: Verify build**

Run: `cd packages/agent-core && pnpm build`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/agent-core/src/server.ts
git commit -m "feat: broadcast push_notification on notify_user tool call"
```

---

### Task 4: Update relay client to tag desktop connections

**Files:**
- Modify: `packages/agent-core/src/relay-client.ts`

**Step 1: Add `client=desktop` query param to relay WS URL**

Find the `buildWsUrl` method (around line 260-266). Update it to include the client tag:

```typescript
  private buildWsUrl(userId: string, token: string | null): string {
    const wsBase = this.relayUrl!.replace('https://', 'wss://').replace('http://', 'ws://')
    let url = `${wsBase}/ws/${userId}?client=desktop`
    if (token) url += `&token=${encodeURIComponent(token)}`
    return url
  }
```

**Step 2: Verify build**

Run: `cd packages/agent-core && pnpm build`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/agent-core/src/relay-client.ts
git commit -m "feat: tag desktop relay connections with client=desktop"
```

---

### Task 5: Update mobile to tag connections and register push token

**Files:**
- Modify: `apps/mobile/lib/useAgent.ts`
- Modify: `apps/mobile/lib/storage.ts`

**Step 1: Tag mobile WS connection**

In `apps/mobile/lib/useAgent.ts`, find the WS URL construction (line 42):

```typescript
    const wsUrl = `${base}/ws/${creds.userId}?client=mobile&token=${creds.token}`
```

**Step 2: Add push token storage helpers**

In `apps/mobile/lib/storage.ts`, add:

```typescript
const PUSH_TOKEN_KEY = 'coagent_push_token'

export async function savePushToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token)
}

export async function getPushToken(): Promise<string | null> {
  return SecureStore.getItemAsync(PUSH_TOKEN_KEY)
}
```

**Step 3: Add notification prefs storage**

```typescript
const NOTIFICATION_PREFS_KEY = 'coagent_notification_mode'

export async function saveNotificationMode(mode: string): Promise<void> {
  await SecureStore.setItemAsync(NOTIFICATION_PREFS_KEY, mode)
}

export async function getNotificationMode(): Promise<string> {
  return (await SecureStore.getItemAsync(NOTIFICATION_PREFS_KEY)) || 'away_only'
}
```

**Step 4: Commit**

```bash
git add apps/mobile/lib/useAgent.ts apps/mobile/lib/storage.ts
git commit -m "feat: tag mobile WS connections, add push token storage"
```

---

### Task 6: Install expo-notifications and register for push

**Files:**
- Modify: `apps/mobile/package.json` (via npx expo install)
- Create: `apps/mobile/lib/notifications.ts`

**Step 1: Install expo-notifications**

Run: `cd apps/mobile && npx expo install expo-notifications expo-device`

**Step 2: Create notifications module**

Create `apps/mobile/lib/notifications.ts`:

```typescript
import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'
import { Platform } from 'react-native'

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
})

export async function registerForPushNotifications(): Promise<string | null> {
  if (!Device.isDevice) {
    console.log('[Notifications] Must use physical device for push')
    return null
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync()
  let finalStatus = existingStatus

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync()
    finalStatus = status
  }

  if (finalStatus !== 'granted') {
    console.log('[Notifications] Permission not granted')
    return null
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
    })
  }

  const tokenData = await Notifications.getExpoPushTokenAsync()
  return tokenData.data
}
```

**Step 3: Commit**

```bash
git add apps/mobile/lib/notifications.ts apps/mobile/package.json pnpm-lock.yaml
git commit -m "feat: add push notification registration module"
```

---

### Task 7: Send push token to relay on WS connect

**Files:**
- Modify: `apps/mobile/lib/useAgent.ts`

**Step 1: Import and call registration on connect**

Add import at top:

```typescript
import { registerForPushNotifications } from './notifications'
```

In the `socket.onopen` handler (around line 46-49), after `setConnected(true)`, register and send the push token:

```typescript
    socket.onopen = () => {
      setConnected(true)
      reconnectDelay.current = RECONNECT_BASE
      // Register push token with relay
      registerForPushNotifications().then(pushToken => {
        if (pushToken && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'register_push_token', token: pushToken }))
        }
      })
    }
```

**Step 2: Commit**

```bash
git add apps/mobile/lib/useAgent.ts
git commit -m "feat: send push token to relay on WS connect"
```

---

### Task 8: Update relay DO to handle push tokens, prefs, and client types

**Files:**
- Modify: `relay/src/index.ts`

**Step 1: Track client types per socket**

In the `UserSession` class, add a map to track client types. Add after `private cachedChatHistory` (line 629):

```typescript
  private clientTypes = new Map<WebSocket, string>()
```

**Step 2: Parse client type on WS upgrade**

In the `fetch` method, extract the `client` query param during WebSocket upgrade (around line 652). Update the WebSocket upgrade block:

```typescript
    if (request.headers.get('Upgrade') === 'websocket') {
      const clientType = url.searchParams.get('client') || 'unknown'

      // Notify existing sockets that a new client connected
      const existing = this.state.getWebSockets()
      if (existing.length > 0) {
        const notify = JSON.stringify({ type: 'client_connected' })
        for (const s of existing) {
          try { s.send(notify) } catch { /* stale */ }
        }
      }
      const pair = new WebSocketPair()
      this.state.acceptWebSocket(pair[1])
      this.clientTypes.set(pair[1], clientType)

      // Send cached chat history directly to new client
      if (this.cachedChatHistory) {
        try { pair[1].send(this.cachedChatHistory) } catch { /* ignore */ }
      }
      // Send current notification prefs to mobile clients
      if (clientType === 'mobile') {
        const mode = (await this.state.storage.get<string>('notification_mode')) || 'away_only'
        try { pair[1].send(JSON.stringify({ type: 'notification_prefs', mode })) } catch { /* ignore */ }
      }
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
```

**Step 3: Handle push token registration and notification prefs in webSocketMessage**

In `webSocketMessage` (line 696), add handling for the new message types. Add after the chat_history caching block (after line 725), before the broadcast:

```typescript
    // Handle push token registration
    try {
      const parsed = JSON.parse(data)
      if (parsed?.type === 'register_push_token') {
        await this.state.storage.put('push_token', parsed.token)
        console.log('[UserSession] Push token registered')
        return // Don't broadcast to other clients
      }
      if (parsed?.type === 'update_notification_prefs') {
        await this.state.storage.put('notification_mode', parsed.mode)
        console.log('[UserSession] Notification prefs updated:', parsed.mode)
        return // Don't broadcast
      }
    } catch { /* non-JSON */ }
```

Note: Since the existing code already parses JSON in a try/catch for chat_history caching, merge these checks into that same block to avoid double-parsing. The final implementation should parse once and handle all cases.

**Step 4: Intercept push_notification messages and send push**

In the broadcast section of `webSocketMessage` (around line 727-733), add interception for `push_notification` type. Replace the simple broadcast with:

```typescript
    // Check for push_notification — intercept and handle push delivery
    try {
      const parsed = JSON.parse(data)
      if (parsed?.type === 'push_notification') {
        // Still broadcast to connected clients (mobile will show in-app)
        const sockets = this.state.getWebSockets()
        for (const s of sockets) {
          if (s !== ws) {
            try { s.send(data) } catch { /* stale */ }
          }
        }
        // Check if we should send a push notification
        await this.maybeSendPush(parsed.title, parsed.body)
        return
      }
    } catch { /* non-JSON, fall through to normal broadcast */ }

    // Normal broadcast to all OTHER connected sockets
    const sockets = this.state.getWebSockets()
    for (const s of sockets) {
      if (s !== ws) {
        try { s.send(data) } catch { /* stale socket, ignore */ }
      }
    }
```

**Step 5: Add the push sending method**

Add a new method to `UserSession`:

```typescript
  private async maybeSendPush(title: string, body: string): Promise<void> {
    const pushToken = await this.state.storage.get<string>('push_token')
    if (!pushToken) return // No mobile device registered

    const mode = (await this.state.storage.get<string>('notification_mode')) || 'away_only'
    if (mode === 'never') return

    if (mode === 'away_only') {
      // Check if a desktop client is connected
      const sockets = this.state.getWebSockets()
      for (const s of sockets) {
        if (this.clientTypes.get(s) === 'desktop') {
          console.log('[UserSession] Desktop connected — suppressing push')
          return
        }
      }
    }

    // Send push via Expo Push API
    try {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: pushToken,
          title,
          body,
          sound: 'default',
        }),
      })
      console.log('[UserSession] Push sent:', title)
    } catch (err) {
      console.error('[UserSession] Push failed:', err)
    }
  }
```

**Step 6: Clean up client type on disconnect**

In `webSocketClose` (line 736), add cleanup:

```typescript
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.clientTypes.delete(ws)
    ws.close(code, reason)
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    this.clientTypes.delete(ws)
    ws.close(1011, 'WebSocket error')
  }
```

**Step 7: Deploy and test**

Run: `cd relay && npx wrangler deploy`
Expected: Deployment succeeds

**Step 8: Commit**

```bash
git add relay/src/index.ts
git commit -m "feat: relay handles push tokens, prefs, and sends push notifications"
```

---

### Task 9: Add notification settings UI to mobile

**Files:**
- Modify: `apps/mobile/app/(tabs)/settings.tsx`
- Modify: `apps/mobile/lib/useAgent.ts`

**Step 1: Add notification mode state to useAgent**

In `apps/mobile/lib/useAgent.ts`, add state:

```typescript
  const [notificationMode, setNotificationMode] = useState<string>('away_only')
```

Add handler in the `socket.onmessage` switch for the new message type:

```typescript
        case 'notification_prefs':
          setNotificationMode(msg.mode)
          break
```

Add a function to update prefs:

```typescript
  const updateNotificationMode = useCallback((mode: string) => {
    setNotificationMode(mode)
    send({ type: 'update_notification_prefs', mode } as any)
  }, [])
```

Return `notificationMode` and `updateNotificationMode` from the hook.

**Step 2: Update AgentContext to include notification state**

Make sure the AgentContext provider passes `notificationMode` and `updateNotificationMode` through.

**Step 3: Add notification settings section to settings.tsx**

After the "Connection" section, add:

```typescript
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notifications</Text>

        {(['always', 'away_only', 'never'] as const).map(mode => (
          <TouchableOpacity
            key={mode}
            style={[styles.row, { borderBottomColor: colors.border }]}
            onPress={() => updateNotificationMode(mode)}
            activeOpacity={0.7}
          >
            <View style={styles.radioRow}>
              <View style={[styles.radio, notificationMode === mode && styles.radioSelected]} />
              <View>
                <Text style={[styles.radioLabel, { color: colors.text }]}>
                  {mode === 'always' ? 'Always' : mode === 'away_only' ? 'When away from desktop' : 'Never'}
                </Text>
                <Text style={[styles.radioHint, { color: colors.muted }]}>
                  {mode === 'always' ? 'Notify even when desktop is open'
                    : mode === 'away_only' ? 'Only notify when desktop is disconnected'
                    : 'Mute all push notifications'}
                </Text>
              </View>
            </View>
          </TouchableOpacity>
        ))}
      </View>
```

**Step 4: Add styles for radio buttons**

```typescript
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 4,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#d4d4d8',
  },
  radioSelected: {
    borderColor: '#18181b',
    backgroundColor: '#18181b',
  },
  radioLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
  radioHint: {
    fontSize: 12,
    marginTop: 2,
  },
```

**Step 5: Commit**

```bash
git add apps/mobile/app/(tabs)/settings.tsx apps/mobile/lib/useAgent.ts apps/mobile/lib/AgentContext.tsx
git commit -m "feat: notification settings UI with always/away_only/never modes"
```

---

### Task 10: End-to-end test

**No files to modify — manual testing.**

**Step 1: Test push token registration**

1. Open the mobile app in Expo Go on your physical phone
2. Accept the notification permission prompt
3. Check relay logs: should see "Push token registered"

**Step 2: Test "away only" mode (desktop disconnected)**

1. Stop the desktop app (kill `pnpm tauri dev`)
2. Send a chat message from mobile that would trigger the agent to use `notify_user`
3. Or trigger a scheduled task/heartbeat that calls `notify_user`
4. You should receive a push notification on your phone

**Step 3: Test "away only" mode (desktop connected)**

1. Start the desktop app
2. Trigger the same notification scenario
3. You should NOT receive a push — desktop is connected

**Step 4: Test "always" mode**

1. In mobile Settings, switch to "Always"
2. With desktop running, trigger a notification
3. You SHOULD receive a push even with desktop connected

**Step 5: Test "never" mode**

1. Switch to "Never"
2. Trigger a notification
3. No push should arrive

**Step 6: Final commit**

```bash
git add -A
git commit -m "feat: push notifications — notify_user tool, relay delivery, mobile settings"
```
