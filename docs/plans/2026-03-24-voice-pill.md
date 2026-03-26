# Voice Pill Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Global push-to-talk hotkey that shows a floating pill at bottom-center of screen, transcribes speech, sends to agent, and shows a one-line summary.

**Architecture:** Register a global shortcut via tauri-plugin-global-shortcut. On keydown, show a second Tauri window (transparent, frameless, always-on-top) and record audio via MediaRecorder API. On keyup, send audio to OpenAI Whisper for transcription, pipe text to agent via WebSocket, show summary in pill, optionally speak it back via TTS. The pill window is a separate Vite entry point with its own React root.

**Tech Stack:** tauri-plugin-global-shortcut, Tauri multi-window, MediaRecorder API, OpenAI Whisper API, OpenAI TTS API (optional), WebSocket

---

### Task 1: Add voice settings to shared types + settings

**Files:**
- Modify: `packages/shared/src/index.ts` (AgentSettings interface)
- Modify: `packages/agent-core/src/settings.ts` (defaults, read/write)

**Step 1: Add voice fields to AgentSettings**

In `packages/shared/src/index.ts`, add to `AgentSettings`:
```typescript
voice_enabled: boolean        // global toggle for voice pill
voice_response: boolean       // TTS read-back of summary
voice_hotkey: string          // shortcut string e.g. "Control+Fn"
```

**Step 2: Add defaults and persistence in settings.ts**

In `packages/agent-core/src/settings.ts`, add to `DEFAULT_SETTINGS`:
```typescript
voice_enabled: false,
voice_response: false,
voice_hotkey: 'Control+Space',
```

Add to `readSettings()` parsed return and `writeSettings()` updated object.

**Step 3: Rebuild shared package**

Run: `cd packages/shared && npx tsc`

**Step 4: Commit**

```bash
git add packages/shared/src/index.ts packages/agent-core/src/settings.ts
git commit -m "feat: add voice settings to AgentSettings"
```

---

### Task 2: Add voice settings UI in SettingsPane

**Files:**
- Modify: `apps/desktop/src/components/SettingsPane.tsx`

**Step 1: Add Voice section to GeneralTab**

After the Autonomy section, add a new section:

```tsx
<Separator className="my-6 dark:bg-neutral-800" />

<SectionHeader eyebrow="Voice" title="Push-to-talk" />
<FieldRow label="Enable voice input">
  <div className="flex items-center gap-3">
    <button
      type="button"
      onClick={() => onUpdate({ voice_enabled: !s.voice_enabled })}
      className={cn(
        'relative w-10 h-6 rounded-full transition-colors',
        s.voice_enabled
          ? 'bg-neutral-900 dark:bg-neutral-100'
          : 'bg-neutral-300 dark:bg-neutral-700'
      )}
    >
      <span className={cn(
        'absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white dark:bg-neutral-900 transition-transform',
        s.voice_enabled && 'translate-x-4'
      )} />
    </button>
    <span className="text-[12.5px] text-neutral-500 dark:text-neutral-400">
      Hold {s.voice_hotkey.replace('Control', 'Ctrl')} to talk
    </span>
  </div>
</FieldRow>
{s.voice_enabled && (
  <FieldRow label="Speak responses">
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => onUpdate({ voice_response: !s.voice_response })}
        className={cn(
          'relative w-10 h-6 rounded-full transition-colors',
          s.voice_response
            ? 'bg-neutral-900 dark:bg-neutral-100'
            : 'bg-neutral-300 dark:bg-neutral-700'
        )}
      >
        <span className={cn(
          'absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white dark:bg-neutral-900 transition-transform',
          s.voice_response && 'translate-x-4'
        )} />
      </button>
      <span className="text-[12.5px] text-neutral-500 dark:text-neutral-400">
        Uses OpenAI TTS — costs extra
      </span>
    </div>
  </FieldRow>
)}
```

**Step 2: Commit**

```bash
git add apps/desktop/src/components/SettingsPane.tsx
git commit -m "feat: add voice settings UI with toggle switches"
```

---

### Task 3: Add tauri-plugin-global-shortcut

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/src/main.rs`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `apps/desktop/package.json`

**Step 1: Add Rust dependency**

In `Cargo.toml`, add to `[dependencies]`:
```toml
tauri-plugin-global-shortcut = "2"
```

**Step 2: Register plugin in main.rs**

Add to the builder chain in `main()`:
```rust
.plugin(tauri_plugin_global_shortcut::init())
```

**Step 3: Add permissions in tauri.conf.json**

Add to `app.security` or create a capabilities file. The plugin needs:
```json
"plugins": {
  "global-shortcut": {
    "enabled": true
  }
}
```

**Step 4: Install JS package**

```bash
cd apps/desktop && pnpm add @tauri-apps/plugin-global-shortcut
```

**Step 5: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/src/main.rs apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat: add tauri-plugin-global-shortcut dependency"
```

---

### Task 4: Create the overlay pill window

**Files:**
- Create: `apps/desktop/overlay.html`
- Create: `apps/desktop/src/overlay.tsx`
- Create: `apps/desktop/src/components/VoicePill.tsx`
- Modify: `apps/desktop/vite.config.ts` (multi-page)
- Modify: `apps/desktop/src-tauri/tauri.conf.json` (second window)

**Step 1: Add overlay HTML entry**

Create `apps/desktop/overlay.html`:
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Voice</title>
</head>
<body class="bg-transparent">
  <div id="root"></div>
  <script type="module" src="/src/overlay.tsx"></script>
</body>
</html>
```

**Step 2: Add overlay React entry**

Create `apps/desktop/src/overlay.tsx`:
```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { VoicePill } from './components/VoicePill'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <VoicePill />
  </React.StrictMode>
)
```

**Step 3: Create VoicePill component**

Create `apps/desktop/src/components/VoicePill.tsx`:
```tsx
import React, { useState, useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Mic, Loader2, Check } from 'lucide-react'

type PillState = 'listening' | 'thinking' | 'result' | 'hidden'

export function VoicePill() {
  const [state, setState] = useState<PillState>('hidden')
  const [summary, setSummary] = useState('')

  useEffect(() => {
    const unlisten1 = listen('voice-state', (event) => {
      const { state: newState, summary: text } = event.payload as { state: PillState; summary?: string }
      setState(newState)
      if (text) setSummary(text)
      if (newState === 'result') {
        setTimeout(() => setState('hidden'), 4000)
      }
    })
    return () => { unlisten1.then(fn => fn()) }
  }, [])

  if (state === 'hidden') return null

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2.5 px-5 py-3 rounded-full bg-neutral-900/95 backdrop-blur-sm shadow-2xl border border-neutral-700/50 text-white text-[13px] font-medium transition-all duration-300 animate-in fade-in slide-in-from-bottom-2">
      {state === 'listening' && (
        <>
          <Mic size={16} className="text-red-400 animate-pulse" />
          <span className="text-neutral-300">Listening...</span>
        </>
      )}
      {state === 'thinking' && (
        <>
          <Loader2 size={16} className="animate-spin text-neutral-400" />
          <span className="text-neutral-300">Thinking...</span>
        </>
      )}
      {state === 'result' && (
        <>
          <Check size={16} className="text-emerald-400" />
          <span className="text-neutral-200 max-w-[400px] truncate">{summary}</span>
        </>
      )}
    </div>
  )
}
```

**Step 4: Configure Vite for multi-page**

Update `apps/desktop/vite.config.ts`:
```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        overlay: path.resolve(__dirname, 'overlay.html'),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
})
```

**Step 5: Add overlay window to tauri.conf.json**

Add to `app.windows` array:
```json
{
  "label": "voice-pill",
  "title": "Voice",
  "url": "overlay.html",
  "transparent": true,
  "decorations": false,
  "alwaysOnTop": true,
  "skipTaskbar": true,
  "width": 500,
  "height": 80,
  "visible": false,
  "resizable": false,
  "shadow": false,
  "focus": false
}
```

Also add `"macOSPrivateApi": true` to `app` for transparent windows on macOS.

**Step 6: Commit**

```bash
git add apps/desktop/overlay.html apps/desktop/src/overlay.tsx apps/desktop/src/components/VoicePill.tsx apps/desktop/vite.config.ts apps/desktop/src-tauri/tauri.conf.json
git commit -m "feat: add voice pill overlay window with multi-page Vite"
```

---

### Task 5: Wire up global hotkey + audio recording + transcription

**Files:**
- Create: `apps/desktop/src/lib/voice.ts`
- Modify: `apps/desktop/src/App.tsx`

**Step 1: Create voice manager**

Create `apps/desktop/src/lib/voice.ts` — handles hotkey registration, audio recording, Whisper transcription, and pill state:

```typescript
import { register, unregister } from '@tauri-apps/plugin-global-shortcut'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { emit } from '@tauri-apps/api/event'

let mediaRecorder: MediaRecorder | null = null
let audioChunks: Blob[] = []
let pillWindow: WebviewWindow | null = null

async function getPillWindow(): Promise<WebviewWindow> {
  if (!pillWindow) {
    pillWindow = await WebviewWindow.getByLabel('voice-pill') ?? undefined
    // If pre-defined window not found, it may not be created yet
  }
  return pillWindow!
}

async function showPill(state: string, summary?: string) {
  const win = await getPillWindow()
  if (win) {
    await win.show()
    await emit('voice-state', { state, summary })
  }
}

async function hidePill() {
  await emit('voice-state', { state: 'hidden' })
  const win = await getPillWindow()
  if (win) setTimeout(() => win.hide(), 300)
}

async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  audioChunks = []
  mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
  mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data)
  mediaRecorder.start()
  await showPill('listening')
}

async function stopRecordingAndTranscribe(wsUrl: string, openaiKey: string): Promise<void> {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return

  const blob = await new Promise<Blob>((resolve) => {
    mediaRecorder!.onstop = () => {
      const b = new Blob(audioChunks, { type: 'audio/webm' })
      // Stop all tracks
      mediaRecorder!.stream.getTracks().forEach(t => t.stop())
      resolve(b)
    }
    mediaRecorder!.stop()
  })

  // Skip if too short (likely accidental)
  if (blob.size < 1000) {
    await hidePill()
    return
  }

  await showPill('thinking')

  // Transcribe with Whisper
  const form = new FormData()
  form.append('file', blob, 'voice.webm')
  form.append('model', 'whisper-1')
  form.append('language', 'en')

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${openaiKey}` },
    body: form,
  })
  const { text } = await res.json()

  if (!text?.trim()) {
    await hidePill()
    return
  }

  // Send to agent via WebSocket
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((resolve) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'voice_chat', message: text }))
      resolve()
    }
  })

  // Listen for response summary
  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data)
    if (msg.type === 'voice_summary') {
      await showPill('result', msg.summary)
      // TTS if enabled — handled by caller
      setTimeout(() => hidePill(), 4000)
      ws.close()
    }
  }
}

export async function registerVoiceHotkey(
  hotkey: string,
  wsUrl: string,
  openaiKey: string
) {
  await register(hotkey, async (event) => {
    if (event.state === 'Pressed') {
      await startRecording()
    } else if (event.state === 'Released') {
      await stopRecordingAndTranscribe(wsUrl, openaiKey)
    }
  })
}

export async function unregisterVoiceHotkey(hotkey: string) {
  await unregister(hotkey).catch(() => {})
}
```

**Step 2: Wire voice into App.tsx**

In App.tsx, when settings load and voice_enabled is true, call `registerVoiceHotkey()`. When settings change, unregister old and register new.

**Step 3: Commit**

```bash
git add apps/desktop/src/lib/voice.ts apps/desktop/src/App.tsx
git commit -m "feat: wire global hotkey to audio recording and Whisper transcription"
```

---

### Task 6: Add voice_chat + voice_summary to WebSocket protocol

**Files:**
- Modify: `packages/shared/src/index.ts` (message types)
- Modify: `packages/agent-core/src/server.ts` (handle voice_chat, emit voice_summary)
- Modify: `apps/desktop/src/hooks/useAgent.ts` (handle voice_summary)

**Step 1: Add message types to shared**

Add to `WSClientMessage`:
```typescript
| { type: 'voice_chat'; message: string }
```

Add to `WSServerMessage`:
```typescript
| { type: 'voice_summary'; summary: string }
```

**Step 2: Handle in server.ts**

When `voice_chat` arrives, send to agent like a regular chat but also extract the first sentence of the response and send back as `voice_summary`:

```typescript
if (msg.type === 'voice_chat') {
  agent.chat(msg.message, (chunk) => {
    broadcast({ type: 'chat_chunk', text: chunk })
  }, (tool, label) => {
    broadcast({ type: 'tool_start', tool, label })
  }).then((fullResponse) => {
    // Extract first sentence as summary
    const summary = fullResponse.split(/[.!?]\s/)[0] + '.'
    send(ws, { type: 'voice_summary', summary: summary.slice(0, 120) })
  })
}
```

**Step 3: Handle voice_summary in useAgent.ts**

Forward the summary to the pill window via Tauri event emit.

**Step 4: Commit**

```bash
git add packages/shared/src/index.ts packages/agent-core/src/server.ts apps/desktop/src/hooks/useAgent.ts
git commit -m "feat: add voice_chat and voice_summary WebSocket messages"
```

---

### Task 7: Add optional TTS playback

**Files:**
- Modify: `apps/desktop/src/lib/voice.ts`

**Step 1: Add TTS function**

```typescript
export async function speakText(text: string, openaiKey: string): Promise<void> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice: 'nova',
      response_format: 'mp3',
    }),
  })
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  await audio.play()
  URL.revokeObjectURL(url)
}
```

**Step 2: Call after summary when voice_response is enabled**

In the voice flow, after receiving voice_summary and if settings.voice_response is true, call `speakText(summary, openaiKey)`.

**Step 3: Commit**

```bash
git add apps/desktop/src/lib/voice.ts
git commit -m "feat: add optional TTS playback for voice responses"
```

---

### Task 8: CSP and permissions

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`

**Step 1: Update CSP**

Add to `media-src`: `mediastream:` (for microphone access)
The `connect-src` already includes `https://api.openai.com`.

**Step 2: Add capabilities for global-shortcut plugin**

Create or update capabilities file for the global shortcut permission.

**Step 3: Test and commit**

```bash
git add apps/desktop/src-tauri/tauri.conf.json
git commit -m "feat: update CSP and permissions for voice recording"
```

---

### Task 9: Build and test end-to-end

**Step 1:** `cd packages/shared && npx tsc`
**Step 2:** `cd ../.. && npx tsc --noEmit -p packages/agent-core/tsconfig.json`
**Step 3:** `npx tsc --noEmit -p apps/desktop/tsconfig.json`
**Step 4:** `bash scripts/build-release.sh`
**Step 5:** Install and test: hold hotkey, speak, verify pill appears, verify transcription, verify summary shows

---

## Notes

- The voice feature reuses the existing agent chat pipeline — no agent changes needed
- MediaRecorder in WebView should work for both macOS and Windows
- `audio/webm` is the most reliable format across platforms and is supported by Whisper
- The pill window stays hidden until the hotkey is pressed — zero overhead when not in use
- OpenAI API key is already stored in settings — reused for Whisper + TTS
