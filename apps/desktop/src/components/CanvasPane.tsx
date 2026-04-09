// CanvasPane — renders a Canvas (markdown document) in a branded iframe.
//
// The agent writes markdown via write_canvas / patch_canvas. We render it
// with react-markdown + remark-gfm, inject branded CSS, and display inside
// a same-origin iframe for style isolation and PDF export (window.print).

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { X, Download, Save, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Canvas, AgentSettings } from '@coagent/shared'
import { buildBrandCSS, brandFromSettings } from '@/lib/canvas-brand'
import { renderCanvasPdf } from '@/lib/canvas-pdf'

interface Props {
  canvas: Canvas
  streaming?: boolean
  streamingCode?: string
  settings: AgentSettings | null | undefined
  onClose: () => void
  onSaveToFiles?: (filename: string, mimeType: string, data: string) => void
}

// Debounce interval for streaming updates (ms)
const STREAM_DEBOUNCE_MS = 120

export function CanvasPane({ canvas, streaming = false, streamingCode, settings, onClose, onSaveToFiles }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [debouncedCode, setDebouncedCode] = useState<string>(canvas.code || '')
  const [saving, setSaving] = useState(false)

  const brand = useMemo(() => brandFromSettings(settings), [
    settings?.brand_company,
    settings?.brand_logo,
    settings?.brand_primary,
    settings?.brand_secondary,
    settings?.brand_tertiary,
    settings?.name,
  ])

  const brandCSS = useMemo(() => buildBrandCSS(brand), [brand])

  // Debounce streaming code
  useEffect(() => {
    const source = streaming && streamingCode ? streamingCode : canvas.code || ''
    if (!streaming) {
      setDebouncedCode(source)
      return
    }
    const t = setTimeout(() => setDebouncedCode(source), STREAM_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [streaming, streamingCode, canvas.code])

  // Render markdown to static HTML
  const markdownHtml = useMemo(() => {
    if (!debouncedCode.trim()) return ''
    try {
      return renderToStaticMarkup(
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {debouncedCode}
        </ReactMarkdown>
      )
    } catch {
      return `<p>${debouncedCode}</p>`
    }
  }, [debouncedCode])

  // Build logo header HTML
  const logoHtml = useMemo(() => {
    if (!brand.name && !brand.logoUrl) return ''
    if (brand.logoUrl) {
      return `<div class="canvas-logo"><img src="${brand.logoUrl}" alt="${brand.name || 'Logo'}" /></div>`
    }
    return `<div class="canvas-logo"><div class="canvas-logo-text">${brand.name}</div></div>`
  }, [brand.name, brand.logoUrl])

  // Build full iframe srcdoc
  const srcdoc = useMemo(() => {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${brandCSS}</style>
</head>
<body>
<div class="canvas-root">
${logoHtml}
${markdownHtml}
</div>
<script>
// Initialize Mermaid diagrams if any exist
(function() {
  var els = document.querySelectorAll('code.language-mermaid');
  if (!els.length) return;
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
  s.onload = function() {
    els.forEach(function(el) {
      var pre = el.parentElement;
      var div = document.createElement('div');
      div.className = 'mermaid';
      div.textContent = el.textContent;
      pre.replaceWith(div);
    });
    mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
    mermaid.run();
  };
  document.head.appendChild(s);
})();
</script>
</body>
</html>`
  }, [brandCSS, logoHtml, markdownHtml])

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

  const handleSaveToFiles = useCallback(async () => {
    if (!onSaveToFiles || saving) return
    setSaving(true)
    try {
      const blob = await renderCanvasPdf(canvas.code, brand, canvas.title)
      const reader = new FileReader()
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1] ?? ''
        onSaveToFiles(`${canvas.title || 'document'}.pdf`, 'application/pdf', base64)
        setSaving(false)
      }
      reader.onerror = () => {
        console.error('[CanvasPane] FileReader error')
        setSaving(false)
      }
      reader.readAsDataURL(blob)
    } catch (err) {
      console.error('[CanvasPane] save to files failed:', err)
      setSaving(false)
    }
  }, [onSaveToFiles, saving, canvas.code, canvas.title, brand])

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
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={handleExportPdf}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            title="Print / Save as PDF"
          >
            <Download size={12} />
            Export PDF
          </button>
          {onSaveToFiles && (
            <button
              onClick={handleSaveToFiles}
              disabled={saving}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
              title="Save PDF to Files"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              Save
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

      {/* Canvas surface */}
      <div className="flex-1 overflow-auto p-3">
        <iframe
          ref={iframeRef}
          srcDoc={srcdoc}
          sandbox="allow-same-origin allow-modals allow-scripts allow-popups"
          title={canvas.title || 'Canvas'}
          className="border-0 block bg-white shadow-sm rounded-md w-full min-h-full"
        />
        {!debouncedCode.trim() && !streaming && (
          <div className="absolute inset-0 flex items-center justify-center text-[13px] text-neutral-400 dark:text-neutral-500 pointer-events-none">
            Empty canvas
          </div>
        )}
      </div>
    </div>
  )
}
