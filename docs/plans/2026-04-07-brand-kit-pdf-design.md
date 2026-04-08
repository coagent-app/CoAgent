# Brand Kit & PDF Export Redesign

**Date:** 2026-04-07
**Status:** Design approved
**Scope:** Canvas document color system + vector PDF export

## Goal

Make Canvas documents feel fully branded and printable:

1. Expand brand kit from a single accent color to a small user-controlled palette, and route every document color through it.
2. Replace the raster-based PDF export (html2canvas → jsPDF bitmap) with a native vector PDF renderer that produces sharp text and clean page breaks.
3. Replace the fake "colored bar + title" brand preview with a real mini-document preview that matches what the Canvas actually renders.

## Motivation

Current problems:

- **Unbranded colors leak into documents.** Callouts use hardcoded blue/amber/emerald/violet, charts have a hardcoded 6-color palette (purple, emerald, amber, red, blue), and KPI deltas use emerald-600 / red-600. Users set one brand color and the doc still doesn't feel "theirs".
- **Single `brand_color` is too restrictive.** Charts with multiple series fall back to the hardcoded rainbow; secondary accents repeat primary.
- **PDF export is grainy.** `html2canvas-pro` rasterizes the DOM at scale 2, jsPDF slices the bitmap across Letter pages. Text is not vector, not selectable, and files run ~13MB for an 8-block doc. Page breaks cut through KPI cards and table rows mid-content.
- **Brand preview doesn't match reality.** The Settings → Brand tab shows a colored bar + title + company name. It doesn't look anything like the Canvas — users have to export a doc to see how their colors actually land.

## Non-goals

- Multi-theme brand kit (light/dark variants)
- Per-document brand overrides
- Font customization
- Custom page templates / layouts
- Replacing the block document model

## Design

### 1. Brand kit shape

Brand kit becomes a small palette of user-chosen colors plus semantic colors the app owns.

**User-controlled (configurable in Settings → Brand):**
- `primary` — the main accent. Used for header eyebrows & borders, KPI card borders/backgrounds, table header background, dividers, signoff/footer borders, 1st chart series. Required.
- `secondary` — alt accent. Used for 2nd chart series and any "alt" accent usage. Optional; falls back to a muted tint of primary.
- `tertiary` — optional third brand color. Used for 3rd chart series. Optional; user can add via "+ Add color".

**App-owned (hardcoded, not exposed in UI):**
- `success` = `#059669` — positive KPI deltas, success callouts
- `warning` = `#d97706` — warning callouts
- `danger` = `#dc2626` — negative KPI deltas, danger callouts
- `neutral` = `#6b7280` — muted text, neutral deltas

Callouts (info/warn/success/tip) keep their semantic coloring — they carry meaning, not brand.

**Chart palette order:** `[primary, secondary, tertiary, success, danger, neutral]`, skipping any unset user colors. Always starts with brand, falls back to semantic colors for extra series.

**Backwards compatibility:** Existing `brand_color` maps to `primary` on first load. No data migration needed — the settings loader fills defaults.

### 2. Settings schema changes

`AgentSettings` in `packages/shared/src/index.ts`:

```ts
// Replace:
brand_color: string

// With:
brand_primary: string    // required; hex
brand_secondary: string  // optional; empty = unset; hex
brand_tertiary: string   // optional; empty = unset; hex
```

Settings loader (`packages/agent-core/src/settings.ts`) reads legacy `brand_color` and writes it into `brand_primary` if present. `brand_company` and `brand_logo` stay unchanged.

### 3. Canvas renderer changes

`CanvasPane.tsx` and `CanvasExportSurface.tsx` set CSS vars from the brand kit:

```ts
--canvas-primary
--canvas-primary-soft    // primary @ 0.25 alpha
--canvas-primary-bg      // primary @ 0.05 alpha
--canvas-secondary
--canvas-tertiary
--canvas-success
--canvas-warning
--canvas-danger
--canvas-neutral
```

`BlockRenderer.tsx` changes:

- All uses of `var(--canvas-accent*)` rename to `var(--canvas-primary*)`.
- `CHART_PALETTE` becomes a computed array built from the brand vars at render time.
- `deltaColor()` uses `var(--canvas-success)` / `var(--canvas-danger)` / `var(--canvas-neutral)`.
- Callout `CALLOUT_STYLES` keeps its existing Tailwind-based semantic colors (brand-independent).
- Any other lingering hardcoded hex values get replaced with brand vars or semantic vars.

### 4. Brand kit preview

Settings → Brand preview becomes a live mini-document. It renders an actual `BlockRenderer` with a synthetic document containing:

- 1 header block (eyebrow + title + subtitle)
- 1 KPI block with 3 items (one with `▲` delta, one with `▼` delta, one neutral)
- 1 callout (info variant)

Wrapped in the same CSS-var container the real Canvas uses, so colors update instantly as the user tweaks the pickers. Scaled down to fit the settings panel width (~320px) with `transform: scale(0.75)` if needed, or rendered at native width and letting the panel scroll horizontally on small widths — final scale decided during implementation.

This is the only way to give users confidence that their picks look good before they generate a real doc.

### 5. PDF export — switch to `@react-pdf/renderer`

Replace `canvas-pdf.ts` (html2canvas + jsPDF bitmap pipeline) with a parallel PDF renderer built on `@react-pdf/renderer`.

**Architecture:**

```
apps/desktop/src/lib/pdf/
  CanvasPdfDocument.tsx    // top-level <Document>/<Page> layout
  blocks/
    HeaderPdf.tsx
    TextPdf.tsx
    KpisPdf.tsx
    TablePdf.tsx
    CalloutPdf.tsx
    TwoColumnPdf.tsx
    ImagePdf.tsx
    DividerPdf.tsx
    SignoffPdf.tsx
    FooterPdf.tsx
    ChartPdf.tsx
    dispatch.tsx           // BlockPdfDispatcher
  theme.ts                 // brand kit → pdf stylesheet
  index.ts                 // renderCanvasDocumentToPdf({ doc, brand })
```

**API:** `renderCanvasDocumentToPdf({ doc, brand })` returns `{ base64, pageCount }`, same shape as the current `renderSurfaceToPdf` so the call sites in `useAgent.ts` / `App.tsx` only swap the implementation.

**Pagination:**
- Use react-pdf's `<Page wrap>` and `<View wrap={false}>` to keep KPI cards, callouts, and table rows from splitting across pages.
- Let text and long tables break naturally — react-pdf handles intra-block pagination cleanly when `wrap` is enabled at the row level.
- Repeat a compact header (logo + company name) on every page via `<View fixed>`.
- Footer with page number (`<Text render={({ pageNumber, totalPages }) => ...} fixed>`).

**Theme:**
- Always light background regardless of desktop app theme. PDFs are meant for print/share, not dark mode.
- Colors pulled from the brand kit at render time (not from CSS vars — react-pdf uses its own StyleSheet). `theme.ts` exports a `brandToStyles(brand)` helper that returns a StyleSheet object with all brand colors baked in.

**Charts:**
- Recharts is DOM/SVG-based and not compatible with react-pdf. Render charts to SVG in a hidden DOM node, serialize the SVG, then embed it in react-pdf via `<Svg>`/`<Image>`. Alternative: use react-pdf's own `<Svg>` primitives and rebuild a minimal bar/line/pie renderer directly against the data. Decision deferred to implementation; we'll measure both.
- If a chart block is present but charting is too expensive to port in v1, fall back to a plain `<View>` placeholder with the chart's data as a table. Tracked as a stretch task, not a blocker for shipping the vector PDF.

**Logo:**
- Base64 data URI (current format) is compatible with react-pdf's `<Image src={...}>`. No changes to the logo field.

**Export trigger flow:**
- `useAgent.exportCanvasPdf()` continues to build the same `canvas_pdf_exported` WS message with base64 bytes. The off-screen `CanvasExportSurface` DOM component is removed (no longer needed — we render straight from the block document JSON).

### 6. Removed / deprecated

- `apps/desktop/src/lib/canvas-pdf.ts` — delete
- `apps/desktop/src/components/CanvasExportSurface.tsx` — delete
- `html2canvas-pro` — remove from package.json dependencies
- `jspdf` — evaluate: if nothing else uses it, remove; if other code uses it, keep

## Data flow

```
Settings → Brand tab
  ↓ onUpdate({ brand_primary, brand_secondary, brand_tertiary })
AgentSettings (persisted via settings.json)
  ↓
App.tsx builds `brand` prop
  ↓
  ├─→ CanvasPane (live rendering, CSS vars)
  ├─→ BrandTab preview (live mini-doc)
  └─→ renderCanvasDocumentToPdf({ doc, brand })
        ↓
      @react-pdf/renderer → base64 vector PDF
        ↓
      WS canvas_pdf_exported → backend writes .pdf to files
```

## Testing

- **Unit:** `theme.ts` — `brandToStyles(brand)` with fully-set / partial / empty brand returns the right color slots and falls back correctly.
- **Visual:** Manual QA on 3 doc types (client-status, daily-briefing, marketing-audit) with 3 brand configs:
  1. Default (primary only)
  2. Full palette (primary + secondary + tertiary set)
  3. Primary + secondary, no tertiary
- **Pagination:** Render a deliberately-long document (8 KPI blocks, 3 tables, 10 callouts) and verify no block splits mid-card.
- **File size:** Confirm new PDFs are <1MB for a typical 8-block doc (vs current ~13MB).
- **Backwards compat:** Load a settings.json that still has `brand_color` and verify it migrates to `brand_primary` without data loss.

## Open questions

None blocking. Chart rendering approach (SVG-to-PDF vs rebuild in react-pdf primitives) will be decided during implementation based on which path produces acceptable fidelity faster.

## Rollout

Single branch, ship as one PR. No feature flag — the new PDF and brand kit are strictly better than the old ones and we have no downstream consumers to migrate.
