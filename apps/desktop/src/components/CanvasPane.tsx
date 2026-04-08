// CanvasPane — live document preview that sits alongside ChatPane.
// Receives BlockDocument state from useAgent and animates newly-arrived
// blocks into view as the agent streams update_document ops.

import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Download, Loader2 } from 'lucide-react'
import type { BlockDocument, DocumentBlock } from '@coagent/shared'
import { BlockRenderer } from '@/components/blocks/BlockRenderer'
import { cn } from '@/lib/utils'
import { hexToRgba } from '@/lib/colors'

interface BrandKit {
  companyName?: string
  primary?: string
  secondary?: string
  tertiary?: string
  logoDataUri?: string
}

interface Props {
  doc: BlockDocument
  streaming: boolean
  brand?: BrandKit
  onClose: () => void
  onExportPdf?: () => void
  exporting?: boolean
}

const isSet = (c?: string) => typeof c === 'string' && c.trim() !== ''

export function CanvasPane({ doc, streaming, brand, onClose, onExportPdf, exporting }: Props) {
  const primary = brand?.primary || '#1a2744'
  const secondary = brand?.secondary || ''
  const tertiary = brand?.tertiary || ''
  const cssVars = useMemo<React.CSSProperties>(() => {
    const success = '#059669'
    const danger = '#dc2626'
    const neutral = '#6b7280'

    // Build chart palette skipping unset user brand slots (same logic as theme.ts)
    // so a primary-only brand doesn't repeat the primary for series 2 and 3.
    const chartPalette: string[] = [primary]
    if (isSet(secondary)) chartPalette.push(secondary)
    if (isSet(tertiary)) chartPalette.push(tertiary)
    chartPalette.push(success, danger, neutral)

    // Emit 6 numbered chart vars; overflow slots wrap around via modulo so
    // the chart cycle always has 6 entries without introducing blank slots.
    const chartVars: Record<string, string> = {}
    for (let i = 0; i < 6; i++) {
      chartVars[`--canvas-chart-${i + 1}` as string] = chartPalette[i % chartPalette.length]
    }

    return {
      // Keep the semantic vars — non-chart blocks (KPI borders, header eyebrow,
      // callouts) depend on these.
      ['--canvas-primary' as any]: primary,
      ['--canvas-primary-soft' as any]: hexToRgba(primary, 0.25),
      ['--canvas-primary-bg' as any]: hexToRgba(primary, 0.05),
      ['--canvas-secondary' as any]: secondary || primary,
      ['--canvas-tertiary' as any]: tertiary || secondary || primary,
      ['--canvas-success' as any]: success,
      ['--canvas-warning' as any]: '#d97706',
      ['--canvas-danger' as any]: danger,
      ['--canvas-neutral' as any]: neutral,
      ...chartVars,
    }
  }, [primary, secondary, tertiary])

  // Track which block IDs have been animated in. New ones fade + slide on arrival.
  const [seenIds, setSeenIds] = useState<Set<string>>(() => new Set(doc.blocks.map(b => b.id)))
  const newlyArrivedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const current = new Set(doc.blocks.map(b => b.id))
    const nextNew = new Set<string>()
    for (const id of current) {
      if (!seenIds.has(id)) nextNew.add(id)
    }
    if (nextNew.size > 0) {
      newlyArrivedRef.current = nextNew
      setSeenIds(prev => {
        const merged = new Set(prev)
        for (const id of current) merged.add(id)
        return merged
      })
    }
  }, [doc.blocks, seenIds])

  // Autoscroll to the bottom while streaming so new blocks stay in view.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (streaming && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [doc.blocks.length, streaming])

  return (
    <div
      className="flex flex-col h-full w-full max-w-[640px] border-l border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950"
      style={cssVars}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {streaming && <Loader2 size={13} className="animate-spin flex-shrink-0" style={{ color: 'var(--canvas-primary)' }} />}
          <div className="text-[12.5px] font-semibold text-neutral-800 dark:text-neutral-100 truncate">
            {doc.title}
          </div>
          {streaming && <div className="text-[10.5px] text-neutral-400 dark:text-neutral-500">drafting…</div>}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {onExportPdf && (
            <button
              onClick={onExportPdf}
              disabled={exporting}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
              title="Export as PDF"
            >
              {exporting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              PDF
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            title="Close canvas"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Document surface */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div id="canvas-surface" className="mx-auto my-6 max-w-[600px] bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-neutral-200 dark:border-neutral-800 p-10 space-y-6">
          {brand?.logoDataUri && (
            <div className="flex justify-end -mb-3">
              <img src={brand.logoDataUri} alt={brand.companyName || 'logo'} className="h-7 opacity-80" />
            </div>
          )}
          {doc.blocks.length === 0 ? (
            <div className="text-center py-16 text-[13px] text-neutral-400 dark:text-neutral-500">
              {streaming ? 'Agent is drafting…' : 'Empty document'}
            </div>
          ) : (
            doc.blocks.map(block => (
              <BlockArrival key={block.id} block={block} isNew={newlyArrivedRef.current.has(block.id)} />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// Wraps a block with a one-shot enter animation when it first arrives. Uses
// CSS transitions so there is no per-frame JS cost after the animation lands.
function BlockArrival({ block, isNew }: { block: DocumentBlock; isNew: boolean }) {
  const [mounted, setMounted] = useState(!isNew)
  useEffect(() => {
    if (isNew) {
      // Let the initial paint happen, then trigger the transition on next frame.
      const raf = requestAnimationFrame(() => setMounted(true))
      return () => cancelAnimationFrame(raf)
    }
  }, [isNew])
  return (
    <div
      className={cn(
        'transition-all duration-500 ease-out',
        mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
      )}
    >
      <BlockRenderer block={block} />
    </div>
  )
}
