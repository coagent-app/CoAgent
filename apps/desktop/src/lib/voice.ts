import { listen, emitTo, type UnlistenFn } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

let mediaRecorder: MediaRecorder | null = null
let audioChunks: Blob[] = []
let recordingStartTime = 0
let speechDetected = false
let audioCtx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let speechCheckInterval: ReturnType<typeof setInterval> | null = null
let fnUnlisteners: UnlistenFn[] = []
let currentHotkey: string | null = null
let locked = false // double-tap fn locks listening on
let lastFnPressTime = 0
let volumeEmitInterval: ReturnType<typeof setInterval> | null = null

// State callback — tells the UI what's happening
let onStateChange: ((state: 'listening' | 'thinking' | 'hidden', summary?: string) => void) | null = null

// Update the voice-pill overlay window
function updatePill(state: string, summary?: string) {
  emitTo('voice-pill', 'voice-state', { state, summary }).catch(() => {})
}

// Emit current volume level to the pill for mic animation
function startVolumeEmit() {
  stopVolumeEmit()
  volumeEmitInterval = setInterval(() => {
    if (!analyser) return
    const dataArray = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(dataArray)
    const peak = dataArray.reduce((max, v) => Math.max(max, Math.abs(v - 128)), 0)
    const normalized = Math.min(peak / 80, 1) // 0-1 range, 80 is loud speech
    emitTo('voice-pill', 'voice-volume', { level: normalized }).catch(() => {})
  }, 60)
}

function stopVolumeEmit() {
  if (volumeEmitInterval) { clearInterval(volumeEmitInterval); volumeEmitInterval = null }
  emitTo('voice-pill', 'voice-volume', { level: 0 }).catch(() => {})
}

function hidePill() {
  updatePill('hidden') // VoicePill treats 'hidden' as 'idle' — stays visible as small mic
}

async function startRecording() {
  try {
    onStateChange?.('listening')
    updatePill('listening')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    audioChunks = []
    speechDetected = false

    // Monitor audio level to detect actual speech
    audioCtx = new AudioContext()
    const source = audioCtx.createMediaStreamSource(stream)
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const dataArray = new Uint8Array(analyser.fftSize)
    speechCheckInterval = setInterval(() => {
      if (!analyser) return
      analyser.getByteTimeDomainData(dataArray)
      // Check if any sample deviates significantly from silence (128)
      const peak = dataArray.reduce((max, v) => Math.max(max, Math.abs(v - 128)), 0)
      if (peak > 15) speechDetected = true // threshold: ~12% above silence
    }, 50)

    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data)
    mediaRecorder.start()
    recordingStartTime = Date.now()
    startVolumeEmit()
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
    hidePill()
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

  // Clean up audio monitoring
  stopVolumeEmit()
  if (speechCheckInterval) { clearInterval(speechCheckInterval); speechCheckInterval = null }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; analyser = null }

  const duration = Date.now() - recordingStartTime
  if (blob.size < 1000 || duration < 600 || !speechDetected) {
    console.log(`[Voice] Skipped — no speech (${duration}ms, ${blob.size}b, speech=${speechDetected})`)
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
  ;(window as any).__voiceActive = false // voice session done
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

export function cancelVoice() {
  locked = false
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stream.getTracks().forEach(t => t.stop())
    mediaRecorder.stop()
    mediaRecorder = null
  }
  stopVolumeEmit()
  if (speechCheckInterval) { clearInterval(speechCheckInterval); speechCheckInterval = null }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; analyser = null }
  onStateChange?.('hidden')
  ;(window as any).__voiceActive = false
  hidePill()
  console.log('[Voice] Cancelled')
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
    const cancelUn = await listen('voice-cancel', () => {
      console.log('[Voice] fn+Control — cancelling')
      cancelVoice()
    })
    fnUnlisteners = [pressUn, releaseUn, cancelUn]
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
  locked = false
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
