// CanvasPane — renders a Canvas (TSX document) using react-runner.
//
// The agent writes TSX code that exports a default component. We feed it
// into useRunner, which compiles via Sucrase and returns a React element.
// We render that element inside a same-origin iframe (srcdoc) so the
// document has its own styling scope and `window.print()` works for PDF
// export. Tailwind is loaded via the Play CDN script inside the iframe.
//
// Streaming UX: the agent broadcasts `canvas_streaming` with partialCode
// every ~100ms while writing. useRunner is fed the growing buffer; on
// parse failures it returns the last good element so the canvas never
// flickers to blank.

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, Download, Loader2 } from 'lucide-react'
import { useRunner } from 'react-runner'
import type { Canvas, AgentSettings } from '@coagent/shared'
import { buildCanvasScope, brandFromSettings } from '@/lib/canvas-scope'

interface Props {
  canvas: Canvas
  /** true while `canvas_streaming` deltas are arriving */
  streaming?: boolean
  /** raw partial TSX from the agent while streaming (overrides canvas.code) */
  streamingCode?: string
  settings: AgentSettings | null | undefined
  onClose: () => void
}

// Bundled Tailwind Play CDN script. We ship it as a Vite asset so the
// renderer works offline. See apps/desktop/src/vendor/tailwind-play.js.
import tailwindPlayRaw from '@/vendor/tailwind-play.js?raw'

// HTML scaffold for the iframe. A single <div id="root"> is hydrated
// imperatively by the effect below.
const IFRAME_SRCDOC = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script>${tailwindPlayRaw}</script>
<style>
  html, body { margin: 0; padding: 0; background: white; }
  body { font-family: system-ui, -apple-system, sans-serif; color: #111; }
  @media print {
    html, body { background: white; }
  }
</style>
</head>
<body>
<div id="root"></div>
</body>
</html>`

export function CanvasPane({
  canvas,
  streaming = false,
  streamingCode,
  settings,
  onClose,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [iframeReady, setIframeReady] = useState(false)
  const [rootEl, setRootEl] = useState<HTMLElement | null>(null)

  // Memoize scope — a new scope object on every render causes a full
  // recompile and stomps on streaming.
  const scope = useMemo(() => {
    return buildCanvasScope(brandFromSettings(settings))
  }, [
    settings?.brand_company,
    settings?.brand_logo,
    settings?.brand_primary,
    settings?.brand_secondary,
    settings?.brand_tertiary,
    settings?.name,
  ])

  // Debounce streaming code so we're not recompiling on every keystroke.
  const [debouncedCode, setDebouncedCode] = useState<string>(canvas.code || '')
  useEffect(() => {
    const source = streaming && streamingCode ? streamingCode : canvas.code || ''
    if (!streaming) {
      setDebouncedCode(source)
      return
    }
    const t = setTimeout(() => setDebouncedCode(source), 120)
    return () => clearTimeout(t)
  }, [streaming, streamingCode, canvas.code])

  const { element, error } = useRunner({
    code: debouncedCode,
    scope,
  })

  // When the iframe loads, grab its #root so we can portal the rendered
  // element into it.
  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    const doc = iframe.contentDocument
    if (!doc) return
    const root = doc.getElementById('root')
    if (root) {
      setRootEl(root)
      setIframeReady(true)
    }
  }, [])

  // Clear the cached root if the iframe unmounts/remounts
  useEffect(() => {
    if (!iframeReady) setRootEl(null)
  }, [iframeReady])

  const handleExportPdf = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    try {
      iframe.contentWindow.focus()
      iframe.contentWindow.print()
    } catch (err) {
      console.error('[CanvasPane] print failed:', err)
    }
  }, [])

  return (
    <div className="flex flex-col h-full w-full max-w-[760px] border-l border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 relative">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {streaming && (
            <Loader2 size={13} className="animate-spin flex-shrink-0 text-neutral-400" />
          )}
          <div className="text-[12.5px] font-semibold text-neutral-800 dark:text-neutral-100 truncate">
            {canvas.title || 'Untitled'}
          </div>
          {streaming && (
            <div className="text-[10.5px] text-neutral-400 dark:text-neutral-500">drafting…</div>
          )}
          {error && !streaming && (
            <div
              className="text-[10.5px] text-amber-600 dark:text-amber-400 truncate max-w-[240px]"
              title={error}
            >
              parse error
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={handleExportPdf}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
            title="Print / Save as PDF"
            disabled={!iframeReady}
          >
            <Download size={12} />
            Export PDF
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            title="Close canvas"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Canvas surface */}
      <div className="flex-1 overflow-auto p-3 relative">
        <iframe
          ref={iframeRef}
          srcDoc={IFRAME_SRCDOC}
          sandbox="allow-same-origin allow-modals"
          title={canvas.title || 'Canvas'}
          onLoad={handleIframeLoad}
          className="border-0 block bg-white shadow-sm rounded-md w-full min-h-full"
        />
        {rootEl && element && createPortal(element, rootEl)}
        {!element && !streaming && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-[13px] text-neutral-400 dark:text-neutral-500 pointer-events-none">
            Empty canvas
          </div>
        )}
      </div>
    </div>
  )
}
