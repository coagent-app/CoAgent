import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Square, FileText, Sheet, File, X, ChevronLeft, ChevronRight, ExternalLink, Paperclip } from 'lucide-react'
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
  processing: boolean
  toolLabel: string | null
  connected: boolean
  onChat: (message: string) => void
  onSteer?: (message: string) => void
  onStop?: () => void
  onIngestFile?: (filename: string, mimeType: string, data: string) => void
  files: FileEntry[]
  apiKeyStatus?: { anthropic: boolean; composio: boolean; openai: boolean } | null
  onNavigateToSettings?: () => void
  lastHeartbeat?: { time: Date; status: string } | null
  skills?: { name: string; description: string }[]
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
function FileDeck({ files }: { files: FileEntry[] }) {
  const [active, setActive] = useState(0)
  const [lightboxFile, setLightboxFile] = useState<FileEntry | null>(null)

  const prev = useCallback(() => setActive(i => Math.max(0, i - 1)), [])
  const next = useCallback(() => setActive(i => Math.min(files.length - 1, i + 1)), [files.length])

  function handleFileClick(file: FileEntry) {
    setLightboxFile(file)
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

const AgentBubble = React.memo(function AgentBubble({ content, files }: { content: string; files: FileEntry[] }) {
  const filesMap = React.useMemo(() => {
    const map = new Map<string, FileEntry>()
    for (const f of files) map.set(f.id, f)
    return map
  }, [files])

  // Extract referenced files and clean content
  const { cleanContent, referencedFiles } = React.useMemo(() => {
    // Count file links first — if there are many, this is a listing, not a document reference
    const allMatches = [...content.matchAll(FILE_LINK_RE)]
    if (allMatches.length > 3) {
      // Too many links — show as plain text list instead of stripping names
      const plain = content.replace(FILE_LINK_RE, (_match, label) => label)
      return { cleanContent: plain.trim(), referencedFiles: [] }
    }
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
        <FileDeck files={referencedFiles} />
      )}
    </div>
  )
})

export function ChatPane({ messages, streamingText, thinking, processing, toolLabel, connected, onChat, onSteer, onStop, onIngestFile, files, apiKeyStatus, onNavigateToSettings, lastHeartbeat, skills = [], className }: ChatPaneProps) {
  const [input, setInput] = useState('')
  const [skillQuery, setSkillQuery] = useState<string | null>(null)
  const [selectedSkillIdx, setSelectedSkillIdx] = useState(0)
  const [attachedFiles, setAttachedFiles] = useState<{ name: string; size: number }[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
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

  const pendingMsgRef = useRef<string | null>(null)

  // Send queued message once connection is established
  useEffect(() => {
    if (connected && pendingMsgRef.current) {
      onChat(pendingMsgRef.current)
      pendingMsgRef.current = null
    }
  }, [connected, onChat])

  // Skill autocomplete: detect @query in input
  const filteredSkills = React.useMemo(() => {
    if (skillQuery === null || skills.length === 0) return []
    const q = skillQuery.toLowerCase()
    return skills.filter(s => s.name.includes(q) || s.description.toLowerCase().includes(q))
  }, [skillQuery, skills])

  const handleInputChange = useCallback((value: string) => {
    setInput(value)
    // Detect @ mention at cursor position
    const atIdx = value.lastIndexOf('@')
    if (atIdx !== -1 && (atIdx === 0 || value[atIdx - 1] === ' ')) {
      const query = value.slice(atIdx + 1)
      if (!query.includes(' ')) {
        setSkillQuery(query)
        setSelectedSkillIdx(0)
        return
      }
    }
    setSkillQuery(null)
  }, [])

  const insertSkill = useCallback((skillName: string) => {
    const atIdx = input.lastIndexOf('@')
    const before = input.slice(0, atIdx)
    setInput(`${before}@${skillName} `)
    setSkillQuery(null)
    inputRef.current?.focus()
  }, [input])

  const processFiles = useCallback((fileList: FileList | File[]) => {
    const files = Array.from(fileList)
    for (const file of files) {
      const reader = new FileReader()
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1]
        onIngestFile?.(file.name, file.type || 'application/octet-stream', base64)
        setAttachedFiles(prev => [...prev, { name: file.name, size: file.size }])
      }
      reader.readAsDataURL(file)
    }
  }, [onIngestFile])

  const isActive = processing || thinking || streamingText !== null

  const handleSend = useCallback(() => {
    const msg = input.trim()
    const hasAttachments = attachedFiles.length > 0
    if (!msg && !hasAttachments) return
    setSkillQuery(null)
    const fullMsg = hasAttachments
      ? `${msg}${msg ? '\n\n' : ''}[Attached ${attachedFiles.length} file${attachedFiles.length > 1 ? 's' : ''}: ${attachedFiles.map(f => f.name).join(', ')}]`
      : msg

    if (isActive && onSteer) {
      // Agent is working — steer it instead of starting a new chat
      onSteer(fullMsg)
    } else if (!connected) {
      pendingMsgRef.current = fullMsg
    } else {
      onChat(fullMsg)
    }
    setInput('')
    setAttachedFiles([])
  }, [input, connected, onChat, onSteer, attachedFiles, isActive])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (skillQuery !== null && filteredSkills.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedSkillIdx(i => Math.min(filteredSkills.length - 1, i + 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedSkillIdx(i => Math.max(0, i - 1)); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertSkill(filteredSkills[selectedSkillIdx].name); return }
      if (e.key === 'Escape') { e.preventDefault(); setSkillQuery(null); return }
    }
    if (e.key === 'Enter') handleSend()
  }, [handleSend, skillQuery, filteredSkills, selectedSkillIdx, insertSkill])

  return (
    <div
      className={cn("flex-1 bg-white dark:bg-neutral-950 flex flex-col overflow-hidden relative", className)}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setIsDragging(false) }}
      onDrop={(e) => {
        e.preventDefault()
        setIsDragging(false)
        if (e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files)
      }}
    >
      {isDragging && (
        <div className="absolute inset-0 z-40 bg-blue-50/80 dark:bg-blue-950/80 border-2 border-dashed border-blue-400 dark:border-blue-500 rounded-lg flex items-center justify-center pointer-events-none">
          <p className="text-blue-600 dark:text-blue-400 font-medium text-[14px]">Drop files here</p>
        </div>
      )}
      <div className="px-7 py-5 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-0.5">
            Ask anything
          </p>
          <h1 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-neutral-100">Co-Agent</h1>
        </div>
        <div className="flex items-center gap-2">
          {lastHeartbeat && (
            <span className="text-[10px] text-neutral-400 dark:text-neutral-500" title={`Last check: ${lastHeartbeat.time.toLocaleTimeString()}`}>
              {lastHeartbeat.status === 'started' ? 'Checking...' : `Checked ${lastHeartbeat.time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
            </span>
          )}
          <div
            title={connected ? 'Connected' : 'Disconnected'}
            className={cn('w-2 h-2 rounded-full', connected ? 'bg-emerald-400' : 'bg-red-400')}
          />
        </div>
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
                <AgentBubble content="Hello. I'm Co-Agent. I'm watching your queue and ready to help. What do you need?" files={files} />
              )}
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
              {msg.role === 'user' ? (
                <div className="bg-neutral-900 dark:bg-neutral-700 text-white text-[13.5px] leading-relaxed rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[560px]">
                  {msg.content}
                </div>
              ) : (
                <AgentBubble content={msg.content} files={files} />
              )}
            </div>
          ))}

          {thinking && !streamingText && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 px-2 py-3">
                <span className="w-1.5 h-1.5 bg-neutral-400 dark:bg-neutral-500 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 bg-neutral-400 dark:bg-neutral-500 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 bg-neutral-400 dark:bg-neutral-500 rounded-full animate-bounce [animation-delay:300ms]" />
                {toolLabel && (
                  <span className="text-[12px] ml-1 shimmer-text">{toolLabel}...</span>
                )}
              </div>
            </div>
          )}

          {streamingText !== null && (
            <div className="flex justify-start">
              <AgentBubble content={streamingText} files={files} />
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      <div className="relative px-7 py-4 border-t border-neutral-100 dark:border-neutral-800">
        {/* Skill autocomplete dropdown */}
        {skillQuery !== null && filteredSkills.length > 0 && (
          <div className="absolute bottom-full left-7 right-7 mb-1 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg overflow-hidden z-10">
            {filteredSkills.map((skill, i) => (
              <button
                key={skill.name}
                className={cn(
                  'w-full text-left px-3 py-2 flex items-center gap-2 text-[13px] transition-colors',
                  i === selectedSkillIdx
                    ? 'bg-neutral-100 dark:bg-neutral-700'
                    : 'hover:bg-neutral-50 dark:hover:bg-neutral-750'
                )}
                onMouseDown={(e) => { e.preventDefault(); insertSkill(skill.name) }}
              >
                <span className="font-medium text-neutral-800 dark:text-neutral-200">@{skill.name}</span>
                <span className="text-neutral-400 dark:text-neutral-500 truncate">{skill.description}</span>
              </button>
            ))}
          </div>
        )}
        {/* Attached files preview */}
        {attachedFiles.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {attachedFiles.map((f, i) => (
              <div key={i} className="flex items-center gap-1.5 bg-neutral-100 dark:bg-neutral-800 rounded-md px-2 py-1 text-[12px]">
                <Paperclip size={11} className="text-neutral-400" />
                <span className="text-neutral-600 dark:text-neutral-300 truncate max-w-[150px]">{f.name}</span>
                <button onClick={() => setAttachedFiles(prev => prev.filter((_, j) => j !== i))} className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300">
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2.5 items-center">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => { if (e.target.files) processFiles(e.target.files); e.target.value = '' }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isActive}
            className="p-1.5 rounded-md text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-30"
            title="Attach file"
          >
            <Paperclip size={16} />
          </button>
          <Input
            ref={inputRef}
            className="flex-1 text-[13.5px] dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-500"
            placeholder={isActive ? 'Type to steer the agent…' : connected ? 'Ask Co-Agent anything… (type @ for skills)' : 'Starting up…'}
            value={input}
            onChange={e => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {isActive && !input.trim() ? (
            <Button size="sm" variant="outline" onClick={onStop}>
              <Square size={10} className="mr-1.5" />
              Stop
            </Button>
          ) : (
            <Button size="sm" onClick={handleSend} disabled={!input.trim() && attachedFiles.length === 0}>
              <Send size={14} className="mr-1.5" />
              {isActive ? 'Steer' : 'Send'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
