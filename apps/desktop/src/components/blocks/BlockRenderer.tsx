// Renders a single DocumentBlock. Each block is a pure function of its data
// and the Canvas brand kit CSS variables. Brand kit colors flow in via CSS
// vars on the Canvas container, so blocks don't need to know about the kit.

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { cn } from '@/lib/utils'
import type {
  DocumentBlock,
  HeaderBlock,
  TextBlock,
  KpisBlock,
  TableBlock,
  CalloutBlock,
  TwoColumnBlock,
  ImageBlock,
  DividerBlock,
  SignoffBlock,
  FooterBlock,
  ChartBlock,
  ColumnBlock,
} from '@coagent/shared'

// ── Placeholder-detection safety net ─────────────────────────────────────
// If the agent slips up and emits an unfilled template token or leaves a
// required field empty mid-stream, we render a shimmer skeleton instead of
// the raw `{{...}}` text. This is a belt-and-suspenders layer on top of the
// tool-level rule ("never emit placeholders"); the user should never see
// template syntax in the Canvas surface.

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/
function looksLikePlaceholder(s: string | undefined | null): boolean {
  if (!s) return false
  return PLACEHOLDER_RE.test(s)
}
function isMissing(s: string | undefined | null): boolean {
  return !s || !s.trim() || looksLikePlaceholder(s)
}

// Shimmer utility — animates a neutral bar. Width controls how "long" the
// fake line appears (matches typical text lengths).
function Shimmer({ className, width }: { className?: string; width?: string }) {
  return (
    <span
      className={cn(
        'inline-block align-middle rounded bg-neutral-200 dark:bg-neutral-700 animate-pulse',
        className,
      )}
      style={{ width: width || '100%' }}
      aria-hidden
    />
  )
}

// Shared markdown renderer used inside text/callout blocks. Keeps the canvas
// print-ready: no editor affordances, just clean typography.
function Markdown({ source }: { source: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0 text-[13.5px] leading-relaxed text-neutral-700 dark:text-neutral-200">{children}</p>,
        h1: ({ children }) => <h1 className="text-[20px] font-bold text-neutral-900 dark:text-neutral-50 mb-2 mt-4 first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="text-[16px] font-semibold text-neutral-900 dark:text-neutral-50 mb-2 mt-4 first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-50 mb-1 mt-3 first:mt-0">{children}</h3>,
        ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-1 text-[13.5px] text-neutral-700 dark:text-neutral-200">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-1 text-[13.5px] text-neutral-700 dark:text-neutral-200">{children}</ol>,
        li: ({ children }) => <li>{children}</li>,
        strong: ({ children }) => <strong className="font-semibold text-neutral-900 dark:text-neutral-50">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--canvas-primary)' }}>{children}</a>,
        table: ({ children }) => (
          <div className="overflow-x-auto my-3">
            <table className="text-[12.5px] border-collapse w-full">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-neutral-50 dark:bg-neutral-800">{children}</thead>,
        th: ({ children }) => <th className="border border-neutral-200 dark:border-neutral-700 px-2 py-1.5 text-left font-semibold text-neutral-800 dark:text-neutral-100">{children}</th>,
        td: ({ children }) => <td className="border border-neutral-200 dark:border-neutral-700 px-2 py-1.5 text-neutral-700 dark:text-neutral-200">{children}</td>,
      }}
    >
      {source}
    </ReactMarkdown>
  )
}

function HeaderBlockView({ block }: { block: HeaderBlock }) {
  const titleMissing = isMissing(block.title)
  const subtitleMissing = isMissing(block.subtitle)
  return (
    <div className="pb-4 border-b" style={{ borderColor: 'var(--canvas-primary-soft)' }}>
      {block.eyebrow && (
        <div className="text-[10.5px] font-semibold tracking-[0.12em] uppercase mb-1.5" style={{ color: 'var(--canvas-primary)' }}>
          {block.eyebrow}
        </div>
      )}
      <h1 className="text-[26px] font-bold text-neutral-900 dark:text-neutral-50 leading-tight min-h-[32px]">
        {titleMissing ? <Shimmer className="h-7" width="60%" /> : block.title}
      </h1>
      {subtitleMissing ? (
        <div className="mt-2"><Shimmer className="h-3" width="40%" /></div>
      ) : (
        <div className="text-[13.5px] text-neutral-500 dark:text-neutral-400 mt-1">
          {block.subtitle}
        </div>
      )}
    </div>
  )
}

function TextBlockView({ block }: { block: TextBlock }) {
  const source = block.markdown || ''
  if (isMissing(source)) {
    return (
      <div className="space-y-2">
        <Shimmer className="h-3" width="85%" />
        <Shimmer className="h-3" width="95%" />
        <Shimmer className="h-3" width="70%" />
      </div>
    )
  }
  // If the text is mostly real but has stray `{{...}}` tokens, strip them so
  // they don't render as literal characters.
  const cleaned = PLACEHOLDER_RE.test(source) ? source.replace(/\{\{[^}]+\}\}/g, '…') : source
  return <div><Markdown source={cleaned} /></div>
}

// Pick a semantic color for a KPI delta so up/down trends are immediately
// readable instead of all being the accent color (which made deltas blend
// into the eyebrow above them).
function deltaColor(delta: string): string {
  const trimmed = delta.trim()
  if (/^[▲↑+]/.test(trimmed) || /\bup\b/i.test(trimmed)) return 'var(--canvas-success)'
  if (/^[▼↓-]/.test(trimmed) || /\bdown\b/i.test(trimmed)) return 'var(--canvas-danger)'
  return 'var(--canvas-neutral)'
}

function KpisBlockView({ block }: { block: KpisBlock }) {
  const count = Math.max(1, block.items.length)
  // Auto-grid: every KPI is equal width, no orphan rows from odd counts.
  // We cap at 6 per row because beyond that the labels get too cramped.
  const colCount = Math.min(count, 6)
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))` }}
    >
      {block.items.map((item, i) => {
        const labelMissing = isMissing(item.label)
        const valueMissing = isMissing(item.value)
        const hasDelta = item.delta && !looksLikePlaceholder(item.delta)
        return (
          <div key={i} className="rounded-lg px-4 py-3 border flex flex-col" style={{ borderColor: 'var(--canvas-primary-soft)', background: 'var(--canvas-primary-bg)' }}>
            <div className="text-[10.5px] uppercase tracking-wide font-semibold text-neutral-500 dark:text-neutral-400 mb-1.5 min-h-[14px] truncate">
              {labelMissing ? <Shimmer className="h-2.5" width="60%" /> : item.label}
            </div>
            <div className="text-[22px] font-bold text-neutral-900 dark:text-neutral-50 leading-tight break-words min-h-[28px]">
              {valueMissing ? <Shimmer className="h-6" width="55%" /> : item.value}
            </div>
            {hasDelta && (
              <div className="text-[11px] font-medium mt-1.5" style={{ color: deltaColor(item.delta as string) }}>{item.delta}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function TableBlockView({ block }: { block: TableBlock }) {
  return (
    <div className="overflow-x-auto">
      {block.caption && !looksLikePlaceholder(block.caption) && (
        <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mb-1.5 italic">{block.caption}</div>
      )}
      <table className="text-[12.5px] border-collapse w-full">
        <thead>
          <tr>
            {block.headers.map((h, i) => (
              <th key={i} className="px-3 py-2 text-left font-semibold text-white" style={{ background: 'var(--canvas-primary)' }}>
                {isMissing(h) ? <Shimmer className="h-3" width="70%" /> : h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, ri) => (
            <tr key={ri} className={cn('border-b border-neutral-200 dark:border-neutral-700', row.emphasis && 'font-semibold')}>
              {row.cells.map((c, ci) => (
                <td key={ci} className="px-3 py-2 text-neutral-700 dark:text-neutral-200 align-top">
                  {isMissing(c) ? <Shimmer className="h-3" width="80%" /> : c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const CALLOUT_STYLES: Record<string, { bg: string; border: string; icon: string; iconColor: string }> = {
  info:    { bg: 'bg-blue-50 dark:bg-blue-950/30',     border: 'border-blue-200 dark:border-blue-800',     icon: 'i', iconColor: 'text-blue-600 dark:text-blue-400' },
  warn:    { bg: 'bg-amber-50 dark:bg-amber-950/30',   border: 'border-amber-200 dark:border-amber-800',   icon: '!', iconColor: 'text-amber-600 dark:text-amber-400' },
  success: { bg: 'bg-emerald-50 dark:bg-emerald-950/30', border: 'border-emerald-200 dark:border-emerald-800', icon: '✓', iconColor: 'text-emerald-600 dark:text-emerald-400' },
  tip:     { bg: 'bg-violet-50 dark:bg-violet-950/30', border: 'border-violet-200 dark:border-violet-800', icon: '◆', iconColor: 'text-violet-600 dark:text-violet-400' },
}

function CalloutBlockView({ block }: { block: CalloutBlock }) {
  const style = CALLOUT_STYLES[block.variant] || CALLOUT_STYLES.info
  const markdown = block.markdown || ''
  const bodyMissing = isMissing(markdown)
  const cleanedMarkdown = PLACEHOLDER_RE.test(markdown) ? markdown.replace(/\{\{[^}]+\}\}/g, '…') : markdown
  return (
    <div className={cn('rounded-lg border px-4 py-3.5 flex items-start gap-3', style.bg, style.border)}>
      <div className={cn('text-[12px] font-bold flex-shrink-0 w-5 h-5 mt-0.5 flex items-center justify-center rounded-full', style.iconColor, style.bg)} style={{ lineHeight: 1 }}>
        {style.icon}
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        {block.title && !looksLikePlaceholder(block.title) && (
          <div className="font-semibold text-[13px] text-neutral-900 dark:text-neutral-50 mb-1 leading-tight">{block.title}</div>
        )}
        {bodyMissing ? (
          <div className="space-y-1.5 py-0.5">
            <Shimmer className="h-2.5" width="90%" />
            <Shimmer className="h-2.5" width="70%" />
          </div>
        ) : (
          <Markdown source={cleanedMarkdown} />
        )}
      </div>
    </div>
  )
}

function ImageBlockView({ block }: { block: ImageBlock }) {
  return (
    <figure className="my-2">
      <img
        src={block.src}
        alt={block.alt || ''}
        className="rounded-lg w-full border border-neutral-200 dark:border-neutral-700"
        style={{ maxWidth: block.maxWidth || '100%' }}
      />
      {block.caption && (
        <figcaption className="text-[11px] text-neutral-500 dark:text-neutral-400 italic mt-1.5 text-center">
          {block.caption}
        </figcaption>
      )}
    </figure>
  )
}

function DividerBlockView(_: { block: DividerBlock }) {
  return <div className="h-px w-full" style={{ background: 'var(--canvas-primary-soft)' }} />
}

function SignoffBlockView({ block }: { block: SignoffBlock }) {
  return (
    <div className="pt-6 border-t" style={{ borderColor: 'var(--canvas-primary-soft)' }}>
      {block.signatureDataUri && (
        <img src={block.signatureDataUri} alt="Signature" className="h-14 mb-2" />
      )}
      <div className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-50">{block.name}</div>
      {block.title && <div className="text-[12px] text-neutral-500 dark:text-neutral-400">{block.title}</div>}
      {block.date && <div className="text-[11px] text-neutral-400 dark:text-neutral-500 mt-1">{block.date}</div>}
    </div>
  )
}

function FooterBlockView({ block }: { block: FooterBlock }) {
  return (
    <div className="pt-4 mt-2 border-t text-[10.5px] text-neutral-400 dark:text-neutral-500 text-center" style={{ borderColor: 'var(--canvas-primary-soft)' }}>
      {block.note || 'Generated by CoAgent'}
    </div>
  )
}

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

function ChartBlockView({ block }: { block: ChartBlock }) {
  const data = Array.isArray(block.data) ? block.data : []
  if (data.length === 0) {
    return <div className="h-48 rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 flex items-center justify-center text-[12px] text-neutral-400">No chart data</div>
  }
  const yKeys = block.yKeys && block.yKeys.length > 0
    ? block.yKeys
    : Object.keys(data[0]).filter(k => k !== block.xKey && k !== block.nameKey && typeof data[0][k] === 'number')

  return (
    <div className="my-2">
      {block.title && <div className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100 mb-2">{block.title}</div>}
      <div style={{ width: '100%', height: 240 }}>
        <ResponsiveContainer>
          {block.kind === 'bar' ? (
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.15} />
              <XAxis dataKey={block.xKey || 'name'} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              {yKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
              {yKeys.map((k, i) => (
                <Bar key={k} dataKey={k} fill={CHART_PALETTE[i % CHART_PALETTE.length]} radius={[4, 4, 0, 0]} />
              ))}
            </BarChart>
          ) : block.kind === 'line' ? (
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.15} />
              <XAxis dataKey={block.xKey || 'name'} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              {yKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
              {yKeys.map((k, i) => (
                <Line key={k} type="monotone" dataKey={k} stroke={CHART_PALETTE[i % CHART_PALETTE.length]} strokeWidth={2} dot={false} />
              ))}
            </LineChart>
          ) : (
            <PieChart>
              <Pie
                data={data}
                dataKey={block.valueKey || 'value'}
                nameKey={block.nameKey || 'name'}
                outerRadius={90}
                label={{ fontSize: 11 }}
              >
                {data.map((_, i) => (
                  <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function TwoColumnBlockView({ block }: { block: TwoColumnBlock }) {
  const ratio = block.ratio || '1:1'
  const cols = ratio === '1:2' ? 'grid-cols-[1fr_2fr]' : ratio === '2:1' ? 'grid-cols-[2fr_1fr]' : 'grid-cols-2'
  return (
    <div className={cn('grid gap-4', cols)}>
      <div className="min-w-0"><BlockDispatcher block={block.left as ColumnBlock} /></div>
      <div className="min-w-0"><BlockDispatcher block={block.right as ColumnBlock} /></div>
    </div>
  )
}

// Dispatches a block to its renderer. Used both at the top level and inside
// TwoColumnBlock for nested blocks.
function BlockDispatcher({ block }: { block: DocumentBlock }) {
  switch (block.type) {
    case 'header':     return <HeaderBlockView block={block} />
    case 'text':       return <TextBlockView block={block} />
    case 'kpis':       return <KpisBlockView block={block} />
    case 'table':      return <TableBlockView block={block} />
    case 'callout':    return <CalloutBlockView block={block} />
    case 'two_column': return <TwoColumnBlockView block={block} />
    case 'image':      return <ImageBlockView block={block} />
    case 'divider':    return <DividerBlockView block={block} />
    case 'signoff':    return <SignoffBlockView block={block} />
    case 'footer':     return <FooterBlockView block={block} />
    case 'chart':      return <ChartBlockView block={block} />
    default:
      return null
  }
}

export function BlockRenderer({ block }: { block: DocumentBlock }) {
  return <BlockDispatcher block={block} />
}
