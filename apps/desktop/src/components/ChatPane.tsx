import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Send, FileText, Sheet, File, X, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentMessage, FileEntry } from '@coagent/shared'

interface ChatPaneProps {
  messages: AgentMessage[]
  streamingText: string | null
  thinking: boolean
  toolLabel: string | null
  connected: boolean
  onChat: (message: string) => void
  files: FileEntry[]
  onOpenDocument?: (id: string) => void
  activeDocumentId: string | null
  apiKeyStatus?: { anthropic: boolean; composio: boolean; openai: boolean } | null
  onNavigateToSettings?: () => void
  className?: string
}

const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
const PDF_EXTS = new Set(['pdf'])
const SHEET_EXTS = new Set(['csv', 'xlsx', 'xls', 'tsv'])

function fileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (PDF_EXTS.has(ext)) return FileText
  if (SHEET_EXTS.has(ext)) return Sheet
  return File
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── PDF inline preview (renders first page via pdfjs-dist) ──────────────────
const pdfPreviewCache = new Map<string, string>()

function PdfInlinePreview({ fileId, path }: { fileId: string; path: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(pdfPreviewCache.get(fileId) ?? null)
  const [loading, setLoading] = useState(!pdfPreviewCache.has(fileId))
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    if (pdfPreviewCache.has(fileId)) return
    ;(async () => {
      try {
        const pdfjsLib = await import('pdfjs-dist')
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url
        ).href
        const bytes: number[] = await invoke('read_file_bytes', { path })
        const data = new Uint8Array(bytes)
        const pdf = await pdfjsLib.getDocument({ data }).promise
        const page = await pdf.getPage(1)
        const viewport = page.getViewport({ scale: 1 })
        const dpr = window.devicePixelRatio || 2
        const scale = (420 * dpr) / viewport.width
        const scaled = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = scaled.width
        canvas.height = scaled.height
        const ctx = canvas.getContext('2d')!
        await page.render({ canvasContext: ctx, viewport: scaled } as any).promise
        const url = canvas.toDataURL('image/png')
        if (mounted.current) {
          pdfPreviewCache.set(fileId, url)
          setDataUrl(url)
        }
      } catch (err) {
        console.warn('[PdfInlinePreview] render failed:', err)
      } finally {
        if (mounted.current) setLoading(false)
      }
    })()
    return () => { mounted.current = false }
  }, [fileId, path])

  if (loading) {
    return <div className="w-full h-48 rounded-lg bg-neutral-200 dark:bg-neutral-700 animate-pulse" />
  }
  if (!dataUrl) return null
  return <img src={dataUrl} alt="PDF preview" className="w-full rounded-lg" draggable={false} />
}

// ── Lightbox overlay for full-size view ─────────────────────────────────────
function Lightbox({ file, onClose }: { file: FileEntry; onClose: () => void }) {
  const ext = file.filename.split('.').pop()?.toLowerCase() ?? ''
  const isImage = IMG_EXTS.has(ext)
  const isPdf = PDF_EXTS.has(ext)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-8" onClick={onClose}>
      <div className="relative max-w-3xl max-h-[85vh] overflow-auto bg-white dark:bg-neutral-900 rounded-2xl shadow-2xl" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-3 right-3 z-10 p-1.5 rounded-full bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors">
          <X size={16} className="text-neutral-600 dark:text-neutral-400" />
        </button>
        <div className="p-4">
          <p className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200 mb-3">{file.filename}</p>
          {isImage && (
            <img src={convertFileSrc(file.path)} alt={file.filename} className="w-full rounded-lg" />
          )}
          {isPdf && (
            <PdfInlinePreview fileId={file.id + '_lightbox'} path={file.path} />
          )}
          {!isImage && !isPdf && (
            <div className="flex items-center justify-center h-40 text-neutral-400 dark:text-neutral-500 text-[13px]">
              Preview not available for this file type
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Single file card (used inside deck or standalone) ────────────────────────
function FileCard({ file, onClick }: { file: FileEntry; onClick?: () => void }) {
  const ext = file.filename.split('.').pop()?.toLowerCase() ?? ''
  const isImage = IMG_EXTS.has(ext)
  const isPdf = PDF_EXTS.has(ext)
  const Icon = fileIcon(file.filename)

  return (
    <div
      className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-xl overflow-hidden cursor-pointer hover:border-neutral-300 dark:hover:border-neutral-600 transition-colors w-[320px]"
      onClick={onClick}
    >
      {isImage && (
        <div className="w-full h-[200px] overflow-hidden bg-neutral-50 dark:bg-neutral-800">
          <img
            src={convertFileSrc(file.path)}
            alt={file.filename}
            className="w-full h-full object-contain"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        </div>
      )}
      {isPdf && (
        <div className="w-full h-[200px] overflow-hidden bg-neutral-50 dark:bg-neutral-800">
          <PdfInlinePreview fileId={file.id} path={file.path} />
        </div>
      )}
      {!isImage && !isPdf && (
        <div className="w-full h-[120px] bg-neutral-50 dark:bg-neutral-800 flex items-center justify-center">
          <Icon size={32} className="text-neutral-300 dark:text-neutral-600" />
        </div>
      )}
      <div className="flex items-center gap-2.5 px-3 py-2 border-t border-neutral-100 dark:border-neutral-800">
        <Icon size={14} className="text-neutral-400 dark:text-neutral-500 flex-shrink-0" />
        <p className="text-[12px] font-medium text-neutral-700 dark:text-neutral-300 truncate flex-1">{file.filename}</p>
        <p className="text-[11px] text-neutral-400 dark:text-neutral-500 flex-shrink-0">{formatSize(file.sizeBytes)}</p>
      </div>
    </div>
  )
}

// ── File deck (stacked cards you flip through) ──────────────────────────────
function FileDeck({ files, onOpenDocument }: { files: FileEntry[]; onOpenDocument?: (id: string) => void }) {
  const [active, setActive] = useState(0)
  const [lightboxFile, setLightboxFile] = useState<FileEntry | null>(null)

  const prev = useCallback(() => setActive(i => Math.max(0, i - 1)), [])
  const next = useCallback(() => setActive(i => Math.min(files.length - 1, i + 1)), [files.length])

  function handleFileClick(file: FileEntry) {
    if (file.type === 'document' && onOpenDocument) {
      onOpenDocument(file.id)
    } else {
      setLightboxFile(file)
    }
  }

  if (files.length === 0) return null

  // Single file — no deck UI needed
  if (files.length === 1) {
    return (
      <>
        <div className="my-2">
          <FileCard file={files[0]} onClick={() => handleFileClick(files[0])} />
        </div>
        {lightboxFile && <Lightbox file={lightboxFile} onClose={() => setLightboxFile(null)} />}
      </>
    )
  }

  return (
    <>
      <div className="my-2 relative" style={{ width: 320, height: 'auto' }}>
        {/* Stacked cards behind */}
        <div className="relative">
          {files.map((file, i) => {
            const offset = i - active
            // Only show active card and up to 2 behind it
            if (offset < 0 || offset > 2) return null
            return (
              <div
                key={file.id}
                className="transition-all duration-300 ease-out"
                style={{
                  position: offset === 0 ? 'relative' : 'absolute',
                  top: offset === 0 ? 0 : offset * 6,
                  left: offset === 0 ? 0 : offset * 4,
                  zIndex: files.length - offset,
                  opacity: offset === 0 ? 1 : offset === 1 ? 0.6 : 0.3,
                  transform: `scale(${1 - offset * 0.03})`,
                  pointerEvents: offset === 0 ? 'auto' : 'none',
                }}
              >
                <FileCard file={file} onClick={() => handleFileClick(file)} />
              </div>
            )
          })}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between mt-2">
          <button
            onClick={prev}
            disabled={active === 0}
            className="p-1 rounded-md hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-20 transition-colors"
          >
            <ChevronLeft size={16} className="text-neutral-500 dark:text-neutral-400" />
          </button>
          <div className="flex gap-1">
            {files.map((_, i) => (
              <button
                key={i}
                onClick={() => setActive(i)}
                className={cn(
                  'w-1.5 h-1.5 rounded-full transition-colors',
                  i === active
                    ? 'bg-neutral-700 dark:bg-neutral-300'
                    : 'bg-neutral-300 dark:bg-neutral-600'
                )}
              />
            ))}
          </div>
          <button
            onClick={next}
            disabled={active === files.length - 1}
            className="p-1 rounded-md hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-20 transition-colors"
          >
            <ChevronRight size={16} className="text-neutral-500 dark:text-neutral-400" />
          </button>
        </div>
      </div>
      {lightboxFile && <Lightbox file={lightboxFile} onClose={() => setLightboxFile(null)} />}
    </>
  )
}

const FILE_LINK_RE = /\[([^\]]*)\]\(coagent-file:([^)]+)\)/g

const AgentBubble = React.memo(function AgentBubble({ content, files, onOpenDocument }: { content: string; files: FileEntry[]; onOpenDocument?: (id: string) => void }) {
  const filesMap = React.useMemo(() => {
    const map = new Map<string, FileEntry>()
    for (const f of files) map.set(f.id, f)
    return map
  }, [files])

  // Extract referenced files and clean content
  const { cleanContent, referencedFiles } = React.useMemo(() => {
    const ids: string[] = []
    const clean = content.replace(FILE_LINK_RE, (_match, _label, id) => {
      ids.push(id)
      return ''
    })
    const resolved = ids.map(id => filesMap.get(id)).filter((f): f is FileEntry => f != null)
    return { cleanContent: clean.trim(), referencedFiles: resolved }
  }, [content, filesMap])

  return (
    <div className="bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[620px] text-[13.5px] leading-relaxed">
      {cleanContent && (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={(url) => url}
          components={{
            table: ({ children }) => (
              <div className="overflow-x-auto my-2">
                <table className="text-[12.5px] border-collapse w-full">{children}</table>
              </div>
            ),
            thead: ({ children }) => <thead className="bg-neutral-100 dark:bg-neutral-700">{children}</thead>,
            th: ({ children }) => <th className="border border-neutral-200 dark:border-neutral-600 px-2.5 py-1.5 text-left font-semibold text-neutral-700 dark:text-neutral-200">{children}</th>,
            td: ({ children }) => <td className="border border-neutral-200 dark:border-neutral-600 px-2.5 py-1.5 text-neutral-600 dark:text-neutral-300">{children}</td>,
            tr: ({ children }) => <tr className="even:bg-neutral-50 dark:even:bg-neutral-700/50">{children}</tr>,
            p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
            ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-0.5">{children}</ul>,
            ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5">{children}</ol>,
            li: ({ children }) => <li>{children}</li>,
            strong: ({ children }) => <strong className="font-semibold text-neutral-900 dark:text-neutral-100">{children}</strong>,
            h1: ({ children }) => <h1 className="text-[15px] font-bold text-neutral-900 dark:text-neutral-100 mb-1 mt-2">{children}</h1>,
            h2: ({ children }) => <h2 className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-100 mb-1 mt-2">{children}</h2>,
            h3: ({ children }) => <h3 className="text-[13.5px] font-semibold text-neutral-900 dark:text-neutral-100 mb-0.5 mt-2">{children}</h3>,
            code: ({ children }) => <code className="bg-neutral-200 dark:bg-neutral-700 rounded px-1 py-0.5 text-[12px] font-mono">{children}</code>,
            a: ({ href, children }) => <a href={href} className="text-blue-600 dark:text-blue-400 underline" target="_blank" rel="noopener noreferrer">{children}</a>,
          }}
        >
          {cleanContent}
        </ReactMarkdown>
      )}
      {referencedFiles.length > 0 && (
        <FileDeck files={referencedFiles} onOpenDocument={onOpenDocument} />
      )}
    </div>
  )
})

export function ChatPane({ messages, streamingText, thinking, toolLabel, connected, onChat, files, onOpenDocument, activeDocumentId, apiKeyStatus, onNavigateToSettings, className }: ChatPaneProps) {
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Scroll to bottom on new messages / streaming
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText, thinking])

  // Scroll to bottom when pane mounts (e.g. navigating back to chat)
  useEffect(() => {
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
    })
  }, [])

  const handleSend = useCallback(() => {
    const msg = input.trim()
    if (!msg || !connected) return
    onChat(msg)
    setInput('')
  }, [input, connected, onChat])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSend()
  }, [handleSend])

  const isActive = thinking || streamingText !== null

  // Pre-compute last assistant index once instead of O(n²) in render
  const lastAssistantIndex = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return i
    }
    return -1
  }, [messages])

  return (
    <div className={cn("flex-1 bg-white dark:bg-neutral-950 flex flex-col overflow-hidden", className)}>
      <div className="px-7 py-5 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-0.5">
            Ask anything
          </p>
          <h1 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-neutral-100">Co-Agent</h1>
        </div>
        <div
          title={connected ? 'Connected' : 'Disconnected'}
          className={cn('w-2 h-2 rounded-full', connected ? 'bg-emerald-400' : 'bg-red-400')}
        />
      </div>

      <ScrollArea className="flex-1">
        <div className="px-7 py-5 flex flex-col gap-3">
          {messages.length === 0 && !isActive && (
            <div className="flex justify-start">
              {apiKeyStatus && !apiKeyStatus.anthropic ? (
                <div className="bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[620px] text-[13.5px] leading-relaxed">
                  <p className="mb-2 font-semibold">Welcome to Co-Agent</p>
                  <p className="mb-3">To get started, add your API keys in Settings.</p>
                  <button
                    onClick={onNavigateToSettings}
                    className="text-[12.5px] font-medium px-3 py-1.5 rounded-lg bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 transition-colors"
                  >
                    Open Settings
                  </button>
                </div>
              ) : (
                <AgentBubble content="Hello. I'm Co-Agent. I'm watching your queue and ready to help. What do you need?" files={files} onOpenDocument={onOpenDocument} />
              )}
            </div>
          )}

          {messages.map((msg, i) => {
            const isLastAssistant = activeDocumentId && msg.role === 'assistant' && i === lastAssistantIndex
            return (
              <div key={i} className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                {msg.role === 'user' ? (
                  <div className="bg-neutral-900 dark:bg-neutral-700 text-white text-[13.5px] leading-relaxed rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[560px]">
                    {msg.content}
                  </div>
                ) : (
                  <div className="max-w-[620px]">
                    <AgentBubble content={msg.content} files={files} onOpenDocument={onOpenDocument} />
                    {isLastAssistant && (
                      <div className="flex justify-end mt-1">
                        <button
                          onClick={() => onOpenDocument?.(activeDocumentId)}
                          className="group flex items-center gap-1.5 pr-2 text-[11.5px] font-medium text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
                        >
                          <svg width="9" height="9" viewBox="0 0 12 12" fill="none" className="text-neutral-300 dark:text-neutral-600 group-hover:text-neutral-400 dark:group-hover:text-neutral-500 transition-colors">
                            <path d="M2 0 L2 8 Q2 10 4 10 L12 10" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
                          </svg>
                          <FileText size={12} />
                          <span>Open document</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {thinking && !streamingText && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 px-2 py-3">
                <span className="w-1.5 h-1.5 bg-neutral-400 dark:bg-neutral-500 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 bg-neutral-400 dark:bg-neutral-500 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 bg-neutral-400 dark:bg-neutral-500 rounded-full animate-bounce [animation-delay:300ms]" />
                {toolLabel && (
                  <span className="text-[12px] text-neutral-400 dark:text-neutral-500 ml-1">{toolLabel}...</span>
                )}
              </div>
            </div>
          )}

          {streamingText !== null && (
            <div className="flex justify-start">
              <AgentBubble content={streamingText} files={files} onOpenDocument={onOpenDocument} />
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      <div className="px-7 py-4 border-t border-neutral-100 dark:border-neutral-800 flex gap-2.5 items-center">
        <Input
          className="flex-1 text-[13.5px] dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-500"
          placeholder={connected ? 'Ask Co-Agent anything…' : 'Connecting…'}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!connected || isActive}
        />
        <Button size="sm" onClick={handleSend} disabled={!connected || isActive || !input.trim()}>
          <Send size={14} className="mr-1.5" />
          Send
        </Button>
      </div>
    </div>
  )
}
