// CanvasPane — renders a Canvas (markdown document) in a branded iframe.
//
// The agent writes markdown via write_canvas / patch_canvas. We render it
// with react-markdown + remark-gfm, inject branded CSS, and display inside
// a same-origin iframe for style isolation and PDF export (window.print).
//
// Scroll-preservation strategy: srcdoc is set ONCE on mount (CSS + empty
// structure only). Subsequent content updates are written directly into the
// iframe's #content div via contentDocument to avoid iframe reloads.

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { X, Download, Save, Loader2, History, CheckCircle, AlertCircle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Canvas, AgentSettings } from '@coagent/shared'
import { buildBrandCSS, brandFromSettings } from '@/lib/canvas-brand'
import { renderCanvasPdf } from '@/lib/canvas-pdf'
import { invoke } from '@tauri-apps/api/core'
import { downloadDir } from '@tauri-apps/api/path'

interface Props {
  canvas: Canvas
  streaming?: boolean
  streamingCode?: string
  settings: AgentSettings | null | undefined
  onClose: () => void
  onSaveToFiles?: (filename: string, mimeType: string, data: string) => void
  canvasesList?: Array<{ id: string; title: string; kind?: string; updatedAt: string }>
  onOpenCanvas?: (canvasId: string) => void
  onLoadCanvases?: () => void
}

// Debounce interval for streaming updates (ms)
const STREAM_DEBOUNCE_MS = 120

function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export function CanvasPane({ canvas, streaming = false, streamingCode, settings, onClose, onSaveToFiles, canvasesList = [], onOpenCanvas, onLoadCanvases }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const iframeReadyRef = useRef(false)
  const [debouncedCode, setDebouncedCode] = useState<string>(canvas.code || '')
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportStatus, setExportStatus] = useState<'success' | 'error' | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const historyRef = useRef<HTMLDivElement>(null)

  // Close history dropdown on outside click
  useEffect(() => {
    if (!historyOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [historyOpen])

  const brand = useMemo(() => brandFromSettings(settings), [
    settings?.brand_company,
    settings?.brand_logo,
    settings?.brand_primary,
    settings?.brand_secondary,
    settings?.brand_tertiary,
    settings?.name,
  ])

  const brandCSS = useMemo(() => buildBrandCSS(brand), [brand])

  // Build logo header HTML — escape user-supplied values to prevent XSS
  const logoHtml = useMemo(() => {
    if (!brand.name && !brand.logoUrl) return ''
    const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    if (brand.logoUrl) {
      return `<div class="canvas-logo"><img src="${escAttr(brand.logoUrl)}" alt="${escAttr(brand.name || 'Logo')}" /></div>`
    }
    return `<div class="canvas-logo"><div class="canvas-logo-text">${escText(brand.name)}</div></div>`
  }, [brand.name, brand.logoUrl])

  // Stable base srcdoc — CSS + structure only, no content. Rebuilt only when
  // brand CSS changes (which causes a full reload anyway).
  // Content updates are sent via postMessage to avoid needing allow-same-origin.
  const srcdoc = useMemo(() => {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${brandCSS}</style>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
</head>
<body>
<div class="canvas-root">
<div id="logo"></div>
<div id="content"></div>
</div>
<script>
// Initialize mermaid if loaded (graceful fallback if CDN fails)
var mermaidReady = false;
try {
  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: 'base',
      themeVariables: {
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '13px',
        background: '#ffffff',
        mainBkg: '#ffffff',
        primaryColor: '#dbeafe',
        primaryTextColor: '#1e3a5f',
        primaryBorderColor: '#3b82f6',
        secondaryColor: '#fce7f3',
        secondaryBorderColor: '#ec4899',
        tertiaryColor: '#d1fae5',
        tertiaryBorderColor: '#10b981',
        lineColor: '#374151',
        pie1: '#3b82f6',
        pie2: '#10b981',
        pie3: '#f59e0b',
        pie4: '#ef4444',
        pie5: '#8b5cf6',
        pie6: '#06b6d4',
        pie7: '#ec4899',
        pie8: '#f97316',
        xyChart: {
          backgroundColor: 'transparent',
          plotColorPalette: '#3b82f6,#10b981,#ef4444,#f59e0b,#8b5cf6,#06b6d4,#ec4899,#f97316'
        },
      }
    });
    mermaidReady = true;
  }
} catch(e) { console.warn('[mermaid] init failed:', e); }

// Render mermaid blocks after content is set. react-markdown renders
// \`\`\`mermaid blocks as <pre><code class="language-mermaid">...</code></pre>.
// We convert those into <div class="mermaid"> for mermaid.run().
var mermaidCounter = 0;
function renderMermaid() {
  if (!mermaidReady) return;
  var codes = document.querySelectorAll('code.language-mermaid');
  if (!codes.length) return;
  var nodes = [];
  codes.forEach(function(code) {
    var pre = code.parentElement;
    if (!pre || pre.tagName !== 'PRE') return;
    var div = document.createElement('div');
    div.className = 'mermaid';
    div.id = 'mermaid-' + (++mermaidCounter);
    div.textContent = code.textContent || '';
    pre.replaceWith(div);
    nodes.push(div);
  });
  if (nodes.length) {
    mermaid.run({ nodes: nodes }).catch(function(err) {
      console.warn('[mermaid] render error:', err);
    });
  }
}

window.addEventListener('message', function(e) {
  if (!e.data || typeof e.data !== 'object') return;
  if (e.data.type === 'set_content') {
    var el = document.getElementById('content');
    if (el) {
      el.innerHTML = e.data.html;
      // Only render mermaid when streaming is done — partial mermaid
      // syntax causes error icons and layout thrashing.
      if (!e.data.streaming) renderMermaid();
    }
  } else if (e.data.type === 'set_logo') {
    var el = document.getElementById('logo');
    if (el) el.innerHTML = e.data.html;
  }
});
</script>
</body>
</html>`
  }, [brandCSS])

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

  // Write content into the iframe via postMessage (no allow-same-origin needed)
  const updateIframeContent = useCallback((html: string, isStreaming: boolean) => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'set_content', html, streaming: isStreaming }, '*')
  }, [])

  // Populate logo once iframe is ready; update when brand changes
  const updateIframeLogo = useCallback((html: string) => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'set_logo', html }, '*')
  }, [])

  // After iframe loads, seed both logo and content
  const handleLoad = useCallback(() => {
    iframeReadyRef.current = true
    updateIframeLogo(logoHtml)
    updateIframeContent(markdownHtml, streaming)
  }, [logoHtml, markdownHtml, streaming, updateIframeLogo, updateIframeContent])

  // Push content updates into the live iframe DOM
  useEffect(() => {
    if (!iframeReadyRef.current) return
    updateIframeContent(markdownHtml, streaming)
  }, [markdownHtml, streaming, updateIframeContent])

  // Push logo updates into the live iframe DOM
  useEffect(() => {
    if (!iframeReadyRef.current) return
    updateIframeLogo(logoHtml)
  }, [logoHtml, updateIframeLogo])

  // When srcdoc changes (brand CSS rebuild), reset ready flag so handleLoad
  // re-seeds content after the reload
  useEffect(() => {
    iframeReadyRef.current = false
  }, [srcdoc])

  const handleExportPdf = useCallback(async () => {
    if (exporting) return
    setExporting(true)
    setExportStatus(null)
    try {
      const downloads = await downloadDir()
      const filename = `${(canvas.title || 'document').replace(/[/\\:*?"<>|]/g, '_')}.pdf`
      const finalPath = `${downloads}/${filename}`
      const blob = await renderCanvasPdf(canvas.code, brand, canvas.title)
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
        reader.onerror = () => reject(new Error('FileReader failed'))
        reader.readAsDataURL(blob)
      })
      await invoke('write_pdf_file', { path: finalPath, base64 })
      setExportStatus('success')
      setTimeout(() => setExportStatus(null), 3000)
    } catch (err) {
      console.error('[CanvasPane] export PDF failed:', err)
      setExportStatus('error')
      setTimeout(() => setExportStatus(null), 4000)
    } finally {
      setExporting(false)
    }
  }, [exporting, canvas.code, canvas.title, brand])

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
          {onLoadCanvases && (
            <div ref={historyRef} className="relative">
              <button
                onClick={() => {
                  if (!historyOpen) onLoadCanvases()
                  setHistoryOpen(o => !o)
                }}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] font-medium text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                title="Canvas history"
                aria-label="Canvas history"
                aria-expanded={historyOpen}
              >
                <History size={12} />
              </button>
              {historyOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 w-64 max-h-72 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-md">
                  {canvasesList.length === 0 ? (
                    <div className="px-3 py-2 text-[11.5px] text-neutral-400 dark:text-neutral-500">No canvases yet</div>
                  ) : (
                    canvasesList.map(item => (
                      <button
                        key={item.id}
                        onClick={() => {
                          onOpenCanvas?.(item.id)
                          setHistoryOpen(false)
                        }}
                        className="w-full text-left flex items-center justify-between px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors gap-2"
                      >
                        <div className="min-w-0">
                          <div className="text-[11.5px] font-medium text-neutral-800 dark:text-neutral-100 truncate">{item.title || 'Untitled'}</div>
                          {item.kind && (
                            <div className="text-[10px] text-neutral-400 dark:text-neutral-500 capitalize">{item.kind}</div>
                          )}
                        </div>
                        <div className="text-[10px] text-neutral-400 dark:text-neutral-500 flex-shrink-0">{relativeDate(item.updatedAt)}</div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
          <button
            onClick={handleExportPdf}
            disabled={exporting}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
            title="Save as PDF"
          >
            {exporting ? (
              <Loader2 size={12} className="animate-spin" />
            ) : exportStatus === 'success' ? (
              <CheckCircle size={12} className="text-green-500" />
            ) : exportStatus === 'error' ? (
              <AlertCircle size={12} className="text-red-500" />
            ) : (
              <Download size={12} />
            )}
            {exportStatus === 'success' ? 'Saved!' : exportStatus === 'error' ? 'Failed' : 'Export PDF'}
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
            aria-label="Close canvas"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Canvas surface */}
      <div className="flex-1 overflow-auto p-3 relative">
        <iframe
          ref={iframeRef}
          srcDoc={srcdoc}
          onLoad={handleLoad}
          sandbox="allow-scripts allow-popups"
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
