# React-Runner Artifacts — Design

**Date:** 2026-04-08
**Goal:** Replace the constrained HTML document system with a Claude Artifacts-style renderer: agent writes TSX, react-runner compiles and renders it in a sandboxed iframe with brand injection, recharts, and lucide icons.

---

## Motivation

The current HTML document system (`write_canvas` / `patch_canvas` + `sec-*`/`ed-*` vocabulary + node-html-parser whitelist + scale-to-fit iframe) is brittle:

- Agent fights the whitelist, producing malformed HTML that fails validation.
- Fixed canvas width causes horizontal scroll on narrow panes.
- Spacing is "either billboard or cramped" — no middle ground without per-doc CSS.
- No charts, no icons, no conditional layout logic — only static markup.
- Skills file is bloated with padding rules and class allowlists.

react-runner is exactly the right tool: 50.5 KB gzip, one dep (sucrase), confirmed as what Claude Artifacts uses. Its `scope` prop is a clean brand injection surface, and `useRunner`'s built-in last-good-render caching gives us streaming UX for free.

---

## Architecture

**Renderer:** react-runner, inside a same-origin iframe with `srcdoc`. Tailwind Play is bundled as a Tauri resource and loaded inside the iframe. Host app's React is passed in via scope, so no double-bundle.

**Agent interface:** two tools, `write_artifact` and `patch_artifact`. Agent writes TSX exporting a default function component. System prompt documents the scope surface.

**Storage:** `.artifact` files (JSON), same atomic-write pattern as `.htmldoc`. Field rename: `html` → `code`. Everything else (title, kind, theme, versions) stays.

**Streaming:** Anthropic SDK `input_json_delta` events for `write_artifact.code` are broadcast as `artifact_streaming` messages. The pane debounces 120ms and feeds the growing buffer into `useRunner`. Failed parses leave the last good render on screen.

**PDF export:** `iframe.contentWindow.print()`. WebKit-native, user picks "Save as PDF" from the system dialog.

---

## Scope surface (what the LLM can import)

```ts
scope = {
  brand,                    // { name, logoUrl, primary, accent, fontHeading, fontBody }
  useBrand: () => brand,
  import: {
    react: React,
    '@brand': {
      brand,
      Logo: () => <img src={brand.logoUrl} alt={brand.name} />,
      Signature: () => <div>{brand.name}</div>,
      __esModule: true,
    },
    recharts: { ...Recharts, __esModule: true },
    'lucide-react': { ...Lucide, __esModule: true },
  },
}
```

Agent writes:

```tsx
import { Logo, brand } from '@brand'
import { LineChart, Line, XAxis, YAxis } from 'recharts'
import { FileText } from 'lucide-react'

export default function Invoice() {
  return (
    <div className="max-w-3xl mx-auto p-12 font-sans">
      <header className="flex justify-between items-center mb-12">
        <Logo />
        <FileText size={24} color={brand.primary} />
      </header>
      <h1 className="text-4xl" style={{ color: brand.primary }}>Invoice #1032</h1>
      <LineChart width={600} height={200} data={[...]}>
        <Line type="monotone" dataKey="amount" stroke={brand.primary} />
        <XAxis dataKey="month" />
        <YAxis />
      </LineChart>
    </div>
  )
}
```

No shadcn, no Radix, no Chart.js. Just react + tailwind + recharts + lucide + brand.

---

## Files to delete

- `packages/agent-core/src/html-whitelist.ts`
- `packages/agent-core/skills/document-design.md` (rewrite as `artifact-design.md`)
- `apps/desktop/src/components/HtmlDocumentPane.tsx` (replace with `ArtifactPane.tsx`)

## Files to modify

- `packages/agent-core/src/html-document-store.ts` → `artifact-store.ts` (rename, field change)
- `packages/agent-core/src/agent.ts` — new tools, streaming hook, scope-aware system prompt; drop `validateHtml` import
- `packages/shared/src/index.ts` — new `Artifact` type, new broadcast message types
- `apps/desktop/src/hooks/useAgent.ts` — handle `artifact_opened` / `artifact_updated` / `artifact_streaming`
- `apps/desktop/src/App.tsx` — mount `ArtifactPane` instead of `HtmlDocumentPane`
- `apps/desktop/src-tauri/tauri.conf.json` — register bundled Tailwind Play as resource

## Files to create

- `apps/desktop/src/components/ArtifactPane.tsx` — same-origin iframe + `useRunner` + memoized scope
- `apps/desktop/src/lib/artifact-scope.ts` — brand scope builder
- `apps/desktop/src-tauri/resources/vendor/tailwind-play.js` — bundled Tailwind CDN script
- `packages/agent-core/src/artifact-store.ts` — replaces html-document-store.ts
- `packages/agent-core/skills/artifact-design.md` — replaces document-design.md

---

## Data flow

```
User: "Make me an invoice for ACME, 3 line items"
 ↓
Agent decides to call write_artifact
 ↓
Anthropic SDK streams input_json_delta events for the "code" parameter
 ↓
agent.ts buffers partial code, emits artifact_streaming broadcast every ~100ms
 ↓
useAgent hook dispatches to ArtifactPane
 ↓
ArtifactPane debounces 120ms, passes code to useRunner
 ↓
useRunner → sucrase → React element → render into iframe's root
 ↓
If parse fails: previous good element stays on screen, error shown in status pill
 ↓
When agent finishes tool call, full code hits artifact-store as atomic write
 ↓
artifact_opened broadcast with final doc id + code
```

---

## Error handling

- **Parse error during streaming:** `useRunner` keeps the last good render, exposes `error: string`. Pane shows a small `compiling…` / `parse error` pill in the corner; never wipes the canvas.
- **Runtime error during render:** `<Runner />` returns `null` under its error boundary. `useRunner` reports the error and retains the previous element. Same pill.
- **Disallowed import in agent code:** `createRequire(scope.import)` throws `Cannot find module 'x'`. Surfaces as parse error — agent gets a structured error and self-corrects (same pattern as the old whitelist, but ten times cleaner).
- **Malformed TSX from agent:** same as parse error — no crash, pill shows message, user sees last good version.

---

## Non-goals for v1

- shadcn/ui, Radix primitives (add on demand, not up front)
- Chart.js (recharts only)
- html2canvas (use `window.print()` for PDF)
- Tauri PDF sidecar (revisit if `window.print()` is insufficient)
- Multiple artifact kinds with different runtimes
- Artifact history/versioning beyond what the store already provides
- Migration of existing `.htmldoc` files — delete them, they're test garbage
- Style isolation via Shadow DOM — iframe is enough
- Server-side TSX validation — rely on `useRunner`'s parse error + agent self-correction

---

## Testing

Manual end-to-end only for v1 — no unit tests. The surface area is small and the only way to know it works is to watch a streaming invoice render in the actual desktop app.

Verification loop:
1. `pnpm tauri dev` (full restart)
2. Ask agent: "Make me an invoice for ACME with 3 line items"
3. Watch the code stream in real time; confirm last-good-render behavior on incomplete JSX
4. Confirm logo renders from brand kit
5. Ask agent: "Add a simple line chart of revenue by month"
6. Confirm recharts renders
7. Click Export PDF; confirm system dialog appears
8. Ask agent: "Change the primary color to green"
9. Confirm `patch_artifact` triggers re-render with new code

---

## Rollout

Single branch, single PR, ship together. No feature flag — the old HTML system is rotten and there's no production user base to protect.
