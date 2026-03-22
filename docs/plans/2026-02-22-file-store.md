# File Store Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a file context library where users drag-and-drop files into a Files view, the agent silently ingests them with Haiku (light sampling only), auto-organizes them into agent-created folders on disk (`~/.coagent/files/<group>/`), and the agent can search/retrieve/attach files autonomously.

**Architecture:** Files are stored in real OS folders under `~/.coagent/files/<group>/filename`. A JSON index (`~/.coagent/file-index.json`) tracks metadata and Voyage embeddings of AI-written summaries. The frontend sends files as base64 over WebSocket; the server decodes, ingests with Haiku, embeds the summary, and saves to the right folder. The agent gets 5 new tools. The UI is a full sidebar view with drag-and-drop and grouped file cards.

**Tech Stack:** Node.js `fs/promises`, `pdf-parse` (PDF extraction), Anthropic Haiku (`claude-haiku-4-5-20251001`) for summary+group, Voyage AI (existing embeddings pattern), `@tauri-apps/plugin-shell` `open()` for OS file opening, React drag-and-drop (native HTML5), lucide-react icons.

---

## Task 1: Install pdf-parse + Add Shared Types

**Files:**
- Modify: `packages/agent-core/package.json`
- Modify: `packages/shared/src/index.ts`
- Run: `cd packages/shared && npm run build`

**Step 1: Install pdf-parse in agent-core**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core
pnpm add pdf-parse
pnpm add -D @types/pdf-parse
```

**Step 2: Add FileEntry type to shared/src/index.ts**

Add this block near the top of the file, after the existing interfaces:

```typescript
export interface FileEntry {
  id: string
  filename: string
  path: string          // absolute path on disk
  added: string         // ISO timestamp
  last_accessed: string // ISO timestamp
  summary: string       // AI-written 2-3 sentence description
  group: string         // agent-assigned folder name e.g. "Contracts"
  size_bytes: number
}
```

**Step 3: Add new WS message types to shared/src/index.ts**

In `WSClientMessage`, add:
```typescript
  | { type: 'get_files' }
  | { type: 'ingest_file'; filename: string; mimeType: string; data: string }
  | { type: 'delete_file'; id: string }
```

In `WSServerMessage`, add:
```typescript
  | { type: 'files_update'; files: FileEntry[] }
```

**Step 4: Build shared package**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/shared && npm run build
```

Expected: no TypeScript errors, `dist/` updated.

**Step 5: Commit**

```bash
git add packages/agent-core/package.json packages/shared/src/index.ts
git commit -m "feat: add FileEntry types and pdf-parse dependency"
```

---

## Task 2: Create file-store.ts

**Files:**
- Create: `packages/agent-core/src/file-store.ts`
- Create: `packages/agent-core/src/__tests__/file-store.test.ts`

**Step 1: Write the failing test**

Create `packages/agent-core/src/__tests__/file-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { listFiles, deleteFileEntry, getStorageStats } from '../file-store.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'coagent-files-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('listFiles', () => {
  it('returns empty array when no index exists', async () => {
    const files = await listFiles(tmpDir)
    expect(files).toEqual([])
  })
})

describe('getStorageStats', () => {
  it('returns zeros when no files exist', async () => {
    const stats = await getStorageStats(tmpDir)
    expect(stats.totalFiles).toBe(0)
    expect(stats.totalBytes).toBe(0)
    expect(stats.largestFiles).toEqual([])
  })
})

describe('deleteFileEntry', () => {
  it('does nothing when id does not exist', async () => {
    await expect(deleteFileEntry(tmpDir, 'nonexistent-id')).resolves.not.toThrow()
  })
})
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core
pnpm test -- --reporter=verbose 2>&1 | head -30
```

Expected: FAIL — `file-store.js` not found.

**Step 3: Create packages/agent-core/src/file-store.ts**

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { readFile, writeFile, mkdir, unlink, rename } from 'fs/promises'
import { existsSync } from 'fs'
import { join, extname } from 'path'
import type { FileEntry } from '@coagent/shared'

const INDEX_FILE = 'file-index.json'
const FILES_DIR = 'files'
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings'
const getVoyageKey = () => process.env.VOYAGE_API_KEY ?? ''

// ── Internal index type (includes embedding, not sent to frontend) ────────────

interface FileIndexEntry extends FileEntry {
  embedding: number[]
}

// ── Index I/O ────────────────────────────────────────────────────────────────

async function readIndex(dataDir: string): Promise<FileIndexEntry[]> {
  const path = join(dataDir, INDEX_FILE)
  if (!existsSync(path)) return []
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

async function writeIndex(dataDir: string, entries: FileIndexEntry[]): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, INDEX_FILE), JSON.stringify(entries, null, 2), 'utf-8')
}

// ── Voyage embedding ──────────────────────────────────────────────────────────

async function embedText(text: string): Promise<number[]> {
  const res = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getVoyageKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: [text], model: 'voyage-3-lite' })
  })
  const data = await res.json() as { data: { embedding: number[] }[] }
  return data.data[0].embedding
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ── File content sampling ─────────────────────────────────────────────────────

async function sampleContent(filename: string, buffer: Buffer, mimeType: string): Promise<{ type: 'text'; text: string } | { type: 'image'; base64: string; mediaType: string }> {
  const ext = extname(filename).toLowerCase()
  const isImage = mimeType.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)

  if (isImage) {
    // Claude reads images natively — pass as base64
    const b64 = buffer.toString('base64')
    const mediaType = (mimeType.startsWith('image/') ? mimeType : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
    return { type: 'image', base64: b64, mediaType }
  }

  if (ext === '.pdf') {
    try {
      const pdfParse = (await import('pdf-parse')).default
      const data = await pdfParse(buffer, { max: 2 }) // first 2 pages only
      return { type: 'text', text: data.text.slice(0, 3000) }
    } catch {
      return { type: 'text', text: buffer.toString('utf-8', 0, 3000) }
    }
  }

  if (ext === '.csv') {
    const lines = buffer.toString('utf-8').split('\n').slice(0, 20).join('\n')
    return { type: 'text', text: lines }
  }

  // DOCX, TXT, and everything else — read as text, first 1000 chars
  return { type: 'text', text: buffer.toString('utf-8', 0, 1000) }
}

// ── Haiku summary + group ─────────────────────────────────────────────────────

async function generateSummaryAndGroup(
  filename: string,
  sample: { type: 'text'; text: string } | { type: 'image'; base64: string; mediaType: string }
): Promise<{ summary: string; group: string }> {
  const anthropic = new Anthropic()

  const prompt = `You are analyzing a file to generate a brief summary and assign it to a folder group.

File: ${filename}

Write a 2-3 sentence summary of what this file is and what it contains. Then assign it to a short, descriptive group name (1-2 words, title case, e.g. "Contracts", "Clients", "Reports", "Images", "Spreadsheets").

Respond in this exact JSON format:
{"summary": "...", "group": "..."}`

  const content: Anthropic.MessageParam['content'] = sample.type === 'image'
    ? [
        { type: 'image', source: { type: 'base64', media_type: sample.mediaType as any, data: sample.base64 } },
        { type: 'text', text: prompt }
      ]
    : [{ type: 'text', text: `${prompt}\n\nFile contents (sample):\n${sample.text}` }]

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{ role: 'user', content }]
  })

  const text = (response.content[0] as { type: 'text'; text: string }).text.trim()

  try {
    const parsed = JSON.parse(text)
    return {
      summary: parsed.summary ?? 'No summary available.',
      group: parsed.group ?? 'Files'
    }
  } catch {
    return { summary: text.slice(0, 200), group: 'Files' }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function ingestFile(
  dataDir: string,
  filename: string,
  buffer: Buffer,
  mimeType: string
): Promise<FileEntry> {
  // Sample file content
  const sample = await sampleContent(filename, buffer, mimeType)

  // Generate summary + group with Haiku
  const { summary, group } = await generateSummaryAndGroup(filename, sample)

  // Save file to ~/.coagent/files/<group>/<filename>
  const groupDir = join(dataDir, FILES_DIR, group)
  await mkdir(groupDir, { recursive: true })
  const filePath = join(groupDir, filename)
  await writeFile(filePath, buffer)

  // Embed the summary
  let embedding: number[] = []
  if (getVoyageKey()) {
    embedding = await embedText(`${filename} ${summary}`)
  }

  // Update index
  const entry: FileIndexEntry = {
    id: crypto.randomUUID(),
    filename,
    path: filePath,
    added: new Date().toISOString(),
    last_accessed: new Date().toISOString(),
    summary,
    group,
    size_bytes: buffer.length,
    embedding
  }

  const index = await readIndex(dataDir)
  index.push(entry)
  await writeIndex(dataDir, index)

  console.log(`[FileStore] Ingested: ${filename} → ${group} (${buffer.length} bytes)`)

  // Return without embedding (frontend doesn't need it)
  const { embedding: _, ...fileEntry } = entry
  return fileEntry
}

export async function listFiles(dataDir: string): Promise<FileEntry[]> {
  const index = await readIndex(dataDir)
  return index.map(({ embedding: _, ...entry }) => entry)
}

export async function searchFiles(dataDir: string, query: string, limit = 5): Promise<FileEntry[]> {
  if (!getVoyageKey()) {
    // Fallback: keyword search on filename + summary
    const index = await readIndex(dataDir)
    const q = query.toLowerCase()
    return index
      .filter(e => e.filename.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q))
      .slice(0, limit)
      .map(({ embedding: _, ...entry }) => entry)
  }

  const queryEmb = await embedText(query)
  const index = await readIndex(dataDir)

  const scored = index.map(e => ({
    entry: e,
    score: e.embedding.length > 0 ? cosine(queryEmb, e.embedding) : 0
  }))
  scored.sort((a, b) => b.score - a.score)

  const top = scored.slice(0, limit)

  // Update last_accessed for retrieved files
  const topIds = new Set(top.map(s => s.entry.id))
  const updated = index.map(e => topIds.has(e.id) ? { ...e, last_accessed: new Date().toISOString() } : e)
  await writeIndex(dataDir, updated)

  return top.map(({ entry: { embedding: _, ...entry } }) => entry)
}

export async function readFileContent(dataDir: string, id: string): Promise<string> {
  const index = await readIndex(dataDir)
  const entry = index.find(e => e.id === id)
  if (!entry) throw new Error(`File ${id} not found`)

  // Update last_accessed
  const updated = index.map(e => e.id === id ? { ...e, last_accessed: new Date().toISOString() } : e)
  await writeIndex(dataDir, updated)

  const buffer = await readFile(entry.path)
  const ext = extname(entry.filename).toLowerCase()

  if (ext === '.pdf') {
    try {
      const pdfParse = (await import('pdf-parse')).default
      const data = await pdfParse(buffer)
      return data.text
    } catch {
      return buffer.toString('utf-8')
    }
  }

  return buffer.toString('utf-8')
}

export async function deleteFileEntry(dataDir: string, id: string): Promise<void> {
  const index = await readIndex(dataDir)
  const entry = index.find(e => e.id === id)
  if (!entry) return

  // Delete from disk if exists
  if (existsSync(entry.path)) {
    await unlink(entry.path).catch(() => {})
  }

  // Remove from index
  await writeIndex(dataDir, index.filter(e => e.id !== id))
  console.log(`[FileStore] Deleted: ${entry.filename}`)
}

export async function getStorageStats(dataDir: string): Promise<{
  totalFiles: number
  totalBytes: number
  largestFiles: { filename: string; size_bytes: number }[]
}> {
  const index = await readIndex(dataDir)
  const totalBytes = index.reduce((sum, e) => sum + e.size_bytes, 0)
  const largestFiles = [...index]
    .sort((a, b) => b.size_bytes - a.size_bytes)
    .slice(0, 5)
    .map(e => ({ filename: e.filename, size_bytes: e.size_bytes }))

  return { totalFiles: index.length, totalBytes, largestFiles }
}
```

**Step 4: Run tests**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core
pnpm test -- --reporter=verbose 2>&1 | grep -E "PASS|FAIL|✓|✗"
```

Expected: All 3 tests PASS.

**Step 5: Commit**

```bash
git add packages/agent-core/src/file-store.ts packages/agent-core/src/__tests__/file-store.test.ts
git commit -m "feat: add file-store module with ingest, search, delete, stats"
```

---

## Task 3: Add Agent Tools + WS Handlers

**Files:**
- Modify: `packages/agent-core/src/agent.ts` (INTERNAL_TOOLS array + runLoop handlers)
- Modify: `packages/agent-core/src/server.ts` (WS message handlers + initial send)

**Step 1: Add 5 tools to INTERNAL_TOOLS in agent.ts**

In `agent.ts`, after the `update_settings` tool in the `INTERNAL_TOOLS` array, add:

```typescript
  {
    name: 'search_files',
    description: 'Search files the user has shared with you. Returns files matching the query with their summaries. Use this when the user references a document or asks you to find something.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What to search for, e.g. "Johnson contract" or "client spreadsheet"' },
        limit: { type: 'number', description: 'Max results (default 5)' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_file',
    description: 'Read the full content of a file by its ID. Use after search_files when you need the actual content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'The file ID from search_files results' }
      },
      required: ['id']
    }
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the file store by its ID. Only do this when the user explicitly asks.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'The file ID to delete' }
      },
      required: ['id']
    }
  },
  {
    name: 'get_storage_stats',
    description: 'Get file storage statistics: total files, total size, and largest files. Use when the user asks about their storage usage.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  }
```

**Step 2: Add imports to agent.ts**

At the top of `agent.ts`, add the import:

```typescript
import { searchFiles, readFileContent, deleteFileEntry, getStorageStats } from './file-store.js'
```

**Step 3: Add tool handlers in runLoop in agent.ts**

In the `tool_use` handling section of `runLoop`, after the `update_settings` handler and before the `else` catch-all, add:

```typescript
          } else if (block.name === 'search_files') {
            const { query, limit } = block.input as { query: string; limit?: number }
            const files = await searchFiles(this.dataDir, query, limit ?? 5)
            if (files.length === 0) {
              result = 'No files found matching that query.'
            } else {
              result = files.map(f =>
                `[id:${f.id}] [${f.group}] ${f.filename} — ${f.summary}`
              ).join('\n')
            }

          } else if (block.name === 'read_file') {
            const { id } = block.input as { id: string }
            result = await readFileContent(this.dataDir, id)

          } else if (block.name === 'delete_file') {
            const { id } = block.input as { id: string }
            await deleteFileEntry(this.dataDir, id)
            result = 'File deleted.'

          } else if (block.name === 'get_storage_stats') {
            const stats = await getStorageStats(this.dataDir)
            const mb = (stats.totalBytes / 1024 / 1024).toFixed(1)
            result = `${stats.totalFiles} files, ${mb} MB total.\nLargest: ${stats.largestFiles.map(f => `${f.filename} (${(f.size_bytes / 1024).toFixed(0)}KB)`).join(', ')}`
```

**Step 4: Update system prompt in agent.ts**

In `buildSystemPrompt`, update the always-available tools line:

```typescript
Always-available tools: memory tools, search_tools, queue_approval, add_done_item, add_todo, complete_todo, run_python, web search (composio_search), PDF generation (text_to_pdf), file tools (search_files, read_file, delete_file, get_storage_stats).
```

**Step 5: Add WS handlers to server.ts**

First, add the import at the top of `server.ts`:

```typescript
import { listFiles, ingestFile, deleteFileEntry } from './file-store.js'
```

In the `wss.on('connection', ...)` block, after the `sendIntegrations` call, add:

```typescript
  listFiles(DATA_DIR).then(files => send(ws, { type: 'files_update', files })).catch(console.error)
```

In the `ws.on('message', ...)` block, add these handlers:

```typescript
    if (msg.type === 'get_files') {
      const files = await listFiles(DATA_DIR)
      send(ws, { type: 'files_update', files })
    }

    if (msg.type === 'ingest_file') {
      try {
        const buffer = Buffer.from(msg.data, 'base64')
        await ingestFile(DATA_DIR, msg.filename, buffer, msg.mimeType)
        const files = await listFiles(DATA_DIR)
        send(ws, { type: 'files_update', files })
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to ingest file: ${err.message}` })
      }
    }

    if (msg.type === 'delete_file') {
      try {
        await deleteFileEntry(DATA_DIR, msg.id)
        const files = await listFiles(DATA_DIR)
        send(ws, { type: 'files_update', files })
      } catch (err: any) {
        send(ws, { type: 'error', message: `Failed to delete file: ${err.message}` })
      }
    }
```

**Step 6: Commit**

```bash
git add packages/agent-core/src/agent.ts packages/agent-core/src/server.ts
git commit -m "feat: add file agent tools and WS handlers"
```

---

## Task 4: Add Files State to useAgent.ts

**Files:**
- Modify: `apps/desktop/src/hooks/useAgent.ts`

**Step 1: Add files state and handlers**

In `useAgent.ts`, add `FileEntry` to the import from `@coagent/shared`:

```typescript
import type { ApprovalItem, DoneItem, TodoItem, AgentMessage, WSServerMessage, WSClientMessage, Integration, AgentSettings, FileEntry } from '@coagent/shared'
```

Add state:
```typescript
  const [files, setFiles] = useState<FileEntry[]>([])
```

In the `socket.onmessage` handler, add:
```typescript
      if (msg.type === 'files_update') setFiles(msg.files)
```

Add callbacks:

```typescript
  const ingestFile = useCallback((filename: string, mimeType: string, data: string) => {
    send({ type: 'ingest_file', filename, mimeType, data })
  }, [send])

  const deleteFile = useCallback((id: string) => {
    send({ type: 'delete_file', id })
  }, [send])
```

Add to the return object:
```typescript
  return { queue, done, todos, messages, streamingText, thinking, connected, integrations, settings, files, error, chat, approve, reject, editQueueItem, completeTodo, deleteTodo, connectIntegration, disconnectIntegration, updateSettings, ingestFile, deleteFile }
```

**Step 2: Commit**

```bash
git add apps/desktop/src/hooks/useAgent.ts
git commit -m "feat: add files state and ingest/delete callbacks to useAgent"
```

---

## Task 5: Add Files to Sidebar

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx`

**Step 1: Update View type and add nav item**

In `Sidebar.tsx`, update the `View` type:

```typescript
export type View = 'chat' | 'queue' | 'todos' | 'done' | 'settings' | 'files'
```

Add `FolderOpen` to the lucide-react import:

```typescript
import {
  Inbox, MessageSquare, CheckCircle2, Settings, ListTodo,
  ChevronRight, FolderOpen
} from 'lucide-react'
```

In the nav items section, add Files after Done:

```typescript
        <NavItem icon={FolderOpen} label="Files" active={view === 'files'} onClick={() => onViewChange('files')} />
```

**Step 2: Commit**

```bash
git add apps/desktop/src/components/Sidebar.tsx
git commit -m "feat: add Files nav item to sidebar"
```

---

## Task 6: Create FilesPane.tsx

**Files:**
- Create: `apps/desktop/src/components/FilesPane.tsx`

**Step 1: Create the component**

```typescript
import React, { useCallback } from 'react'
import { Trash2, FileText, Sheet, Image, File } from 'lucide-react'
import { open } from '@tauri-apps/plugin-shell'
import { cn } from '@/lib/utils'
import type { FileEntry } from '@coagent/shared'

interface FilesPaneProps {
  files: FileEntry[]
  onIngest: (filename: string, mimeType: string, data: string) => void
  onDelete: (id: string) => void
}

function fileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') return FileText
  if (['csv', 'xlsx', 'xls'].includes(ext ?? '')) return Sheet
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext ?? '')) return Image
  return File
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function FilesPane({ files, onIngest, onDelete }: FilesPaneProps) {
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    readAndSend(e.dataTransfer.files)
  }, [onIngest])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handlePicker = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = (e) => {
      const files = (e.target as HTMLInputElement).files
      if (files) readAndSend(files)
    }
    input.click()
  }, [onIngest])

  function readAndSend(fileList: FileList) {
    for (const file of fileList) {
      const reader = new FileReader()
      reader.onload = (e) => {
        const result = e.target?.result as string
        const base64 = result.split(',')[1]
        onIngest(file.name, file.type || 'application/octet-stream', base64)
      }
      reader.readAsDataURL(file)
    }
  }

  async function handleOpen(path: string) {
    try {
      await open(path)
    } catch (err) {
      console.error('Failed to open file:', err)
    }
  }

  // Group files by their group field
  const groups = files.reduce<Record<string, FileEntry[]>>((acc, file) => {
    if (!acc[file.group]) acc[file.group] = []
    acc[file.group].push(file)
    return acc
  }, {})

  const groupNames = Object.keys(groups).sort()

  return (
    <div
      className="flex-1 bg-white flex flex-col overflow-hidden"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {/* Header */}
      <div className="px-8 pt-7 pb-4 flex items-center justify-between flex-shrink-0">
        <div>
          <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-widest mb-1">Context</p>
          <h1 className="text-[19px] font-bold tracking-tight text-neutral-900">Files</h1>
        </div>
        <button
          type="button"
          onClick={handlePicker}
          className="text-[12px] font-medium px-3 py-1.5 rounded-lg bg-neutral-900 text-white hover:bg-neutral-700 transition-colors"
        >
          + Add files
        </button>
      </div>

      {/* Drop zone hint when empty */}
      {files.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
          <div className="w-12 h-12 rounded-full bg-neutral-100 flex items-center justify-center">
            <File size={20} className="text-neutral-400" />
          </div>
          <p className="text-[14px] font-medium text-neutral-500">Drop files to share with CoAgent</p>
          <p className="text-[12px] text-neutral-400 max-w-xs">Contracts, spreadsheets, docs — CoAgent reads them and uses them as context.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-8 pb-8">
          {/* Drop zone banner */}
          <div
            className="border-2 border-dashed border-neutral-200 rounded-xl py-4 text-center mb-6 text-[12px] text-neutral-400 cursor-pointer hover:border-neutral-300 hover:text-neutral-500 transition-colors"
            onClick={handlePicker}
          >
            Drop files anywhere or click to add
          </div>

          {/* Groups */}
          {groupNames.map(group => (
            <div key={group} className="mb-8">
              <p className="text-[11px] font-semibold text-neutral-400 uppercase tracking-widest mb-3">
                {group}
              </p>
              <div className="grid grid-cols-3 gap-3">
                {groups[group].map(file => {
                  const Icon = fileIcon(file.filename)
                  return (
                    <div
                      key={file.id}
                      className="group relative border border-neutral-100 rounded-xl p-3 hover:border-neutral-200 transition-colors cursor-pointer"
                      onClick={() => handleOpen(file.path)}
                    >
                      {/* Delete button */}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onDelete(file.id) }}
                        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-neutral-300 hover:text-red-500 p-0.5"
                      >
                        <Trash2 size={12} />
                      </button>

                      {/* Icon */}
                      <div className="w-10 h-10 rounded-lg bg-neutral-50 flex items-center justify-center mb-2">
                        <Icon size={18} className="text-neutral-400" />
                      </div>

                      {/* Filename */}
                      <p className="text-[12px] font-medium text-neutral-800 truncate leading-tight">
                        {file.filename}
                      </p>

                      {/* Meta */}
                      <p className="text-[10px] text-neutral-400 mt-0.5">
                        {formatDate(file.added)} · {formatBytes(file.size_bytes)}
                      </p>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add apps/desktop/src/components/FilesPane.tsx
git commit -m "feat: create FilesPane component with drag-drop, grouped folders, OS open"
```

---

## Task 7: Wire FilesPane into App.tsx

**Files:**
- Modify: `apps/desktop/src/App.tsx`

**Step 1: Add imports and destructure from useAgent**

Add import:
```typescript
import { FilesPane } from '@/components/FilesPane'
```

Update the `useAgent()` destructure to include:
```typescript
const { queue, done, todos, messages, streamingText, thinking, connected, integrations, settings, files, error, chat, approve, reject, editQueueItem, completeTodo, deleteTodo, connectIntegration, disconnectIntegration, updateSettings, ingestFile, deleteFile } = useAgent()
```

**Step 2: Add Files view render**

After the `{view === 'done' && ...}` block, add:

```typescript
        {view === 'files' && (
          <FilesPane
            files={files}
            onIngest={ingestFile}
            onDelete={deleteFile}
          />
        )}
```

**Step 3: Verify the app compiles**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop
pnpm build 2>&1 | tail -20
```

Expected: no TypeScript errors.

**Step 4: Commit**

```bash
git add apps/desktop/src/App.tsx
git commit -m "feat: wire FilesPane into App with files view"
```

---

## Manual Test Checklist

With both `packages/agent-core` (`pnpm dev`) and `apps/desktop` (`pnpm tauri dev`) running:

- [ ] Files nav item appears in sidebar
- [ ] Clicking Files shows the empty state with drop zone
- [ ] Dragging a PDF onto the app ingests it and it appears in the right group
- [ ] Dragging a CSV ingests it into a different group than PDFs
- [ ] Hovering a file card shows the trash icon
- [ ] Clicking trash removes the file from the view and disk
- [ ] Clicking a file card opens it in the OS default app
- [ ] "Add files" button opens a file picker
- [ ] In Chat: "What files do you have?" — agent responds with file summaries
- [ ] In Chat: "Find my contract" — agent returns matching file
- [ ] Server logs show `[FileStore] Ingested:` on upload
- [ ] `~/.coagent/files/<group>/` directories exist on disk after upload
- [ ] `~/.coagent/file-index.json` contains entries after upload
