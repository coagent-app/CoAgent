# Brand Kit & Vector PDF Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Route every Canvas document color through a user-controlled brand palette and replace the grainy html2canvas PDF pipeline with `@react-pdf/renderer` for vector output.

**Architecture:** Extend `AgentSettings` from a single `brand_color` to `brand_primary` / `brand_secondary` / `brand_tertiary`. Canvas renderer routes all colors through brand CSS vars (callouts stay semantic). Settings → Brand preview renders a real mini block-doc. PDF export is rewritten as a parallel React tree using `@react-pdf/renderer` primitives.

**Tech Stack:** TypeScript, React, Tauri, `@react-pdf/renderer`, shared monorepo (`@coagent/shared`, `@coagent/agent-core`).

**Design doc:** `docs/plans/2026-04-07-brand-kit-pdf-design.md`

**Testing model:** This is a visual/UI feature. Tests = `pnpm typecheck` passes on each package + manual visual QA via HMR in running `pnpm tauri dev` (already running in background). No unit test framework in the desktop app. Per-task "verify" steps are typecheck + a specific visual check in the running app.

**Branch note:** Currently on `main` with uncommitted canvas work already in the tree. Execute directly on main (per user's workflow — no worktrees). Commit frequently.

---

## Task 1: Install `@react-pdf/renderer`

**Files:**
- Modify: `apps/desktop/package.json`

**Step 1: Install**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop
pnpm add @react-pdf/renderer
```

**Step 2: Verify**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && pnpm --filter @coagent/desktop typecheck`
Expected: PASS (no errors; the dependency declaration compiles).

**Step 3: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml
git commit -m "chore(desktop): add @react-pdf/renderer for vector PDF export"
```

---

## Task 2: Extend `AgentSettings` schema with brand palette

**Files:**
- Modify: `packages/shared/src/index.ts` — replace `brand_color: string` with `brand_primary`, `brand_secondary`, `brand_tertiary`
- Modify: `packages/agent-core/src/settings.ts` — defaults, read (with legacy migration), write

**Step 1: Shared schema**

In `packages/shared/src/index.ts` replace:

```ts
brand_color: string          // accent color hex for documents, e.g. '#1a2744'
```

with:

```ts
brand_primary: string        // required accent color hex, e.g. '#1a2744'
brand_secondary: string      // optional secondary accent hex; '' = unset
brand_tertiary: string       // optional tertiary accent hex; '' = unset
```

**Step 2: Settings defaults**

In `packages/agent-core/src/settings.ts` `getDefaultSettings()`, replace:

```ts
brand_color: '',
```

with:

```ts
brand_primary: '',
brand_secondary: '',
brand_tertiary: '',
```

**Step 3: Settings reader with legacy migration**

In the same file's `readSettings()`, replace the `brand_color` branch with:

```ts
brand_primary: parsed.brand_primary ?? parsed.brand_color ?? DEFAULT_SETTINGS.brand_primary,
brand_secondary: parsed.brand_secondary ?? DEFAULT_SETTINGS.brand_secondary,
brand_tertiary: parsed.brand_tertiary ?? DEFAULT_SETTINGS.brand_tertiary,
```

Note the `?? parsed.brand_color` fallback — this silently migrates any existing `settings.json`.

**Step 4: Settings writer**

In `writeSettings()`, replace the `brand_color` branch with three analogous branches:

```ts
brand_primary: patch.brand_primary !== undefined ? patch.brand_primary : current.brand_primary,
brand_secondary: patch.brand_secondary !== undefined ? patch.brand_secondary : current.brand_secondary,
brand_tertiary: patch.brand_tertiary !== undefined ? patch.brand_tertiary : current.brand_tertiary,
```

**Step 5: Verify**

Run: `pnpm --filter @coagent/shared build && pnpm --filter @coagent/agent-core typecheck`
Expected: PASS. (Desktop app will still fail because it references `brand_color` — fixed in next tasks.)

**Step 6: Commit**

```bash
git add packages/shared/src/index.ts packages/agent-core/src/settings.ts
git commit -m "feat(settings): replace brand_color with brand_primary/secondary/tertiary palette"
```

---

## Task 3: Update desktop app to use new brand fields

**Files:**
- Modify: `apps/desktop/src/App.tsx` — both places where `brand_color` is read (lines 177, 307 per earlier grep)
- Modify: `apps/desktop/src/components/SettingsPane.tsx` `BrandTab` — replace single color picker with three
- Modify: `apps/desktop/src/components/CanvasPane.tsx` — `BrandKit` interface and accent plumbing
- Modify: `apps/desktop/src/components/CanvasExportSurface.tsx` — same interface update

**Step 1: Update `BrandKit` interface in CanvasPane.tsx**

```ts
interface BrandKit {
  companyName?: string
  primary?: string
  secondary?: string
  tertiary?: string
  logoDataUri?: string
}
```

And `CanvasExportSurface.tsx` — same interface.

**Step 2: Update App.tsx brand construction**

Replace both `accentColor: settings.brand_color || undefined` occurrences with:

```ts
primary: settings.brand_primary || undefined,
secondary: settings.brand_secondary || undefined,
tertiary: settings.brand_tertiary || undefined,
```

Also rename `companyName` stays as-is.

**Step 3: Update CanvasPane CSS var computation**

In `CanvasPane.tsx`, replace the `accent` / `cssVars` block with:

```ts
const primary = brand?.primary || '#1a2744'
const secondary = brand?.secondary || ''
const tertiary = brand?.tertiary || ''
const cssVars = useMemo<React.CSSProperties>(() => ({
  ['--canvas-primary' as any]: primary,
  ['--canvas-primary-soft' as any]: hexToRgba(primary, 0.25),
  ['--canvas-primary-bg' as any]: hexToRgba(primary, 0.05),
  ['--canvas-secondary' as any]: secondary || primary,
  ['--canvas-tertiary' as any]: tertiary || secondary || primary,
  ['--canvas-success' as any]: '#059669',
  ['--canvas-warning' as any]: '#d97706',
  ['--canvas-danger' as any]: '#dc2626',
  ['--canvas-neutral' as any]: '#6b7280',
}), [primary, secondary, tertiary])
```

Also replace `style={{ color: 'var(--canvas-accent)' }}` with `style={{ color: 'var(--canvas-primary)' }}` (loader icon).

**Step 4: Mirror the same changes in CanvasExportSurface.tsx**

Same `cssVars` block; same var names.

**Step 5: Update BrandTab in SettingsPane.tsx (Brand section only — preview stays simple for now, rebuilt in Task 5)**

Replace the "Accent Color" `FieldRow` with three rows: Primary, Secondary, Tertiary. Secondary and Tertiary have a "Reset / clear" button.

Concrete code (drop-in replacement for the current Accent Color field):

```tsx
<FieldRow label="Primary Color">
  <ColorPickerRow
    value={settings.brand_primary}
    defaultValue="#1a2744"
    onChange={v => onUpdate({ brand_primary: v })}
  />
</FieldRow>

<FieldRow label="Secondary Color">
  <ColorPickerRow
    value={settings.brand_secondary}
    defaultValue="#8b5cf6"
    placeholder="Optional"
    clearable
    onChange={v => onUpdate({ brand_secondary: v })}
  />
</FieldRow>

<FieldRow label="Tertiary Color">
  <ColorPickerRow
    value={settings.brand_tertiary}
    defaultValue="#10b981"
    placeholder="Optional"
    clearable
    onChange={v => onUpdate({ brand_tertiary: v })}
  />
</FieldRow>
```

And add a `ColorPickerRow` helper (local to SettingsPane.tsx, above `BrandTab`):

```tsx
function ColorPickerRow({
  value,
  defaultValue,
  placeholder,
  clearable,
  onChange,
}: {
  value: string
  defaultValue: string
  placeholder?: string
  clearable?: boolean
  onChange: (v: string) => void
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="color"
        value={value || defaultValue}
        onChange={e => onChange(e.target.value)}
        className="w-9 h-9 rounded-lg border border-neutral-200 dark:border-neutral-700 cursor-pointer p-0.5 bg-transparent"
      />
      <Input
        value={value}
        onChange={e => {
          const v = e.target.value
          if (/^#[0-9a-fA-F]{0,6}$/.test(v) || v === '') onChange(v)
        }}
        placeholder={placeholder || defaultValue}
        className="text-[13px] h-9 w-32 font-mono"
      />
      {clearable && value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
        >
          Clear
        </button>
      )}
    </div>
  )
}
```

Also update the preview-visibility condition (line 819-ish) from `settings.brand_color` to `settings.brand_primary`.
Also update the two hardcoded preview colors (lines 829, 833) from `settings.brand_color` to `settings.brand_primary`.
(Full preview rewrite happens in Task 5.)

**Step 6: Verify**

1. Run: `pnpm --filter @coagent/desktop typecheck`
   Expected: PASS.
2. Visual check: open running app, go to Settings → Brand. Confirm three color pickers show. Pick a primary, close+reopen Settings, confirm it persisted.
3. Generate a test doc and confirm CanvasPane renders with the new primary color on header border, KPI cards, table headers.

**Step 7: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/components/SettingsPane.tsx apps/desktop/src/components/CanvasPane.tsx apps/desktop/src/components/CanvasExportSurface.tsx
git commit -m "feat(brand): three-color brand kit with primary/secondary/tertiary pickers"
```

---

## Task 4: Route all BlockRenderer colors through brand CSS vars

**Files:**
- Modify: `apps/desktop/src/components/blocks/BlockRenderer.tsx`

**Step 1: Rename accent → primary**

Find/replace across the file:
- `--canvas-accent-soft` → `--canvas-primary-soft`
- `--canvas-accent-bg` → `--canvas-primary-bg`
- `--canvas-accent` → `--canvas-primary`

**Step 2: Rebuild CHART_PALETTE**

Replace the static `CHART_PALETTE` constant with a function that reads brand vars at render time:

```ts
// Chart palette cycles through user brand colors first, then semantic fallbacks.
// Using CSS vars lets the same component work in both live Canvas and (later)
// the PDF renderer (which bakes values from the brand kit into a StyleSheet).
const CHART_PALETTE = [
  'var(--canvas-primary)',
  'var(--canvas-secondary)',
  'var(--canvas-tertiary)',
  'var(--canvas-success)',
  'var(--canvas-danger)',
  'var(--canvas-neutral)',
]
```

No other change needed — existing `CHART_PALETTE[i % CHART_PALETTE.length]` usage keeps working.

**Step 3: Update deltaColor to use brand vars**

Replace `deltaColor()`:

```ts
function deltaColor(delta: string): string {
  const trimmed = delta.trim()
  if (/^[▲↑+]/.test(trimmed) || /\bup\b/i.test(trimmed)) return 'var(--canvas-success)'
  if (/^[▼↓-]/.test(trimmed) || /\bdown\b/i.test(trimmed)) return 'var(--canvas-danger)'
  return 'var(--canvas-neutral)'
}
```

**Step 4: Verify**

1. Run: `pnpm --filter @coagent/desktop typecheck`
   Expected: PASS.
2. Visual check: open a test doc in Canvas. Pick a distinctive primary color (e.g. `#c026d3` hot pink). Confirm header eyebrow, KPI borders, dividers, table header bg, chart bars all pick up the pink. Pick a secondary green — confirm 2nd chart series is green.
3. Confirm KPI deltas still show green for `▲`, red for `▼`.
4. Confirm callouts are still blue/amber/emerald/violet (unchanged by design).

**Step 5: Commit**

```bash
git add apps/desktop/src/components/blocks/BlockRenderer.tsx
git commit -m "feat(canvas): route all block colors through brand CSS vars"
```

---

## Task 5: Rebuild Brand preview as a real mini-doc

**Files:**
- Modify: `apps/desktop/src/components/SettingsPane.tsx` — replace the fake-bar preview in `BrandTab` with a real `BlockRenderer`-based mini-doc

**Step 1: Build the sample doc**

Inside `BrandTab`, above the `return`, add:

```tsx
const sampleDoc: DocumentBlock[] = useMemo(() => [
  {
    id: 's1',
    type: 'header',
    eyebrow: 'PREVIEW',
    title: settings.brand_company || 'Sample Document',
    subtitle: 'How your branded documents will look',
  },
  {
    id: 's2',
    type: 'kpis',
    items: [
      { label: 'Revenue', value: '$48.2K', delta: '▲ 12%' },
      { label: 'Churn', value: '2.1%', delta: '▼ 0.4%' },
      { label: 'NPS', value: '72', delta: '+3' },
    ],
  },
  {
    id: 's3',
    type: 'callout',
    variant: 'info',
    title: 'Callouts stay semantic',
    markdown: 'Info, warning, success, and tip callouts keep their own colors by design — they carry meaning, not brand.',
  },
], [settings.brand_company])
```

Add to the top imports:
```ts
import type { DocumentBlock } from '@coagent/shared'
import { BlockRenderer } from '@/components/blocks/BlockRenderer'
```

**Step 2: Build CSS vars for the preview**

In `BrandTab`, add below `sampleDoc`:

```tsx
const previewCssVars = useMemo<React.CSSProperties>(() => {
  const primary = settings.brand_primary || '#1a2744'
  const secondary = settings.brand_secondary || primary
  const tertiary = settings.brand_tertiary || secondary
  const hexToRgba = (hex: string, a: number) => {
    const h = hex.replace('#', '')
    const f = h.length === 3 ? h.split('').map(c => c + c).join('') : h
    const r = parseInt(f.slice(0, 2), 16), g = parseInt(f.slice(2, 4), 16), b = parseInt(f.slice(4, 6), 16)
    return [r, g, b].some(Number.isNaN) ? `rgba(26, 39, 68, ${a})` : `rgba(${r}, ${g}, ${b}, ${a})`
  }
  return {
    ['--canvas-primary' as any]: primary,
    ['--canvas-primary-soft' as any]: hexToRgba(primary, 0.25),
    ['--canvas-primary-bg' as any]: hexToRgba(primary, 0.05),
    ['--canvas-secondary' as any]: secondary,
    ['--canvas-tertiary' as any]: tertiary,
    ['--canvas-success' as any]: '#059669',
    ['--canvas-warning' as any]: '#d97706',
    ['--canvas-danger' as any]: '#dc2626',
    ['--canvas-neutral' as any]: '#6b7280',
  }
}, [settings.brand_primary, settings.brand_secondary, settings.brand_tertiary])
```

**Step 3: Replace the preview JSX**

Replace the entire existing preview block (the `{(settings.brand_company || settings.brand_color || logoSrc) && (...)` wrapper) with:

```tsx
<Separator className="my-5" />
<p className="text-[11px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-3">Preview</p>
<div
  className="rounded-lg border border-neutral-200 dark:border-neutral-700 p-6 bg-white dark:bg-neutral-900 space-y-5 overflow-hidden"
  style={previewCssVars}
>
  {logoSrc && (
    <div className="flex justify-end -mb-2">
      <img src={logoSrc} alt={settings.brand_company || 'logo'} className="h-6 opacity-80 object-contain" />
    </div>
  )}
  {sampleDoc.map(block => (
    <BlockRenderer key={block.id} block={block} />
  ))}
</div>
```

Note: no visibility gate — the preview is always shown so the user can see defaults.

**Step 4: Verify**

1. Run: `pnpm --filter @coagent/desktop typecheck`
   Expected: PASS.
2. Visual check: Settings → Brand. Preview should now render a real mini-doc (header, 3 KPIs, callout). Change primary color — confirm header border, KPI cards update instantly. Change secondary — no visible change in this preview (no chart block). Add a logo — confirm it shows top-right.

**Step 5: Commit**

```bash
git add apps/desktop/src/components/SettingsPane.tsx
git commit -m "feat(brand): replace fake preview bar with real mini block-doc"
```

---

## Task 6: PDF theme module

**Files:**
- Create: `apps/desktop/src/lib/pdf/theme.ts`

**Step 1: Create theme.ts**

```ts
// apps/desktop/src/lib/pdf/theme.ts
// Brand kit → react-pdf StyleSheet. react-pdf can't read CSS vars, so we
// bake brand colors into a typed palette that block components consume.

export interface BrandPalette {
  primary: string
  primarySoft: string    // primary @ 0.25
  primaryBg: string      // primary @ 0.05
  secondary: string
  tertiary: string
  success: string
  warning: string
  danger: string
  neutral: string
  chartPalette: string[] // ordered cycle for multi-series charts
}

const DEFAULT_PRIMARY = '#1a2744'

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  if ([r, g, b].some(n => Number.isNaN(n))) return `rgba(26, 39, 68, ${alpha})`
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export interface BrandInput {
  primary?: string
  secondary?: string
  tertiary?: string
}

export function buildBrandPalette(brand?: BrandInput): BrandPalette {
  const primary = brand?.primary || DEFAULT_PRIMARY
  const secondary = brand?.secondary || ''
  const tertiary = brand?.tertiary || ''
  const success = '#059669'
  const warning = '#d97706'
  const danger = '#dc2626'
  const neutral = '#6b7280'
  return {
    primary,
    primarySoft: hexToRgba(primary, 0.25),
    primaryBg: hexToRgba(primary, 0.05),
    secondary: secondary || primary,
    tertiary: tertiary || secondary || primary,
    success,
    warning,
    danger,
    neutral,
    chartPalette: [
      primary,
      secondary || primary,
      tertiary || secondary || primary,
      success,
      danger,
      neutral,
    ],
  }
}

// Semantic callout styles (brand-independent). Matches web renderer.
export const PDF_CALLOUT_STYLES = {
  info:    { bg: '#eff6ff', border: '#bfdbfe', text: '#1e40af', icon: 'i' },
  warn:    { bg: '#fffbeb', border: '#fde68a', text: '#b45309', icon: '!' },
  success: { bg: '#ecfdf5', border: '#a7f3d0', text: '#047857', icon: '✓' },
  tip:     { bg: '#f5f3ff', border: '#ddd6fe', text: '#6d28d9', icon: '◆' },
} as const
```

**Step 2: Verify**

Run: `pnpm --filter @coagent/desktop typecheck`
Expected: PASS.

**Step 3: Commit**

```bash
git add apps/desktop/src/lib/pdf/theme.ts
git commit -m "feat(pdf): brand palette helper for react-pdf StyleSheet"
```

---

## Task 7: PDF block components — text, header, divider, footer

Start with the simplest blocks. These establish the file layout pattern for the rest.

**Files:**
- Create: `apps/desktop/src/lib/pdf/blocks/HeaderPdf.tsx`
- Create: `apps/desktop/src/lib/pdf/blocks/TextPdf.tsx`
- Create: `apps/desktop/src/lib/pdf/blocks/DividerPdf.tsx`
- Create: `apps/desktop/src/lib/pdf/blocks/FooterPdf.tsx`
- Create: `apps/desktop/src/lib/pdf/blocks/SignoffPdf.tsx`
- Create: `apps/desktop/src/lib/pdf/blocks/ImagePdf.tsx`

**Step 1: HeaderPdf.tsx**

```tsx
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import type { HeaderBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

export function HeaderPdf({ block, palette }: { block: HeaderBlock; palette: BrandPalette }) {
  const styles = StyleSheet.create({
    wrap: {
      paddingBottom: 10,
      marginBottom: 14,
      borderBottomWidth: 1,
      borderBottomColor: palette.primarySoft,
      borderBottomStyle: 'solid',
    },
    eyebrow: {
      fontSize: 9,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: 1.2,
      color: palette.primary,
      marginBottom: 4,
    },
    title: { fontSize: 22, fontWeight: 700, color: '#111827', lineHeight: 1.15 },
    subtitle: { fontSize: 11, color: '#6b7280', marginTop: 4 },
  })
  return (
    <View style={styles.wrap} wrap={false}>
      {block.eyebrow ? <Text style={styles.eyebrow}>{block.eyebrow}</Text> : null}
      <Text style={styles.title}>{block.title || 'Untitled'}</Text>
      {block.subtitle ? <Text style={styles.subtitle}>{block.subtitle}</Text> : null}
    </View>
  )
}
```

**Step 2: TextPdf.tsx**

Keep it simple — no full markdown parser in v1. Render paragraphs split by blank lines, strip `**bold**` markers, strip `{{placeholder}}` tokens (match web behavior).

```tsx
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import type { TextBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g

function stripMarkdown(s: string): string {
  // Minimal: bold/italic/code markers, placeholders, bullet glyphs.
  return s
    .replace(PLACEHOLDER_RE, '…')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}

export function TextPdf({ block, palette: _palette }: { block: TextBlock; palette: BrandPalette }) {
  const styles = StyleSheet.create({
    wrap: { marginBottom: 8 },
    p: { fontSize: 11, color: '#374151', lineHeight: 1.55, marginBottom: 4 },
    bullet: { fontSize: 11, color: '#374151', lineHeight: 1.55, marginBottom: 2, marginLeft: 12 },
  })
  const source = block.markdown || ''
  const lines = source.split(/\n+/).map(l => l.trim()).filter(Boolean)
  return (
    <View style={styles.wrap}>
      {lines.map((line, i) => {
        const isBullet = /^[-*]\s+/.test(line)
        const clean = stripMarkdown(isBullet ? line.replace(/^[-*]\s+/, '') : line)
        return (
          <Text key={i} style={isBullet ? styles.bullet : styles.p}>
            {isBullet ? `• ${clean}` : clean}
          </Text>
        )
      })}
    </View>
  )
}
```

**Step 3: DividerPdf.tsx**

```tsx
import { View, StyleSheet } from '@react-pdf/renderer'
import type { DividerBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

export function DividerPdf({ block: _block, palette }: { block: DividerBlock; palette: BrandPalette }) {
  const styles = StyleSheet.create({
    line: { height: 1, width: '100%', backgroundColor: palette.primarySoft, marginVertical: 8 },
  })
  return <View style={styles.line} />
}
```

**Step 4: FooterPdf.tsx**

```tsx
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import type { FooterBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

export function FooterPdf({ block, palette }: { block: FooterBlock; palette: BrandPalette }) {
  const styles = StyleSheet.create({
    wrap: {
      marginTop: 12,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: palette.primarySoft,
      borderTopStyle: 'solid',
    },
    text: { fontSize: 9, color: '#9ca3af', textAlign: 'center' },
  })
  return (
    <View style={styles.wrap} wrap={false}>
      <Text style={styles.text}>{block.note || 'Generated by CoAgent'}</Text>
    </View>
  )
}
```

**Step 5: SignoffPdf.tsx**

```tsx
import { View, Text, Image, StyleSheet } from '@react-pdf/renderer'
import type { SignoffBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

export function SignoffPdf({ block, palette }: { block: SignoffBlock; palette: BrandPalette }) {
  const styles = StyleSheet.create({
    wrap: {
      marginTop: 16,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: palette.primarySoft,
      borderTopStyle: 'solid',
    },
    sig: { height: 42, marginBottom: 4, objectFit: 'contain' },
    name: { fontSize: 12, fontWeight: 600, color: '#111827' },
    title: { fontSize: 10, color: '#6b7280' },
    date: { fontSize: 9, color: '#9ca3af', marginTop: 2 },
  })
  return (
    <View style={styles.wrap} wrap={false}>
      {block.signatureDataUri ? <Image src={block.signatureDataUri} style={styles.sig} /> : null}
      <Text style={styles.name}>{block.name}</Text>
      {block.title ? <Text style={styles.title}>{block.title}</Text> : null}
      {block.date ? <Text style={styles.date}>{block.date}</Text> : null}
    </View>
  )
}
```

**Step 6: ImagePdf.tsx**

```tsx
import { View, Image, Text, StyleSheet } from '@react-pdf/renderer'
import type { ImageBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

export function ImagePdf({ block, palette: _palette }: { block: ImageBlock; palette: BrandPalette }) {
  const styles = StyleSheet.create({
    wrap: { marginVertical: 6 },
    img: { width: '100%', objectFit: 'contain' },
    caption: { fontSize: 9, color: '#6b7280', textAlign: 'center', marginTop: 4, fontStyle: 'italic' },
  })
  return (
    <View style={styles.wrap} wrap={false}>
      <Image src={block.src} style={styles.img} />
      {block.caption ? <Text style={styles.caption}>{block.caption}</Text> : null}
    </View>
  )
}
```

**Step 7: Verify**

Run: `pnpm --filter @coagent/desktop typecheck`
Expected: PASS (even though no one imports them yet, they must compile).

**Step 8: Commit**

```bash
git add apps/desktop/src/lib/pdf/blocks/HeaderPdf.tsx apps/desktop/src/lib/pdf/blocks/TextPdf.tsx apps/desktop/src/lib/pdf/blocks/DividerPdf.tsx apps/desktop/src/lib/pdf/blocks/FooterPdf.tsx apps/desktop/src/lib/pdf/blocks/SignoffPdf.tsx apps/desktop/src/lib/pdf/blocks/ImagePdf.tsx
git commit -m "feat(pdf): header/text/divider/footer/signoff/image block components"
```

---

## Task 8: PDF block components — KPIs, table, callout

**Files:**
- Create: `apps/desktop/src/lib/pdf/blocks/KpisPdf.tsx`
- Create: `apps/desktop/src/lib/pdf/blocks/TablePdf.tsx`
- Create: `apps/desktop/src/lib/pdf/blocks/CalloutPdf.tsx`

**Step 1: KpisPdf.tsx**

```tsx
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import type { KpisBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

function deltaColor(delta: string, palette: BrandPalette): string {
  const trimmed = delta.trim()
  if (/^[▲↑+]/.test(trimmed) || /\bup\b/i.test(trimmed)) return palette.success
  if (/^[▼↓-]/.test(trimmed) || /\bdown\b/i.test(trimmed)) return palette.danger
  return palette.neutral
}

export function KpisPdf({ block, palette }: { block: KpisBlock; palette: BrandPalette }) {
  const count = Math.max(1, block.items.length)
  const colCount = Math.min(count, 4) // 4 per row in PDF (tighter than web)
  const styles = StyleSheet.create({
    row: { flexDirection: 'row', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
    card: {
      flexGrow: 1,
      flexBasis: `${100 / colCount - 2}%`,
      borderWidth: 1,
      borderColor: palette.primarySoft,
      borderStyle: 'solid',
      backgroundColor: palette.primaryBg,
      borderRadius: 6,
      padding: 10,
    },
    label: {
      fontSize: 8,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      color: '#6b7280',
      marginBottom: 4,
    },
    value: { fontSize: 18, fontWeight: 700, color: '#111827' },
    delta: { fontSize: 9, fontWeight: 500, marginTop: 3 },
  })
  return (
    <View style={styles.row} wrap={false}>
      {block.items.map((item, i) => (
        <View key={i} style={styles.card} wrap={false}>
          <Text style={styles.label}>{item.label || ' '}</Text>
          <Text style={styles.value}>{item.value || ' '}</Text>
          {item.delta ? (
            <Text style={[styles.delta, { color: deltaColor(item.delta, palette) }]}>{item.delta}</Text>
          ) : null}
        </View>
      ))}
    </View>
  )
}
```

**Step 2: TablePdf.tsx**

```tsx
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import type { TableBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

export function TablePdf({ block, palette }: { block: TableBlock; palette: BrandPalette }) {
  const styles = StyleSheet.create({
    wrap: { marginVertical: 6 },
    caption: { fontSize: 9, color: '#6b7280', fontStyle: 'italic', marginBottom: 3 },
    table: { width: '100%' },
    headRow: { flexDirection: 'row', backgroundColor: palette.primary },
    headCell: {
      flex: 1,
      padding: 6,
      fontSize: 9,
      fontWeight: 700,
      color: '#ffffff',
    },
    bodyRow: {
      flexDirection: 'row',
      borderBottomWidth: 0.5,
      borderBottomColor: '#e5e7eb',
      borderBottomStyle: 'solid',
    },
    cell: {
      flex: 1,
      padding: 6,
      fontSize: 10,
      color: '#374151',
    },
    cellEmph: {
      fontWeight: 600,
    },
  })
  return (
    <View style={styles.wrap}>
      {block.caption ? <Text style={styles.caption}>{block.caption}</Text> : null}
      <View style={styles.table}>
        <View style={styles.headRow} wrap={false}>
          {block.headers.map((h, i) => (
            <Text key={i} style={styles.headCell}>{h || ' '}</Text>
          ))}
        </View>
        {block.rows.map((row, ri) => (
          <View key={ri} style={styles.bodyRow} wrap={false}>
            {row.cells.map((c, ci) => (
              <Text key={ci} style={[styles.cell, row.emphasis ? styles.cellEmph : {}]}>
                {c || ' '}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </View>
  )
}
```

Note: each row has `wrap={false}` so rows don't split mid-cell across pages. The body as a whole can still paginate.

**Step 3: CalloutPdf.tsx**

```tsx
import { View, Text, StyleSheet } from '@react-pdf/renderer'
import type { CalloutBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'
import { PDF_CALLOUT_STYLES } from '../theme'

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g
function cleanup(s: string): string {
  return s.replace(PLACEHOLDER_RE, '…').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1')
}

export function CalloutPdf({ block, palette: _palette }: { block: CalloutBlock; palette: BrandPalette }) {
  const variant = (block.variant in PDF_CALLOUT_STYLES ? block.variant : 'info') as keyof typeof PDF_CALLOUT_STYLES
  const s = PDF_CALLOUT_STYLES[variant]
  const styles = StyleSheet.create({
    wrap: {
      flexDirection: 'row',
      gap: 8,
      padding: 10,
      borderRadius: 6,
      borderWidth: 1,
      borderStyle: 'solid',
      backgroundColor: s.bg,
      borderColor: s.border,
      marginBottom: 8,
    },
    icon: {
      width: 16,
      height: 16,
      borderRadius: 8,
      textAlign: 'center',
      fontSize: 10,
      fontWeight: 700,
      color: s.text,
      paddingTop: 1.5,
    },
    body: { flex: 1 },
    title: { fontSize: 11, fontWeight: 700, color: '#111827', marginBottom: 2 },
    text: { fontSize: 10, color: '#374151', lineHeight: 1.5 },
  })
  return (
    <View style={styles.wrap} wrap={false}>
      <Text style={styles.icon}>{s.icon}</Text>
      <View style={styles.body}>
        {block.title ? <Text style={styles.title}>{block.title}</Text> : null}
        <Text style={styles.text}>{cleanup(block.markdown || '')}</Text>
      </View>
    </View>
  )
}
```

**Step 4: Verify**

Run: `pnpm --filter @coagent/desktop typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/desktop/src/lib/pdf/blocks/KpisPdf.tsx apps/desktop/src/lib/pdf/blocks/TablePdf.tsx apps/desktop/src/lib/pdf/blocks/CalloutPdf.tsx
git commit -m "feat(pdf): kpis/table/callout block components"
```

---

## Task 9: PDF block components — two-column, chart

**Files:**
- Create: `apps/desktop/src/lib/pdf/blocks/TwoColumnPdf.tsx`
- Create: `apps/desktop/src/lib/pdf/blocks/ChartPdf.tsx`
- Create: `apps/desktop/src/lib/pdf/blocks/dispatch.tsx`

**Step 1: dispatch.tsx** (needed before TwoColumn can reference it)

```tsx
import type { DocumentBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'
import { HeaderPdf } from './HeaderPdf'
import { TextPdf } from './TextPdf'
import { KpisPdf } from './KpisPdf'
import { TablePdf } from './TablePdf'
import { CalloutPdf } from './CalloutPdf'
import { ImagePdf } from './ImagePdf'
import { DividerPdf } from './DividerPdf'
import { SignoffPdf } from './SignoffPdf'
import { FooterPdf } from './FooterPdf'
import { ChartPdf } from './ChartPdf'
import { TwoColumnPdf } from './TwoColumnPdf'

export function BlockPdfDispatcher({ block, palette }: { block: DocumentBlock; palette: BrandPalette }) {
  switch (block.type) {
    case 'header':     return <HeaderPdf block={block} palette={palette} />
    case 'text':       return <TextPdf block={block} palette={palette} />
    case 'kpis':       return <KpisPdf block={block} palette={palette} />
    case 'table':      return <TablePdf block={block} palette={palette} />
    case 'callout':    return <CalloutPdf block={block} palette={palette} />
    case 'two_column': return <TwoColumnPdf block={block} palette={palette} />
    case 'image':      return <ImagePdf block={block} palette={palette} />
    case 'divider':    return <DividerPdf block={block} palette={palette} />
    case 'signoff':    return <SignoffPdf block={block} palette={palette} />
    case 'footer':     return <FooterPdf block={block} palette={palette} />
    case 'chart':      return <ChartPdf block={block} palette={palette} />
    default:           return null
  }
}
```

**Step 2: TwoColumnPdf.tsx**

```tsx
import { View, StyleSheet } from '@react-pdf/renderer'
import type { TwoColumnBlock, ColumnBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'
import { BlockPdfDispatcher } from './dispatch'

export function TwoColumnPdf({ block, palette }: { block: TwoColumnBlock; palette: BrandPalette }) {
  const ratio = block.ratio || '1:1'
  const [lf, rf] = ratio === '1:2' ? [1, 2] : ratio === '2:1' ? [2, 1] : [1, 1]
  const styles = StyleSheet.create({
    row: { flexDirection: 'row', gap: 12, marginBottom: 8 },
    col: {},
  })
  return (
    <View style={styles.row}>
      <View style={[styles.col, { flex: lf }]}>
        <BlockPdfDispatcher block={block.left as ColumnBlock} palette={palette} />
      </View>
      <View style={[styles.col, { flex: rf }]}>
        <BlockPdfDispatcher block={block.right as ColumnBlock} palette={palette} />
      </View>
    </View>
  )
}
```

**Step 3: ChartPdf.tsx — minimal bar/line/pie renderer with `<Svg>` primitives**

```tsx
import { View, Text, Svg, Rect, Line as SvgLine, Polyline, G, Path, StyleSheet } from '@react-pdf/renderer'
import type { ChartBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

const W = 480
const H = 220
const PAD = { top: 20, right: 16, bottom: 28, left: 36 }

function yKeysOf(block: ChartBlock, data: any[]): string[] {
  if (block.yKeys && block.yKeys.length > 0) return block.yKeys
  if (data.length === 0) return []
  return Object.keys(data[0]).filter(k => k !== block.xKey && k !== block.nameKey && typeof data[0][k] === 'number')
}

function maxVal(data: any[], keys: string[]): number {
  let m = 0
  for (const row of data) for (const k of keys) if (typeof row[k] === 'number' && row[k] > m) m = row[k]
  return m || 1
}

export function ChartPdf({ block, palette }: { block: ChartBlock; palette: BrandPalette }) {
  const styles = StyleSheet.create({
    wrap: { marginVertical: 8 },
    title: { fontSize: 11, fontWeight: 600, color: '#111827', marginBottom: 4 },
    empty: {
      height: 120,
      borderWidth: 1,
      borderColor: '#e5e7eb',
      borderStyle: 'dashed',
      borderRadius: 6,
      padding: 12,
      fontSize: 10,
      color: '#9ca3af',
      textAlign: 'center',
    },
  })
  const data = Array.isArray(block.data) ? block.data : []
  if (data.length === 0) {
    return (
      <View style={styles.wrap} wrap={false}>
        <Text style={styles.empty}>No chart data</Text>
      </View>
    )
  }

  const chartW = W - PAD.left - PAD.right
  const chartH = H - PAD.top - PAD.bottom

  if (block.kind === 'pie') {
    // Simple pie: cumulative angles, each slice as a Path.
    const valueKey = block.valueKey || 'value'
    const total = data.reduce((acc, d) => acc + (Number(d[valueKey]) || 0), 0) || 1
    const cx = W / 2, cy = H / 2, r = Math.min(chartH, chartW) / 2 - 6
    let acc = 0
    const slices = data.map((d, i) => {
      const v = Number(d[valueKey]) || 0
      const start = (acc / total) * Math.PI * 2
      acc += v
      const end = (acc / total) * Math.PI * 2
      const x1 = cx + Math.cos(start - Math.PI / 2) * r
      const y1 = cy + Math.sin(start - Math.PI / 2) * r
      const x2 = cx + Math.cos(end - Math.PI / 2) * r
      const y2 = cy + Math.sin(end - Math.PI / 2) * r
      const large = end - start > Math.PI ? 1 : 0
      return {
        d: `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`,
        fill: palette.chartPalette[i % palette.chartPalette.length],
      }
    })
    return (
      <View style={styles.wrap} wrap={false}>
        {block.title ? <Text style={styles.title}>{block.title}</Text> : null}
        <Svg width={W} height={H}>
          {slices.map((s, i) => <Path key={i} d={s.d} fill={s.fill} />)}
        </Svg>
      </View>
    )
  }

  const yKeys = yKeysOf(block, data)
  if (yKeys.length === 0) {
    return (
      <View style={styles.wrap} wrap={false}>
        <Text style={styles.empty}>No numeric series</Text>
      </View>
    )
  }
  const max = maxVal(data, yKeys)
  const xStep = chartW / Math.max(1, data.length)

  const yToPx = (v: number) => PAD.top + chartH - (v / max) * chartH

  return (
    <View style={styles.wrap} wrap={false}>
      {block.title ? <Text style={styles.title}>{block.title}</Text> : null}
      <Svg width={W} height={H}>
        {/* y axis baseline */}
        <SvgLine x1={PAD.left} y1={PAD.top + chartH} x2={PAD.left + chartW} y2={PAD.top + chartH} stroke="#d1d5db" strokeWidth={0.5} />
        {block.kind === 'bar' ? (
          yKeys.map((key, ki) => {
            const barW = (xStep * 0.8) / yKeys.length
            return (
              <G key={key}>
                {data.map((row, ri) => {
                  const v = Number(row[key]) || 0
                  const h = (v / max) * chartH
                  const x = PAD.left + ri * xStep + (xStep * 0.1) + ki * barW
                  const y = PAD.top + chartH - h
                  return (
                    <Rect key={ri} x={x} y={y} width={barW * 0.9} height={h} fill={palette.chartPalette[ki % palette.chartPalette.length]} />
                  )
                })}
              </G>
            )
          })
        ) : (
          // line
          yKeys.map((key, ki) => {
            const points = data.map((row, ri) => {
              const v = Number(row[key]) || 0
              const x = PAD.left + ri * xStep + xStep / 2
              const y = yToPx(v)
              return `${x},${y}`
            }).join(' ')
            return (
              <Polyline
                key={key}
                points={points}
                fill="none"
                stroke={palette.chartPalette[ki % palette.chartPalette.length]}
                strokeWidth={2}
              />
            )
          })
        )}
      </Svg>
    </View>
  )
}
```

**Step 4: Verify**

Run: `pnpm --filter @coagent/desktop typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/desktop/src/lib/pdf/blocks/TwoColumnPdf.tsx apps/desktop/src/lib/pdf/blocks/ChartPdf.tsx apps/desktop/src/lib/pdf/blocks/dispatch.tsx
git commit -m "feat(pdf): two-column and chart block components with svg primitives"
```

---

## Task 10: PDF document wrapper + entry point

**Files:**
- Create: `apps/desktop/src/lib/pdf/CanvasPdfDocument.tsx`
- Create: `apps/desktop/src/lib/pdf/index.ts`

**Step 1: CanvasPdfDocument.tsx**

```tsx
import { Document, Page, View, Text, Image, StyleSheet } from '@react-pdf/renderer'
import type { BlockDocument } from '@coagent/shared'
import type { BrandPalette } from './theme'
import { BlockPdfDispatcher } from './blocks/dispatch'

interface Props {
  doc: BlockDocument
  palette: BrandPalette
  companyName?: string
  logoDataUri?: string
}

export function CanvasPdfDocument({ doc, palette, companyName, logoDataUri }: Props) {
  const styles = StyleSheet.create({
    page: {
      paddingTop: 48,
      paddingBottom: 56,
      paddingHorizontal: 56,
      backgroundColor: '#ffffff',
      fontFamily: 'Helvetica',
    },
    runningHeader: {
      position: 'absolute',
      top: 20,
      left: 56,
      right: 56,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    runningLogo: { height: 14, objectFit: 'contain' },
    runningCompany: { fontSize: 8, color: '#9ca3af' },
    runningFooter: {
      position: 'absolute',
      bottom: 20,
      left: 56,
      right: 56,
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    footerText: { fontSize: 8, color: '#9ca3af' },
    body: { gap: 10 },
  })

  return (
    <Document title={doc.title} author={companyName || 'CoAgent'}>
      <Page size="LETTER" style={styles.page} wrap>
        {/* Fixed running header on every page */}
        <View style={styles.runningHeader} fixed>
          {logoDataUri ? (
            <Image src={logoDataUri} style={styles.runningLogo} />
          ) : (
            <Text style={styles.runningCompany}>{companyName || ' '}</Text>
          )}
          <Text style={styles.runningCompany}>{doc.title}</Text>
        </View>

        {/* Body */}
        <View style={styles.body}>
          {doc.blocks.map(block => (
            <BlockPdfDispatcher key={block.id} block={block} palette={palette} />
          ))}
        </View>

        {/* Fixed footer on every page */}
        <View style={styles.runningFooter} fixed>
          <Text style={styles.footerText}>{companyName || 'CoAgent'}</Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  )
}
```

**Step 2: index.ts (public entry point)**

```ts
// apps/desktop/src/lib/pdf/index.ts
// Public entry: render a Canvas block document to a base64 PDF.
// This replaces the old html2canvas-based renderer in canvas-pdf.ts.

import { pdf } from '@react-pdf/renderer'
import type { BlockDocument } from '@coagent/shared'
import { CanvasPdfDocument } from './CanvasPdfDocument'
import { buildBrandPalette, type BrandInput } from './theme'

export interface RenderedPdf {
  base64: string
  pageCount: number
}

export interface RenderCanvasPdfOptions {
  doc: BlockDocument
  brand?: {
    companyName?: string
    primary?: string
    secondary?: string
    tertiary?: string
    logoDataUri?: string
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      // data:application/pdf;base64,<payload>
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

export async function renderCanvasDocumentToPdf(opts: RenderCanvasPdfOptions): Promise<RenderedPdf> {
  const { doc, brand } = opts
  const brandInput: BrandInput = {
    primary: brand?.primary,
    secondary: brand?.secondary,
    tertiary: brand?.tertiary,
  }
  const palette = buildBrandPalette(brandInput)

  const instance = pdf(
    <CanvasPdfDocument
      doc={doc}
      palette={palette}
      companyName={brand?.companyName}
      logoDataUri={brand?.logoDataUri}
    />
  )
  const blob = await instance.toBlob()
  const base64 = await blobToBase64(blob)
  // react-pdf doesn't expose pageCount from the blob; estimate from byte-count buckets
  // or just report 0. Callers log it for debug — not critical. Report 0 for now.
  return { base64, pageCount: 0 }
}
```

**Step 3: Verify**

Run: `pnpm --filter @coagent/desktop typecheck`
Expected: PASS.

**Step 4: Commit**

```bash
git add apps/desktop/src/lib/pdf/CanvasPdfDocument.tsx apps/desktop/src/lib/pdf/index.ts
git commit -m "feat(pdf): canvas document wrapper + renderCanvasDocumentToPdf entry"
```

---

## Task 11: Wire new renderer into export flow, delete old pipeline

**Files:**
- Modify: `apps/desktop/src/hooks/useAgent.ts` — `exportCanvasPdf` now calls `renderCanvasDocumentToPdf` directly (no off-screen surface)
- Modify: `apps/desktop/src/App.tsx` — delete `CanvasExportSurface` rendering and prop passing
- Delete: `apps/desktop/src/lib/canvas-pdf.ts`
- Delete: `apps/desktop/src/components/CanvasExportSurface.tsx`
- Modify: `apps/desktop/package.json` — remove `html2canvas-pro` (keep `jspdf` only if still used elsewhere — check first)

**Step 1: Swap import + call in useAgent.ts**

Find the existing `exportCanvasPdf` implementation. Replace any `renderSurfaceToPdf` usage with direct `renderCanvasDocumentToPdf({ doc, brand })` call. Remove the off-screen-surface orchestration (the code that mounts a hidden div, waits for paint, then hands the DOM to the renderer).

The new flow:
1. User clicks Export PDF
2. `exportCanvasPdf()` collects current `canvasDoc` + brand from settings
3. Calls `renderCanvasDocumentToPdf({ doc, brand })` — returns base64
4. Sends `canvas_pdf_export` WS message with base64 payload (existing code path)

Concrete guidance: grep for `renderSurfaceToPdf` and `CanvasExportSurface` in `useAgent.ts` and `App.tsx` — there should be 2-4 references total. Replace the surface-mount dance with a direct call.

**Step 2: Delete old files**

```bash
rm apps/desktop/src/lib/canvas-pdf.ts
rm apps/desktop/src/components/CanvasExportSurface.tsx
```

**Step 3: Remove `html2canvas-pro` dependency**

Check if anything else imports it:
```bash
cd /Users/brettponters/AI-Projects/CoAgent && grep -r "html2canvas" apps/ packages/ --include="*.ts" --include="*.tsx" -l
```
Expected: no results (only the deleted file referenced it).

Then:
```bash
cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop && pnpm remove html2canvas-pro
```

Also check jspdf:
```bash
cd /Users/brettponters/AI-Projects/CoAgent && grep -r "jspdf" apps/ packages/ --include="*.ts" --include="*.tsx" -l
```
If no results, `pnpm remove jspdf` too. If still used somewhere, leave it.

**Step 4: Verify**

1. Run: `pnpm --filter @coagent/desktop typecheck`
   Expected: PASS (no dangling references to deleted files).
2. Visual check: in the running app, open a Canvas doc, click Export PDF. A toast should appear with the filename. Click Reveal in Finder. Open the PDF.
3. Inspect the PDF:
   - Text is selectable? ✓
   - File size < 1MB for a typical 8-block doc? ✓
   - Page breaks don't split KPI cards or table rows? ✓
   - Header + page number on every page? ✓
   - Brand primary color applied to header eyebrow, KPI borders, table header bg? ✓
   - Chart (if present) rendered with brand palette? ✓

**Step 5: Commit**

```bash
git add apps/desktop/src/hooks/useAgent.ts apps/desktop/src/App.tsx apps/desktop/package.json pnpm-lock.yaml
git rm apps/desktop/src/lib/canvas-pdf.ts apps/desktop/src/components/CanvasExportSurface.tsx
git commit -m "feat(pdf): switch export pipeline to @react-pdf/renderer vector output"
```

---

## Task 12: Final verification

**Step 1: Full monorepo typecheck**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && pnpm -r typecheck`
Expected: PASS across all packages.

**Step 2: Visual QA matrix**

Test with 3 brand configs and at least 2 doc types:

| Brand | Doc | Expected |
|-------|-----|----------|
| Default (no colors picked) | client-status | Default navy `#1a2744` everywhere; chart palette starts with navy then falls through semantic colors |
| Primary only (hot pink `#c026d3`) | daily-briefing | Pink eyebrow/borders/KPI cards/dividers. Chart single-series = pink. |
| Primary + secondary + tertiary (pink + green + gold) | marketing-audit with chart | All three colors appear in the chart. Header/KPIs use pink. |

Each doc: also export to PDF and verify vector output matches the on-screen canvas.

**Step 3: Final commit (if any cleanup)**

If everything passes, nothing to commit. If there are straggler fixes:

```bash
git add -A
git commit -m "chore(brand): visual QA fixes"
```

---

## Notes for the implementer

- **No unit tests in this plan** because the desktop app has no test framework set up and this is a visual feature. Verification is manual via HMR.
- **Dev is running in the background** (`pnpm tauri dev` started earlier). HMR will pick up file changes automatically — no need to restart on every task. If HMR gets stuck, `pgrep -fl tauri` and restart.
- **Commit after every task.** Do not batch. If a task fails mid-way, we need a clean rollback point.
- **If a task reveals an unexpected dependency** (e.g., a block type I didn't cover, or an import that's circular), stop and ask — don't improvise.
- **Don't touch unrelated files.** The working tree has many uncommitted changes from previous work; leave them alone unless they're explicitly in a task's Files list.
- **Branch:** execute directly on `main` (per user workflow). Commits will land alongside the earlier design doc commit.
