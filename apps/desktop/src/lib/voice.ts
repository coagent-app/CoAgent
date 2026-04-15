import { listen, emitTo, type UnlistenFn } from '@tauri-apps/api/event'
import { setVoiceActive } from '@/hooks/useAgent'

let mediaRecorder: MediaRecorder | null = null
let audioChunks: Blob[] = []
let recordingStartTime = 0
let speechDetected = false
let audioCtx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let speechCheckInterval: ReturnType<typeof setInterval> | null = null
let fnUnlisteners: UnlistenFn[] = []
let currentHotkey: string | null = null
let locked = false // tap-lock: first tap locks listening on, second tap sends
let pressTime = 0 // track press timing for hold-to-release vs tap detection
let recordingReady: Promise<void> | null = null // resolves when startRecording completes
const HOLD_THRESHOLD_MS = 400 // hold longer than this = hold-to-release mode
let volumeEmitInterval: ReturnType<typeof setInterval> | null = null
let cachedStream: MediaStream | null = null
let streamCreatedAt = 0
let streamIdleTimer: ReturnType<typeof setTimeout> | null = null
const STREAM_IDLE_TIMEOUT_MS = 30_000
let isRecordingActive = false // explicit flag to guard idle-timer race vs mediaRecorder.state

// State callback — tells the UI what's happening
let onStateChange: ((state: 'listening' | 'thinking' | 'hidden', summary?: string) => void) | null = null

// Update the voice-pill overlay window
function updatePill(state: string, summary?: string) {
  emitTo('voice-pill', 'voice-state', { state, summary }).catch(err => console.debug('[Voice] Pill event failed:', err))
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
    emitTo('voice-pill', 'voice-volume', { level: normalized }).catch(err => console.debug('[Voice] Pill event failed:', err))
  }, 60)
}

function stopVolumeEmit() {
  if (volumeEmitInterval) { clearInterval(volumeEmitInterval); volumeEmitInterval = null }
  emitTo('voice-pill', 'voice-volume', { level: 0 }).catch(err => console.debug('[Voice] Pill event failed:', err))
}

function hidePill() {
  updatePill('hidden') // VoicePill treats 'hidden' as 'idle' — stays visible as small mic
}

function releaseStream() {
  if (streamIdleTimer) { clearTimeout(streamIdleTimer); streamIdleTimer = null }
  if (cachedStream) { cachedStream.getTracks().forEach(t => t.stop()); cachedStream = null }
  streamCreatedAt = 0
}

async function getStream(): Promise<MediaStream> {
  // Validate cached stream: must be active and all tracks must be live
  if (cachedStream && cachedStream.active && cachedStream.getTracks().every(t => t.readyState === 'live')) {
    return cachedStream
  }
  // Release stale stream before acquiring a new one
  releaseStream()
  cachedStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  streamCreatedAt = Date.now()
  // Auto-release after 30s of idle (no recording started)
  if (streamIdleTimer) clearTimeout(streamIdleTimer)
  streamIdleTimer = setTimeout(() => {
    // Only release if not currently recording
    if (!isRecordingActive) {
      console.log('[Voice] Stream idle timeout — releasing mic')
      releaseStream()
    }
  }, STREAM_IDLE_TIMEOUT_MS)
  return cachedStream
}

async function startRecording() {
  try {
    onStateChange?.('listening')
    updatePill('listening')
    isRecordingActive = true
    // Cancel idle timeout — recording is starting
    if (streamIdleTimer) { clearTimeout(streamIdleTimer); streamIdleTimer = null }
    const stream = await getStream()
    audioChunks = []
    speechDetected = false

    // Monitor audio level to detect actual speech
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContext()
      const source = audioCtx.createMediaStreamSource(stream)
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
    }
    if (audioCtx.state === 'suspended') await audioCtx.resume()
    const dataArray = new Uint8Array(analyser!.fftSize)
    speechCheckInterval = setInterval(() => {
      if (!analyser) return
      analyser.getByteTimeDomainData(dataArray)
      const peak = dataArray.reduce((max, v) => Math.max(max, Math.abs(v - 128)), 0)
      if (peak > 30) speechDetected = true
    }, 50)

    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data)
    mediaRecorder.start()
    recordingStartTime = Date.now()
    startVolumeEmit()
    console.log('[Voice] Recording started')
  } catch (err) {
    isRecordingActive = false
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
      resolve(b)
    }
    mediaRecorder!.stop()
  })

  // Clean up speech check, keep stream + audioCtx alive for next press
  stopVolumeEmit()
  if (speechCheckInterval) { clearInterval(speechCheckInterval); speechCheckInterval = null }
  // Restart idle timer — release stream if no recording starts within 30s
  if (streamIdleTimer) clearTimeout(streamIdleTimer)
  streamIdleTimer = setTimeout(() => {
    if (!isRecordingActive) {
      console.log('[Voice] Stream idle timeout after recording — releasing mic')
      releaseStream()
    }
  }, STREAM_IDLE_TIMEOUT_MS)

  const duration = Date.now() - recordingStartTime
  if (blob.size < 1000 || duration < 600 || !speechDetected) {
    isRecordingActive = false
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
    isRecordingActive = false
    const dataUrl = reader.result as string
    const base64 = dataUrl.split(',')[1] ?? ''
    if (base64) onAudioReady(base64)
    else onStateChange?.('hidden')
  }
  reader.onerror = () => {
    isRecordingActive = false
    console.error('[Voice] FileReader error:', reader.error)
    onStateChange?.('hidden')
  }
  reader.readAsDataURL(blob)
}

let ttsAudio: HTMLAudioElement | null = null

export function showVoiceSummary() {
  // Keep showing whatever was last displayed, then hide after a short delay
  responseAccum = ''
  responseLocked = false
  onStateChange?.('hidden')
  setVoiceActive(false) // voice session done
  // If TTS audio is playing or queued, wait for it to finish before hiding
  if (ttsPlaying || ttsQueue.length > 0) {
    ttsOnAllDone = () => { ttsOnAllDone = null; setTimeout(() => hidePill(), 500) }
  } else if (ttsAudio && !ttsAudio.ended && !ttsAudio.paused) {
    ttsAudio.onended = () => { ttsAudio = null; setTimeout(() => hidePill(), 500) }
  } else {
    setTimeout(() => hidePill(), 2000)
  }
}

export function playTtsAudio(base64Mp3: string) {
  // Stop any existing playback
  if (ttsAudio) { ttsAudio.pause(); ttsAudio = null }
  const audio = new Audio(`data:audio/mp3;base64,${base64Mp3}`)
  audio.volume = ttsVolume
  ttsAudio = audio
  audio.onended = () => { ttsAudio = null }
  audio.play().catch(err => console.error('[Voice] TTS playback failed:', err))
}

// ── Streaming TTS — queue MP3 segments, play each as it completes ─────────
let ttsVolume = 0.5 // 0.0–1.0, default 50%

export function setTtsVolume(v: number) {
  ttsVolume = Math.max(0, Math.min(1, v))
  if (ttsAudio) ttsAudio.volume = ttsVolume
}

export function getTtsVolume(): number { return ttsVolume }

let ttsChunks: Uint8Array[] = []
let ttsQueue: Blob[] = []
let ttsPlaying = false
let ttsOnAllDone: (() => void) | null = null

export function handleTtsChunk(base64Chunk: string, _seq: number) {
  const bytes = Uint8Array.from(atob(base64Chunk), c => c.charCodeAt(0))
  ttsChunks.push(bytes)
}

export function cancelTts() {
  ttsChunks = []
  ttsQueue = []
  ttsPlaying = false
  ttsOnAllDone = null
  if (ttsAudio) { ttsAudio.pause(); ttsAudio = null }
}

function playNextTtsSegment() {
  // Mutex: only one segment plays at a time; recursive call from onended/onerror is allowed
  // because ttsPlaying is reset to false before calling back in.
  if (ttsPlaying) return
  if (ttsQueue.length === 0) {
    ttsOnAllDone?.()
    return
  }
  ttsPlaying = true
  const blob = ttsQueue.shift()!
  const url = URL.createObjectURL(blob)
  if (ttsAudio) { ttsAudio.pause(); ttsAudio = null }
  const audio = new Audio(url)
  audio.volume = ttsVolume
  ttsAudio = audio
  audio.onended = () => {
    ttsAudio = null
    URL.revokeObjectURL(url)
    ttsPlaying = false
    playNextTtsSegment()
  }
  audio.onerror = () => {
    ttsAudio = null
    URL.revokeObjectURL(url)
    ttsPlaying = false
    playNextTtsSegment()
  }
  audio.play().catch(err => {
    console.error('[Voice] TTS segment playback failed:', err)
    ttsPlaying = false
    playNextTtsSegment()
  })
}

export function handleTtsDone() {
  if (ttsChunks.length === 0) return
  const segmentBlob = new Blob(ttsChunks as BlobPart[], { type: 'audio/mpeg' })
  ttsChunks = []
  ttsQueue.push(segmentBlob)
  console.log('[Voice] TTS segment ready (%d bytes), queue: %d', segmentBlob.size, ttsQueue.length)

  if (!ttsPlaying) {
    playNextTtsSegment()
  }
}

// Show tool activity in the pill (e.g. "Reading email...")
export function showVoiceToolLabel(label: string) {
  updatePill('working', label)
}

// Strip markdown for pill display
function stripMd(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/\n+/g, ' ')
}

// Show first two sentences of the agent response in the pill
let responseAccum = ''
let responseLocked = false
export function showVoiceResponse(chunk: string) {
  if (responseLocked) return
  responseAccum += chunk
  const clean = stripMd(responseAccum)
  // Count sentence endings (. ! ? followed by a space)
  let count = 0
  const re = /[.!?]\s/g
  let lastEnd = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(clean)) !== null) {
    count++
    lastEnd = m.index + 1
    if (count >= 2) break
  }
  if (count >= 2) {
    responseLocked = true
    updatePill('responding', clean.slice(0, lastEnd))
  } else {
    updatePill('responding', clean)
  }
}

export function resetVoiceResponse() {
  responseAccum = ''
  responseLocked = false
}

export function cancelVoice() {
  locked = false
  isRecordingActive = false
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
    mediaRecorder = null
  }
  stopVolumeEmit()
  if (speechCheckInterval) { clearInterval(speechCheckInterval); speechCheckInterval = null }
  releaseStream()
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; analyser = null }
  onStateChange?.('hidden')
  setVoiceActive(false)
  hidePill()
  cancelTts()
  console.log('[Voice] Cancelled')
}

// ── Shared dictation recording (used by ChatPane mic button) ──────────────
export interface DictationSession {
  stop: () => Promise<{ base64: string } | null>
}

export async function startDictation(): Promise<DictationSession> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const chunks: Blob[] = []
  let hasSpeech = false
  const startTime = Date.now()

  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(stream)
  const anal = ctx.createAnalyser()
  anal.fftSize = 512
  source.connect(anal)
  const buf = new Uint8Array(anal.fftSize)
  const interval = setInterval(() => {
    anal.getByteTimeDomainData(buf)
    const peak = buf.reduce((max, v) => Math.max(max, Math.abs(v - 128)), 0)
    if (peak > 30) hasSpeech = true
  }, 50)

  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
  recorder.ondataavailable = (e) => chunks.push(e.data)
  recorder.start()

  return {
    stop: () => new Promise((resolve) => {
      clearInterval(interval)
      if (recorder.state === 'inactive') {
        stream.getTracks().forEach(t => t.stop())
        ctx.close().catch(() => {})
        resolve(null)
        return
      }
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        ctx.close().catch(() => {})
        const blob = new Blob(chunks, { type: 'audio/webm' })
        const duration = Date.now() - startTime
        if (!hasSpeech || blob.size < 1000 || duration < 300) {
          resolve(null)
          return
        }
        const reader = new FileReader()
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(',')[1] ?? ''
          resolve(base64 ? { base64 } : null)
        }
        reader.onerror = () => {
          console.error('[Voice] FileReader error (dictation):', reader.error)
          resolve(null)
        }
        reader.readAsDataURL(blob)
      }
      recorder.stop()
    })
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
    console.log('[Voice] Registering ctrl+fn (hold-to-release + tap-lock)')
    // Dual mode: hold ctrl+fn to record (release sends), or quick tap to toggle lock.
    // Using combo avoids macOS Globe key emoji/Character Viewer.
    const pressUn = await listen('voice-fn-press', async () => {
      pressTime = Date.now()
      if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        // Not recording — start on every press (both hold and tap)
        setVoiceActive(true)
        // Track the promise so release can await it (prevents race condition)
        recordingReady = startRecording()
          .then(() => { recordingReady = null })
          .catch(err => {
            recordingReady = null
            console.error('[Voice] Recording start failed:', err)
            onStateChange?.('hidden')
          })
      }
      // If already recording (locked from first tap), press is noted; action on release
    })
    const releaseUn = await listen('voice-fn-release', async () => {
      // Wait for recording to be fully initialized before processing release
      if (recordingReady) await recordingReady
      if (!mediaRecorder || mediaRecorder.state === 'inactive') return
      const holdDuration = Date.now() - pressTime

      if (holdDuration >= HOLD_THRESHOLD_MS) {
        // Hold-to-release: held key long enough → send immediately
        locked = false
        emitTo('voice-pill', 'voice-locked', { locked: false }).catch(err => console.debug('[Voice] Pill event failed:', err))
        console.log('[Voice] Hold release (%dms) — sending', holdDuration)
        await stopRecordingAndSend(onAudioReady)
      } else if (locked) {
        // Second quick tap (was locked) → stop and send
        locked = false
        emitTo('voice-pill', 'voice-locked', { locked: false }).catch(err => console.debug('[Voice] Pill event failed:', err))
        console.log('[Voice] Second tap — sending')
        await stopRecordingAndSend(onAudioReady)
      } else {
        // First quick tap → lock recording on (keep listening)
        locked = true
        emitTo('voice-pill', 'voice-locked', { locked: true }).catch(err => console.debug('[Voice] Pill event failed:', err))
        console.log('[Voice] First tap — locked listening on')
      }
    })
    fnUnlisteners = [pressUn, releaseUn]
    console.log('[Voice] ctrl+fn listeners registered (hold or double-tap)')
  } else {
    // Fallback to global shortcut plugin for custom hotkeys — always hold-to-release
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
  releaseStream()
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; analyser = null }
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
