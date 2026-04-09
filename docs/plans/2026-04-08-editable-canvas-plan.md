# Editable Canvas + Export Save-To Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Per feedback_review_at_end.md, run batches back-to-back with a single review pass at the very end (not per-task).

**Goal:** Stop PDF exports from stacking up in the Files pane, and make the Canvas directly editable by the user using the same op model the agent uses.

**Architecture:** User-initiated exports open a native save dialog and write the PDF to a chosen disk path (not ingested into Files). Agent-initiated exports dedupe by `docId`. The Canvas becomes always-editable-when-not-streaming via per-block editors that emit `DocumentUpdateOp`s; ops are applied locally via `applyDocumentOps` and sent to the server via a new `canvas_client_ops` WS message for persistence.

**Tech Stack:** TypeScript, React, Tauri 2 (+ `tauri-plugin-dialog`), vitest (for agent-core), existing `BlockDocument` / `DocumentUpdateOp` model in `packages/shared/src/blocks.ts`.

**Design doc:** `docs/plans/2026-04-08-editable-canvas-design.md`

---

## Phase 1 — Export Save-To (stacking fix)

### Task 1: Install tauri-plugin-dialog

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src-tauri/src/main.rs` (init block around line 1020-1045)
- Modify: `apps/desktop/src-tauri/capabilities/default.json`

**Step 1: Add Cargo dependency**

In `apps/desktop/src-tauri/Cargo.toml`, under `[dependencies]`, add:
```toml
tauri-plugin-dialog = "2"
```

**Step 2: Add JS dependency**

In `apps/desktop/package.json`, under `"dependencies"`, add:
```json
"@tauri-apps/plugin-dialog": "^2.4.1",
```
Then run: `cd apps/desktop && pnpm install`

**Step 3: Register the plugin in Rust**

In `apps/desktop/src-tauri/src/main.rs`, find the `tauri::Builder::default()` chain and add `.plugin(tauri_plugin_dialog::init())` alongside the other `.plugin(...)` calls.

**Step 4: Allow the save dialog in capabilities**

In `apps/desktop/src-tauri/capabilities/default.json`, add `"dialog:allow-save"` to the `permissions` array.

**Step 5: Commit**
```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock apps/desktop/package.json apps/desktop/pnpm-lock.yaml apps/desktop/src-tauri/src/main.rs apps/desktop/src-tauri/capabilities/default.json
git commit -m "feat(desktop): add tauri-plugin-dialog for native save dialog"
```

---

### Task 2: Canvas toolbar "Save PDF…" → native dialog

**Files:**
- Modify: `apps/desktop/src/components/CanvasPane.tsx` (toolbar button around line 113-123)
- Modify: `apps/desktop/src/hooks/useAgent.ts` (`exportCanvasPdf`, line 882-896)

**Step 1: Change `exportCanvasPdf` to accept a target path**

In `apps/desktop/src/hooks/useAgent.ts`, at the top imports add:
```ts
import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'
```

Wait — `writeFile` needs `tauri-plugin-fs`. Instead, add a new Rust command `write_file_bytes` in main.rs (see step 2) to avoid another plugin.

Back in `useAgent.ts`, rewrite `exportCanvasPdf`:
```ts
const exportCanvasPdf = useCallback(async () => {
  if (!canvasDoc) return
  setCanvasExporting(true)
  try {
    // 1. Ask where to save
    const defaultName = (canvasDoc.title || 'Document').trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '_') + '.pdf'
    const targetPath = await save({
      defaultPath: defaultName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (!targetPath) {
      setCanvasExporting(false)
      return
    }
    // 2. Render via hidden WKWebView to base64
    const { base64 } = await exportDocumentPdfViaTauri(canvasDoc, brandFromSettings(settings))
    // 3. Write bytes to chosen path
    await invoke('write_file_bytes', { path: targetPath, base64 })
    // 4. Surface toast with the file path
    setExportToast({ fileId: '', filename: targetPath.split('/').pop() || defaultName, filePath: targetPath })
  } catch (err: any) {
    console.error('[Canvas] Export failed:', err)
    setError(`Export failed: ${err?.message || String(err)}`)
    setTimeout(() => setError(null), 5000)
  } finally {
    setCanvasExporting(false)
  }
}, [canvasDoc, settings])
```

The `exportToast` state already exists (`App.tsx` ExportToast component at line 30-72 accepts `filePath` and shows a "Reveal" button, which is exactly what we want for save-to-disk flow).

**Step 2: Add `write_file_bytes` Tauri command**

In `apps/desktop/src-tauri/src/main.rs`, add (near other commands like `read_file_bytes`):
```rust
#[tauri::command]
fn write_file_bytes(path: String, base64: String) -> Result<(), String> {
    use base64_standard_decode; // See helper below — or use existing base64_decode_from
    let bytes = base64_decode_from(&base64).map_err(|e| format!("decode: {}", e))?;
    std::fs::write(&path, &bytes).map_err(|e| format!("write: {}", e))?;
    Ok(())
}
```
If no base64 decoder helper exists alongside `base64_encode_to`, add one. Search main.rs for `base64_encode_to` to find the right spot.

Register in `invoke_handler!` (line 1049-1059) by adding `write_file_bytes,`.

**Step 3: Update ExportToast state type**

In `useAgent.ts`, find `exportToast` state and its type. Update it to include optional `filePath`:
```ts
const [exportToast, setExportToast] = useState<{ fileId: string; filename: string; filePath?: string } | null>(null)
```

**Step 4: Change toolbar button label**

In `apps/desktop/src/components/CanvasPane.tsx` around line 113-123, the button already shows `PDF`. Change it to show `Save PDF…`:
```tsx
{exporting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
Save PDF…
```

**Step 5: Manual test**

1. Restart: `pnpm tauri dev` in `apps/desktop/`
2. Ask agent to draft a doc so canvas opens
3. Click "Save PDF…" → dialog appears
4. Pick Desktop → verify PDF written there
5. Cancel dialog → verify nothing happens, no error
6. Verify the new PDF does NOT appear in the Files pane

**Step 6: Commit**
```bash
git add apps/desktop/src/hooks/useAgent.ts apps/desktop/src/components/CanvasPane.tsx apps/desktop/src-tauri/src/main.rs
git commit -m "feat(canvas): save PDF via native dialog instead of Files pane"
```

---

### Task 3: Dedupe agent-initiated exports by docId

**Files:**
- Modify: `packages/agent-core/src/server.ts` (canvas_save_pdf handler, line 3209-3245)

**Step 1: Add docId → fileId map**

Near the top of `server.ts` where other module-level state lives, add:
```ts
// Tracks the most recent exported PDF file for each Canvas docId so repeated
// agent-initiated exports overwrite a single Files entry instead of stacking.
const docIdToExportedFileId = new Map<string, string>()
```

**Step 2: Dedupe in the handler**

In the `canvas_save_pdf` handler (line 3209-3245), replace the `ingestFile` block with:
```ts
const buffer = Buffer.from(msg.base64, 'base64')
const safeTitle = (doc.title || 'Document').trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').slice(0, 60) || 'Document'
const filename = `${safeTitle}.pdf`

// If we've exported this doc before and the file still exists, overwrite.
let entry: FileEntry | null = null
const existingId = docIdToExportedFileId.get(msg.docId)
if (existingId) {
  const prior = await getFile(DATA_DIR, existingId)  // or whatever the file-store lookup is
  if (prior) {
    entry = await overwriteFile(DATA_DIR, existingId, buffer, filename)
  }
}
if (!entry) {
  entry = await ingestFile(DATA_DIR, filename, buffer, 'application/pdf')
  docIdToExportedFileId.set(msg.docId, entry.id)
}
```

Check `packages/agent-core/src/file-store.ts` for the actual function names. If `overwriteFile` doesn't exist, add it:
```ts
export async function overwriteFile(
  dataDir: string,
  fileId: string,
  buffer: Buffer,
  filename: string,
): Promise<FileEntry | null> {
  const existing = await getFile(dataDir, fileId)
  if (!existing) return null
  const path = filePath(dataDir, fileId)
  await writeFile(path, buffer)
  existing.filename = filename
  existing.size = buffer.length
  existing.updatedAt = new Date().toISOString()
  await saveIndex(dataDir)  // whatever the persistence call is
  return existing
}
```

**Step 3: Write a vitest for the dedupe logic**

Create `packages/agent-core/src/__tests__/canvas-export-dedupe.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ingestFile, overwriteFile, getFile } from '../file-store.js'

describe('canvas export dedupe', () => {
  let dataDir: string
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'coagent-test-'))
  })

  it('overwriteFile replaces bytes under the same id', async () => {
    const first = await ingestFile(dataDir, 'Doc.pdf', Buffer.from('v1'), 'application/pdf')
    const second = await overwriteFile(dataDir, first.id, Buffer.from('v2-longer'), 'Doc.pdf')
    expect(second).not.toBeNull()
    expect(second!.id).toBe(first.id)
    const fetched = await getFile(dataDir, first.id)
    expect(fetched!.size).toBe('v2-longer'.length)
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })
})
```

**Step 4: Run the test**

```bash
cd packages/agent-core && pnpm test canvas-export-dedupe
```
Expected: PASS

**Step 5: Commit**
```bash
git add packages/agent-core/src/server.ts packages/agent-core/src/file-store.ts packages/agent-core/src/__tests__/canvas-export-dedupe.test.ts
git commit -m "feat(canvas): dedupe agent-initiated PDF exports by docId"
```

---

## Phase 2 — Editable Canvas Infrastructure

### Task 4: New WS message type `canvas_client_ops`

**Files:**
- Modify: `packages/shared/src/index.ts` (WSClientMessage union around line 231)

**Step 1: Add to the client message union**

```ts
| { type: 'canvas_client_ops'; docId: string; ops: DocumentUpdateOp[] }
```

Add alongside the existing `canvas_open_doc` entry. Keep the existing `DocumentUpdateOp` import at the top.

**Step 2: Commit**
```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): add canvas_client_ops WS message type"
```

---

### Task 5: Server handler for `canvas_client_ops`

**Files:**
- Modify: `packages/agent-core/src/server.ts` (add new handler near the canvas_* handlers around line 3150-3210)

**Step 1: Handler**

```ts
if (msg.type === 'canvas_client_ops') {
  try {
    const updated = await updateBlockDocument(DATA_DIR, msg.docId, msg.ops)
    if (!updated) {
      send(ws, { type: 'canvas_error', docId: msg.docId, message: 'Document not found' })
      return
    }
    // Rebroadcast to OTHER clients so multi-window stays in sync. We don't
    // echo back to the sender — they've already applied optimistically.
    for (const client of wss.clients) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'canvas_update', docId: msg.docId, ops: msg.ops }))
      }
    }
  } catch (err: any) {
    console.error('[Canvas] canvas_client_ops failed:', err)
    send(ws, { type: 'canvas_error', docId: msg.docId, message: err?.message || 'Failed to apply ops' })
  }
}
```

Import `updateBlockDocument` from `./block-document-store.js` at the top if not already imported.

**Step 2: Vitest for updateBlockDocument with all op types**

Create `packages/agent-core/src/__tests__/client-ops.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createBlockDocument, updateBlockDocument, readBlockDocument } from '../block-document-store.js'

describe('canvas_client_ops updateBlockDocument', () => {
  let dataDir: string
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'coagent-test-')) })
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }) })

  it('applies replace op', async () => {
    const doc = await createBlockDocument(dataDir, { title: 'T', blocks: [
      { id: 'b1', type: 'text', markdown: 'old' },
    ] })
    const updated = await updateBlockDocument(dataDir, doc.id, [
      { op: 'replace', blockId: 'b1', block: { id: 'b1', type: 'text', markdown: 'new' } },
    ])
    expect(updated!.blocks[0]).toMatchObject({ type: 'text', markdown: 'new' })
  })

  it('applies insert + delete ops', async () => {
    const doc = await createBlockDocument(dataDir, { title: 'T', blocks: [
      { id: 'b1', type: 'text', markdown: 'a' },
    ] })
    const afterInsert = await updateBlockDocument(dataDir, doc.id, [
      { op: 'insert', index: 1, block: { id: 'b2', type: 'text', markdown: 'b' } },
    ])
    expect(afterInsert!.blocks).toHaveLength(2)
    const afterDelete = await updateBlockDocument(dataDir, doc.id, [
      { op: 'delete', blockId: 'b1' },
    ])
    expect(afterDelete!.blocks).toHaveLength(1)
    expect(afterDelete!.blocks[0].id).toBe('b2')
  })

  it('applies set_title op', async () => {
    const doc = await createBlockDocument(dataDir, { title: 'Old', blocks: [] })
    const updated = await updateBlockDocument(dataDir, doc.id, [
      { op: 'set_title', title: 'New' },
    ])
    expect(updated!.title).toBe('New')
  })
})
```
Check the actual `createBlockDocument` signature in `block-document-store.ts` and adjust the input shape to match.

**Step 3: Run the test**
```bash
cd packages/agent-core && pnpm test client-ops
```
Expected: PASS

**Step 4: Commit**
```bash
git add packages/agent-core/src/server.ts packages/agent-core/src/__tests__/client-ops.test.ts
git commit -m "feat(canvas): server handler for canvas_client_ops"
```

---

### Task 6: `useCanvasEditor` hook (selection, history, emit)

**Files:**
- Create: `apps/desktop/src/hooks/useCanvasEditor.ts`
- Modify: `apps/desktop/src/hooks/useAgent.ts` (export a `sendCanvasClientOps` function)

**Step 1: Expose `sendCanvasClientOps` from useAgent**

In `useAgent.ts`, add near `exportCanvasPdf`:
```ts
const sendCanvasClientOps = useCallback((docId: string, ops: DocumentUpdateOp[]) => {
  send({ type: 'canvas_client_ops', docId, ops } as any)
}, [send])
```
Add `sendCanvasClientOps` to the returned object at the bottom.

**Step 2: Create the hook**

`apps/desktop/src/hooks/useCanvasEditor.ts`:
```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BlockDocument, DocumentBlock, DocumentUpdateOp } from '@coagent/shared'
import { applyDocumentOps } from '@/lib/canvas'

// Each history entry stores forward and inverse ops so undo/redo can flip
// between them without re-reading the doc.
interface HistoryEntry {
  forward: DocumentUpdateOp[]
  inverse: DocumentUpdateOp[]
}

interface UseCanvasEditorArgs {
  doc: BlockDocument | null
  streaming: boolean
  onLocalChange: (next: BlockDocument) => void
  onEmit: (docId: string, ops: DocumentUpdateOp[]) => void
}

export function useCanvasEditor({ doc, streaming, onLocalChange, onEmit }: UseCanvasEditorArgs) {
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)
  const historyRef = useRef<HistoryEntry[]>([])
  const futureRef = useRef<HistoryEntry[]>([])

  // Clear selection and history when a new streaming run starts or when the
  // underlying doc id changes.
  useEffect(() => {
    setSelectedBlockId(null)
    if (streaming) {
      historyRef.current = []
      futureRef.current = []
    }
  }, [doc?.id, streaming])

  const emit = useCallback((entry: HistoryEntry) => {
    if (!doc) return
    historyRef.current.push(entry)
    futureRef.current = []  // new action invalidates redo stack
    const next = applyDocumentOps(doc, entry.forward)
    onLocalChange(next)
    onEmit(doc.id, entry.forward)
  }, [doc, onLocalChange, onEmit])

  const undo = useCallback(() => {
    if (!doc) return
    const entry = historyRef.current.pop()
    if (!entry) return
    futureRef.current.push(entry)
    const next = applyDocumentOps(doc, entry.inverse)
    onLocalChange(next)
    onEmit(doc.id, entry.inverse)
  }, [doc, onLocalChange, onEmit])

  const redo = useCallback(() => {
    if (!doc) return
    const entry = futureRef.current.pop()
    if (!entry) return
    historyRef.current.push(entry)
    const next = applyDocumentOps(doc, entry.forward)
    onLocalChange(next)
    onEmit(doc.id, entry.forward)
  }, [doc, onLocalChange, onEmit])

  // Helper for the common replace-block case — computes inverse automatically
  const replaceBlock = useCallback((blockId: string, newBlock: DocumentBlock) => {
    if (!doc) return
    const original = findBlock(doc.blocks, blockId)
    if (!original) return
    emit({
      forward: [{ op: 'replace', blockId, block: newBlock }],
      inverse: [{ op: 'replace', blockId, block: original }],
    })
  }, [doc, emit])

  const deleteBlock = useCallback((blockId: string) => {
    if (!doc) return
    const original = findBlock(doc.blocks, blockId)
    const index = findBlockIndex(doc.blocks, blockId)
    if (!original || index < 0) return
    emit({
      forward: [{ op: 'delete', blockId }],
      inverse: [{ op: 'insert', index, block: original }],
    })
  }, [doc, emit])

  const insertBlock = useCallback((index: number, block: DocumentBlock) => {
    emit({
      forward: [{ op: 'insert', index, block }],
      inverse: [{ op: 'delete', blockId: block.id }],
    })
  }, [emit])

  return {
    selectedBlockId,
    setSelectedBlockId,
    replaceBlock,
    deleteBlock,
    insertBlock,
    undo,
    redo,
    canUndo: historyRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
  }
}

function findBlock(blocks: DocumentBlock[], id: string): DocumentBlock | null {
  for (const b of blocks) {
    if (b.id === id) return b
    if (b.type === 'section') {
      for (const c of b.blocks) if (c.id === id) return c as DocumentBlock
    }
  }
  return null
}

function findBlockIndex(blocks: DocumentBlock[], id: string): number {
  return blocks.findIndex(b => b.id === id)
}
```

**Step 3: Type check**
```bash
cd apps/desktop && pnpm tsc --noEmit
```
Expected: no new errors.

**Step 4: Commit**
```bash
git add apps/desktop/src/hooks/useCanvasEditor.ts apps/desktop/src/hooks/useAgent.ts
git commit -m "feat(canvas): add useCanvasEditor hook with op history"
```

---

### Task 7: Streaming guard in CanvasPane

**Files:**
- Modify: `apps/desktop/src/components/CanvasPane.tsx`

**Step 1: Block edits while streaming**

In CanvasPane, when `streaming` is true, the canvas must not be editable and selection must be cleared. Add state clearing in the existing `useEffect` that watches `streaming`, or pass `streaming` to `useCanvasEditor` (which already handles it in Task 6).

Also show a transient toast when the agent starts streaming while a block is selected:
```tsx
useEffect(() => {
  if (streaming && selectedBlockId) {
    // Could show a toast here via a prop callback
    console.log('[Canvas] Agent started streaming; clearing edit selection')
  }
}, [streaming, selectedBlockId])
```

**Step 2: Commit (small, no behavior shift yet — just prep)**
```bash
git add apps/desktop/src/components/CanvasPane.tsx
git commit -m "feat(canvas): prep CanvasPane for edit mode + streaming guard"
```

---

## Phase 3 — Editors Batch A (header, text, footer, signoff)

### Task 8: HeaderEditor

**Files:**
- Create: `apps/desktop/src/components/blocks/editors/HeaderEditor.tsx`

**Step 1: Component**
```tsx
import { useState } from 'react'
import type { HeaderBlock } from '@coagent/shared'

export function HeaderEditor({ block, onCommit }: {
  block: HeaderBlock
  onCommit: (next: HeaderBlock) => void
}) {
  const [title, setTitle] = useState(block.title)
  const [subtitle, setSubtitle] = useState(block.subtitle ?? '')
  const [eyebrow, setEyebrow] = useState(block.eyebrow ?? '')

  const commit = () => {
    if (title === block.title && subtitle === (block.subtitle ?? '') && eyebrow === (block.eyebrow ?? '')) return
    onCommit({
      ...block,
      title,
      subtitle: subtitle || undefined,
      eyebrow: eyebrow || undefined,
    })
  }

  return (
    <div className="space-y-1">
      {/* eyebrow */}
      <input
        value={eyebrow}
        onChange={e => setEyebrow(e.target.value)}
        onBlur={commit}
        placeholder="Eyebrow"
        className="text-[10px] uppercase tracking-wider text-neutral-500 bg-transparent outline-none w-full border-0 focus:ring-0"
      />
      {/* title */}
      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        onBlur={commit}
        placeholder="Title"
        className="text-[22px] font-semibold text-neutral-900 dark:text-neutral-100 bg-transparent outline-none w-full border-0 focus:ring-0"
      />
      {/* subtitle */}
      <input
        value={subtitle}
        onChange={e => setSubtitle(e.target.value)}
        onBlur={commit}
        placeholder="Subtitle"
        className="text-[13px] text-neutral-600 dark:text-neutral-400 bg-transparent outline-none w-full border-0 focus:ring-0"
      />
    </div>
  )
}
```

**Step 2: Commit**
```bash
git add apps/desktop/src/components/blocks/editors/HeaderEditor.tsx
git commit -m "feat(canvas): HeaderEditor component"
```

---

### Task 9: TextEditor

**Files:**
- Create: `apps/desktop/src/components/blocks/editors/TextEditor.tsx`

**Step 1: Component**

Raw markdown textarea. On blur, commit if changed.
```tsx
import { useState, useRef, useEffect } from 'react'
import type { TextBlock } from '@coagent/shared'

export function TextEditor({ block, onCommit }: {
  block: TextBlock
  onCommit: (next: TextBlock) => void
}) {
  const [value, setValue] = useState(block.markdown)
  const ref = useRef<HTMLTextAreaElement>(null)

  // Auto-resize textarea to content height
  useEffect(() => {
    if (!ref.current) return
    ref.current.style.height = 'auto'
    ref.current.style.height = ref.current.scrollHeight + 'px'
  }, [value])

  const commit = () => {
    if (value === block.markdown) return
    onCommit({ ...block, markdown: value })
  }

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={e => setValue(e.target.value)}
      onBlur={commit}
      className="w-full bg-transparent outline-none border-0 focus:ring-0 font-mono text-[12.5px] text-neutral-800 dark:text-neutral-200 resize-none leading-relaxed"
      placeholder="Write markdown…"
    />
  )
}
```

**Step 2: Commit**
```bash
git add apps/desktop/src/components/blocks/editors/TextEditor.tsx
git commit -m "feat(canvas): TextEditor component (markdown textarea)"
```

---

### Task 10: FooterEditor + SignoffEditor

**Files:**
- Create: `apps/desktop/src/components/blocks/editors/FooterEditor.tsx`
- Create: `apps/desktop/src/components/blocks/editors/SignoffEditor.tsx`

**Step 1: FooterEditor**
```tsx
import { useState } from 'react'
import type { FooterBlock } from '@coagent/shared'

export function FooterEditor({ block, onCommit }: {
  block: FooterBlock
  onCommit: (next: FooterBlock) => void
}) {
  const [note, setNote] = useState(block.note ?? '')
  const commit = () => {
    if (note === (block.note ?? '')) return
    onCommit({ ...block, note: note || undefined })
  }
  return (
    <input
      value={note}
      onChange={e => setNote(e.target.value)}
      onBlur={commit}
      placeholder="Footer note"
      className="w-full text-center text-[11px] text-neutral-500 bg-transparent outline-none border-0 focus:ring-0"
    />
  )
}
```

**Step 2: SignoffEditor**
```tsx
import { useState } from 'react'
import type { SignoffBlock } from '@coagent/shared'

export function SignoffEditor({ block, onCommit }: {
  block: SignoffBlock
  onCommit: (next: SignoffBlock) => void
}) {
  const [name, setName] = useState(block.name)
  const [title, setTitle] = useState(block.title ?? '')
  const [date, setDate] = useState(block.date ?? '')

  const commit = () => {
    if (name === block.name && title === (block.title ?? '') && date === (block.date ?? '')) return
    onCommit({ ...block, name, title: title || undefined, date: date || undefined })
  }
  return (
    <div className="space-y-1">
      <input value={name} onChange={e => setName(e.target.value)} onBlur={commit} placeholder="Name" className="text-[13px] font-semibold bg-transparent outline-none w-full border-0 focus:ring-0" />
      <input value={title} onChange={e => setTitle(e.target.value)} onBlur={commit} placeholder="Title" className="text-[12px] text-neutral-500 bg-transparent outline-none w-full border-0 focus:ring-0" />
      <input value={date} onChange={e => setDate(e.target.value)} onBlur={commit} placeholder="Date" className="text-[12px] text-neutral-500 bg-transparent outline-none w-full border-0 focus:ring-0" />
    </div>
  )
}
```

**Step 3: Commit**
```bash
git add apps/desktop/src/components/blocks/editors/FooterEditor.tsx apps/desktop/src/components/blocks/editors/SignoffEditor.tsx
git commit -m "feat(canvas): FooterEditor + SignoffEditor"
```

---

### Task 11: Wire editors into CanvasPane via BlockEditor wrapper

**Files:**
- Create: `apps/desktop/src/components/blocks/editors/BlockEditor.tsx`
- Modify: `apps/desktop/src/components/CanvasPane.tsx`

**Step 1: BlockEditor wrapper**

```tsx
import type { DocumentBlock } from '@coagent/shared'
import { BlockRenderer } from '@/components/blocks/BlockRenderer'
import { HeaderEditor } from './HeaderEditor'
import { TextEditor } from './TextEditor'
import { FooterEditor } from './FooterEditor'
import { SignoffEditor } from './SignoffEditor'

export function BlockEditor({ block, isEditing, onCommit }: {
  block: DocumentBlock
  isEditing: boolean
  onCommit: (next: DocumentBlock) => void
}) {
  if (!isEditing) return <BlockRenderer block={block} />
  switch (block.type) {
    case 'header': return <HeaderEditor block={block} onCommit={onCommit as any} />
    case 'text': return <TextEditor block={block} onCommit={onCommit as any} />
    case 'footer': return <FooterEditor block={block} onCommit={onCommit as any} />
    case 'signoff': return <SignoffEditor block={block} onCommit={onCommit as any} />
    default: return <BlockRenderer block={block} />  // editors for others added in next batches
  }
}
```

**Step 2: Wire into CanvasPane**

In `CanvasPane.tsx`:
- Import `useCanvasEditor`, `BlockEditor`
- Accept new prop `onDocumentChange?: (next: BlockDocument) => void` (and `onEmit?: (docId, ops) => void`)
- Construct the editor hook:
  ```tsx
  const editor = useCanvasEditor({
    doc,
    streaming,
    onLocalChange: next => onDocumentChange?.(next),
    onEmit: (docId, ops) => onEmit?.(docId, ops),
  })
  ```
- Replace the `BlockArrival` child with a wrapper that handles selection and renders `BlockEditor`:
  ```tsx
  <BlockArrival ...>
    <div
      onClick={() => !streaming && editor.setSelectedBlockId(block.id)}
      className={editor.selectedBlockId === block.id ? 'ring-2 ring-blue-400 rounded-md -m-2 p-2' : ''}
    >
      <BlockEditor
        block={block}
        isEditing={!streaming && editor.selectedBlockId === block.id}
        onCommit={next => editor.replaceBlock(block.id, next)}
      />
    </div>
  </BlockArrival>
  ```

**Step 3: Wire props from App.tsx**

In `App.tsx` where `<CanvasPane>` is rendered, pass:
```tsx
<CanvasPane
  doc={canvasDoc}
  streaming={canvasStreaming}
  brand={...}
  onClose={closeCanvas}
  onExportPdf={exportCanvasPdf}
  exporting={canvasExporting}
  onDocumentChange={next => setCanvasDocFromClient(next)}
  onEmit={(docId, ops) => sendCanvasClientOps(docId, ops)}
/>
```

`setCanvasDocFromClient` is the state setter exposed from `useAgent` for the canvas doc — it may already exist as a setter used internally; if not, expose one that just calls the existing `setCanvasDoc`.

**Step 4: Type check + manual smoke**
```bash
cd apps/desktop && pnpm tsc --noEmit
```
Then restart dev and:
1. Ask agent to draft a doc
2. After streaming ends, click a text block → editor appears, text is editable
3. Edit and blur → verify the change persists after a hard reload
4. Edit the title (header block) → verify it saves

**Step 5: Commit**
```bash
git add apps/desktop/src/components/blocks/editors/BlockEditor.tsx apps/desktop/src/components/CanvasPane.tsx apps/desktop/src/App.tsx apps/desktop/src/hooks/useAgent.ts
git commit -m "feat(canvas): click-to-edit text/header/footer/signoff blocks"
```

---

## Phase 4 — Editors Batch B (kpis, table, callout, image caption)

### Task 12: CalloutEditor

**Files:**
- Create: `apps/desktop/src/components/blocks/editors/CalloutEditor.tsx`
- Modify: `apps/desktop/src/components/blocks/editors/BlockEditor.tsx` (add callout case)

**Step 1: Component**
```tsx
import { useState } from 'react'
import type { CalloutBlock, CalloutVariant } from '@coagent/shared'

const VARIANTS: CalloutVariant[] = ['info', 'warn', 'success', 'tip']

export function CalloutEditor({ block, onCommit }: {
  block: CalloutBlock
  onCommit: (next: CalloutBlock) => void
}) {
  const [variant, setVariant] = useState<CalloutVariant>(block.variant)
  const [title, setTitle] = useState(block.title ?? '')
  const [markdown, setMarkdown] = useState(block.markdown)

  const commit = () => {
    if (variant === block.variant && title === (block.title ?? '') && markdown === block.markdown) return
    onCommit({ ...block, variant, title: title || undefined, markdown })
  }

  return (
    <div className="space-y-2 border border-neutral-300 dark:border-neutral-700 rounded-md p-3">
      <select value={variant} onChange={e => { setVariant(e.target.value as CalloutVariant); setTimeout(commit, 0) }} className="text-[11px] bg-transparent outline-none">
        {VARIANTS.map(v => <option key={v} value={v}>{v}</option>)}
      </select>
      <input value={title} onChange={e => setTitle(e.target.value)} onBlur={commit} placeholder="Title" className="text-[13px] font-semibold bg-transparent outline-none w-full border-0 focus:ring-0" />
      <textarea value={markdown} onChange={e => setMarkdown(e.target.value)} onBlur={commit} placeholder="Markdown" className="w-full bg-transparent outline-none border-0 focus:ring-0 font-mono text-[12px] resize-none" />
    </div>
  )
}
```

**Step 2: Add callout case in BlockEditor**
```tsx
case 'callout': return <CalloutEditor block={block} onCommit={onCommit as any} />
```

**Step 3: Commit**
```bash
git add apps/desktop/src/components/blocks/editors/CalloutEditor.tsx apps/desktop/src/components/blocks/editors/BlockEditor.tsx
git commit -m "feat(canvas): CalloutEditor"
```

---

### Task 13: KpisEditor

**Files:**
- Create: `apps/desktop/src/components/blocks/editors/KpisEditor.tsx`
- Modify: `apps/desktop/src/components/blocks/editors/BlockEditor.tsx`

**Step 1: Component**
```tsx
import { useState } from 'react'
import type { KpisBlock, KpiItem } from '@coagent/shared'
import { X, Plus } from 'lucide-react'

export function KpisEditor({ block, onCommit }: {
  block: KpisBlock
  onCommit: (next: KpisBlock) => void
}) {
  const [items, setItems] = useState<KpiItem[]>(block.items)

  const update = (next: KpiItem[]) => {
    setItems(next)
    onCommit({ ...block, items: next })
  }
  const updateItem = (i: number, patch: Partial<KpiItem>) => {
    update(items.map((it, idx) => idx === i ? { ...it, ...patch } : it))
  }
  const addItem = () => update([...items, { label: 'New', value: '0' }])
  const removeItem = (i: number) => update(items.filter((_, idx) => idx !== i))

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
      {items.map((item, i) => (
        <div key={i} className="relative border border-neutral-300 dark:border-neutral-700 rounded-md p-2 pr-6">
          <input value={item.label} onChange={e => updateItem(i, { label: e.target.value })} placeholder="Label" className="text-[10px] uppercase tracking-wide text-neutral-500 bg-transparent outline-none w-full border-0 focus:ring-0" />
          <input value={item.value} onChange={e => updateItem(i, { value: e.target.value })} placeholder="Value" className="text-[16px] font-semibold bg-transparent outline-none w-full border-0 focus:ring-0" />
          <input value={item.delta ?? ''} onChange={e => updateItem(i, { delta: e.target.value || undefined })} placeholder="Δ" className="text-[11px] text-neutral-500 bg-transparent outline-none w-full border-0 focus:ring-0" />
          <button onClick={() => removeItem(i)} className="absolute top-1 right-1 text-neutral-400 hover:text-red-500" aria-label="Remove"><X size={12} /></button>
        </div>
      ))}
      <button onClick={addItem} className="flex items-center justify-center gap-1 border border-dashed border-neutral-300 dark:border-neutral-700 rounded-md p-2 text-[11px] text-neutral-500 hover:bg-neutral-50 dark:hover:bg-neutral-800">
        <Plus size={12} /> Add KPI
      </button>
    </div>
  )
}
```

**Step 2: Add to BlockEditor switch**
```tsx
case 'kpis': return <KpisEditor block={block} onCommit={onCommit as any} />
```

**Step 3: Commit**
```bash
git add apps/desktop/src/components/blocks/editors/KpisEditor.tsx apps/desktop/src/components/blocks/editors/BlockEditor.tsx
git commit -m "feat(canvas): KpisEditor"
```

---

### Task 14: TableEditor

**Files:**
- Create: `apps/desktop/src/components/blocks/editors/TableEditor.tsx`
- Modify: `apps/desktop/src/components/blocks/editors/BlockEditor.tsx`

**Step 1: Component**

```tsx
import { useState } from 'react'
import type { TableBlock, TableRow } from '@coagent/shared'
import { Plus, X } from 'lucide-react'

export function TableEditor({ block, onCommit }: {
  block: TableBlock
  onCommit: (next: TableBlock) => void
}) {
  const [headers, setHeaders] = useState(block.headers)
  const [rows, setRows] = useState<TableRow[]>(block.rows)
  const [caption, setCaption] = useState(block.caption ?? '')

  const commit = (nextHeaders = headers, nextRows = rows, nextCaption = caption) => {
    onCommit({ ...block, headers: nextHeaders, rows: nextRows, caption: nextCaption || undefined })
  }

  const updateHeader = (i: number, v: string) => {
    const next = headers.map((h, idx) => idx === i ? v : h)
    setHeaders(next)
  }
  const updateCell = (r: number, c: number, v: string) => {
    const next = rows.map((row, ri) => ri === r
      ? { ...row, cells: row.cells.map((cell, ci) => ci === c ? v : cell) }
      : row)
    setRows(next)
  }
  const addRow = () => {
    const next = [...rows, { cells: headers.map(() => '') }]
    setRows(next)
    commit(headers, next, caption)
  }
  const removeRow = (r: number) => {
    const next = rows.filter((_, i) => i !== r)
    setRows(next)
    commit(headers, next, caption)
  }
  const addCol = () => {
    const nextHeaders = [...headers, 'Col']
    const nextRows = rows.map(row => ({ ...row, cells: [...row.cells, ''] }))
    setHeaders(nextHeaders)
    setRows(nextRows)
    commit(nextHeaders, nextRows, caption)
  }
  const removeCol = (c: number) => {
    const nextHeaders = headers.filter((_, i) => i !== c)
    const nextRows = rows.map(row => ({ ...row, cells: row.cells.filter((_, i) => i !== c) }))
    setHeaders(nextHeaders)
    setRows(nextRows)
    commit(nextHeaders, nextRows, caption)
  }

  return (
    <div className="space-y-2">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} className="border border-neutral-300 dark:border-neutral-700 p-1 relative group">
                <input value={h} onChange={e => updateHeader(i, e.target.value)} onBlur={() => commit()} className="w-full font-semibold bg-transparent outline-none border-0 focus:ring-0" />
                <button onClick={() => removeCol(i)} className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 text-red-500 text-[10px]"><X size={10} /></button>
              </th>
            ))}
            <th className="w-8 border-0">
              <button onClick={addCol} className="text-neutral-400 hover:text-neutral-600"><Plus size={12} /></button>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="group">
              {row.cells.map((cell, c) => (
                <td key={c} className="border border-neutral-300 dark:border-neutral-700 p-1">
                  <input value={cell} onChange={e => updateCell(r, c, e.target.value)} onBlur={() => commit()} className="w-full bg-transparent outline-none border-0 focus:ring-0" />
                </td>
              ))}
              <td className="w-8 border-0">
                <button onClick={() => removeRow(r)} className="opacity-0 group-hover:opacity-100 text-red-500"><X size={12} /></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={addRow} className="flex items-center gap-1 text-[11px] text-neutral-500 hover:text-neutral-700">
        <Plus size={12} /> Add row
      </button>
      <input value={caption} onChange={e => setCaption(e.target.value)} onBlur={() => commit()} placeholder="Caption" className="w-full text-[11px] italic text-neutral-500 bg-transparent outline-none border-0 focus:ring-0" />
    </div>
  )
}
```

**Step 2: Add to BlockEditor switch**
```tsx
case 'table': return <TableEditor block={block} onCommit={onCommit as any} />
```

**Step 3: Commit**
```bash
git add apps/desktop/src/components/blocks/editors/TableEditor.tsx apps/desktop/src/components/blocks/editors/BlockEditor.tsx
git commit -m "feat(canvas): TableEditor"
```

---

### Task 15: ImageEditor (caption only)

**Files:**
- Create: `apps/desktop/src/components/blocks/editors/ImageEditor.tsx`
- Modify: `apps/desktop/src/components/blocks/editors/BlockEditor.tsx`

**Step 1: Component**
```tsx
import { useState } from 'react'
import type { ImageBlock } from '@coagent/shared'

export function ImageEditor({ block, onCommit }: {
  block: ImageBlock
  onCommit: (next: ImageBlock) => void
}) {
  const [caption, setCaption] = useState(block.caption ?? '')
  const commit = () => {
    if (caption === (block.caption ?? '')) return
    onCommit({ ...block, caption: caption || undefined })
  }
  return (
    <figure className="space-y-1">
      <img src={block.src} alt={block.alt || ''} style={{ maxWidth: block.maxWidth || '100%' }} />
      <input value={caption} onChange={e => setCaption(e.target.value)} onBlur={commit} placeholder="Caption" className="w-full text-[11px] italic text-neutral-500 bg-transparent outline-none border-0 focus:ring-0" />
    </figure>
  )
}
```

**Step 2: Add to switch**
```tsx
case 'image': return <ImageEditor block={block} onCommit={onCommit as any} />
```

**Step 3: Commit**
```bash
git add apps/desktop/src/components/blocks/editors/ImageEditor.tsx apps/desktop/src/components/blocks/editors/BlockEditor.tsx
git commit -m "feat(canvas): ImageEditor (caption-only V1)"
```

---

## Phase 5 — Block Controls + Undo/Redo

### Task 16: BlockControls hover toolbar

**Files:**
- Create: `apps/desktop/src/components/blocks/editors/BlockControls.tsx`
- Modify: `apps/desktop/src/components/CanvasPane.tsx`

**Step 1: Component**
```tsx
import { ArrowUp, ArrowDown, Copy, Trash2 } from 'lucide-react'

export function BlockControls({ onMoveUp, onMoveDown, onDuplicate, onDelete, visible }: {
  onMoveUp?: () => void
  onMoveDown?: () => void
  onDuplicate: () => void
  onDelete: () => void
  visible: boolean
}) {
  if (!visible) return null
  return (
    <div className="absolute -top-3 right-2 flex items-center gap-0.5 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-sm p-0.5 z-10">
      <button onClick={onMoveUp} disabled={!onMoveUp} className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-30" title="Move up"><ArrowUp size={12} /></button>
      <button onClick={onMoveDown} disabled={!onMoveDown} className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-30" title="Move down"><ArrowDown size={12} /></button>
      <button onClick={onDuplicate} className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700" title="Duplicate"><Copy size={12} /></button>
      <button onClick={onDelete} className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-red-500" title="Delete"><Trash2 size={12} /></button>
    </div>
  )
}
```

**Step 2: Wire into CanvasPane**

In the block mapping, wrap each block in a `relative group` container and show `BlockControls` on `group-hover`. The move handlers are implemented via `delete + insert` ops:

```tsx
const moveBlock = (fromIndex: number, toIndex: number) => {
  if (!canvasDoc) return
  const block = canvasDoc.blocks[fromIndex]
  if (!block) return
  editor.emit({
    forward: [
      { op: 'delete', blockId: block.id },
      { op: 'insert', index: toIndex, block },
    ],
    inverse: [
      { op: 'delete', blockId: block.id },
      { op: 'insert', index: fromIndex, block },
    ],
  })
}
```

Expose `emit` from `useCanvasEditor` (currently private — make it public or add `moveBlock` / `duplicateBlock` helpers to the hook).

**Step 3: Smoke test**
- Restart dev
- Hover a block → toolbar appears
- Move up/down → order changes, persists after reload
- Duplicate → new block, persists
- Delete → block removed, persists

**Step 4: Commit**
```bash
git add apps/desktop/src/components/blocks/editors/BlockControls.tsx apps/desktop/src/components/CanvasPane.tsx apps/desktop/src/hooks/useCanvasEditor.ts
git commit -m "feat(canvas): block hover controls (move/duplicate/delete)"
```

---

### Task 17: Keyboard shortcuts (Cmd+Z, Alt+↑/↓, Escape)

**Files:**
- Modify: `apps/desktop/src/components/CanvasPane.tsx`

**Step 1: Keydown listener**

Inside CanvasPane, after `useCanvasEditor`:
```tsx
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    // Only handle when canvas is focused (not e.g. when typing in the chat)
    const active = document.activeElement
    const inEditor = active?.closest('#canvas-surface') != null
    if (!inEditor) return

    const meta = e.metaKey || e.ctrlKey
    if (meta && e.key === 'z' && !e.shiftKey) {
      e.preventDefault()
      editor.undo()
    } else if (meta && (e.key === 'Z' || (e.shiftKey && e.key === 'z'))) {
      e.preventDefault()
      editor.redo()
    } else if (e.key === 'Escape') {
      editor.setSelectedBlockId(null)
      ;(active as HTMLElement | null)?.blur?.()
    }
    // Alt+arrows: move the selected block
    if (e.altKey && editor.selectedBlockId) {
      const idx = doc.blocks.findIndex(b => b.id === editor.selectedBlockId)
      if (idx < 0) return
      if (e.key === 'ArrowUp' && idx > 0) {
        e.preventDefault()
        moveBlock(idx, idx - 1)
      }
      if (e.key === 'ArrowDown' && idx < doc.blocks.length - 1) {
        e.preventDefault()
        moveBlock(idx, idx + 1)
      }
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}, [editor, doc.blocks])
```

**Step 2: Commit**
```bash
git add apps/desktop/src/components/CanvasPane.tsx
git commit -m "feat(canvas): keyboard shortcuts (undo/redo, alt-arrows, escape)"
```

---

## Phase 6 — End-to-end verification

### Task 18: Full e2e verification

**Files:**
- None (verification only)

**Step 1: Stacking fix**
1. Ask agent to draft a doc (opens Canvas)
2. Click "Save PDF…" → pick Desktop → verify PDF written
3. Verify the PDF does NOT appear in the Files pane
4. Ask agent to call `export_document_pdf` (tool call path, e.g., "export this and attach to an email to me")
5. Verify a single Files entry appears
6. Ask agent to edit the doc and re-export
7. Verify the **same** Files entry is overwritten (no stacking)

**Step 2: Editable canvas**
1. Draft a doc with header + text + kpis + table + callout
2. Click text block → edit → blur → verify saved
3. Click header → edit title → blur → verify saved
4. Click kpis → change a value → blur → verify saved
5. Click table → edit a cell → add a row → blur → verify saved
6. Click callout → change variant → verify saved
7. Hover a block → click delete → verify removed
8. Hover a block → click duplicate → verify copy
9. Hover a block → click move down → verify reordered
10. Edit something → Cmd+Z → verify undo works
11. Cmd+Shift+Z → verify redo works
12. Reload the app → verify all edits persisted to .cadoc

**Step 3: Streaming guard**
1. Edit a block while agent is idle → works
2. Ask agent "edit this doc" (starts streaming) → verify selection clears + edits block
3. Streaming ends → edits resume

**Step 4: Multi-client**
1. Open second dev window (`open http://localhost:1420` in another browser, or open the app twice)
2. Edit a block in window 1
3. Verify window 2 updates within ~200ms

**Step 5: Any fix commits needed from the verification round**
```bash
git add <files>
git commit -m "fix(canvas): <specific issue found in verification>"
```

---

## Phase 7 — Final code review

### Task 19: End-of-plan code review

Per feedback_review_at_end.md, run a single review pass now — NOT per-batch.

1. Use the `superpowers:code-reviewer` agent OR `code-reviewer` agent
2. Review scope: all commits since the start of this plan
3. Focus areas:
   - Consistency with existing patterns (BlockRenderer, useAgent, server.ts)
   - Memory leaks in the op history stack
   - Race conditions between optimistic updates and server echoes
   - Tauri plugin integration correctness
   - TypeScript strictness
4. Address any critical/important findings
5. Commit any fixes

---

## DONE state

- Canvas toolbar shows "Save PDF…" and opens a native dialog
- Agent-initiated exports of the same doc overwrite a single Files entry
- Users can click any editable block type and edit inline
- Edits generate `DocumentUpdateOp`s, are applied locally, and persist to `.cadoc`
- Hover controls for move/duplicate/delete
- Cmd+Z/Cmd+Shift+Z undo/redo
- Agent streaming safely disables editing without data loss
- Multi-client sync works
- All agent-core tests pass
- No new TypeScript errors
