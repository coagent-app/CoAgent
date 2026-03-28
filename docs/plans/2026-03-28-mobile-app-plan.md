# CoAgent Mobile App Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an iOS Expo app that connects to the CoAgent agent through the Cloudflare relay, providing chat and hands-free voice interaction.

**Architecture:** Thin React Native client in `apps/mobile/` connecting via WebSocket to the existing relay Durable Object at `/client/:userId`. All agent logic stays on the Mac. QR code pairing for onboarding. Three screens: chat, voice, settings.

**Tech Stack:** Expo SDK 52+, React Native, TypeScript, `@coagent/shared` types, Expo SecureStore, Expo Camera, Expo AV, `qrcode` npm package (desktop side)

---

### Task 1: Relay DO — Notify Agent on Client Connect

The relay DO currently does NOT send any initial state when a client connects. The agent server sends state dumps on local WS connections, but the relay has no way to trigger that for remote clients. We need the relay to tell the agent "a new client just connected" so the agent re-sends the full state.

**Files:**
- Modify: `relay/src/relay-do.ts:129-162` (handleClientUpgrade)
- Modify: `packages/agent-core/src/server.ts` (add handler for `client_connected`)
- Modify: `packages/shared/src/index.ts` (add message type)

**Step 1: Add `client_connected` to shared types**

In `packages/shared/src/index.ts`, add to `WSClientMessage` union:

```typescript
| { type: 'client_connected' }
```

**Step 2: Relay DO sends notification on client connect**

In `relay/src/relay-do.ts`, inside `handleClientUpgrade()`, after `this.clientSockets.add(server)` (around line 146), add:

```typescript
// Tell agent a new client connected so it sends full state
this.forwardToAgent(JSON.stringify({ type: 'client_connected' }))
```

**Step 3: Agent server handles `client_connected`**

In `packages/agent-core/src/server.ts`, find the WebSocket message handler switch/if block. Add a handler for `client_connected` that re-broadcasts the full state dump. Find the existing code that sends initial state on local WS connection (the block that sends `queue_update`, `done_update`, `chat_history`, `integrations_update`, `settings_update`, `files_update`, `folders_update`, `calendar_update`, `relay_status`, `skills_update`). Extract that into a helper function `broadcastFullState(ws)` and call it both on local connect AND when `client_connected` is received.

The key difference: on `client_connected`, the state should be broadcast to ALL connected clients (since the relay will forward it), so use the existing `broadcast()` helper rather than sending to a specific socket.

**Step 4: Test manually**

```bash
# Deploy relay
cd relay && npx wrangler deploy

# Restart agent
pnpm tauri dev

# Connect a test client via wscat
npx wscat -c "wss://{RELAY_URL}/client/{userId}?token={token}"
# Should immediately receive state dump messages
```

**Step 5: Commit**

```bash
git add relay/src/relay-do.ts packages/agent-core/src/server.ts packages/shared/src/index.ts
git commit -m "feat: relay notifies agent on client connect for state dump"
```

---

### Task 2: Scaffold Expo App

**Files:**
- Create: `apps/mobile/` (Expo project)
- Modify: `pnpm-workspace.yaml` (add mobile to workspace)

**Step 1: Create Expo project**

```bash
cd apps
npx create-expo-app@latest mobile --template blank-typescript
cd mobile
```

**Step 2: Install dependencies**

```bash
npx expo install expo-secure-store expo-camera expo-av expo-linking expo-router react-native-safe-area-context react-native-screens
```

**Step 3: Add to pnpm workspace**

In `pnpm-workspace.yaml`, ensure `apps/mobile` is covered by the existing `apps/*` glob. If not, add it.

**Step 4: Link shared types**

In `apps/mobile/package.json`, add:

```json
{
  "dependencies": {
    "@coagent/shared": "workspace:*"
  }
}
```

Then run `pnpm install` from the root.

**Step 5: Verify it runs**

```bash
cd apps/mobile
npx expo start --ios
```

Expected: Expo dev client opens in iOS simulator with blank screen.

**Step 6: Set up app structure**

Create the file structure:

```
apps/mobile/
  app/
    _layout.tsx        # Root layout with tab navigator
    (tabs)/
      _layout.tsx      # Tab bar config (chat, voice, settings)
      index.tsx        # Chat screen
      voice.tsx        # Voice screen
      settings.tsx     # Settings screen
  lib/
    useAgent.ts        # WebSocket hook (ported from desktop)
    voice.ts           # Audio recording + TTS playback
    storage.ts         # SecureStore wrapper for credentials
  components/
    MessageBubble.tsx  # Chat message component
    VoiceOrb.tsx       # Voice session visual indicator
```

Create each file with minimal placeholder content (e.g., `export default function ChatScreen() { return <Text>Chat</Text> }`).

**Step 7: Commit**

```bash
git add apps/mobile pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat: scaffold Expo mobile app with tab navigation"
```

---

### Task 3: Credential Storage & QR Scanning

**Files:**
- Create: `apps/mobile/lib/storage.ts`
- Create: `apps/mobile/app/scan.tsx` (QR scan screen)
- Modify: `apps/mobile/app/_layout.tsx` (route to scan if no credentials)

**Step 1: Implement storage module**

Create `apps/mobile/lib/storage.ts`:

```typescript
import * as SecureStore from 'expo-secure-store'

export interface RelayCredentials {
  relayUrl: string
  token: string
  userId: string
}

const KEY = 'coagent_relay_credentials'

export async function getCredentials(): Promise<RelayCredentials | null> {
  const raw = await SecureStore.getItemAsync(KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as RelayCredentials
  } catch {
    return null
  }
}

export async function saveCredentials(creds: RelayCredentials): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(creds))
}

export async function clearCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY)
}
```

**Step 2: Implement QR scan screen**

Create `apps/mobile/app/scan.tsx`:

```typescript
import { useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useRouter } from 'expo-router'
import { saveCredentials } from '../lib/storage'

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions()
  const [scanned, setScanned] = useState(false)
  const router = useRouter()

  async function handleBarCodeScanned({ data }: { data: string }) {
    if (scanned) return
    setScanned(true)

    try {
      // Parse URL params: coagent.app/pair?token=xxx&relay=yyy&userId=zzz
      const url = new URL(data)
      const token = url.searchParams.get('token')
      const relayUrl = url.searchParams.get('relay')
      const userId = url.searchParams.get('userId')

      if (!token || !relayUrl || !userId) {
        setScanned(false)
        return
      }

      await saveCredentials({ token, relayUrl, userId })
      router.replace('/(tabs)')
    } catch {
      setScanned(false)
    }
  }

  if (!permission?.granted) {
    return (
      <View style={styles.container}>
        <Text style={styles.text}>Camera permission needed to scan QR code</Text>
        <Text style={styles.link} onPress={requestPermission}>Grant Permission</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFillObject}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={handleBarCodeScanned}
      />
      <View style={styles.overlay}>
        <Text style={styles.text}>Scan QR code from CoAgent desktop</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  overlay: { position: 'absolute', bottom: 100, left: 0, right: 0, alignItems: 'center' },
  text: { color: '#fff', fontSize: 16, textAlign: 'center', padding: 20 },
  link: { color: '#60a5fa', fontSize: 16, marginTop: 12 },
})
```

**Step 3: Root layout routes to scan if no credentials**

In `apps/mobile/app/_layout.tsx`:

```typescript
import { useEffect, useState } from 'react'
import { Stack, useRouter, useSegments } from 'expo-router'
import { getCredentials } from '../lib/storage'

export default function RootLayout() {
  const [ready, setReady] = useState(false)
  const [hasCreds, setHasCreds] = useState(false)
  const router = useRouter()
  const segments = useSegments()

  useEffect(() => {
    getCredentials().then(creds => {
      setHasCreds(!!creds)
      setReady(true)
    })
  }, [])

  useEffect(() => {
    if (!ready) return
    const onScanPage = segments[0] === 'scan'
    if (!hasCreds && !onScanPage) router.replace('/scan')
    if (hasCreds && onScanPage) router.replace('/(tabs)')
  }, [ready, hasCreds, segments])

  if (!ready) return null

  return <Stack screenOptions={{ headerShown: false }} />
}
```

**Step 4: Test in simulator**

```bash
npx expo start --ios
```

Expected: App opens to QR scan screen (or permission prompt).

**Step 5: Commit**

```bash
git add apps/mobile/lib/storage.ts apps/mobile/app/scan.tsx apps/mobile/app/_layout.tsx
git commit -m "feat: QR code scanning and credential storage"
```

---

### Task 4: Desktop — Pair Mobile QR Code

**Files:**
- Modify: `apps/desktop/src/components/SettingsPane.tsx` (add Pair Mobile button + QR)
- Install: `qrcode` npm package in desktop app

**Step 1: Install qrcode package**

```bash
cd apps/desktop
pnpm add qrcode @types/qrcode
```

**Step 2: Add Pair Mobile section to SettingsPane GeneralTab**

In `apps/desktop/src/components/SettingsPane.tsx`, inside the `GeneralTab` component, add a "Pair Mobile" section at the bottom. This reads the relay credentials from settings/relay state and generates a QR code:

```typescript
import QRCode from 'qrcode'

// Inside GeneralTab component, add state:
const [mobileQr, setMobileQr] = useState<string | null>(null)

async function generateMobileQr() {
  // relayUrl and token come from the parent component's relay props
  // For now, read from environment or settings
  const relayUrl = process.env.RELAY_URL || ''
  const token = process.env.RELAY_TOKEN || ''
  const userId = 'default' // or from settings
  if (!relayUrl || !token) return

  const pairUrl = `https://coagent.app/pair?token=${encodeURIComponent(token)}&relay=${encodeURIComponent(relayUrl)}&userId=${encodeURIComponent(userId)}`
  const dataUrl = await QRCode.toDataURL(pairUrl, { width: 200, margin: 2 })
  setMobileQr(dataUrl)
}
```

Add to the GeneralTab JSX, after the existing sections:

```tsx
<div className="pt-6 border-t border-neutral-200 dark:border-neutral-800">
  <h3 className="text-[13px] font-semibold mb-3">Mobile App</h3>
  {mobileQr ? (
    <div className="flex flex-col items-center gap-3">
      <img src={mobileQr} alt="Pair Mobile QR" className="w-48 h-48 rounded-lg" />
      <p className="text-[11px] text-neutral-400 text-center">
        Scan with your iPhone camera to connect CoAgent mobile
      </p>
      <button onClick={() => setMobileQr(null)} className="text-[11px] text-neutral-400 hover:text-neutral-600">
        Hide
      </button>
    </div>
  ) : (
    <button onClick={generateMobileQr} className="text-[12.5px] text-blue-500 hover:text-blue-400">
      Show QR Code to Pair Phone
    </button>
  )}
</div>
```

Note: The relay credentials need to be accessible here. The `SettingsPane` already receives `relayActive` and relay props from App.tsx. You may need to thread the actual `RELAY_URL` and `RELAY_TOKEN` through — either read from the server via a new WS message, or pass them as props. The simplest approach: add a `get_relay_credentials` WS message that returns `{ relayUrl, token, userId }` from the server (which reads `~/.coagent/.env`).

**Step 3: Test**

1. Open desktop app → Settings → General tab
2. Click "Show QR Code to Pair Phone"
3. QR code should appear with the pair URL encoded

**Step 4: Commit**

```bash
git add apps/desktop/src/components/SettingsPane.tsx apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat: pair mobile QR code in desktop settings"
```

---

### Task 5: Mobile useAgent Hook

Port the desktop `useAgent` hook to connect through the relay instead of localhost.

**Files:**
- Create: `apps/mobile/lib/useAgent.ts`
- Reference: `apps/desktop/src/hooks/useAgent.ts`

**Step 1: Create the mobile useAgent hook**

Create `apps/mobile/lib/useAgent.ts`. This is a simplified port of the desktop hook:

```typescript
import { useState, useEffect, useRef, useCallback } from 'react'
import { AppState } from 'react-native'
import type {
  AgentMessage, AgentSettings, ApprovalItem, CalendarEntry,
  WSClientMessage, WSServerMessage
} from '@coagent/shared'
import { getCredentials } from './storage'

const RECONNECT_BASE = 500
const RECONNECT_MAX = 10000

export function useAgent() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectDelay = useRef(RECONNECT_BASE)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unmountedRef = useRef(false)

  const [connected, setConnected] = useState(false)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [thinking, setThinking] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [toolLabel, setToolLabel] = useState<string | null>(null)
  const [settings, setSettings] = useState<AgentSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Voice TTS state
  const [ttsPlaying, setTtsPlaying] = useState(false)

  function send(msg: WSClientMessage) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }

  const connect = useCallback(async () => {
    if (unmountedRef.current) return
    const creds = await getCredentials()
    if (!creds) return

    const wsUrl = `${creds.relayUrl.replace(/^http/, 'ws')}/client/${creds.userId}?token=${creds.token}`
    const socket = new WebSocket(wsUrl)

    socket.onopen = () => {
      setConnected(true)
      reconnectDelay.current = RECONNECT_BASE
    }

    socket.onclose = () => {
      setConnected(false)
      if (wsRef.current === socket) wsRef.current = null
      if (!unmountedRef.current) {
        reconnectTimer.current = setTimeout(() => {
          reconnectDelay.current = Math.min(reconnectDelay.current * 1.5, RECONNECT_MAX)
          connect()
        }, reconnectDelay.current)
      }
    }

    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data) as WSServerMessage
      switch (msg.type) {
        case 'chat_history':
          setMessages(msg.messages)
          break
        case 'chat_chunk':
          setStreamingText(prev => (prev ?? '') + msg.text)
          setThinking(false)
          break
        case 'chat_segment_end':
          setStreamingText(prev => {
            if (prev) setMessages(msgs => [...msgs, { role: 'assistant', content: prev, timestamp: new Date().toISOString() }])
            return null
          })
          break
        case 'chat_response':
          setMessages(msgs => [...msgs, msg.message])
          setStreamingText(null)
          setProcessing(false)
          setToolLabel(null)
          break
        case 'agent_thinking':
          setThinking(true)
          break
        case 'tool_start':
          setToolLabel(msg.label)
          setThinking(false)
          break
        case 'tool_end':
          setToolLabel(null)
          break
        case 'settings_update':
          setSettings(msg.settings)
          break
        case 'error':
          setError(msg.message)
          setTimeout(() => setError(null), 5000)
          break
        case 'voice_tts_chunk':
          setTtsPlaying(true)
          // Forward to voice module for audio playback
          globalThis.__ttsChunkHandler?.(msg.data, msg.seq)
          break
        case 'voice_tts_done':
          globalThis.__ttsDoneHandler?.()
          break
        case 'voice_transcribed':
          // Show user's transcribed voice input as a message
          setMessages(msgs => [...msgs, { role: 'user', content: msg.text, timestamp: new Date().toISOString() }])
          break
        case 'agent_stopped':
          setProcessing(false)
          setStreamingText(null)
          setToolLabel(null)
          setThinking(false)
          break
      }
    }

    wsRef.current = socket
  }, [])

  useEffect(() => {
    connect()

    // Reconnect when app comes to foreground
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !wsRef.current) connect()
    })

    return () => {
      unmountedRef.current = true
      sub.remove()
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  const chat = useCallback((message: string) => {
    setMessages(msgs => [...msgs, { role: 'user', content: message, timestamp: new Date().toISOString() }])
    setProcessing(true)
    send({ type: 'chat', message })
  }, [])

  const sendVoiceAudio = useCallback((base64: string) => {
    setProcessing(true)
    send({ type: 'voice_audio', data: base64 })
  }, [])

  const stopAgent = useCallback(() => {
    send({ type: 'stop_agent' })
  }, [])

  return {
    connected, messages, streamingText, thinking, processing,
    toolLabel, settings, error, ttsPlaying,
    chat, sendVoiceAudio, stopAgent,
  }
}
```

**Step 2: Test connection**

With the relay deployed (Task 1) and credentials saved (Task 3), the hook should connect and receive the state dump. Test by rendering connection status on the chat screen.

**Step 3: Commit**

```bash
git add apps/mobile/lib/useAgent.ts
git commit -m "feat: mobile useAgent hook connecting through relay"
```

---

### Task 6: Chat Screen

**Files:**
- Create: `apps/mobile/components/MessageBubble.tsx`
- Modify: `apps/mobile/app/(tabs)/index.tsx`

**Step 1: Create MessageBubble component**

Create `apps/mobile/components/MessageBubble.tsx`:

```typescript
import { View, Text, StyleSheet } from 'react-native'
import type { AgentMessage } from '@coagent/shared'

export function MessageBubble({ message }: { message: AgentMessage }) {
  const isUser = message.role === 'user'

  return (
    <View style={[styles.row, isUser && styles.rowUser]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAgent]}>
        <Text style={[styles.text, isUser && styles.textUser]}>
          {message.content}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 16, paddingVertical: 4, flexDirection: 'row' },
  rowUser: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '80%', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18 },
  bubbleUser: { backgroundColor: '#3b82f6', borderBottomRightRadius: 4 },
  bubbleAgent: { backgroundColor: '#f3f4f6', borderBottomLeftRadius: 4 },
  text: { fontSize: 15, lineHeight: 20, color: '#1f2937' },
  textUser: { color: '#ffffff' },
})
```

**Step 2: Build chat screen**

In `apps/mobile/app/(tabs)/index.tsx`:

```typescript
import { useState, useRef } from 'react'
import {
  View, Text, TextInput, FlatList, KeyboardAvoidingView,
  Platform, TouchableOpacity, StyleSheet, ActivityIndicator
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { MessageBubble } from '../../components/MessageBubble'
import { useAgent } from '../../lib/useAgent'

export default function ChatScreen() {
  const { connected, messages, streamingText, thinking, processing, toolLabel, chat } = useAgent()
  const [input, setInput] = useState('')
  const flatListRef = useRef<FlatList>(null)
  const insets = useSafeAreaInsets()

  function handleSend() {
    const text = input.trim()
    if (!text || processing) return
    chat(text)
    setInput('')
  }

  // Combine messages with streaming text for display
  const displayMessages = [...messages]
  if (streamingText) {
    displayMessages.push({
      role: 'assistant',
      content: streamingText,
      timestamp: new Date().toISOString(),
    })
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Connection banner */}
      {!connected && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>Connecting to agent...</Text>
        </View>
      )}

      {/* Messages */}
      <FlatList
        ref={flatListRef}
        data={displayMessages}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => <MessageBubble message={item} />}
        contentContainerStyle={{ paddingTop: insets.top + 60, paddingBottom: 8 }}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
      />

      {/* Thinking / tool indicator */}
      {(thinking || toolLabel) && (
        <View style={styles.indicator}>
          <ActivityIndicator size="small" color="#9ca3af" />
          <Text style={styles.indicatorText}>
            {toolLabel || 'Thinking...'}
          </Text>
        </View>
      )}

      {/* Input bar */}
      <View style={[styles.inputBar, { paddingBottom: insets.bottom + 8 }]}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Message your agent..."
          placeholderTextColor="#9ca3af"
          multiline
          maxLength={4000}
          returnKeyType="send"
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
        />
        <TouchableOpacity
          style={[styles.sendButton, (!input.trim() || processing) && styles.sendDisabled]}
          onPress={handleSend}
          disabled={!input.trim() || processing}
        >
          <Text style={styles.sendText}>↑</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  banner: { position: 'absolute', top: 50, left: 0, right: 0, zIndex: 10, alignItems: 'center' },
  bannerText: { backgroundColor: '#fef3c7', color: '#92400e', fontSize: 12, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, overflow: 'hidden' },
  indicator: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 6 },
  indicatorText: { color: '#9ca3af', fontSize: 13 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#e5e7eb', backgroundColor: '#ffffff' },
  input: { flex: 1, fontSize: 15, maxHeight: 100, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: '#f3f4f6', borderRadius: 20, color: '#1f2937' },
  sendButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#3b82f6', justifyContent: 'center', alignItems: 'center', marginLeft: 8, marginBottom: 2 },
  sendDisabled: { backgroundColor: '#d1d5db' },
  sendText: { color: '#fff', fontSize: 18, fontWeight: '700' },
})
```

**Step 3: Test**

```bash
npx expo start --ios
```

Expected: Chat screen shows messages, can type and send, streaming text renders live, thinking indicator shows.

**Step 4: Commit**

```bash
git add apps/mobile/components/MessageBubble.tsx apps/mobile/app/\(tabs\)/index.tsx
git commit -m "feat: mobile chat screen with streaming messages"
```

---

### Task 7: Voice Module

Port audio recording and TTS playback to React Native using Expo AV.

**Files:**
- Create: `apps/mobile/lib/voice.ts`

**Step 1: Implement voice module**

Create `apps/mobile/lib/voice.ts`:

```typescript
import { Audio } from 'expo-av'

let recording: Audio.Recording | null = null
let ttsSound: Audio.Sound | null = null
let ttsChunks: Uint8Array[] = []

// --- Recording ---

export async function startRecording(): Promise<void> {
  await Audio.requestPermissionsAsync()
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
  })

  const { recording: rec } = await Audio.Recording.createAsync(
    Audio.RecordingOptionsPresets.HIGH_QUALITY
  )
  recording = rec
}

export async function stopRecordingAndGetBase64(): Promise<string | null> {
  if (!recording) return null

  await recording.stopAndUnloadAsync()
  await Audio.setAudioModeAsync({ allowsRecordingIOS: false })

  const uri = recording.getURI()
  recording = null
  if (!uri) return null

  // Read file as base64
  const response = await fetch(uri)
  const blob = await response.blob()

  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const dataUrl = reader.result as string
      const base64 = dataUrl.split(',')[1] ?? ''
      resolve(base64 || null)
    }
    reader.readAsDataURL(blob)
  })
}

export function cancelRecording() {
  if (recording) {
    recording.stopAndUnloadAsync().catch(() => {})
    recording = null
  }
}

// --- TTS Playback ---

export async function handleTtsChunk(base64Chunk: string, seq: number) {
  const bytes = Uint8Array.from(atob(base64Chunk), c => c.charCodeAt(0))
  ttsChunks.push(bytes)

  // Play on first chunk
  if (seq === 0) {
    await playTtsFromChunks()
  }
}

export async function handleTtsDone() {
  // Reconstruct full audio and play seamlessly
  if (ttsChunks.length === 0) return
  await playTtsFromChunks()
  ttsChunks = []
}

async function playTtsFromChunks() {
  // Stop existing playback
  if (ttsSound) {
    await ttsSound.unloadAsync().catch(() => {})
    ttsSound = null
  }

  // Combine all chunks into one blob
  const totalLength = ttsChunks.reduce((sum, c) => sum + c.length, 0)
  const combined = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of ttsChunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }

  // Create data URI and play
  const base64 = btoa(String.fromCharCode(...combined))
  const uri = `data:audio/ogg;base64,${base64}`

  const { sound } = await Audio.Sound.createAsync({ uri })
  ttsSound = sound
  await sound.playAsync()
}

export async function stopTts() {
  if (ttsSound) {
    await ttsSound.stopAsync().catch(() => {})
    await ttsSound.unloadAsync().catch(() => {})
    ttsSound = null
  }
  ttsChunks = []
}

// --- Wire up global handlers for useAgent hook ---

export function registerTtsHandlers() {
  ;(globalThis as any).__ttsChunkHandler = handleTtsChunk
  ;(globalThis as any).__ttsDoneHandler = handleTtsDone
}

export function unregisterTtsHandlers() {
  delete (globalThis as any).__ttsChunkHandler
  delete (globalThis as any).__ttsDoneHandler
}
```

**Step 2: Commit**

```bash
git add apps/mobile/lib/voice.ts
git commit -m "feat: mobile voice recording and TTS playback module"
```

---

### Task 8: Voice Screen

**Files:**
- Create: `apps/mobile/components/VoiceOrb.tsx`
- Modify: `apps/mobile/app/(tabs)/voice.tsx`

**Step 1: Create VoiceOrb visual component**

Create `apps/mobile/components/VoiceOrb.tsx`:

```typescript
import { useEffect, useRef } from 'react'
import { View, Animated, StyleSheet } from 'react-native'

type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking'

export function VoiceOrb({ state }: { state: VoiceState }) {
  const pulse = useRef(new Animated.Value(1)).current

  useEffect(() => {
    if (state === 'listening' || state === 'speaking') {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1.15, duration: 600, useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
        ])
      )
      anim.start()
      return () => anim.stop()
    } else {
      pulse.setValue(1)
    }
  }, [state])

  const color =
    state === 'listening' ? '#3b82f6' :
    state === 'thinking' ? '#f59e0b' :
    state === 'speaking' ? '#10b981' :
    '#d1d5db'

  return (
    <Animated.View style={[styles.orb, { backgroundColor: color, transform: [{ scale: pulse }] }]}>
      <View style={[styles.inner, { backgroundColor: color }]} />
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  orb: { width: 140, height: 140, borderRadius: 70, justifyContent: 'center', alignItems: 'center', opacity: 0.9 },
  inner: { width: 100, height: 100, borderRadius: 50, opacity: 0.6 },
})
```

**Step 2: Build voice screen**

In `apps/mobile/app/(tabs)/voice.tsx`:

```typescript
import { useState, useEffect, useCallback } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { VoiceOrb } from '../../components/VoiceOrb'
import { useAgent } from '../../lib/useAgent'
import {
  startRecording, stopRecordingAndGetBase64, cancelRecording,
  stopTts, registerTtsHandlers, unregisterTtsHandlers
} from '../../lib/voice'

type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking'

export default function VoiceScreen() {
  const { connected, sendVoiceAudio, processing, ttsPlaying, streamingText } = useAgent()
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [sessionActive, setSessionActive] = useState(false)
  const insets = useSafeAreaInsets()

  useEffect(() => {
    registerTtsHandlers()
    return () => {
      unregisterTtsHandlers()
      cancelRecording()
      stopTts()
    }
  }, [])

  // State machine: track what the agent is doing
  useEffect(() => {
    if (!sessionActive) {
      setVoiceState('idle')
      return
    }
    if (ttsPlaying) {
      setVoiceState('speaking')
    } else if (processing || streamingText) {
      setVoiceState('thinking')
    } else if (sessionActive) {
      // Agent done responding, resume listening
      startListening()
    }
  }, [sessionActive, processing, ttsPlaying, streamingText])

  async function startListening() {
    setVoiceState('listening')
    await startRecording()

    // VAD: stop after 2 seconds of silence
    // (simplified — in production, use audio level analysis)
    // For now, record for up to 30 seconds then auto-send
    setTimeout(async () => {
      if (voiceState === 'listening') {
        await sendAudio()
      }
    }, 30000)
  }

  async function sendAudio() {
    const base64 = await stopRecordingAndGetBase64()
    if (base64) {
      setVoiceState('thinking')
      sendVoiceAudio(base64)
    } else {
      // No audio captured, resume listening
      if (sessionActive) startListening()
    }
  }

  const toggleSession = useCallback(async () => {
    if (sessionActive) {
      // End session
      setSessionActive(false)
      cancelRecording()
      await stopTts()
      setVoiceState('idle')
    } else {
      // Start session
      setSessionActive(true)
      await startListening()
    }
  }, [sessionActive])

  // Manual "I'm done talking" tap while listening
  const handleTapWhileListening = useCallback(async () => {
    if (voiceState === 'listening') {
      await sendAudio()
    }
  }, [voiceState])

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {!connected && (
        <Text style={styles.offline}>Agent offline</Text>
      )}

      <View style={styles.orbContainer}>
        <TouchableOpacity
          onPress={voiceState === 'listening' ? handleTapWhileListening : undefined}
          activeOpacity={0.8}
        >
          <VoiceOrb state={voiceState} />
        </TouchableOpacity>

        <Text style={styles.stateLabel}>
          {voiceState === 'idle' && 'Tap to start'}
          {voiceState === 'listening' && 'Listening... tap when done'}
          {voiceState === 'thinking' && 'Thinking...'}
          {voiceState === 'speaking' && 'Speaking...'}
        </Text>
      </View>

      <TouchableOpacity
        style={[styles.button, sessionActive && styles.buttonActive]}
        onPress={toggleSession}
        disabled={!connected}
      >
        <Text style={styles.buttonText}>
          {sessionActive ? 'End Session' : 'Start Voice Session'}
        </Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', justifyContent: 'space-between', alignItems: 'center', padding: 24 },
  offline: { color: '#f59e0b', fontSize: 13, marginTop: 8 },
  orbContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 24 },
  stateLabel: { color: '#9ca3af', fontSize: 15 },
  button: { width: '100%', paddingVertical: 16, borderRadius: 16, backgroundColor: '#3b82f6', alignItems: 'center' },
  buttonActive: { backgroundColor: '#ef4444' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
})
```

Note: The VAD (voice activity detection) is simplified here. A production implementation would use `expo-av`'s audio metering or a native VAD library to detect silence and auto-send. For v1, the user taps the orb when they're done speaking, and the session auto-resumes listening after the agent responds.

**Step 3: Test**

```bash
npx expo start --ios
```

Expected: Voice tab shows orb, tap "Start Voice Session" → orb turns blue (listening), tap orb → sends audio → orb turns yellow (thinking) → agent responds with TTS → orb turns green (speaking) → resumes listening.

**Step 4: Commit**

```bash
git add apps/mobile/components/VoiceOrb.tsx apps/mobile/app/\(tabs\)/voice.tsx
git commit -m "feat: mobile voice screen with session mode and TTS"
```

---

### Task 9: Settings Screen

**Files:**
- Modify: `apps/mobile/app/(tabs)/settings.tsx`

**Step 1: Build settings screen**

In `apps/mobile/app/(tabs)/settings.tsx`:

```typescript
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useAgent } from '../../lib/useAgent'
import { clearCredentials, getCredentials } from '../../lib/storage'
import { useState, useEffect } from 'react'

export default function SettingsScreen() {
  const { connected } = useAgent()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const [relayUrl, setRelayUrl] = useState<string>('')

  useEffect(() => {
    getCredentials().then(creds => {
      if (creds) setRelayUrl(creds.relayUrl)
    })
  }, [])

  function handleUnpair() {
    Alert.alert(
      'Unpair Device',
      'This will disconnect the app from your agent. You can re-pair by scanning the QR code again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unpair',
          style: 'destructive',
          onPress: async () => {
            await clearCredentials()
            router.replace('/scan')
          },
        },
      ]
    )
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + 16 }]}>
      <Text style={styles.title}>Settings</Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Connection</Text>
        <View style={styles.row}>
          <Text style={styles.label}>Status</Text>
          <View style={[styles.dot, connected ? styles.dotGreen : styles.dotRed]} />
          <Text style={styles.value}>{connected ? 'Connected' : 'Offline'}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Relay</Text>
          <Text style={styles.value} numberOfLines={1}>{relayUrl}</Text>
        </View>
      </View>

      <View style={styles.section}>
        <TouchableOpacity style={styles.rePairButton} onPress={() => router.push('/scan')}>
          <Text style={styles.rePairText}>Re-scan QR Code</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.unpairButton} onPress={handleUnpair}>
          <Text style={styles.unpairText}>Unpair Device</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff', paddingHorizontal: 20 },
  title: { fontSize: 28, fontWeight: '700', color: '#1f2937', marginBottom: 24 },
  section: { marginBottom: 32 },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  label: { fontSize: 15, color: '#6b7280', width: 60 },
  value: { fontSize: 15, color: '#1f2937', flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotGreen: { backgroundColor: '#22c55e' },
  dotRed: { backgroundColor: '#ef4444' },
  rePairButton: { paddingVertical: 14, borderRadius: 12, backgroundColor: '#f3f4f6', alignItems: 'center', marginBottom: 12 },
  rePairText: { fontSize: 15, color: '#3b82f6', fontWeight: '500' },
  unpairButton: { paddingVertical: 14, borderRadius: 12, backgroundColor: '#fef2f2', alignItems: 'center' },
  unpairText: { fontSize: 15, color: '#ef4444', fontWeight: '500' },
})
```

**Step 2: Test**

```bash
npx expo start --ios
```

Expected: Settings tab shows connection status, relay URL, re-pair and unpair buttons. Unpair clears credentials and returns to scan screen.

**Step 3: Commit**

```bash
git add apps/mobile/app/\(tabs\)/settings.tsx
git commit -m "feat: mobile settings screen with connection status and unpair"
```

---

### Task 10: Tab Navigation

**Files:**
- Modify: `apps/mobile/app/(tabs)/_layout.tsx`

**Step 1: Configure tab bar**

In `apps/mobile/app/(tabs)/_layout.tsx`:

```typescript
import { Tabs } from 'expo-router'
import { Platform } from 'react-native'

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#ffffff',
          borderTopColor: '#e5e7eb',
          paddingBottom: Platform.OS === 'ios' ? 0 : 8,
        },
        tabBarActiveTintColor: '#3b82f6',
        tabBarInactiveTintColor: '#9ca3af',
        tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Chat',
          tabBarIcon: ({ color }) => <TabIcon name="chat" color={color} />,
        }}
      />
      <Tabs.Screen
        name="voice"
        options={{
          title: 'Voice',
          tabBarIcon: ({ color }) => <TabIcon name="mic" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <TabIcon name="settings" color={color} />,
        }}
      />
    </Tabs>
  )
}

// Simple text-based icons (replace with @expo/vector-icons if desired)
function TabIcon({ name, color }: { name: string; color: string }) {
  const icons: Record<string, string> = {
    chat: '💬',
    mic: '🎙',
    settings: '⚙',
  }
  return (
    <span style={{ fontSize: 20, color }}>{icons[name] || '•'}</span>
  )
}
```

Note: For production, swap the emoji icons for `@expo/vector-icons` (Ionicons or SF Symbols). Keep emoji for v1 to avoid extra dependencies.

**Step 2: Test full app**

```bash
npx expo start --ios
```

Expected: Three tabs at bottom — Chat, Voice, Settings. All screens functional.

**Step 3: Commit**

```bash
git add apps/mobile/app/\(tabs\)/_layout.tsx
git commit -m "feat: mobile tab navigation with chat, voice, settings"
```

---

### Task 11: Universal Link Handling

For the QR code deep link to work (app installed → opens app directly), configure Expo linking.

**Files:**
- Modify: `apps/mobile/app.json` (or `app.config.ts`)

**Step 1: Configure linking**

In `apps/mobile/app.json`, add:

```json
{
  "expo": {
    "scheme": "coagent",
    "plugins": [
      ["expo-camera", { "cameraPermission": "Camera is used to scan QR codes for pairing" }],
      ["expo-av", { "microphonePermission": "Microphone is used for voice conversations with your agent" }]
    ],
    "ios": {
      "bundleIdentifier": "com.coagent.mobile",
      "associatedDomains": ["applinks:coagent.app"]
    }
  }
}
```

**Step 2: Handle incoming links**

In `apps/mobile/app/_layout.tsx`, add link handling:

```typescript
import * as Linking from 'expo-linking'

// Inside RootLayout, add:
useEffect(() => {
  async function handleUrl(url: string) {
    try {
      const parsed = new URL(url)
      const token = parsed.searchParams.get('token')
      const relayUrl = parsed.searchParams.get('relay')
      const userId = parsed.searchParams.get('userId')
      if (token && relayUrl && userId) {
        await saveCredentials({ token, relayUrl, userId })
        setHasCreds(true)
      }
    } catch {}
  }

  // Handle cold start
  Linking.getInitialURL().then(url => { if (url) handleUrl(url) })

  // Handle warm start
  const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url))
  return () => sub.remove()
}, [])
```

**Step 3: Commit**

```bash
git add apps/mobile/app.json apps/mobile/app/_layout.tsx
git commit -m "feat: universal link handling for QR code pairing"
```
