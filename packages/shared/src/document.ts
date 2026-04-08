// HTML document model — HTML-as-source-of-truth document architecture.
// See docs/plans/2026-04-08-html-document-architecture.md for the full design.
// This file coexists with ./blocks.ts — do NOT modify block types here.

export interface DocumentTheme {
  // Core shadcn-compatible tokens (drive all Tailwind classes)
  background: string            // page background, hex or hsl string
  foreground: string            // body ink
  muted: string                 // subtle bg (e.g. kpi strip bg)
  mutedForeground: string       // secondary text
  primary: string               // brand primary, used for emphasis
  primaryForeground: string     // text on primary
  secondary: string             // optional brand secondary
  secondaryForeground: string
  accent: string                // highlight color distinct from primary
  accentForeground: string
  border: string                // rules, dividers, table borders
  radius: string                // e.g. "0.75rem"

  // Typography
  fontDisplay: string           // CSS font stack for titles
  fontBody: string              // CSS font stack for prose

  // Brand extras (not in shadcn but needed for docs)
  logoDataUri?: string
  footerText?: string
}

export interface HtmlDocument {
  id: string
  title: string
  kind?: string              // free-form label ("proposal", "flyer", "report") — agent picks
  html: string               // SOURCE OF TRUTH. Constrained HTML fragment.
  theme: DocumentTheme       // populated from brand kit on create, mutable per doc
  createdAt: string
  updatedAt: string
  versions?: Array<{ savedAt: string; html: string }>  // last N snapshots for undo
}
