# Document Canvas Design

**Date:** 2026-04-07
**Status:** Approved — moving to implementation plan

## Problem

The current document system (`create_document` → pdfmake templates → PDF file in Files) has three core problems:

1. **You can't edit the result.** Seven hard-coded templates render a PDF you can only regenerate by re-prompting the agent. `DocumentEditor` is form/JSON-based for most templates, not visual.
2. **It's not adaptable.** Every report shape requires a new template implemented in ~200 lines of pdfmake code. A "client status report" or "marketing audit" isn't any of the 7 templates, so the agent falls back to freeform markdown PDFs that look generic.
3. **The output is a dead file.** A PDF in FilesPane has no preview, no live editing, no history, no relationship to the conversation. Feels like a filing cabinet, not a workspace.

## Goal

A single composable document system that:

- Lets the agent (or user) build **any** document from a small set of reusable blocks.
- Renders live in a Canvas pane next to chat, streaming as it's generated.
- Ends in a real file the agent can attach to emails downstream.
- Applies the user's **brand kit** (company name, accent color, logo) automatically.
- Feels coherent with the existing pane system.

## Architecture

### Document model

A document is a JSON object:

```json
{
  "id": "doc_abc123",
  "title": "Q2 Status Report — Acme Corp",
  "brandKitId": "default",
  "presetId": "client-status",
  "blocks": [
    { "id": "b1", "type": "header", "title": "Q2 Status Report", "subtitle": "Acme Corp" },
    { "id": "b2", "type": "kpis", "items": [ {"label": "Hours", "value": "42 / 60"}, ... ] },
    { "id": "b3", "type": "text", "markdown": "## This week\n\nWe shipped..." },
    ...
  ],
  "createdAt": "2026-04-07T...",
  "updatedAt": "2026-04-07T...",
  "versions": [ /* last N snapshots */ ]
}
```

Stored on disk as `{dataDir}/files/{id}.cadoc` — a JSON file with the `.cadoc` extension. Indexed in the existing file-store alongside uploads via a new `FileEntry.type = 'block_document'`.

### Block library (11 blocks)

| Block | Purpose |
|---|---|
| `header` | Title + subtitle. Auto-applies brand kit (logo, accent). |
| `text` | Markdown content. The workhorse. |
| `kpis` | Horizontal strip of label/value pairs (2-6 items). |
| `table` | Headers + rows. Row emphasis flag for totals. |
| `callout` | Boxed note with variant (info/warn/success/tip). Markdown inside. |
| `two_column` | Two side-by-side slots, each holds any non-structural block. |
| `image` | Image + optional caption. |
| `divider` | Section break. |
| `signoff` | Name, title, signature image, date. |
| `footer` | Auto-branded footer. |
| `chart` | Bar / line / pie chart. Rendered via recharts. |

No `code`, no `quote`, no `toc` — can be added later if needed.

### Brand kit

Separate object `BrandKit { id, companyName, accentColor, logoUrl, footerText? }`. Phase 1 uses the one already in `AgentSettings` (`brand_company`, `brand_color`, `brand_logo`) wrapped as a single "default" brand kit. Multi-brand kits come in Phase 2.

Applied at the document root via CSS variables (`--accent-color`, `--brand-company`). `header`, `footer`, `signoff`, `kpis` consume them.

### Agent tool surface (3 tools)

1. **`compose_document`** — create a new block doc.
   - Input: `{ title, brandKitId?, presetId?, blocks? }`. Either `presetId` (start from a preset) or `blocks` (compose from scratch) or both (preset + overrides).
   - Output: `{ docId, filename }`.
   - Side effect: server broadcasts `canvas_open` message so frontend opens Canvas with the new doc.

2. **`edit_document`** — edit an existing block doc. (Named `edit_document` to avoid clashing with the old `update_document` tool which patches pdfmake template data.)
   - Input: `{ doc_id, ops: [{op: 'replace'|'insert'|'delete', blockId?, index?, block?}] }`.
   - Output: `{ docId, applied }`.
   - Side effect: server broadcasts `canvas_update` message so Canvas reflects the edit.

3. **`list_documents`** — list block docs (for attaching, referencing, updating).
   - Input: `{ filter? }`.
   - Output: `{ docs: [{id, title, createdAt, updatedAt}] }`.

### Presets

JSON files in `packages/agent-core/presets/documents/`:
- `client-status.json`
- `daily-briefing.json`
- `marketing-audit.json`

Each is a pre-composed `{title, blocks[]}` the agent can use as a starting point. Adding a new preset = adding a new JSON file, zero code changes. Users can save any doc as a preset from the Canvas UI (Phase 2).

### Streaming generation

Phase 1 implementation: **simulated streaming on the frontend**.

1. Agent calls `compose_document` → tool runs to completion, produces the full doc JSON.
2. Server broadcasts `canvas_open` with the full doc and a `streaming: true` flag.
3. Frontend opens Canvas and animates blocks appearing one-by-one on a schedule:
   - Structural blocks: snap in with fade-up, ~120ms apart.
   - Text blocks: markdown animates character-by-character at ~30ms/char with a blinking cursor.
4. When all blocks are revealed, `streaming: false`, Canvas becomes interactive.

Real partial-JSON streaming of tool input is deferred to Phase 2 (more complex, marginal UX gain given the frontend animation already feels live).

### Canvas UI

New component `CanvasPane.tsx`. Opens as a split-view beside `ChatPane` when a document is active. Draggable divider (saved to localStorage). Collapse to a chip in chat when closed.

Layout:

```
┌─────────────────────────────────────────┐
│  Chat         │  Canvas                 │
│  (messages)   │  ┌───────────────────┐  │
│  (input)      │  │  Title  Brand  ⋯  │  │
│               │  ├───────────────────┤  │
│               │  │  [Document body]  │  │
│               │  │  header           │  │
│               │  │  kpis             │  │
│               │  │  text (streaming) │  │
│               │  └───────────────────┘  │
│               │  Save  Attach  Export   │
└───────────────┴─────────────────────────┘
  ~480px           remainder (draggable)
```

Canvas header: title, brand kit selector (Phase 2), overflow menu.
Canvas body: rendered blocks, read-only in Phase 1.
Canvas footer: save status, word count, actions (Save, Attach, Export PDF, Export Markdown).

### Phase 1 vs Phase 2

**Phase 1 (this ship):**
- Block types + document store + 3 agent tools
- 3 initial presets
- CanvasPane + all 11 blocks rendered read-only
- Simulated streaming animation
- HTML → PDF export via Tauri webview print-to-PDF
- FilesPane integration: `.cadoc` files open in Canvas
- System prompt update teaching the block library

**Phase 2 (later):**
- Rich inline editing per block (Tiptap for text, form-in-place for structural)
- Drag-to-reorder, insert via "+", delete
- Version history UI + restore
- Multi-brand-kit management
- Real streaming of tool input via partial JSON parser
- User-saved presets from Canvas
- Comments, cursors, collaboration
- Migrate/retire the 7 pdfmake templates

Phase 1 ships the end-to-end loop (agent → Canvas → PDF → attach to email). Phase 2 makes it fully editable.

### File system

No separate Documents pane. Block docs live in `FilesPane` alongside uploads. They render with a distinctive icon, and clicking them opens Canvas instead of the default file viewer. The old 7 templates continue to open the existing `DocumentEditor` until Phase 2 migrates them.

### Error handling

- Preset not found → fall back to empty `blocks: []`, log warning.
- Invalid block shape in `compose_document` → validate against schema, return error to agent for retry.
- PDF export fails → keep the `.cadoc` doc, show error toast, no file written.
- Canvas open on a deleted `.cadoc` → show "Document not found" in Canvas, offer to close.
- WebSocket disconnect mid-stream → frontend finishes the streaming animation from its cached doc state.

### Testing

- Unit tests for document store (read/write/list/update_ops).
- Unit tests for preset loading and block schema validation.
- Integration test: `compose_document` → emit `canvas_open` → file lands on disk.
- Manual test: end-to-end loop in the running app (agent → Canvas → Attach to email).

## Non-goals

- Retiring pdfmake in Phase 1 (stays for old templates)
- Rich editing in Phase 1 (read-only is enough to ship the loop)
- Real-time collaboration, comments, cursors
- Chart/data interactivity beyond static render
- Mobile layout optimization (app min size 800×600, desktop-first)

## Open questions

None remaining. Decisions locked:
- 11 blocks including `chart`, no `code`/`quote`
- Tiptap for text editing (Phase 2)
- Old templates stay during Phase 1 (option iii)
- `.cadoc` in existing FilesPane, no separate Documents pane
