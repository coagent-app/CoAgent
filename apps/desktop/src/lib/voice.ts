import { listen, emitTo, type UnlistenFn } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

let mediaRecorder: MediaRecorder | null = null
let audioChunks: Blob[] = []
let fnUnlisteners: UnlistenFn[] = []
let currentHotkey: string | null = null

// State callback — tells the UI what's happening
let onStateChange: ((state: 'listening' | 'thinking' | 'hidden', summary?: string) => void) | null = null

// Update the voice-pill overlay window
function updatePill(state: string, summary?: string) {
  emitTo('voice-pill', 'voice-state', { state, summary }).catch(() => {})
}

async function hidePill() {
  updatePill('hidden')
  setTimeout(async () => {
    const win = await WebviewWindow.getByLabel('voice-pill')
    if (win) win.hide().catch(() => {})
  }, 300)
}

async function startRecording() {
  try {
    onStateChange?.('listening')
    updatePill('listening')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    audioChunks = []
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data)
    mediaRecorder.start()
    console.log('[Voice] Recording started')
  } catch (err) {
    console.error('[Voice] Failed to start recording:', err)
    onStateChange?.('hidden')
    hidePill()
  }
}

async function stopRecordingAndSend(
  onAudioReady: (base64: string) => void
): Promise<void> {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    onStateChange?.('hidden')
    return
  }

  const blob = await new Promise<Blob>((resolve) => {
    mediaRecorder!.onstop = () => {
      const b = new Blob(audioChunks, { type: 'audio/webm' })
      mediaRecorder!.stream.getTracks().forEach(t => t.stop())
      resolve(b)
    }
    mediaRecorder!.stop()
  })

  if (blob.size < 1000) {
    onStateChange?.('hidden')
    hidePill()
    return
  }

  onStateChange?.('thinking')
  updatePill('thinking')
  console.log('[Voice] Sending audio to server, size:', blob.size)

  const reader = new FileReader()
  reader.onloadend = () => {
    const dataUrl = reader.result as string
    const base64 = dataUrl.split(',')[1] ?? ''
    if (base64) onAudioReady(base64)
    else onStateChange?.('hidden')
  }
  reader.readAsDataURL(blob)
}

export function showVoiceSummary(_summary: string) {
  // Keep showing whatever was last displayed, then hide after a short delay
  responseAccum = ''
  onStateChange?.('hidden')
  setTimeout(() => hidePill(), 2000)
}

// Show tool activity in the pill (e.g. "Reading email...")
export function showVoiceToolLabel(label: string) {
  updatePill('working', label)
}

// Show just the first sentence of the agent response in the pill
let responseAccum = ''
let responseLocked = false
export function showVoiceResponse(chunk: string) {
  if (responseLocked) return
  responseAccum += chunk
  // Stop after first sentence or 80 chars
  const sentenceEnd = responseAccum.search(/[.!?]\s/)
  if (sentenceEnd > 0) {
    responseAccum = responseAccum.slice(0, sentenceEnd + 1)
    responseLocked = true
  } else if (responseAccum.length > 80) {
    responseLocked = true
  }
  updatePill('responding', responseAccum)
}

export function resetVoiceResponse() {
  responseAccum = ''
  responseLocked = false
}

export function speakText(text: string): void {
  try {
    const synth = window.speechSynthesis
    const utter = new SpeechSynthesisUtterance(text)
    utter.rate = 1.0
    synth.speak(utter)
  } catch (err) {
    console.error('[Voice] TTS failed:', err)
  }
}

export async function registerVoiceHotkey(
  hotkey: string,
  onAudioReady: (base64: string) => void,
  stateCallback: (state: 'listening' | 'thinking' | 'hidden', summary?: string) => void
) {
  await unregisterVoiceHotkey()
  currentHotkey = hotkey
  onStateChange = stateCallback

  if (hotkey === 'fn') {
    console.log('[Voice] Registering fn key via native listener')
    const pressUn = await listen('voice-fn-press', async () => {
      console.log('[Voice] fn pressed — starting recording')
      await startRecording()
    })
    const releaseUn = await listen('voice-fn-release', async () => {
      console.log('[Voice] fn released — stopping recording')
      await stopRecordingAndSend(onAudioReady)
    })
    fnUnlisteners = [pressUn, releaseUn]
    console.log('[Voice] fn key listeners registered')
  } else {
    // Fallback to global shortcut plugin for custom hotkeys
    const { register } = await import('@tauri-apps/plugin-global-shortcut')
    await register(hotkey, async (event) => {
      if (event.state === 'Pressed') await startRecording()
      else if (event.state === 'Released') await stopRecordingAndSend(onAudioReady)
    })
    console.log('[Voice] Hotkey registered:', hotkey)
  }
}

export async function unregisterVoiceHotkey() {
  onStateChange = null
  if (fnUnlisteners.length > 0) {
    fnUnlisteners.forEach(fn => fn())
    fnUnlisteners = []
  }
  if (currentHotkey && currentHotkey !== 'fn') {
    const { unregister } = await import('@tauri-apps/plugin-global-shortcut')
    await unregister(currentHotkey).catch(() => {})
  }
  currentHotkey = null
}
