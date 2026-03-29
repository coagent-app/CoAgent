import { Audio } from 'expo-av'
import * as FileSystem from 'expo-file-system'

let recording: Audio.Recording | null = null
let ttsSound: Audio.Sound | null = null
let ttsChunks: Uint8Array[] = []
let onTtsDoneCallback: (() => void) | null = null
let cleaningUp = false

// --- Recording ---

/** Fully tear down any existing recording before starting fresh */
async function cleanupRecording(): Promise<void> {
  if (cleaningUp) return
  cleaningUp = true
  try {
    if (recording) {
      try { await recording.stopAndUnloadAsync() } catch (_) {}
      recording = null
    }
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false })
  } finally {
    cleaningUp = false
  }
}

export async function startRecording(): Promise<void> {
  const { granted } = await Audio.requestPermissionsAsync()
  if (!granted) throw new Error('Microphone permission denied')

  // Always clean up first — prevents "recorder not prepared" errors
  await cleanupRecording()

  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
  })

  const rec = new Audio.Recording()
  await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.LOW_QUALITY)
  await rec.startAsync()
  recording = rec
}

export async function stopRecordingAndGetBase64(): Promise<string | null> {
  if (!recording) return null

  const rec = recording
  recording = null

  try {
    await rec.stopAndUnloadAsync()
  } catch (err) {
    console.error('[Voice] Stop recording error:', err)
  }
  await Audio.setAudioModeAsync({ allowsRecordingIOS: false })

  const uri = rec.getURI()
  console.log('[Voice] Recording URI:', uri)
  if (!uri) return null

  try {
    // fetch() works on local file:// URIs in React Native — most reliable approach
    const response = await fetch(uri)
    const arrayBuffer = await response.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    console.log('[Voice] Recording size:', bytes.length, 'bytes')
    if (bytes.length === 0) return null
    const base64 = uint8ArrayToBase64(bytes)
    // Clean up temp file
    FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
    return base64
  } catch (err) {
    console.error('[Voice] Failed to read recording:', err)
    return null
  }
}

export async function cancelRecording(): Promise<void> {
  await cleanupRecording()
}

// --- Thinking Feedback (haptic pulses) ---

import * as Haptics from 'expo-haptics'

let thinkingInterval: ReturnType<typeof setInterval> | null = null

/** Gentle haptic pulse loop — no audio, just tactile feedback */
export async function startThinkingSound(): Promise<void> {
  stopThinkingSound()
  // Immediate acknowledgment — one firm tap
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {})
  // Then gentle pulses every 1.5s while thinking
  thinkingInterval = setInterval(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
  }, 1500)
}

export function stopThinkingSound(): void {
  if (thinkingInterval) {
    clearInterval(thinkingInterval)
    thinkingInterval = null
  }
}

// --- TTS Playback ---

export function setTtsDoneCallback(cb: (() => void) | null) {
  onTtsDoneCallback = cb
}

export async function handleTtsChunk(base64Chunk: string, _seq: number) {
  const bytes = Uint8Array.from(atob(base64Chunk), c => c.charCodeAt(0))
  ttsChunks.push(bytes)
}

export async function handleTtsDone() {
  if (ttsChunks.length === 0) {
    onTtsDoneCallback?.()
    return
  }
  await playTtsFromChunks()
}

async function playTtsFromChunks() {
  if (ttsSound) {
    await ttsSound.unloadAsync().catch(() => {})
    ttsSound = null
  }

  // Combine all chunks into one buffer
  const totalLength = ttsChunks.reduce((sum, c) => sum + c.length, 0)
  const combined = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of ttsChunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }
  ttsChunks = []

  console.log('[Voice] TTS audio size:', totalLength, 'bytes')

  // Stop thinking haptics before playing response
  stopThinkingSound()

  // Convert to base64 and play as data URI — mp3 is supported on iOS
  const base64 = uint8ArrayToBase64(combined)
  const uri = `data:audio/mpeg;base64,${base64}`

  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
  })

  try {
    const { sound } = await Audio.Sound.createAsync({ uri })
    ttsSound = sound

    sound.setOnPlaybackStatusUpdate((status) => {
      if (status.isLoaded && status.didJustFinish) {
        sound.setOnPlaybackStatusUpdate(null)
        onTtsDoneCallback?.()
      }
    })

    await sound.playAsync()
  } catch (err) {
    console.error('[Voice] TTS playback failed:', err)
    onTtsDoneCallback?.()
  }
}

/** Convert Uint8Array to base64 safely and fast */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Build in chunks to avoid stack overflow, use array join to avoid O(n²) string concat
  const chunks: string[] = []
  const chunkSize = 4096
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, bytes.length)
    let str = ''
    for (let j = i; j < end; j++) {
      str += String.fromCharCode(bytes[j])
    }
    chunks.push(str)
  }
  return btoa(chunks.join(''))
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

export function registerTtsHandlers(onDone?: () => void) {
  if (onDone) setTtsDoneCallback(onDone)
  ;(globalThis as any).__ttsChunkHandler = handleTtsChunk
  ;(globalThis as any).__ttsDoneHandler = handleTtsDone
}

export function unregisterTtsHandlers() {
  setTtsDoneCallback(null)
  delete (globalThis as any).__ttsChunkHandler
  delete (globalThis as any).__ttsDoneHandler
}
