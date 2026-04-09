# Editable Canvas + Export Save-To Design

**Date:** 2026-04-08
**Status:** Approved, ready for planning

## Goals

1. Stop PDF exports from stacking up in the Files pane.
2. Make the Canvas editable so users can tweak an agent-drafted document without
   asking the agent to rewrite it.

Both features build on the existing `BlockDocument` + `DocumentUpdateOp` model
introduced in the document canvas rewrite.

---

## Part 1 — Export Save-To (stacking fix)

### Problem

`canvas_save_pdf` in `packages/agent-core/src/server.ts:3231` calls `ingestFile()`
on every export, creating a new entry in the Files pane each time. Iterating a
document produces `Report.pdf`, `Report.pdf`, `Report.pdf`… that all pile up.

### Fix

Split the two export flows:

1. **User-initiated export** (Canvas toolbar "Save PDF…" button)
   - Opens a native save dialog via `@tauri-apps/plugin-dialog`.
   - Default filename = `{doc.title}.pdf`; user picks any location on disk.
   - PDF is written straight to the chosen path. It **does not** enter the
     Files pane. The button label changes from "PDF" to "Save PDF…".

2. **Agent-initiated export** (when an agent tool calls `export_document_pdf`
   and needs a `file_id` to attach the PDF to an email, etc.)
   - Dedupe by `docId`. First export of a doc ingests; subsequent exports of
     the same doc overwrite the existing file entry (same filename + file_id).
   - This keeps the agent path working while preventing pileup during drafting.

### Surface changes

- `CanvasPane` toolbar: `Download` icon button stays but triggers save-dialog
  flow; label becomes "Save PDF…".
- New Tauri command `save_pdf_to_path(path, base64)` in `src-tauri/src/main.rs`
  that decodes the base64 and writes it to the chosen path. Returns the path.
- `useAgent.exportCanvasPdf` gets an optional `toPath?: string` param; when
  set, it writes straight to disk instead of sending `canvas_save_pdf`.
- Server-side: track a `Map<docId, fileId>` for agent-initiated exports; on
  `canvas_save_pdf` with `requestId`, look up existing file, overwrite in
  place if found.

---

## Part 2 — Editable Canvas (V1)

### Principles (YAGNI)

- **No edit mode toggle.** Canvas is always editable when the agent isn't
  streaming. Click-to-edit, blur-to-save (Notion-style).
- **Reuse the existing op model.** Every user edit generates a
  `DocumentUpdateOp`, applied locally via `applyDocumentOps`, then sent to the
  server via a new `canvas_client_ops` WS message.
- **Server is source of truth.** Same write path as the `edit_document` tool.
- **Streaming guard.** If the agent starts streaming while a block is being
  edited, the editor commits or cancels, selection clears, and a toast says
  "Agent is updating…". V1 is last-writer-wins; no OT/CRDT.

### What's editable in V1

| Block type     | Editor                                                            |
|----------------|-------------------------------------------------------------------|
| `header`       | Inline inputs for title / subtitle / eyebrow                      |
| `text`         | Raw markdown textarea (monospace)                                 |
| `kpis`         | Per-item label/value/delta inputs; add/remove items               |
| `table`        | `contenteditable` cells; add/remove row + column; emphasis toggle |
| `callout`      | Variant select + title input + markdown textarea                  |
| `image`        | Caption inline input only (no image swap in V1)                   |
| `divider`      | No props (present/absent only)                                    |
| `signoff`      | Name / title / date inputs                                        |
| `footer`       | Note input                                                        |
| `two_column`   | Edit left/right via their inner-block editors; no ratio change    |
| `section`      | Edit `title` / `eyebrow` inline; no variant swap                  |

**Deferred to V2:** chart data editing, image replacement, section/two_column
variant swapping, rich-text toolbar, drag-to-reorder.

### Block-level controls (on hover)

- Move up / Move down (keyboard: `Alt+↑` / `Alt+↓` when block is focused)
- Duplicate (copy + insert-after)
- Delete (confirm for non-empty blocks)

Compile to `insert` / `delete` / `replace` ops.

### Selection and focus

- Click a block → select (subtle ring)
- Click inside an editable region → native focus into the editor
- `Escape` → blur + deselect
- Click outside canvas surface → deselect

### Undo / redo

- Local op history stack (per-session only, not persisted)
- `Cmd+Z` / `Cmd+Shift+Z`
- Entries store `{ forward, inverse }`. Inverse is computed at edit time
  (replace needs previous block snapshot, delete needs the deleted block, etc.)
- Stack cleared when the agent streams new updates — you can't undo across
  an agent write.

### Architecture

```
apps/desktop/src/components/CanvasPane.tsx
├── editable block wrapper (swaps BlockRenderer → BlockEditor per block)
├── BlockControls (hover toolbar: move / duplicate / delete)
└── uses useCanvasEditor()

apps/desktop/src/components/blocks/editors/   (new)
├── HeaderEditor.tsx
├── TextEditor.tsx
├── KpisEditor.tsx
├── TableEditor.tsx
├── CalloutEditor.tsx
├── ImageEditor.tsx       (caption only)
├── SignoffEditor.tsx
├── FooterEditor.tsx
└── BlockControls.tsx

apps/desktop/src/hooks/useCanvasEditor.ts  (new)
├── selection state
├── op history (undo/redo)
├── emit(ops)    — apply locally + send canvas_client_ops
└── undo() / redo()

packages/shared/src/index.ts
└── new WSClientMessage: { type: 'canvas_client_ops', docId, ops }

packages/agent-core/src/server.ts
└── handler for 'canvas_client_ops':
    ├── load doc, apply ops via block-document-store.applyOps
    ├── write .cadoc
    └── broadcast canvas_update to other clients (not sender)
```

### Data flow for a user edit

```
1. User clicks a text block → TextEditor mounts with markdown value
2. User types, blur fires
3. Editor emits op:
     { op: 'replace', blockId, block: { ...original, markdown: newValue } }
4. useCanvasEditor:
   a. Pushes { forward, inverse: replaceWithOriginal } onto history
   b. setCanvasDoc(prev => applyDocumentOps(prev, [op]))  — optimistic
   c. send({ type: 'canvas_client_ops', docId, ops: [op] })
5. Server applies to .cadoc, broadcasts canvas_update to other clients
```

### Error handling

- WS disconnected: op is queued in a pending list and resent on reconnect.
  Optimistic update already applied.
- Server rejects op (doc missing, invalid shape): server sends `canvas_error`,
  client applies the stored `inverse` op to roll back and surfaces a toast.

### Testing

- Manual per-block-type editor smoke test
- Multi-client: two dev windows, edit in one, verify the other updates
- Streaming guard: start an agent draft mid-edit → verify block and toast
- Undo: edit 3 blocks → Cmd+Z three times → verify exact original state

---

## Scope estimate

- Part 1 (stacking fix): ~1 hour, single batch
- Part 2 (editable canvas): 2–3 focused batches
  - Batch A: editor infra + header/text/footer editors + useCanvasEditor +
    server handler
  - Batch B: kpis / table / callout / signoff / image-caption editors
  - Batch C: block controls + undo/redo + streaming guard + multi-client test
