// Canvas store — reads/writes/updates .canvas files for the react-runner
// document architecture.
// See docs/plans/2026-04-08-react-runner-artifacts-design.md for the full design.

import { readFile, readdir, writeFile, mkdir, unlink, rename } from 'fs/promises'
import { join } from 'path'
import type { Canvas } from '@coagent/shared'

const CANVASES_DIR = 'canvases'
const MAX_VERSIONS = 5

// ── id / filename helpers ────────────────────────────────────────────────

function genCanvasId(): string {
  return 'cv_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

function canvasPath(dataDir: string, id: string): string {
  return join(dataDir, CANVASES_DIR, `${id}.canvas`)
}

// ── atomic write ─────────────────────────────────────────────────────────

// Per-canvas write queue so concurrent writers to the same file serialize
// instead of racing on the tmp file. Without this, two overlapping writes
// both create `<path>.tmp`; the first rename wins, the second ENOENTs.
const writeLocks = new Map<string, Promise<void>>()

let canvasDirCreated = false

async function writeCanvasAtomic(path: string, canvas: Canvas): Promise<void> {
  const prev = writeLocks.get(path) || Promise.resolve()
  const next = prev.catch(() => {}).then(async () => {
    if (!canvasDirCreated) {
      await mkdir(join(path, '..'), { recursive: true })
      canvasDirCreated = true
    }
    const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmpPath, JSON.stringify(canvas, null, 2), 'utf-8')
    await rename(tmpPath, path)
  })
  writeLocks.set(path, next)
  try {
    await next
  } finally {
    if (writeLocks.get(path) === next) writeLocks.delete(path)
  }
}

// ── public API ───────────────────────────────────────────────────────────

export interface CreateCanvasInput {
  title: string
  code: string
  kind?: string
}

export async function createCanvas(
  dataDir: string,
  input: CreateCanvasInput,
): Promise<Canvas> {
  const id = genCanvasId()
  const now = new Date().toISOString()
  const canvas: Canvas = {
    id,
    title: input.title,
    kind: input.kind,
    code: input.code,
    createdAt: now,
    updatedAt: now,
    versions: [],
  }
  await writeCanvasAtomic(canvasPath(dataDir, id), canvas)
  return canvas
}

export async function readCanvas(
  dataDir: string,
  id: string,
): Promise<Canvas | null> {
  try {
    const raw = await readFile(canvasPath(dataDir, id), 'utf-8')
    return JSON.parse(raw) as Canvas
  } catch {
    return null
  }
}

export interface CanvasPatch {
  title?: string
  code?: string
  kind?: string
}

export async function updateCanvas(
  dataDir: string,
  id: string,
  patch: CanvasPatch,
): Promise<Canvas | null> {
  const canvas = await readCanvas(dataDir, id)
  if (!canvas) return null

  // Only snapshot when code actually changes
  const versions = patch.code !== undefined && patch.code !== canvas.code
    ? [{ savedAt: canvas.updatedAt, code: canvas.code }, ...(canvas.versions || [])].slice(0, MAX_VERSIONS)
    : (canvas.versions || [])

  const updated: Canvas = {
    ...canvas,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.code !== undefined ? { code: patch.code } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    updatedAt: new Date().toISOString(),
    versions,
  }

  await writeCanvasAtomic(canvasPath(dataDir, id), updated)
  return updated
}

export async function listCanvases(
  dataDir: string,
): Promise<Array<{ id: string; title: string; kind?: string; createdAt: string; updatedAt: string }>> {
  const dir = join(dataDir, CANVASES_DIR)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const canvasFiles = entries.filter(f => f.endsWith('.canvas'))
  const results = await Promise.all(
    canvasFiles.map(async (file) => {
      const id = file.replace(/\.canvas$/, '')
      const canvas = await readCanvas(dataDir, id)
      if (!canvas) return null
      return { id: canvas.id, title: canvas.title, kind: canvas.kind, createdAt: canvas.createdAt, updatedAt: canvas.updatedAt }
    }),
  )
  // Most recent first
  return results.filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function deleteCanvas(dataDir: string, id: string): Promise<boolean> {
  try {
    await unlink(canvasPath(dataDir, id))
    return true
  } catch {
    return false
  }
}
