// Block document store — reads/writes/updates .cadoc files for the Canvas
// document system. Integrates with the existing file-store index so docs
// show up alongside uploads in FilesPane.

import { readFile, writeFile, mkdir, unlink, rename } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import type {
  BlockDocument,
  DocumentBlock,
  DocumentUpdateOp,
  BlockDocumentVersion,
} from '@coagent/shared'
import type { FileEntry } from '@coagent/shared'

const DOCS_DIR = 'documents'
const MAX_VERSIONS = 5

// ── id / filename helpers ────────────────────────────────────────────────

function genDocId(): string {
  return 'doc_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

function genBlockId(): string {
  return 'b_' + Math.random().toString(36).slice(2, 8)
}

function docPath(dataDir: string, id: string): string {
  return join(dataDir, DOCS_DIR, `${id}.cadoc`)
}

function safeFilename(title: string, id: string): string {
  const base = title.trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').slice(0, 60) || 'Document'
  return `${base}.cadoc`
}

// ── atomic write ─────────────────────────────────────────────────────────

// Per-doc write queue so concurrent writers to the same .cadoc serialize
// instead of racing on the tmp file. Without this, two overlapping writes
// both create `<path>.tmp`; the first rename wins, the second ENOENTs.
const writeLocks = new Map<string, Promise<void>>()

async function writeDocAtomic(path: string, doc: BlockDocument): Promise<void> {
  const prev = writeLocks.get(path) || Promise.resolve()
  const next = prev.catch(() => {}).then(async () => {
    await mkdir(join(path, '..'), { recursive: true })
    // Unique tmp name so even if the lock is bypassed we don't collide.
    const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmpPath, JSON.stringify(doc, null, 2), 'utf-8')
    await rename(tmpPath, path)
  })
  writeLocks.set(path, next)
  try {
    await next
  } finally {
    if (writeLocks.get(path) === next) writeLocks.delete(path)
  }
}

// ── ensure every block has an id ─────────────────────────────────────────

function ensureBlockIds(blocks: DocumentBlock[]): DocumentBlock[] {
  return blocks.map(b => {
    if (b.id) return b
    return { ...b, id: genBlockId() }
  })
}

// ── public API ───────────────────────────────────────────────────────────

export interface CreateBlockDocumentInput {
  title: string
  blocks: DocumentBlock[]
  brandKitId?: string
  presetId?: string
}

export async function createBlockDocument(
  dataDir: string,
  input: CreateBlockDocumentInput,
): Promise<BlockDocument> {
  const id = genDocId()
  const now = new Date().toISOString()
  const doc: BlockDocument = {
    id,
    title: input.title,
    brandKitId: input.brandKitId,
    presetId: input.presetId,
    blocks: ensureBlockIds(input.blocks),
    createdAt: now,
    updatedAt: now,
    versions: [],
  }
  await writeDocAtomic(docPath(dataDir, id), doc)
  return doc
}

export async function readBlockDocument(
  dataDir: string,
  id: string,
): Promise<BlockDocument | null> {
  const path = docPath(dataDir, id)
  if (!existsSync(path)) return null
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as BlockDocument
  } catch {
    return null
  }
}

export async function listBlockDocuments(
  dataDir: string,
): Promise<Array<{ id: string; title: string; createdAt: string; updatedAt: string; presetId?: string }>> {
  const dir = join(dataDir, DOCS_DIR)
  if (!existsSync(dir)) return []
  const { readdir } = await import('fs/promises')
  const entries = await readdir(dir)
  const docs: Array<{ id: string; title: string; createdAt: string; updatedAt: string; presetId?: string }> = []
  for (const file of entries) {
    if (!file.endsWith('.cadoc')) continue
    const id = file.replace(/\.cadoc$/, '')
    const doc = await readBlockDocument(dataDir, id)
    if (doc) {
      docs.push({
        id: doc.id,
        title: doc.title,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        presetId: doc.presetId,
      })
    }
  }
  // Most recent first
  docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return docs
}

export async function deleteBlockDocument(dataDir: string, id: string): Promise<void> {
  const path = docPath(dataDir, id)
  if (existsSync(path)) {
    await unlink(path)
  }
}

// ── update ops ───────────────────────────────────────────────────────────

// Replace/delete ops refer to a blockId that may be either a top-level block
// or a child inside a section. These helpers walk both levels so the agent
// can address nested blocks without the caller needing to know the layout.
function replaceBlockRecursive(
  blocks: DocumentBlock[],
  blockId: string,
  replacement: DocumentBlock,
): DocumentBlock[] {
  return blocks.map(b => {
    if (b.id === blockId) {
      return { ...replacement, id: blockId }
    }
    if (b.type === 'section') {
      const nextChildren = b.blocks.map(child =>
        child.id === blockId
          // Guard the replacement is still a valid section child — if the
          // caller tries to nest a header/footer/signoff/section we fall
          // back to keeping the original.
          ? isValidSectionChild(replacement)
            ? ({ ...replacement, id: blockId } as DocumentBlock as typeof child)
            : child
          : child,
      )
      return { ...b, blocks: nextChildren }
    }
    return b
  })
}

function deleteBlockRecursive(blocks: DocumentBlock[], blockId: string): DocumentBlock[] {
  const out: DocumentBlock[] = []
  for (const b of blocks) {
    if (b.id === blockId) continue
    if (b.type === 'section') {
      out.push({ ...b, blocks: b.blocks.filter(child => child.id !== blockId) })
      continue
    }
    out.push(b)
  }
  return out
}

function isValidSectionChild(block: DocumentBlock): boolean {
  switch (block.type) {
    case 'header':
    case 'signoff':
    case 'footer':
    case 'section':
      return false
    default:
      return true
  }
}

export function applyOps(doc: BlockDocument, ops: DocumentUpdateOp[]): BlockDocument {
  let blocks: DocumentBlock[] = [...doc.blocks]
  let title = doc.title
  for (const op of ops) {
    switch (op.op) {
      case 'replace': {
        blocks = replaceBlockRecursive(blocks, op.blockId, op.block)
        break
      }
      case 'insert': {
        const newBlock = op.block.id ? op.block : { ...op.block, id: genBlockId() }
        const idx = Math.max(0, Math.min(op.index, blocks.length))
        blocks = [...blocks.slice(0, idx), newBlock, ...blocks.slice(idx)]
        break
      }
      case 'delete': {
        blocks = deleteBlockRecursive(blocks, op.blockId)
        break
      }
      case 'set_title': {
        title = op.title
        break
      }
    }
  }
  return { ...doc, title, blocks }
}

export async function updateBlockDocument(
  dataDir: string,
  id: string,
  ops: DocumentUpdateOp[],
): Promise<BlockDocument | null> {
  const doc = await readBlockDocument(dataDir, id)
  if (!doc) return null

  // Snapshot current state into versions before mutating
  const snapshot: BlockDocumentVersion = {
    savedAt: doc.updatedAt,
    blocks: doc.blocks,
  }
  const versions = [snapshot, ...(doc.versions || [])].slice(0, MAX_VERSIONS)

  const updated = applyOps(doc, ops)
  updated.versions = versions
  updated.updatedAt = new Date().toISOString()

  await writeDocAtomic(docPath(dataDir, id), updated)
  return updated
}

// ── preset loading ───────────────────────────────────────────────────────

const PRESET_CACHE = new Map<string, { title: string; blocks: DocumentBlock[]; plan?: string }>()

function getPresetsDir(): string {
  // Presets ship alongside the compiled agent-core. At runtime the file lives
  // in dist/block-document-store.js; presets are at ../presets/documents
  // relative to that, or ../presets/documents when running from source (src/).
  const candidates = [
    join(__dirname, '..', 'presets', 'documents'),
    join(__dirname, '..', '..', 'presets', 'documents'),
    join(__dirname, 'presets', 'documents'),
    join(process.cwd(), 'presets', 'documents'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}

export function listPresets(): string[] {
  const dir = getPresetsDir()
  if (!existsSync(dir)) return []
  try {
    // Sync fs list — called once at startup/tool-registration time
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readdirSync } = require('fs') as typeof import('fs')
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''))
  } catch {
    return []
  }
}

export async function loadPreset(
  presetId: string,
): Promise<{ title: string; blocks: DocumentBlock[]; plan?: string } | null> {
  const cached = PRESET_CACHE.get(presetId)
  if (cached) return { title: cached.title, blocks: cached.blocks, plan: cached.plan }
  const path = join(getPresetsDir(), `${presetId}.json`)
  if (!existsSync(path)) return null
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as { title: string; blocks: DocumentBlock[]; plan?: string }
    PRESET_CACHE.set(presetId, parsed)
    return parsed
  } catch {
    return null
  }
}

// ── file-store integration helpers ───────────────────────────────────────

/**
 * Build the FileEntry for a block document so it shows up in FilesPane.
 * Called by agent.ts after createBlockDocument — does NOT write to the
 * file-store index directly; the caller is responsible for upserting into
 * the index (same pattern as uploads).
 */
export function buildBlockDocFileEntry(
  doc: BlockDocument,
  dataDir: string,
  group: string = '',
): FileEntry & { embedding?: number[] } {
  const filename = safeFilename(doc.title, doc.id)
  const path = docPath(dataDir, doc.id)
  const now = new Date().toISOString()
  return {
    id: doc.id,
    type: 'block_document',
    filename,
    path,
    addedAt: doc.createdAt,
    lastAccessed: now,
    summary: `Canvas document: ${doc.title}`,
    group,
    sizeBytes: 0,                // computed by caller if needed
    blockDocId: doc.id,
  }
}
