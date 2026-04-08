// Block document model — composable documents built from typed blocks.
// Used by the Canvas pane in the desktop app and the compose_document
// / edit_document / list_documents agent tools.

export type CalloutVariant = 'info' | 'warn' | 'success' | 'tip'

export type ChartKind = 'bar' | 'line' | 'pie'

export interface BrandKit {
  id: string
  companyName: string
  accentColor: string      // hex, e.g. "#1a2744"
  logoDataUri?: string     // base64 data URI (PNG/JPEG)
  footerText?: string
}

// ── Structural block types ────────────────────────────────────────────────

export interface HeaderBlock {
  id: string
  type: 'header'
  title: string
  subtitle?: string
  eyebrow?: string         // small text above title, e.g. "Q2 2026"
}

export interface TextBlock {
  id: string
  type: 'text'
  markdown: string
}

export interface KpiItem {
  label: string
  value: string
  delta?: string           // optional change indicator, e.g. "+12%"
}

export interface KpisBlock {
  id: string
  type: 'kpis'
  items: KpiItem[]         // 2-6 items recommended
}

export interface TableRow {
  cells: string[]
  emphasis?: boolean       // for totals rows
}

export interface TableBlock {
  id: string
  type: 'table'
  headers: string[]
  rows: TableRow[]
  caption?: string
}

export interface CalloutBlock {
  id: string
  type: 'callout'
  variant: CalloutVariant
  title?: string
  markdown: string
}

// TwoColumn holds any block except another TwoColumn or structural singletons
// (header/footer). Typically text+image or text+table.
export type ColumnBlock =
  | TextBlock
  | KpisBlock
  | TableBlock
  | CalloutBlock
  | ImageBlock
  | ChartBlock
  | DividerBlock

export interface TwoColumnBlock {
  id: string
  type: 'two_column'
  left: ColumnBlock
  right: ColumnBlock
  ratio?: '1:1' | '1:2' | '2:1'
}

export interface ImageBlock {
  id: string
  type: 'image'
  src: string              // data URI or file URL
  alt?: string
  caption?: string
  maxWidth?: string        // CSS width, e.g. "60%"
}

export interface DividerBlock {
  id: string
  type: 'divider'
}

export interface SignoffBlock {
  id: string
  type: 'signoff'
  name: string
  title?: string
  date?: string
  signatureDataUri?: string
}

export interface FooterBlock {
  id: string
  type: 'footer'
  // Content comes from brand kit; optional override text below
  note?: string
}

export interface ChartBlock {
  id: string
  type: 'chart'
  kind: ChartKind
  title?: string
  data: Array<Record<string, string | number>>
  xKey?: string            // key in data for X-axis (bar/line)
  yKeys?: string[]         // keys in data for series (bar/line)
  nameKey?: string         // key for pie slice name
  valueKey?: string        // key for pie slice value
}

// ── Layout-variant sections ──────────────────────────────────────────────
//
// A section wraps a small group of child blocks with a layout variant. The
// variant controls how the children are arranged on the page — this is how
// the agent picks between "hero", "two column", "gallery", etc. per chunk
// of content. Variants are a closed enum: no layout interpreter, no
// template library, no per-block style overrides. If the current variants
// can't express what you want, the renderer falls back to `standard`.
//
// Rules:
//   - Sections cannot nest inside each other (flat sections only).
//   - Header/signoff/footer are doc-level and never inside a section.
//   - A doc can freely mix top-level flat blocks AND sections.
//   - For `hero`, the first image child becomes the backdrop and remaining
//     children render over it.
//   - For `two_column` and `comparison`, renderer expects exactly 2 children
//     and splits them 50/50 (the existing `two_column` block can still be
//     used for asymmetric splits with a ratio).
//   - For `gallery`, children should be images; renderer grids them.
//   - For `kpi_band`, children should be a single KpisBlock (renderer adds
//     section chrome — title + subtle background).
//   - For `quote_pull`, single text child rendered oversized with a side rule.
//   - `timeline` is reserved — renderer currently falls back to standard
//     until per-item timestamp metadata ships.
export type LayoutVariant =
  | 'standard'
  | 'hero'
  | 'two_column'
  | 'kpi_band'
  | 'timeline'
  | 'gallery'
  | 'quote_pull'
  | 'comparison'

// Block types that can be nested inside a section. Excludes: header, footer,
// signoff (doc-level), and section (no nesting).
export type SectionChildBlock =
  | TextBlock
  | KpisBlock
  | TableBlock
  | CalloutBlock
  | TwoColumnBlock
  | ImageBlock
  | DividerBlock
  | ChartBlock

export interface SectionBlock {
  id: string
  type: 'section'
  variant: LayoutVariant
  title?: string            // optional section heading rendered by the variant
  eyebrow?: string          // small label above the title (all variants)
  blocks: SectionChildBlock[]
}

export type DocumentBlock =
  | HeaderBlock
  | TextBlock
  | KpisBlock
  | TableBlock
  | CalloutBlock
  | TwoColumnBlock
  | ImageBlock
  | DividerBlock
  | SignoffBlock
  | FooterBlock
  | ChartBlock
  | SectionBlock

export type DocumentBlockType = DocumentBlock['type']

// ── Document + versioning ─────────────────────────────────────────────────

export interface BlockDocumentVersion {
  savedAt: string
  blocks: DocumentBlock[]
}

export interface BlockDocument {
  id: string
  title: string
  brandKitId?: string
  presetId?: string
  blocks: DocumentBlock[]
  createdAt: string
  updatedAt: string
  versions?: BlockDocumentVersion[]   // last N snapshots
}

// ── Update operations ─────────────────────────────────────────────────────

export type DocumentUpdateOp =
  | { op: 'replace'; blockId: string; block: DocumentBlock }
  | { op: 'insert'; index: number; block: DocumentBlock }
  | { op: 'delete'; blockId: string }
  | { op: 'set_title'; title: string }

