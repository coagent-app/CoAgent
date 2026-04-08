// HtmlDocumentPane — renders an HtmlDocument in a sandboxed iframe.
// Phase 2 of the HTML document architecture. Toolbar chrome with
// Save/Export/streaming loader over a `sandbox="allow-same-origin"` iframe.
//
// Editor affordances implemented here (Phase 2):
//   - Click-to-edit on .ed-* leaves (contentEditable, blur/Enter → patchDocument)
//   - Section hover toolbar overlay (positioned outside the iframe)
//
// Phase 3 will wire patchDocument to the server. For now, callbacks are
// no-op stubs that log and update local state optimistically.

import { useEffect, useRef, useState, useCallback } from 'react'
import { X, Download, Loader2, Save, RefreshCw, Palette, Trash2, PlusCircle } from 'lucide-react'
import type { HtmlDocument, DocumentTheme } from '@coagent/shared'
import docRuntimeCss from '@/doc-runtime/doc-runtime.css?raw'

// ── Theme → CSS custom properties ────────────────────────────────────────────

function buildThemeStyle(theme: DocumentTheme): string {
  return `
.doc {
  --background: ${theme.background};
  --foreground: ${theme.foreground};
  --muted: ${theme.muted};
  --muted-foreground: ${theme.mutedForeground};
  --primary: ${theme.primary};
  --primary-foreground: ${theme.primaryForeground};
  --secondary: ${theme.secondary};
  --secondary-foreground: ${theme.secondaryForeground};
  --accent: ${theme.accent};
  --accent-foreground: ${theme.accentForeground};
  --border: ${theme.border};
  --radius: ${theme.radius};
  --font-display: ${theme.fontDisplay};
  --font-body: ${theme.fontBody};
}
`.trim()
}

// ── Editor affordance CSS injected into the iframe ────────────────────────────
// Sets cursor styles for editable leaves and section hover ring so the iframe
// itself can visually reflect interactive regions without needing JS inside.

const EDITOR_AFFORDANCE_CSS = `
[data-ed-active="true"] {
  outline: 2px solid rgba(59, 130, 246, 0.6);
  outline-offset: 2px;
  border-radius: 2px;
}
[data-ed-id] {
  cursor: text;
}
[data-sec-id]:hover {
  outline: 1px dashed rgba(99, 102, 241, 0.4);
  outline-offset: 4px;
}
`

// ── Build full iframe srcdoc ──────────────────────────────────────────────────

function buildIframeSrcdoc(doc: HtmlDocument): string {
  const themeStyle = buildThemeStyle(doc.theme)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${docRuntimeCss}</style>
<style>${themeStyle}</style>
<style>${EDITOR_AFFORDANCE_CSS}</style>
</head>
<body style="margin:0;padding:0;background:transparent;">
${doc.html}
</body>
</html>`
}

// ── Prop types ────────────────────────────────────────────────────────────────

export interface PatchDocumentArgs {
  targetId: string
  op: 'replace_text' | 'replace_node' | 'insert_before' | 'insert_after' | 'delete' | 'restyle'
  content?: string
}

interface SectionAction {
  label: string
  icon: React.ReactNode
  onClick: (sectionId: string) => void
}

interface Props {
  doc: HtmlDocument
  streaming?: boolean
  onClose: () => void
  onExportPdf?: () => void
  onSaveToFiles?: () => void
  exporting?: boolean
  /** Called when a .ed-* leaf's text changes. No-op/log until Phase 3. */
  onPatchDocument?: (args: PatchDocumentArgs) => void
  /** Optimistic local update — called alongside onPatchDocument so UI reflects change instantly. */
  onDocumentChange?: (next: HtmlDocument) => void
}

// ── Section hover toolbar ─────────────────────────────────────────────────────

interface HoverToolbarState {
  sectionId: string
  top: number
  right: number
}

// ── Main component ────────────────────────────────────────────────────────────

export function HtmlDocumentPane({
  doc,
  streaming = false,
  onClose,
  onExportPdf,
  onSaveToFiles,
  exporting = false,
  onPatchDocument,
  onDocumentChange,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [hoverToolbar, setHoverToolbar] = useState<HoverToolbarState | null>(null)
  const hoverToolbarRef = useRef<HoverToolbarState | null>(null)

  // ── Sync iframe contents ──────────────────────────────────────────────────

  // Track last rendered html + theme to avoid unnecessary resyncs
  const lastSrcdocRef = useRef<string>('')

  const syncIframe = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    const srcdoc = buildIframeSrcdoc(doc)
    if (srcdoc === lastSrcdocRef.current) return
    lastSrcdocRef.current = srcdoc

    // Write full document into the iframe using srcdoc. This re-parses the
    // document each time but avoids cross-origin issues with about:blank.
    iframe.srcdoc = srcdoc
  }, [doc])

  // Initial sync and re-sync when doc changes
  useEffect(() => {
    syncIframe()
  }, [syncIframe])

  // Autoscroll to bottom during streaming
  useEffect(() => {
    if (streaming && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [doc.html, streaming])

  // ── Wire editor affordances after iframe loads ────────────────────────────

  const wireEditorAffordances = useCallback(() => {
    const iframe = iframeRef.current
    const iframeDoc = iframe?.contentDocument
    if (!iframeDoc || !iframeDoc.body) return

    // Mark .ed-* leaves that have an id attribute as editable
    const edLeaves = iframeDoc.querySelectorAll('[class*="ed-"]')
    edLeaves.forEach((el) => {
      const elem = el as HTMLElement
      const id = elem.id
      if (!id) return // skip — no id, not addressable

      // Stamp a data attribute for our CSS hook
      elem.setAttribute('data-ed-id', id)
      elem.contentEditable = 'true'
      elem.spellcheck = true

      // Store original text so we can diff on blur
      elem.dataset.origText = elem.textContent ?? ''

      const commit = () => {
        const newText = elem.textContent ?? ''
        const orig = elem.dataset.origText ?? ''
        if (newText === orig) return
        elem.dataset.origText = newText

        // Phase 3 will route this to the server. For now, log + local optimistic update.
        console.log(`[HtmlDocumentPane] patch replace_text id="${id}" text="${newText.slice(0, 60)}"`)
        onPatchDocument?.({ targetId: id, op: 'replace_text', content: newText })

        if (onDocumentChange) {
          // Naive local html patch: replace the element's innerHTML in the source string.
          // This keeps local state in sync until server confirms.
          const parser = new DOMParser()
          const parsed = parser.parseFromString(doc.html, 'text/html')
          const target = parsed.getElementById(id)
          if (target) {
            target.textContent = newText
            onDocumentChange({ ...doc, html: parsed.body.innerHTML, updatedAt: new Date().toISOString() })
          }
        }
      }

      elem.addEventListener('blur', commit)
      elem.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          elem.blur()
        }
        if (e.key === 'Escape') {
          // Revert
          elem.textContent = elem.dataset.origText ?? ''
          elem.blur()
        }
      })

      // Visual feedback while focused
      elem.addEventListener('focus', () => elem.setAttribute('data-ed-active', 'true'))
      elem.addEventListener('blur', () => elem.removeAttribute('data-ed-active'))
    })

    // Wire .sec-* section hover detection — we detect mouseover in the iframe
    // and compute a rect to position the toolbar overlay (which lives in the
    // React tree, outside the sandboxed iframe).
    const sections = iframeDoc.querySelectorAll('[class*="sec-"]')
    sections.forEach((el) => {
      const elem = el as HTMLElement
      const id = elem.id
      if (!id) return

      elem.setAttribute('data-sec-id', id)

      elem.addEventListener('mouseenter', () => {
        const iframe = iframeRef.current
        const container = containerRef.current
        if (!iframe || !container) return

        const iframeRect = iframe.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()
        const elemRect = elem.getBoundingClientRect()

        // elemRect is in the iframe's own coordinate space; translate to container space
        const top = iframeRect.top - containerRect.top + elemRect.top
        const right = containerRect.right - iframeRect.right + (iframeRect.width - elemRect.right)

        const state: HoverToolbarState = { sectionId: id, top, right }
        hoverToolbarRef.current = state
        setHoverToolbar(state)
      })

      elem.addEventListener('mouseleave', () => {
        hoverToolbarRef.current = null
        setHoverToolbar(null)
      })
    })
  }, [doc, onPatchDocument, onDocumentChange])

  // Wire on every iframe load
  const handleIframeLoad = useCallback(() => {
    if (!streaming) {
      wireEditorAffordances()
    }
  }, [streaming, wireEditorAffordances])

  // Re-wire when streaming ends (full doc is now present)
  useEffect(() => {
    if (!streaming) {
      // Small delay so the iframe DOM settles after the final srcdoc write
      const t = setTimeout(() => wireEditorAffordances(), 100)
      return () => clearTimeout(t)
    }
  }, [streaming, wireEditorAffordances])

  // ── Section toolbar actions (no-op stubs until Phase 3) ──────────────────

  const handleSectionAction = useCallback((sectionId: string, action: string) => {
    console.log(`[HtmlDocumentPane] section action="${action}" sectionId="${sectionId}"`)
    // Phase 3: route to patchDocument tool calls via onPatchDocument
    switch (action) {
      case 'regenerate':
        // Will trigger scoped write_document for this section
        break
      case 'restyle':
        onPatchDocument?.({ targetId: sectionId, op: 'restyle', content: '' })
        break
      case 'delete':
        onPatchDocument?.({ targetId: sectionId, op: 'delete' })
        break
      case 'insert_above':
        onPatchDocument?.({ targetId: sectionId, op: 'insert_before', content: '' })
        break
      case 'insert_below':
        onPatchDocument?.({ targetId: sectionId, op: 'insert_after', content: '' })
        break
    }
    setHoverToolbar(null)
  }, [onPatchDocument])

  const sectionActions: SectionAction[] = [
    {
      label: 'Regenerate',
      icon: <RefreshCw size={11} />,
      onClick: (id) => handleSectionAction(id, 'regenerate'),
    },
    {
      label: 'Restyle',
      icon: <Palette size={11} />,
      onClick: (id) => handleSectionAction(id, 'restyle'),
    },
    {
      label: 'Delete',
      icon: <Trash2 size={11} />,
      onClick: (id) => handleSectionAction(id, 'delete'),
    },
    {
      label: 'Insert Above',
      icon: <PlusCircle size={11} />,
      onClick: (id) => handleSectionAction(id, 'insert_above'),
    },
    {
      label: 'Insert Below',
      icon: <PlusCircle size={11} />,
      onClick: (id) => handleSectionAction(id, 'insert_below'),
    },
  ]

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full w-full max-w-[640px] border-l border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 relative"
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {streaming && (
            <Loader2
              size={13}
              className="animate-spin flex-shrink-0 text-neutral-400"
            />
          )}
          <div className="text-[12.5px] font-semibold text-neutral-800 dark:text-neutral-100 truncate">
            {doc.title || 'Untitled'}
          </div>
          {streaming && (
            <div className="text-[10.5px] text-neutral-400 dark:text-neutral-500">
              drafting…
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {onSaveToFiles && (
            <button
              onClick={onSaveToFiles}
              disabled={exporting}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
              title="Save PDF to Files (in-app)"
            >
              {exporting ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              Save to Files
            </button>
          )}
          {onExportPdf && (
            <button
              onClick={onExportPdf}
              disabled={exporting}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
              title="Export PDF to a location on disk"
            >
              {exporting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              Export…
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            title="Close document"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Document surface */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto relative">
        {doc.html ? (
          <iframe
            ref={iframeRef}
            // allow-same-origin: needed so contentDocument is accessible for
            // wiring contentEditable. No scripts — the iframe runs no JS.
            sandbox="allow-same-origin"
            title={doc.title || 'Document'}
            onLoad={handleIframeLoad}
            className="w-full h-full border-0"
            style={{ minHeight: '600px' }}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-[13px] text-neutral-400 dark:text-neutral-500">
            {streaming ? 'Agent is drafting…' : 'Empty document'}
          </div>
        )}

        {/* Section hover toolbar — overlaid on the iframe, outside the sandbox */}
        {hoverToolbar && !streaming && (
          <div
            className="absolute z-20 flex items-center gap-0.5 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-md px-1 py-0.5"
            style={{
              top: Math.max(8, hoverToolbar.top),
              right: Math.max(8, hoverToolbar.right),
            }}
            // Keep the toolbar alive while the user moves from section to toolbar
            onMouseEnter={() => {
              // Prevent dismissal when cursor moves into the toolbar itself
            }}
            onMouseLeave={() => setHoverToolbar(null)}
          >
            {sectionActions.map((action) => (
              <button
                key={action.label}
                onClick={() => hoverToolbar && action.onClick(hoverToolbar.sectionId)}
                className="flex items-center gap-1 px-1.5 py-1 rounded text-[10.5px] text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors whitespace-nowrap"
                title={action.label}
              >
                {action.icon}
                <span className="hidden sm:inline">{action.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
