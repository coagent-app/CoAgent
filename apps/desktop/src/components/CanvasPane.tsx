// CanvasPane — live document preview that sits alongside ChatPane.
// Receives BlockDocument state from useAgent and animates newly-arrived
// blocks into view as the agent streams update_document ops.
// When not streaming, each block is individually editable via per-block
// editors. Edits emit DocumentUpdateOps that are applied locally and sent
// to the server for persistence.

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { X, Download, Loader2 } from 'lucide-react'
import type { BlockDocument, DocumentBlock, DocumentUpdateOp } from '@coagent/shared'
import { BlockRenderer } from '@/components/blocks/BlockRenderer'
import { BlockEditor } from '@/components/blocks/editors/BlockEditor'
import { BlockControls } from '@/components/blocks/editors/BlockControls'
import { cn } from '@/lib/utils'
import { hexToRgba } from '@/lib/colors'
import { useCanvasEditor } from '@/hooks/useCanvasEditor'

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
  onDocumentChange?: (next: BlockDocument) => void
  onEmit?: (docId: string, ops: DocumentUpdateOp[]) => void
}

const isSet = (c?: string) => typeof c === 'string' && c.trim() !== ''

export function CanvasPane({ doc, streaming, brand, onClose, onExportPdf, exporting, onDocumentChange, onEmit }: Props) {
  const primary = brand?.primary || '#1a2744'
  const secondary = brand?.secondary || ''
  const tertiary = brand?.tertiary || ''
  const cssVars = useMemo<React.CSSProperties>(() => {
    const success = '#059669'
    const danger = '#dc2626'
    const neutral = '#6b7280'

    // Build chart palette skipping unset user brand slots (same logic as theme.ts)
    const chartPalette: string[] = [primary]
    if (isSet(secondary)) chartPalette.push(secondary)
    if (isSet(tertiary)) chartPalette.push(tertiary)
    chartPalette.push(success, danger, neutral)

    const chartVars: Record<string, string> = {}
    for (let i = 0; i < 6; i++) {
      chartVars[`--canvas-chart-${i + 1}` as string] = chartPalette[i % chartPalette.length]
    }

    return {
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

  // ── Editor state ─────────────────────────────────────────────────────────

  const handleEmit = useCallback((docId: string, ops: DocumentUpdateOp[]) => {
    onEmit?.(docId, ops)
  }, [onEmit])

  const editor = useCanvasEditor(doc, handleEmit)

  // Notify parent when local doc state changes so App.tsx / useAgent can
  // keep canvasDocRef in sync (needed for accurate agent-export snapshots).
  useEffect(() => {
    onDocumentChange?.(editor.doc)
  }, [editor.doc, onDocumentChange])

  // Selection: which block id is currently "active" for editing.
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)

  // Clear selection when streaming starts.
  useEffect(() => {
    if (streaming) setSelectedBlockId(null)
  }, [streaming])

  // Hover tracking per block for showing BlockControls.
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null)

  // ── Block arrival animation ───────────────────────────────────────────────

  const [seenIds, setSeenIds] = useState<Set<string>>(() => new Set(doc.blocks.map(b => b.id)))
  const newlyArrivedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const current = new Set(editor.doc.blocks.map(b => b.id))
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
  }, [editor.doc.blocks, seenIds])

  // ── Autoscroll ────────────────────────────────────────────────────────────

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (streaming && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [editor.doc.blocks.length, streaming])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  //
  // Only active when focus is inside #canvas-surface so shortcuts don't
  // interfere with the ChatPane text input or other UI.

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const surface = document.getElementById('canvas-surface')
      if (!surface) return
      // Check if the focused element is inside canvas-surface
      if (!surface.contains(document.activeElement) && document.activeElement !== surface) return

      const isMac = navigator.platform.includes('Mac')
      const mod = isMac ? e.metaKey : e.ctrlKey

      if (mod && !e.shiftKey && e.key === 'z') {
        e.preventDefault()
        editor.undo()
        return
      }
      if (mod && e.shiftKey && e.key === 'z') {
        e.preventDefault()
        editor.redo()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSelectedBlockId(null)
        ;(document.activeElement as HTMLElement)?.blur?.()
        return
      }
      if (e.altKey && e.key === 'ArrowUp' && selectedBlockId) {
        e.preventDefault()
        const idx = editor.doc.blocks.findIndex(b => b.id === selectedBlockId)
        if (idx > 0) editor.moveBlock(idx, idx - 1)
        return
      }
      if (e.altKey && e.key === 'ArrowDown' && selectedBlockId) {
        e.preventDefault()
        const idx = editor.doc.blocks.findIndex(b => b.id === selectedBlockId)
        if (idx < editor.doc.blocks.length - 1) editor.moveBlock(idx, idx + 1)
        return
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [editor, selectedBlockId])

  // ── Render ────────────────────────────────────────────────────────────────

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
            {editor.doc.title}
          </div>
          {streaming && <div className="text-[10.5px] text-neutral-400 dark:text-neutral-500">drafting…</div>}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {onExportPdf && (
            <button
              onClick={onExportPdf}
              disabled={exporting}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
              title="Save PDF to disk"
            >
              {exporting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              Save PDF…
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
        <div
          id="canvas-surface"
          tabIndex={-1}
          className="mx-auto my-6 max-w-[600px] bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-neutral-200 dark:border-neutral-800 p-10 space-y-6 outline-none"
        >
          {brand?.logoDataUri && (
            <div className="flex justify-end -mb-3">
              <img src={brand.logoDataUri} alt={brand.companyName || 'logo'} className="h-7 opacity-80" />
            </div>
          )}
          {editor.doc.blocks.length === 0 ? (
            <div className="text-center py-16 text-[13px] text-neutral-400 dark:text-neutral-500">
              {streaming ? 'Agent is drafting…' : 'Empty document'}
            </div>
          ) : (
            editor.doc.blocks.map((block, idx) => (
              <BlockArrival
                key={block.id}
                block={block}
                isNew={newlyArrivedRef.current.has(block.id)}
                isSelected={selectedBlockId === block.id}
                isEditing={!streaming && selectedBlockId === block.id}
                streaming={streaming}
                onSelect={() => { if (!streaming) setSelectedBlockId(block.id) }}
                onMouseEnter={() => setHoveredBlockId(block.id)}
                onMouseLeave={() => setHoveredBlockId(prev => prev === block.id ? null : prev)}
                showControls={!streaming && hoveredBlockId === block.id}
                onCommit={next => editor.replaceBlock(block.id, next)}
                onMoveUp={idx > 0 ? () => editor.moveBlock(idx, idx - 1) : undefined}
                onMoveDown={idx < editor.doc.blocks.length - 1 ? () => editor.moveBlock(idx, idx + 1) : undefined}
                onDuplicate={() => editor.duplicateBlock(block.id)}
                onDelete={() => editor.deleteBlock(block.id)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ── BlockArrival ─────────────────────────────────────────────────────────────
// Wraps a block with:
//   - One-shot entrance animation when it first arrives during streaming
//   - Selection ring when clicked (non-streaming)
//   - BlockControls overlay on hover (non-streaming)
//   - BlockEditor or BlockRenderer depending on isEditing

interface BlockArrivalProps {
  block: DocumentBlock
  isNew: boolean
  isSelected: boolean
  isEditing: boolean
  streaming: boolean
  onSelect: () => void
  onMouseEnter: () => void
  onMouseLeave: () => void
  showControls: boolean
  onCommit: (next: DocumentBlock) => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  onDuplicate: () => void
  onDelete: () => void
}

function BlockArrival({
  block,
  isNew,
  isSelected,
  isEditing,
  streaming,
  onSelect,
  onMouseEnter,
  onMouseLeave,
  showControls,
  onCommit,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  onDelete,
}: BlockArrivalProps) {
  const [mounted, setMounted] = useState(!isNew)
  useEffect(() => {
    if (isNew) {
      const raf = requestAnimationFrame(() => setMounted(true))
      return () => cancelAnimationFrame(raf)
    }
  }, [isNew])

  return (
    <div
      className={cn(
        'relative group transition-all duration-500 ease-out',
        mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3',
        !streaming && isSelected && 'ring-2 ring-offset-2 ring-blue-400 rounded-md',
      )}
      onClick={onSelect}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <BlockEditor
        block={block}
        isEditing={isEditing}
        onCommit={onCommit}
      />
      {!streaming && (
        <BlockControls
          visible={showControls}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
        />
      )}
    </div>
  )
}
