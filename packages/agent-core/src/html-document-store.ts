// HTML document store — reads/writes/updates .htmldoc files for the HTML
// document architecture.
// See docs/plans/2026-04-08-html-document-architecture.md for the full design.

import { readFile, writeFile, mkdir, unlink, rename } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import type { HtmlDocument, DocumentTheme } from '@coagent/shared'

const DOCS_DIR = 'documents'
const MAX_VERSIONS = 5

// ── id / filename helpers ────────────────────────────────────────────────

function genHtmlDocId(): string {
  return 'hdoc_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

function htmlDocPath(dataDir: string, id: string): string {
  return join(dataDir, DOCS_DIR, `${id}.htmldoc`)
}

// ── atomic write ─────────────────────────────────────────────────────────

// Per-doc write queue so concurrent writers to the same .htmldoc serialize
// instead of racing on the tmp file. Without this, two overlapping writes
// both create `<path>.tmp`; the first rename wins, the second ENOENTs.
const writeLocks = new Map<string, Promise<void>>()

async function writeHtmlDocAtomic(path: string, doc: HtmlDocument): Promise<void> {
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

// ── public API ───────────────────────────────────────────────────────────

export interface CreateHtmlDocumentInput {
  title: string
  html: string
  theme: DocumentTheme
  kind?: string
}

export async function createHtmlDocument(
  dataDir: string,
  input: CreateHtmlDocumentInput,
): Promise<HtmlDocument> {
  const id = genHtmlDocId()
  const now = new Date().toISOString()
  const doc: HtmlDocument = {
    id,
    title: input.title,
    kind: input.kind,
    html: input.html,
    theme: input.theme,
    createdAt: now,
    updatedAt: now,
    versions: [],
  }
  await writeHtmlDocAtomic(htmlDocPath(dataDir, id), doc)
  return doc
}

export async function readHtmlDocument(
  dataDir: string,
  id: string,
): Promise<HtmlDocument | null> {
  const path = htmlDocPath(dataDir, id)
  if (!existsSync(path)) return null
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as HtmlDocument
  } catch {
    return null
  }
}

export interface HtmlDocumentPatch {
  title?: string
  html?: string
  theme?: Partial<DocumentTheme>
  kind?: string
}

export async function updateHtmlDocument(
  dataDir: string,
  id: string,
  patch: HtmlDocumentPatch,
): Promise<HtmlDocument | null> {
  const doc = await readHtmlDocument(dataDir, id)
  if (!doc) return null

  // Snapshot current html into versions before mutating
  const snapshot = { savedAt: doc.updatedAt, html: doc.html }
  const versions = [snapshot, ...(doc.versions || [])].slice(0, MAX_VERSIONS)

  const updated: HtmlDocument = {
    ...doc,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.html !== undefined ? { html: patch.html } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    ...(patch.theme !== undefined ? { theme: { ...doc.theme, ...patch.theme } } : {}),
    updatedAt: new Date().toISOString(),
    versions,
  }

  await writeHtmlDocAtomic(htmlDocPath(dataDir, id), updated)
  return updated
}

export async function listHtmlDocuments(
  dataDir: string,
): Promise<Array<{ id: string; title: string; kind?: string; createdAt: string; updatedAt: string }>> {
  const dir = join(dataDir, DOCS_DIR)
  if (!existsSync(dir)) return []
  const { readdir } = await import('fs/promises')
  const entries = await readdir(dir)
  const docs: Array<{ id: string; title: string; kind?: string; createdAt: string; updatedAt: string }> = []
  for (const file of entries) {
    if (!file.endsWith('.htmldoc')) continue
    const id = file.replace(/\.htmldoc$/, '')
    const doc = await readHtmlDocument(dataDir, id)
    if (doc) {
      docs.push({
        id: doc.id,
        title: doc.title,
        kind: doc.kind,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      })
    }
  }
  // Most recent first
  docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return docs
}

export async function deleteHtmlDocument(dataDir: string, id: string): Promise<boolean> {
  const path = htmlDocPath(dataDir, id)
  if (!existsSync(path)) return false
  await unlink(path)
  return true
}
