/**
 * transcribe.ts — local, offline transcription via whisper.cpp
 *
 * Zero external npm dependencies. Uses only Node.js built-ins:
 *   child_process, fs, https, path, os
 *
 * The feature is completely optional — every step degrades gracefully.
 * If the whisper binary or model cannot be found/downloaded, the function
 * returns null without throwing.
 */

import { execFile, execFileSync } from 'child_process'
import {
  existsSync,
  createWriteStream,
  unlinkSync,
  statSync,
  writeFileSync,
} from 'fs'
import { mkdir, unlink, writeFile } from 'fs/promises'
import * as https from 'https'
import * as http from 'http'
import { join, extname, basename, dirname } from 'path'
import { tmpdir } from 'os'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// ── Constants ─────────────────────────────────────────────────────────────────

const MODEL_FILENAME = 'ggml-tiny.en-q5_1.bin'
const MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en-q5_1.bin'
const MODEL_MIN_SIZE = 1024 * 1024 // 1 MB sanity check
const TRANSCRIBE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.wav'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.wmv', '.flv'])

// ── Binary resolution ─────────────────────────────────────────────────────────

/**
 * Returns the absolute path to the whisper binary, or null if not found.
 * Checks (in order):
 *   1. Bundled sidecar next to process.execPath (Tauri production)
 *   2. `whisper` on PATH
 *   3. `whisper-cpp` on PATH
 */
function findWhisperBinary(): string | null {
  // 1. Sidecar — lives in the same directory as the compiled coagent-server binary
  const sidecarDir = dirname(process.execPath)
  const sidecarPath = join(sidecarDir, 'whisper')
  if (existsSync(sidecarPath)) {
    return sidecarPath
  }

  // 2. Dev mode — check the Tauri binaries directory relative to the monorepo
  const devBinDir = join(__dirname, '..', '..', '..', 'apps', 'desktop', 'src-tauri', 'binaries')
  for (const suffix of [`-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`, '']) {
    const devPath = join(devBinDir, `whisper${suffix}`)
    if (existsSync(devPath)) return devPath
  }

  // 3. PATH — check common binary names
  for (const name of ['whisper-cli', 'whisper', 'whisper-cpp']) {
    try {
      execFileSync(name, ['--help'], { stdio: 'ignore', timeout: 3000 })
      return name
    } catch {
      // not found or errored — try next
    }
  }

  return null
}

// ── Model download ────────────────────────────────────────────────────────────

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const lockPath = destPath + '.downloading'

    const cleanup = (err?: Error) => {
      // Remove partial download and lock
      try { unlinkSync(destPath) } catch { /* ignore */ }
      try { unlinkSync(lockPath) } catch { /* ignore */ }
      if (err) reject(err)
      else resolve()
    }

    // Create lock file
    writeFileSync(lockPath, String(Date.now()))

    const writer = createWriteStream(destPath)
    writer.on('error', (err) => cleanup(err))

    const request = (redirectUrl: string, depth = 0) => {
      if (depth > 5) {
        cleanup(new Error('Too many redirects'))
        return
      }

      const parsed = new URL(redirectUrl)
      const mod = parsed.protocol === 'https:' ? https : http

      mod.get(redirectUrl, (res: any) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          request(res.headers.location, depth + 1)
          return
        }
        if (res.statusCode !== 200) {
          cleanup(new Error(`HTTP ${res.statusCode} downloading model`))
          return
        }

        const total = parseInt(res.headers['content-length'] ?? '0', 10)
        let downloaded = 0
        let lastLogMB = 0

        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          const mb = Math.floor(downloaded / (1024 * 1024))
          if (mb > lastLogMB) {
            const pct = total > 0 ? ` (${Math.round((downloaded / total) * 100)}%)` : ''
            process.stderr.write(`[Transcribe] Downloading model: ${mb}MB${pct}\n`)
            lastLogMB = mb
          }
        })

        res.pipe(writer)
        res.on('error', (err: Error) => cleanup(err))
        writer.on('finish', () => {
          try { unlinkSync(lockPath) } catch { /* ignore */ }
          resolve()
        })
      }).on('error', (err: Error) => cleanup(err))
    }

    request(url)
  })
}

/**
 * Ensures the quantized tiny model is present in {dataDir}/models/.
 * Returns the model path, or null if download fails.
 */
async function ensureModel(dataDir: string): Promise<string | null> {
  const modelsDir = join(dataDir, 'models')
  await mkdir(modelsDir, { recursive: true })
  const modelPath = join(modelsDir, MODEL_FILENAME)
  const lockPath = modelPath + '.downloading'

  // Already exists and large enough
  if (existsSync(modelPath)) {
    try {
      const { size } = statSync(modelPath)
      if (size > MODEL_MIN_SIZE) return modelPath
    } catch { /* fall through to re-download */ }
  }

  // Another process is already downloading
  if (existsSync(lockPath)) {
    process.stderr.write('[Transcribe] Model download already in progress, skipping\n')
    return null
  }

  process.stderr.write(`[Transcribe] Downloading whisper model (${MODEL_FILENAME})...\n`)
  try {
    await downloadFile(MODEL_URL, modelPath)
    process.stderr.write('[Transcribe] Model download complete\n')
    return modelPath
  } catch (err) {
    process.stderr.write(`[Transcribe] Model download failed: ${(err as Error).message}\n`)
    // Clean up partial file (lock already removed by cleanup() in downloadFile)
    try { unlinkSync(modelPath) } catch { /* ignore */ }
    return null
  }
}

// ── Audio conversion ──────────────────────────────────────────────────────────

/**
 * Converts input media to a 16kHz mono 16-bit WAV.
 * Returns the path to the temp WAV file, or null on failure.
 * Caller is responsible for deleting the temp file.
 */
async function convertToWav(inputPath: string): Promise<string | null> {
  const ext = extname(inputPath).toLowerCase()
  const isAudio = AUDIO_EXTS.has(ext)
  const isVideo = VIDEO_EXTS.has(ext)

  if (!isAudio && !isVideo) return null

  const tmpWav = join(tmpdir(), `coagent-transcribe-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`)

  if (isAudio) {
    // macOS built-in afconvert — available on every Mac, no install required
    try {
      await execFileAsync('afconvert', [
        '-f', 'WAVE',
        '-d', 'LEI16@16000',
        '-c', '1',
        inputPath,
        tmpWav,
      ], { timeout: 60_000 })
      return tmpWav
    } catch (err) {
      process.stderr.write(`[Transcribe] afconvert failed: ${(err as Error).message}\n`)
      return null
    }
  }

  // Video — requires ffmpeg
  try {
    await execFileAsync('ffmpeg', [
      '-i', inputPath,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      tmpWav,
      '-y',
    ], { timeout: 120_000 })
    return tmpWav
  } catch (err) {
    process.stderr.write(`[Transcribe] ffmpeg failed (video transcription requires ffmpeg on PATH): ${(err as Error).message}\n`)
    return null
  }
}

// ── Whisper invocation ────────────────────────────────────────────────────────

async function runWhisper(
  whisperBin: string,
  modelPath: string,
  wavPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      whisperBin,
      [
        '-m', modelPath,
        '-f', wavPath,
        '--output-txt',
        '--no-timestamps',
        '-l', 'en',
      ],
      { timeout: TRANSCRIBE_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 },
    )
    return stdout.trim() || null
  } catch (err) {
    process.stderr.write(`[Transcribe] whisper execution failed: ${(err as Error).message}\n`)
    return null
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Transcribes a media file using a locally-bundled whisper.cpp binary.
 *
 * Steps:
 *   1. Find the whisper binary (sidecar or PATH)
 *   2. Download the quantized tiny model on first use
 *   3. Convert media to 16kHz mono WAV
 *   4. Run whisper and capture transcript
 *   5. Save transcript to {filePath}.transcript.txt
 *
 * Returns the transcript string, or null if any step fails or the binary/model
 * is unavailable. Never throws.
 */
export async function transcribeFile(
  filePath: string,
  dataDir: string,
): Promise<string | null> {
  const filename = basename(filePath)

  try {
    // 1. Find whisper binary
    const whisperBin = findWhisperBinary()
    if (!whisperBin) {
      process.stderr.write('[Transcribe] whisper binary not found — skipping transcription\n')
      return null
    }

    // 2. Ensure model is downloaded
    const modelPath = await ensureModel(dataDir)
    if (!modelPath) return null

    // 3. Convert to WAV
    const t0 = Date.now()
    const wavPath = await convertToWav(filePath)
    if (!wavPath) return null

    // 4. Run whisper
    let transcript: string | null = null
    try {
      transcript = await runWhisper(whisperBin, modelPath, wavPath)
    } finally {
      // Always clean up temp WAV
      try { await unlink(wavPath) } catch { /* ignore */ }
    }

    if (!transcript) return null

    const elapsed = Date.now() - t0
    const words = transcript.split(/\s+/).filter(Boolean).length
    process.stderr.write(`[Transcribe] Transcribed ${filename} in ${elapsed}ms (${words} words)\n`)

    return transcript
  } catch (err) {
    process.stderr.write(`[Transcribe] Unexpected error for ${filename}: ${(err as Error).message}\n`)
    return null
  }
}
