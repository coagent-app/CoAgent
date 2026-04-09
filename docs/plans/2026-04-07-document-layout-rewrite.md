# Document Layout Rewrite

**Date:** 2026-04-07
**Goal:** Documents stop looking formulaic, and Canvas and PDF stop diverging. Ship Gamma's layout-variant pattern on top of HTML→print export.

## The core insight (from research)

Formulaic docs aren't a renderer problem — they're a **data model** problem. Every block stacks in one column because there's no way for the agent to say "this next section is a hero" or "this is a timeline." Fixing the renderer alone produces prettier stacks. Fixing the data model alone creates a new Canvas↔PDF parity nightmare. Doing both is the Gamma move.

Concurrent finding: `@react-pdf/renderer` is hard-capped at "flexbox rectangles." No CSS grid (Yoga limitation, won't fix), no text wrap around images (7-year-old issue), no shadows, no float. It cannot express the layout variants we want. So the PDF path has to move off it.

## Architecture

### Single source of truth
Canvas (React + Tailwind + CSS vars + ReactMarkdown + Recharts) is the only renderer. PDF is produced by pointing a real browser engine at the Canvas DOM and printing it. There is no parallel PDF component tree.

### Layout variants
A new `layoutVariant` field on a `section` container (or on existing structure — TBD in Phase 2a). Small enum, 8 values max:

- `standard` — current behavior, vertical stack
- `hero` — full-bleed image/color with title overlay
- `two_column` — asymmetric 2fr/1fr or 1fr/2fr grid
- `kpi_band` — 4–6 column KPI row, optional sparklines
- `timeline` — left-rail timestamps, right-column content
- `gallery` — 2–3 column image grid with captions
- `quote_pull` — oversized serif quote with side rule
- `comparison` — split before/after or A/B grid

Agent picks one per section, per content. No template library. No layout interpreter (Tome died on that).

## Phases

### Phase 1 — Path C spike (gate)
Build HTML→print export end-to-end before touching the data model. If WKWebView's `createPDF` can't produce acceptable PDFs from the existing Canvas, everything downstream is dead and we pivot.

**1a.** `?print=docId` URL param in App.tsx — bypass normal UI, render doc via CanvasPane in print mode. Load doc from `http://localhost:7830/documents/:id` HTTP endpoint. Signal ready via `document.title = 'PRINT_READY'` when charts + images + fonts are loaded.

**1b.** Hidden Tauri `WebviewWindow` dynamically spawned from Rust. Invisible, no decorations, no taskbar, not focused. Pointed at `devUrl?print=docId` (dev) or `index.html?print=docId` (prod).

**1c.** Rust `capture_window_pdf(label)` command. Raw obj-c: NSWindow → contentView → walk subviews for WKWebView → `createPDFWithConfiguration:completionHandler:` → dispatch semaphore blocks until callback fires → return NSData as Vec<u8>. Matches existing obj-c style in main.rs.

**1d.** Wire `canvas_export_request` in useAgent.ts to the new flow: spawn hidden window → wait for print-ready event → invoke capture command → close window → base64 PDF → existing file-store save.

**Verify:** Generate a doc, export, open in Preview. If text is selectable, layout matches Canvas, and fonts look right — GO. Otherwise STOP and pivot.

### Phase 2 — Layout variants (only if Phase 1 GO)

**2a.** Schema: add `layoutVariant` enum to `@coagent/shared/blocks.ts`. Wrap top-level blocks in an optional `section` container, OR add the field directly to a new `SectionBlock` type. TBD when I read the existing schema. `applyOps` needs to handle the new shape.

**2b.** Canvas renderer: 8 variants as real CSS. Tailwind grid/flex tricks. Each variant is a wrapper component that lays out child blocks differently. Zero PDF work because PDF inherits Canvas.

**2c.** Agent: tool description + system prompt teach the 8 variants. One-line guidance per variant. Compose-first — agent picks per section, no fixed template.

### Phase 3 — Delete react-pdf
Only after Phase 1 is verified and Phase 2 ships. Remove `apps/desktop/src/lib/pdf/**` (~1,500 lines), remove `@react-pdf/renderer` from deps, drop ~8MB from the bundle. One renderer forever.

## Non-goals (explicit rejections from research)

- **No layout interpreter.** Tome built one, shipped it, died on it. Agent picks from a closed enum.
- **No sprawling template library.** Beautiful.ai's trap — always exhaustible.
- **No free-canvas / z-index positioning.** Agent can't reason about it; breaks any renderer.
- **No per-block style overrides beyond the variant.** Variants are the unit of variety; everything inside follows theme rules.
- **No dark mode exports for now.** Light-mode Canvas is the baseline.

## Rollback

Phase 1 is a feature flag: `useNewExportPath` in settings. If anything breaks in production, flip the flag off and the old react-pdf path runs again. Keep react-pdf in the tree until Phase 3 lands.

## Known risks

1. **WKWebView print CSS coverage.** `@page`, `break-inside: avoid` work. `position: running()` does not. Running headers/footers will use duplicated sticky DOM instead. Mitigated in 1a design.
2. **Font embedding.** System fonts render fine in-app; brand fonts (if added later) need `@font-face` data URIs in the print route.
3. **Async chart render timing.** Recharts + images must finish before capture. Ready signal gates this.
4. **Hidden window creation on macOS.** First try: visible=false + no-focus + off-screen position. Fallback: actual visible window at 1x1 offscreen.
