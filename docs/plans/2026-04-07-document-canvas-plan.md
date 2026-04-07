# Document Canvas Phase 1 Implementation Plan

> **For Claude:** Execute task-by-task. Each task should build, typecheck, and not break existing behavior.

**Goal:** Ship the end-to-end block document loop — agent composes, Canvas streams it live next to chat, user reviews, exports to PDF, agent attaches to email.

**Architecture:** Block JSON document model (`.cadoc`), new `CanvasPane` split-view beside `ChatPane`, read-only block rendering with simulated streaming animation, HTML → PDF via Tauri webview print-to-PDF. Old pdfmake templates stay for backward compatibility.

**Tech Stack:** React + TypeScript + Tailwind (existing), `react-markdown` + `remark-gfm` for text blocks, `recharts` for charts, Tauri webview native print-to-PDF.

**Design doc:** `docs/plans/2026-04-07-document-canvas-design.md`

---

## Task 1: Block type definitions

**Files:**
- Create: `packages/shared/src/blocks.ts`
- Modify: `packages/shared/src/index.ts` (re-export)

**What:** TypeScript types for all 11 blocks, `BlockDocument`, `BrandKit`, `DocumentUpdateOp`. Each block is a discriminated union on `type`.

**Acceptance:**
- `pnpm -F @coagent/shared build` clean
- Types importable from `@coagent/shared` across packages

---

## Task 2: Block document store

**Files:**
- Create: `packages/agent-core/src/block-document-store.ts`

**What:**
- `createBlockDocument(dataDir, doc)` — writes `{id}.cadoc` + indexes in file-store with `type: 'block_document'`
- `readBlockDocument(dataDir, id)` — reads from disk
- `updateBlockDocument(dataDir, id, ops)` — applies ops (replace/insert/delete), snapshots previous version into `versions[]` (keep last 5), writes atomically
- `listBlockDocuments(dataDir, filter?)` — filter by preset/brand/date
- `deleteBlockDocument(dataDir, id)` — removes file + index entry

Atomic tmp+rename writes. Reuses existing file-store index so `.cadoc` files show up in FilesPane automatically.

**Acceptance:**
- Can create a doc, read it back, apply an op, see new version in `versions[]`
- Doc shows in `getFiles()` output with `type: 'block_document'`

---

## Task 3: Preset files

**Files:**
- Create: `packages/agent-core/presets/documents/client-status.json`
- Create: `packages/agent-core/presets/documents/daily-briefing.json`
- Create: `packages/agent-core/presets/documents/marketing-audit.json`

**What:** Pre-composed `{title, blocks[]}` JSON files. Each has placeholder content the agent replaces.

**Acceptance:**
- Preset files are valid `BlockDocument` shape (minus id/createdAt)
- Hand-inspect: each one produces a reasonable report if instantiated as-is

---

## Task 4: Agent tools (compose_document, edit_document, list_documents)

**Files:**
- Modify: `packages/agent-core/src/agent.ts` (add 3 tools to TOOLS array, add handlers in switch)
- Modify: `packages/agent-core/src/agent.ts` (system prompt: add block library section)
- Modify: `packages/shared/src/index.ts` (add `canvas_open` / `canvas_update` / `canvas_close` WS messages)
- Modify: `packages/agent-core/src/server.ts` (broadcast canvas messages when tools run)

**What:**
- `compose_document` tool: loads preset if given, merges user blocks, creates doc via store, emits `canvas_open` with full doc + `streaming: true`
- `edit_document` tool: loads doc, applies ops, emits `canvas_update` with op list
- `list_documents` tool: lists block docs
- System prompt: ~80-line block library reference teaching the agent each block type, when to use which, and how to compose. Point the agent at these tools for report/briefing/status work while keeping old `create_document` available for resume/invoice/letter.
- Tool labels in `TOOL_LABELS` map: "Composing Document", "Editing Document"

**Acceptance:**
- Agent can call `compose_document({presetId: 'client-status', title: 'Test'})` → file written → `canvas_open` broadcast
- `pnpm -F @coagent/agent-core build` clean

---

## Task 5: Frontend block types + hook plumbing

**Files:**
- Modify: `apps/desktop/src/hooks/useAgent.ts` — add state for `activeDocument: BlockDocument | null`, handle `canvas_open`/`canvas_update`/`canvas_close` WS messages, expose `closeCanvas()`.
- Modify: `apps/desktop/src/hooks/useAgent.ts` — destructure exports for App.tsx

**What:**
Wire the WebSocket messages into React state so Canvas has a source of truth.

**Acceptance:**
- `canvas_open` message sets `activeDocument`
- `canvas_update` applies ops locally (same logic as server-side `applyOps`)
- `canvas_close` clears `activeDocument`

---

## Task 6: Block components + BlockRenderer

**Files:**
- Create: `apps/desktop/src/components/blocks/` directory
- Create: `apps/desktop/src/components/blocks/HeaderBlock.tsx`
- Create: `apps/desktop/src/components/blocks/TextBlock.tsx`
- Create: `apps/desktop/src/components/blocks/KpisBlock.tsx`
- Create: `apps/desktop/src/components/blocks/TableBlock.tsx`
- Create: `apps/desktop/src/components/blocks/CalloutBlock.tsx`
- Create: `apps/desktop/src/components/blocks/TwoColumnBlock.tsx`
- Create: `apps/desktop/src/components/blocks/ImageBlock.tsx`
- Create: `apps/desktop/src/components/blocks/DividerBlock.tsx`
- Create: `apps/desktop/src/components/blocks/SignoffBlock.tsx`
- Create: `apps/desktop/src/components/blocks/FooterBlock.tsx`
- Create: `apps/desktop/src/components/blocks/ChartBlock.tsx`
- Create: `apps/desktop/src/components/blocks/BlockRenderer.tsx`
- Create: `apps/desktop/src/styles/document.css` — print-first CSS with @page, brand kit CSS variables, per-block styles

**What:**
Read-only rendering for all 11 blocks. Each component takes its typed block + brand kit. `BlockRenderer` switches on `block.type`. Print CSS handles page layout.

Dependencies to add: `react-markdown`, `remark-gfm`, `recharts`.

**Acceptance:**
- Storybook-less smoke test: each block renders with dummy data without throwing
- Print CSS: page size 8.5×11, 0.75in margins, break-inside: avoid on kpis/table/callout

---

## Task 7: Streaming animation hook

**Files:**
- Create: `apps/desktop/src/hooks/useStreamingCanvas.ts`

**What:**
Takes a `BlockDocument` + `streaming: boolean`. If streaming, reveals blocks one at a time on a schedule. Text blocks animate markdown content character-by-character. Returns `{visibleBlocks, currentStreamingBlockId}` for `CanvasPane` to render.

Tuning:
- Structural block cadence: ~150ms between blocks
- Text block reveal rate: ~25ms/char
- Auto-advance to next block when current finishes

**Acceptance:**
- Manual test: `canvas_open` with 5 blocks reveals them sequentially over ~3s
- Works with 0-block and 1-block docs

---

## Task 8: CanvasPane container

**Files:**
- Create: `apps/desktop/src/components/CanvasPane.tsx`

**What:**
Split-view container. Left side is `ChatPane` (narrower), right side is Canvas. Draggable vertical divider between them (persisted to localStorage). Canvas header (title, close), body (scrollable, renders blocks via `BlockRenderer`), footer (Save, Attach, Export, word count).

Phase 1 editing: none (read-only). Save button writes any pending edits (none in Phase 1) and flushes to disk. Attach button triggers PDF export + pre-fills an email draft. Export menu: PDF, Markdown.

**Acceptance:**
- Opens when `activeDocument` set, hides when null
- Draggable divider resizes both panes, snaps to min widths
- Streaming animation runs when `activeDocument.streaming === true`

---

## Task 9: Canvas integration in App.tsx

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/components/FilesPane.tsx` — open `.cadoc` files in Canvas via `onOpenDocument(id)` callback

**What:**
In `view === 'chat'`, render the `CanvasPane` wrapper that contains `ChatPane + Canvas`. When `activeDocument` is non-null, show Canvas pane. When null, `ChatPane` takes full width.

FilesPane: detect files with `type: 'block_document'` (or extension `.cadoc`), show a distinctive icon, clicking opens Canvas instead of the default file viewer. Wires to a new `open_document` WS message that server responds to with `canvas_open`.

**Acceptance:**
- Agent calls `compose_document` → Canvas slides in beside chat
- User clicks a `.cadoc` file in FilesPane → Canvas opens with that doc
- Closing Canvas hides the pane, chat goes full width

---

## Task 10: HTML → PDF export via Tauri

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs` — add `export_canvas_pdf` command
- Create: `apps/desktop/src/lib/canvas-export.ts` — calls the Tauri command, handles the returned PDF path

**What:**
Tauri command that:
1. Takes rendered HTML string (we'll pass the Canvas body HTML from the frontend)
2. Uses the webview's print-to-PDF API to produce a PDF buffer
3. Writes the PDF to the files dir with a filename from the doc title
4. Registers it in the file-store via the existing ingest path
5. Returns the new file ID

Frontend flow: user clicks Export → frontend serializes Canvas body HTML → Tauri command → file ID returned → optionally opens a confirmation toast.

**Note on API:** Tauri v2 webview has `printToPdf` on the window. If not exposed in JS bindings, we call it from Rust via `webview.print_to_pdf(...)` after loading the HTML in a hidden window. Fallback if not available: write HTML to a temp file, ask user to use browser print dialog, skip programmatic export in Phase 1 and ship the attach-as-HTML path instead.

**Acceptance:**
- Manual test: click Export PDF on a live doc → PDF file lands in files store
- PDF visually matches the Canvas preview (same fonts, layout, colors)

---

## Task 11: System prompt update

**Files:**
- Modify: `packages/agent-core/src/agent.ts` — system prompt string

**What:**
Add a concise (~80 lines) section teaching:
- The 11 blocks, one line each
- When to use `compose_document` vs the old `create_document` (reports/briefings/status → new; resume/invoice/letter → old for now)
- How to use presets (client-status, daily-briefing, marketing-audit)
- Brand kit is automatic, don't pass it manually
- Text blocks use markdown, agent should write naturally

**Acceptance:**
- Agent, when asked to "generate a Q2 status report for Acme," calls `compose_document` with the `client-status` preset and fills in blocks (manual test)

---

## Task 12: Build verify

**Files:** None

**What:**
- `pnpm build` across all packages (agent-core, shared, desktop)
- Fix any type errors or lint failures
- Manually smoke-test: launch dev app, ask agent to compose a document, verify Canvas opens and animates blocks

**Acceptance:**
- `pnpm build` clean
- Agent can compose a doc, Canvas opens, blocks animate in, user can close Canvas
- Old `create_document` tool still works (regression check)

---

## Rollout

1. Implement tasks 1-12 in order.
2. Manual end-to-end test on running app.
3. Commit in logical chunks (types + store, tools + presets, frontend blocks + canvas, integration, export, system prompt, build fix).
4. Do NOT bump version until a real build/release is planned. This work lands on `feat/teams` branch (current).

## Out of scope (Phase 2)

- Rich inline editing (Tiptap)
- Drag-to-reorder, insert/delete UI
- Version history UI
- Multi-brand-kit management
- Real partial-JSON streaming
- User-saved presets
- Retiring old 7 templates
