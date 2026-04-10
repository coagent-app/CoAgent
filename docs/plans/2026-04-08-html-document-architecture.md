# HTML Document Architecture — Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task.

**Date:** 2026-04-08
**Status:** Draft, pending approval
**Owner:** Brett
**Supersedes:** `2026-04-07-document-layout-rewrite.md`, `2026-04-08-editable-canvas-design.md`

---

## Goal

Replace the fixed-block document system with an HTML-as-source-of-truth architecture. The agent writes constrained HTML + Tailwind into a sandboxed renderer; users click-edit text inline and chat-edit layout. One storage format, one renderer, one PDF pipeline. Unbounded variety, unified editing, brand-consistent.

## Why

The fixed block palette has a structural ceiling on variety that expanding the palette cannot fix. Tome shut down (April 2025) with exactly this complaint from users. Gamma and Canva get around it by training proprietary layout foundation models — a path we cannot take. The 2026 state of the art for "any document type" is **AI emits constrained code into a sandboxed renderer, with design quality enforced by skills not schema** — Claude Artifacts, v0, ChatGPT Canvas, Anthropic's own `web-artifacts-builder` all use this pattern.

See: `docs/research/2026-04-08-ai-document-generation-research.md` for the full research report with citations.

## Non-goals

- Replicating Gamma's generative layout model (out of reach).
- Collaborative multi-user editing.
- Generic HTML sanitizer / XSS defense beyond the doc sandbox. The HTML comes from the agent and renders only in our own sandboxed iframe; we still whitelist tags/classes as a correctness net, not a security net.
- Preserving old `.cadoc` block JSON files forever. We ship a one-way converter and delete the old code path once all existing docs are migrated.

## Architecture

### Storage format

One document = one HTML string + one theme object + metadata.

Theme variables follow the **shadcn/ui naming convention** so the agent's muscle-memory Tailwind patterns (`bg-background text-foreground border-border`) work out of the box. The agent is heavily trained on shadcn and will write better Tailwind for free when our variables match its training distribution.

```ts
// packages/shared/src/document.ts (NEW)
export interface DocumentTheme {
  // Core shadcn-compatible tokens (drive all Tailwind classes)
  background: string            // page background, hex
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
```

**On disk:** `~/.coagent/documents/<id>.htmldoc` — plain JSON with the shape above. Replaces `.cadoc`.

### HTML vocabulary

Closed set of semantic classes enforced server-side via a whitelist. The agent writes Tailwind utilities freely *inside* container elements with these classes. Theme variables drive colors/fonts.

**Container classes (must appear in this order, all optional):**
```
.doc            — root, always present
  .doc-page     — one page worth of content; repeat for multi-page
    .doc-header — top-of-page title zone (title, eyebrow, logo)
    .doc-body   — main content
    .doc-footer — bottom-of-page footer
```

**Section classes (children of `.doc-body`):**
```
.sec              — generic section wrapper (accepts any Tailwind inside)
.sec-hero         — top-of-doc hero (big title + lede, optional bg)
.sec-kpi          — KPI strip (numbers in a row)
.sec-split        — two-column side-by-side
.sec-compare      — before/after or A/B comparison
.sec-gallery      — image grid
.sec-quote        — pull quote
.sec-table        — table wrapper
.sec-signoff      — name/title/date block
.sec-cta          — call to action
```

**Leaf editable classes** (these are the click-to-edit targets):
```
.ed-title         — h1/h2 editable text
.ed-eyebrow       — small label text
.ed-lede          — lead paragraph
.ed-body          — body prose paragraph
.ed-stat-value    — KPI number
.ed-stat-label    — KPI label
.ed-cell          — table cell
.ed-caption       — image caption
.ed-signature     — signoff line
```

**Theme variables (CSS custom properties)** set on `.doc`, following the shadcn/ui convention:
```
--background, --foreground
--muted, --muted-foreground
--primary, --primary-foreground
--secondary, --secondary-foreground
--accent, --accent-foreground
--border
--radius
--font-display, --font-body
```

Agent writes Tailwind that references these naturally (e.g. `bg-background text-foreground`, `bg-primary text-primary-foreground`, `border-border`). Because the names match shadcn's training distribution, the agent reaches for the right classes by default. One theme file, everything themed automatically, no brittle arbitrary-value syntax like `bg-[var(--brand-primary)]`.

The precompiled `doc-runtime.css` extends Tailwind's theme to map these class names to the CSS custom properties:
```css
@layer base {
  .doc {
    --background: ...;  /* populated per-doc from theme object */
    --foreground: ...;
    /* etc. */
  }
}
```
And `tailwind.config.js` for the doc runtime bundle maps `background → hsl(var(--background))` etc., standard shadcn setup.

### Server-side whitelist

On every `write_canvas` and `patch_canvas`, the server parses the HTML (using `node-html-parser` — lightweight, no DOM) and rejects:

- Any tag not in: `div, section, article, header, footer, main, h1-h6, p, span, strong, em, ul, ol, li, table, thead, tbody, tr, th, td, img, figure, figcaption, blockquote, hr, br`.
- Any class not matching `^(doc|sec-|ed-|grid|flex|gap-|p-|m-|px-|py-|mx-|my-|mt-|mb-|ml-|mr-|pt-|pb-|pl-|pr-|text-|bg-|border|rounded|font-|leading-|tracking-|w-|h-|max-w-|min-h-|items-|justify-|content-|self-|place-|col-|row-|aspect-|object-|opacity-|shadow|ring-|space-|divide-|order-|hidden|block|inline|flex-|grid-|relative|absolute|sticky|top-|left-|right-|bottom-|z-|overflow-|break-|whitespace-|truncate|uppercase|lowercase|capitalize|italic|underline|no-underline|cursor-|select-|pointer-events-|transition|duration-|ease-|delay-|animate-)`.
- Any attribute except: `class`, `id`, `src`, `alt`, `href` (http/https/data-uri only), `colspan`, `rowspan`, `style` (limited to CSS custom property setters), `data-editable` (internal marker).
- Any `<script>`, `<style>` (except the one `.doc > style` that sets `:root` vars), `<link>`, `<iframe>`, event handlers (`on*`), `javascript:` urls.

Rejection returns a structured error the agent can self-correct from: `{ error: "invalid_html", reason: "disallowed class 'text-rainbow'", line: 12 }`.

### Agent tools

Replaces `create_document` / `update_document`.

#### `write_canvas`
```
{
  title: string,
  html: string,           // full HTML fragment, streams allowed
  theme?: Partial<DocumentTheme>,  // override brand defaults
  kind?: string
}
→ { doc_id }
```
Creates or fully rewrites a doc. Streams — the client renders progressively as the HTML string grows. Used for: initial generation, "make this more premium," template-level regenerations.

#### `patch_canvas`
```
{
  doc_id: string,
  target_id: string,      // an id="..." the agent set in a previous write, or "doc" for root theme edits
  op: "replace_text" | "replace_node" | "insert_before" | "insert_after" | "delete" | "restyle" | "set_theme",
  content?: string,       // HTML for *_node/insert ops, text for replace_text, class string for restyle
  theme?: Partial<DocumentTheme>  // only for set_theme op
}
→ { ok, updated_html }
```
Targeted edit. The agent assigns `id="n1"`, `id="n2"` etc. as it writes; subsequent patches reference those ids. Used for: "tighten this paragraph," "change the accent color on the hero," "add one more KPI," "make it green instead of blue" (set_theme op).

Agent system prompt gets a short section that says: **prefer `patch_canvas` for scoped edits; use `write_canvas` only for new docs or full rewrites. Always assign stable ids to top-level sections so patches are addressable.**

### The skill — one universal file

**Location:** `packages/agent-core/skills/document-design.md`

**Contents (outline):**

1. **Vocabulary reference** — full list of allowed classes with one-line purpose each.
2. **Theme variables** — how to reference `var(--brand-primary)` etc. and never hardcode colors.
3. **Anti-slop design principles** (borrowed from Anthropic's frontend-design skill):
   - Typography hierarchy: display font for titles, body font for prose, 3-4 size stops max.
   - Color discipline: brand primary for emphasis only, ink for body, muted for secondary. Never more than 3 colors per section.
   - Spacing rhythm: 4/8/16/24/48px scale via Tailwind `p-*` / `m-*` / `gap-*`.
   - Negative space is a feature. Err on the side of more whitespace.
   - Left-align by default. Center only for hero titles and CTAs.
   - One hero per doc. One primary CTA per doc.
   - Never purple gradients. Never centered everything. Never uniform rounded-3xl on everything.
4. **Document archetypes** (guidance, not templates):
   - **Reports / briefs** — hero → KPI strip → body sections with pull quotes → signoff.
   - **Proposals** — hero → problem → approach → deliverables → pricing table → signoff.
   - **Flyers / listings** — hero with image → 3-column KPI → body → CTA.
   - **Letters** — header → body paragraphs → signoff.
   - **Invoices** — header with business info → line items table → totals → payment terms.
   - Agent picks composition based on user intent, not a fixed recipe.
5. **Stable-id discipline** — every top-level `.sec-*` and every editable leaf gets `id="..."` so patches are addressable.
6. **Brand kit integration** — on every new doc, read the user's brand kit from settings and populate the theme variables. Do not override user brand choices unless explicitly asked.
7. **Examples** — 3-4 short but complete HTML docs showing different compositions with the same brand kit so the agent sees how theming drives variety independent of layout.

Skill is loaded into the agent context whenever `write_canvas` or `patch_canvas` is about to be called.

### Editor UX (keeps current look)

The CanvasPane keeps its current chrome (toolbar, Save to Files, Export, streaming loader). What changes is the rendering surface: instead of mapping `doc.blocks` to React block components, the pane renders the HTML inside a sandboxed iframe. The iframe loads our `doc-runtime.css` (Tailwind build + theme vars + editor affordances) and the `doc.html` fragment.

**Click-to-edit flow:**
- `contentEditable="true"` set on every element matching `.ed-*`.
- On blur or Enter, diff the text against the previous value. If changed, send `patch_canvas(replace_text, target_id)` to the server. No LLM call for typos.
- Hover on any `.sec-*` shows a small toolbar (Regenerate, Restyle, Delete, Insert above/below) — the Durable/Canvas pattern. Clicking opens a scoped mini-prompt that ends up as a `patch_canvas` with the agent.

**Streaming:**
- During `write_canvas`, the iframe's document.body.innerHTML grows as chunks arrive. Autoscroll to bottom when streaming.
- No per-block arrival animation — the HTML renders naturally. Current "block arrival" fade can be reimplemented via CSS `@starting-style` on newly-inserted sections if we want it back.

**Undo/redo:**
- Linear history on the HTML string. Snapshot per patch. `Cmd+Z` / `Cmd+Shift+Z`. Same keyboard bindings as now.

### Export pipeline

Already exists — the WKWebView print path (`export_document_pdf` Rust command + `PrintRoute.tsx`). It currently renders React blocks. New version: PrintRoute loads the HTML fragment + doc-runtime.css into the hidden window, signals ready, WKWebView captures. Zero fidelity gap because editor and PDF read the same HTML.

**Delete:** `packages/agent-core/src/document-renderer.ts` (already deleted per earlier cleanup), `apps/desktop/src/lib/pdf/CanvasPdfDocument.tsx`, anything `@react-pdf/renderer`.

## Migration

Reversible, incremental. Each phase commits cleanly and leaves the app in a working state.

### Phase 1 — Schema + runtime (no agent changes yet)

1. Add `HtmlDocument` type to `@coagent/shared`.
2. Add `html-document-store.ts` next to `block-document-store.ts` — read/write `.htmldoc` files with atomic per-path write queue.
3. Build `doc-runtime.css` — Tailwind build with our semantic classes in `@layer components`, theme variables via CSS custom properties.
4. Build server-side HTML whitelist parser + tests.

**Verify:** unit tests pass on whitelist parser for a handful of sample HTML fragments (valid + rejecting each kind of violation).

### Phase 2 — Render path

1. New `HtmlDocumentPane.tsx` component next to `CanvasPane.tsx`. Renders `HtmlDocument` into a sandboxed iframe with `doc-runtime.css` injected.
2. Wire click-to-edit on `.ed-*` leaves — `contentEditable`, blur → diff → patch.
3. Wire section hover toolbar.
4. Add feature flag in settings: `experimental.htmlDocuments` (default off).
5. When flag is on, App.tsx mounts `HtmlDocumentPane` instead of `CanvasPane`.

**Verify:** manually create a `.htmldoc` file on disk with a sample document, open the app with the flag on, confirm it renders correctly, click-edit a headline, confirm it persists.

### Phase 3 — Agent tools

1. Add `write_canvas`, `patch_canvas`, `set_document_theme` tools in `agent.ts`.
2. Add server-side handlers in `server.ts` that validate via the whitelist parser and persist via `html-document-store`.
3. Add the `document-design.md` skill file. Load it into agent context when these tools are about to be called (similar to how `DOC_COMPOSITION_GUIDE` is currently injected into the `create_document` tool result).
4. Keep old `create_document` / `update_document` tools working side-by-side during migration.

**Verify:** ask the agent (with the flag on) to write a new document. It picks `write_canvas`, streams HTML, renders live in the iframe, text is editable, sections are movable.

### Phase 4 — PrintRoute / PDF

1. Update `PrintRoute.tsx` to render an `HtmlDocument` (load `doc-runtime.css`, inject the HTML fragment).
2. Update `export_document_pdf` to pass an `htmlDocId` alternative to the existing `doc_json` path.
3. Test round trip: agent writes a doc, user clicks Export, PDF opens matching the on-screen render.

**Verify:** pixel-close match between the iframe render and the exported PDF.

### Phase 5 — Flip default + converter

1. Write `blocks → html` converter (one-way) for existing `.cadoc` files. Lossy is acceptable for exotic blocks; map header/text/kpis/table/callout/image/signoff cleanly, fall back to `<div class="sec">...</div>` for unknowns.
2. On app startup, migrate any `.cadoc` files found to `.htmldoc`. Back up originals to `~/.coagent/documents/.legacy/`.
3. Flip feature flag default to on.
4. Delete old `create_document` / `update_document` tools, `CanvasPane.tsx`, `useCanvasEditor.ts`, `block-document-store.ts`, `BlockRenderer.tsx`, all block-related types.
5. Delete `docs/plans/2026-04-07-document-layout-rewrite.md` and `docs/plans/2026-04-08-editable-canvas-*.md` — superseded.

**Verify:** full regression — create new doc, export PDF, attach to email via Composio, open existing (migrated) doc, edit, export.

### Phase 6 — Polish

1. Section-insert UX: floating "+" between sections that opens a mini-prompt (scoped `write_canvas`).
2. Theme editor in Settings → Brand Kit (already exists) → propagate changes to open docs via `set_document_theme`.
3. Add `@starting-style` fade-in for newly-inserted sections if the block-arrival animation is missed.

## Open questions

1. **Tailwind build inside the iframe.** Options: (a) ship a precompiled `doc-runtime.css` generated at app build time containing all utilities the skill says the agent can use, (b) run the Tailwind JIT at runtime in the iframe (too heavy). Answer: **(a)** — build a safelist from the whitelist regex into Tailwind's `safelist` config, one precompiled CSS bundle.
2. **What happens when the agent emits a class not in the whitelist?** Server rejects with a structured error, agent retries. If it fails twice, we strip the offending class and log a warning. User-facing: nothing.
3. **Images.** Image blocks currently accept data URIs and file URLs. Keep both. Data URI inline in HTML works; file URLs resolve via the existing Tauri asset protocol.
4. **Charts.** Current chart block uses Recharts. Options: (a) render charts as SVG inline in the HTML (agent generates SVG), (b) register `<doc-chart>` as a web component that lives in the iframe and renders via Recharts. Start with (a) — SVG is static, prints fine, no JS in the sandbox. Move to (b) only if agent-generated SVG quality is poor.
5. **What about the document_renderer on the agent side** (used for non-canvas exports, e.g. agent exporting via email)? Update it to render HTML docs the same way PrintRoute does — one renderer, HTML path only, after migration.

## Rollback

Each phase is a distinct commit. If any phase reveals a blocker:
- Phases 1-2: no user-visible change, just delete the new files.
- Phase 3: disable the new agent tools, fall back to old `create_document`.
- Phase 4: PrintRoute branches on doc type, old path still works.
- Phase 5: revert the flag flip; `.htmldoc` files stay on disk but app falls back to `.cadoc`.

If we decide the whole architecture is wrong after shipping, the `.legacy/` backup of old `.cadoc` files lets us restore the previous version of any doc.

## Out of scope for this plan

- Multi-page pagination logic (hand it to `@page` CSS and WKWebView).
- Real-time collaborative editing.
- Per-vertical skill files (user explicitly wants one universal skill).
- Voice editing of documents.
- Document versioning UI (keep the internal `versions[]` snapshot for undo only).

## Success criteria

1. Agent can generate a visually distinct proposal, flyer, and report for the same freelancer without looking cut-and-paste.
2. User can click any headline or paragraph in the doc and fix a typo without opening chat.
3. User can highlight a section, say "make this more visually striking," and get a scoped rewrite.
4. PDF export matches on-screen render pixel-close.
5. Brand kit changes propagate to all open docs automatically.
6. Existing docs migrate cleanly without data loss.
7. Current canvas UI look (toolbar, buttons, streaming loader) is preserved.
