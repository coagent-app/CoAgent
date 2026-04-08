// Off-screen document surface used to render a Canvas doc to PDF without
// requiring the visible CanvasPane to be mounted. We position it far off-screen
// (not display:none — html2canvas needs real layout), let the blocks paint,
// then hand the DOM node to renderSurfaceToPdf.

import { useEffect, useMemo, useRef } from 'react'
import type { BlockDocument } from '@coagent/shared'
import { BlockRenderer } from '@/components/blocks/BlockRenderer'
import { renderSurfaceToPdf } from '@/lib/canvas-pdf'

interface BrandKit {
  companyName?: string
  primary?: string
  secondary?: string
  tertiary?: string
  logoDataUri?: string
}

interface Props {
  doc: BlockDocument
  brand?: BrandKit
  onRendered: (result: { base64: string; pageCount: number }) => void
  onError: (message: string) => void
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  if ([r, g, b].some(n => Number.isNaN(n))) return `rgba(37, 99, 235, ${alpha})`
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function CanvasExportSurface({ doc, brand, onRendered, onError }: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const firedRef = useRef(false)

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

  useEffect(() => {
    if (firedRef.current) return
    firedRef.current = true

    // Give React a frame to paint the blocks, then render.
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(async () => {
        const surface = surfaceRef.current
        if (!surface) {
          onError('Export surface not mounted')
          return
        }
        try {
          const result = await renderSurfaceToPdf({ surface })
          onRendered(result)
        } catch (err: any) {
          onError(err?.message || String(err))
        }
      })
    })
    return () => cancelAnimationFrame(raf)
    // Only render once per mount — doc id is the identity we care about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id])

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        left: '-10000px',
        top: 0,
        width: '640px',
        pointerEvents: 'none',
        ...cssVars,
      }}
    >
      <div
        ref={surfaceRef}
        id="canvas-export-surface"
        className="mx-auto my-6 max-w-[600px] bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-neutral-200 dark:border-neutral-800 p-10 space-y-6"
      >
        {brand?.logoDataUri && (
          <div className="flex justify-end -mb-3">
            <img src={brand.logoDataUri} alt={brand.companyName || 'logo'} className="h-7 opacity-80" />
          </div>
        )}
        {doc.blocks.map(block => (
          <BlockRenderer key={block.id} block={block} />
        ))}
      </div>
    </div>
  )
}
