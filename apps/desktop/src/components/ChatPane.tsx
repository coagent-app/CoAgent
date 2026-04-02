import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Square, FileText, Sheet, File, X, ChevronLeft, ChevronRight, ExternalLink, Paperclip, Mic } from 'lucide-react'
import { CapabilityCard } from '@/components/CapabilityCard'
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
  researchAgents?: { query: string; status: string; detail?: string }[]
  connected: boolean
  onChat: (message: string) => void
  onSteer?: (message: string) => void
  onStop?: () => void
  onIngestFile?: (filename: string, mimeType: string, data: string) => void
  files: FileEntry[]
  onNavigateToSettings?: () => void
  lastHeartbeat?: { time: Date; status: string; nextAt?: Date } | null
  skills?: { name: string; description: string; placeholder?: string }[]
  capabilityCard?: { name: string; capabilities: { name: string; description: string; checked: boolean }[]; authFields?: { name: string; displayName: string; description: string; helpUrl?: string; helpText?: string }[] } | null
  onConfirmCapabilities?: (selected: string[], authValues?: Record<string, string>) => void
  userName?: string
  userRole?: string
  onboarded?: boolean
  className?: string
}

function getWelcomeMessage(userName?: string, userRole?: string, onboarded?: boolean): string {
  const name = userName ? `, ${userName}` : ''
  if (!onboarded) {
    if (userRole?.toLowerCase().includes('real estate')) {
      return `Hey${name}! I'm CoAgent, your AI assistant built for real estate. I run privately on your machine and can help with contracts, client follow-ups, listings, and your daily workflow.\n\nLet's get you set up — what market are you in, and do you primarily work with buyers, sellers, or both?`
    }
    return `Hey${name}! I'm CoAgent — your personal AI assistant. I run privately on your machine and can manage your email, calendar, tasks, and workflows.\n\nLet's get you set up. What do you do for work, and what would you like help with?`
  }
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  return `${greeting}${name}. What can I help you with?`
}

// ── Typing placeholder ──────────────────────────────────────────────────────
const PLACEHOLDER_PREFIX = 'Ask Co-Agent to '
const DEFAULT_SUFFIXES = [
  'check your calendar…',
  'summarize your emails…',
  'draft a follow-up…',
  'find upcoming meetings…',
  'search your contacts…',
  'schedule a reminder…',
]

// Turn a skill description into a short placeholder suffix

// Shuffle array (Fisher-Yates)
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function useTypingPlaceholder(active: boolean, skills: { name: string; description: string; placeholder?: string }[] = []) {
  const suffixes = React.useMemo(() => {
    const skillSuffixes = skills.map(s => s.placeholder).filter((p): p is string => !!p)
    const all = [...DEFAULT_SUFFIXES, ...skillSuffixes, 'do anything… (@ for skills)']
    return shuffle(all)
  }, [skills])

  const [suffix, setSuffix] = useState('')
  const idx = useRef(0)
  const charIdx = useRef(0)
  const direction = useRef<'typing' | 'deleting' | 'paused'>('typing')
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    if (active) { setSuffix(''); return }

    const tick = () => {
      const s = suffixes[idx.current % suffixes.length]
      if (direction.current === 'typing') {
        charIdx.current++
        setSuffix(s.slice(0, charIdx.current))
        if (charIdx.current >= s.length) {
          direction.current = 'paused'
          timeoutRef.current = setTimeout(tick, 30000)
          return
        }
        timeoutRef.current = setTimeout(tick, 80 + Math.random() * 60)
      } else if (direction.current === 'paused') {
        direction.current = 'deleting'
        timeoutRef.current = setTimeout(tick, 50)
      } else {
        charIdx.current--
        setSuffix(s.slice(0, charIdx.current))
        if (charIdx.current <= 0) {
          direction.current = 'typing'
          idx.current = (idx.current + 1) % suffixes.length
          timeoutRef.current = setTimeout(tick, 2000)
          return
        }
        timeoutRef.current = setTimeout(tick, 35)
      }
    }

    timeoutRef.current = setTimeout(tick, 1000)
    return () => clearTimeout(timeoutRef.current)
  }, [active, suffixes])

  // Prefix always visible, only suffix animates
  if (active) return ''
  return PLACEHOLDER_PREFIX + suffix
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

// ── Dictation hook (hold-to-dictate → Whisper cleanup) ──────────────────────
// Uses shared recording logic from voice.ts to avoid duplication
function useDictation(onResult: (text: string) => void) {
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const sessionRef = useRef<import('@/lib/voice').DictationSession | null>(null)

  const start = useCallback(async () => {
    if (recording || transcribing) return
    setRecording(true)
    try {
      const { startDictation } = await import('@/lib/voice')
      sessionRef.current = await startDictation()
    } catch (err) {
      console.error('[Dictation] Mic access failed:', err)
      setRecording(false)
    }
  }, [recording, transcribing])

  const stop = useCallback(async () => {
    if (!recording) return
    setRecording(false)
    const session = sessionRef.current
    sessionRef.current = null
    if (!session) return
    const result = await session.stop()
    if (!result) return
    setTranscribing(true)
    window.dispatchEvent(new CustomEvent('coagent-ws-send', {
      detail: { type: 'voice_dictation', data: result.base64 }
    }))
  }, [recording])

  // Listen for Whisper result
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent).detail as string
      setTranscribing(false)
      if (text) onResult(text)
    }
    window.addEventListener('coagent-dictation', handler)
    return () => window.removeEventListener('coagent-dictation', handler)
  }, [onResult])

  return { recording, transcribing, start, stop }
}

export function ChatPane({ messages, streamingText, thinking, processing, toolLabel, researchAgents = [], connected, onChat, onSteer, onStop, onIngestFile, files, onNavigateToSettings, lastHeartbeat, skills = [], capabilityCard, onConfirmCapabilities, userName, userRole, onboarded, className }: ChatPaneProps) {
  const [input, setInput] = useState('')
  const [skillQuery, setSkillQuery] = useState<string | null>(null)
  const [selectedSkillIdx, setSelectedSkillIdx] = useState(0)
  const [attachedFiles, setAttachedFiles] = useState<{ name: string; size: number }[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [inputFocused, setInputFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Dictation: append Whisper result to input
  const handleDictation = useCallback((text: string) => {
    setInput(prev => prev ? `${prev} ${text}` : text)
    inputRef.current?.focus()
  }, [])
  const dictation = useDictation(handleDictation)

  // Hold Space to dictate: prevent the space character, start after 3s hold.
  // On early release (<3s), insert the space that was suppressed.
  const spaceHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const spaceHeld = useRef(false)
  const spaceActivated = useRef(false)
  const inputValueRef = useRef(input)
  inputValueRef.current = input
  const dictationRef = useRef(dictation)
  dictationRef.current = dictation
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      const d = dictationRef.current
      if (d.recording || d.transcribing) return
      // Only intercept when input is empty and input is focused
      if (inputValueRef.current) return
      if (document.activeElement !== inputRef.current) return
      e.preventDefault()
      e.stopImmediatePropagation()
      spaceHeld.current = true
      spaceActivated.current = false
      spaceHoldTimer.current = setTimeout(() => {
        if (spaceHeld.current) {
          spaceActivated.current = true
          dictationRef.current.start()
        }
      }, 3000)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      if (!spaceHeld.current && !dictationRef.current.recording) return
      spaceHeld.current = false
      if (spaceHoldTimer.current) { clearTimeout(spaceHoldTimer.current); spaceHoldTimer.current = null }
      if (dictationRef.current.recording) {
        e.preventDefault()
        e.stopImmediatePropagation()
        dictationRef.current.stop()
      } else if (!spaceActivated.current) {
        // Released before 3s — insert the space they intended to type
        setInput(prev => prev + ' ')
      }
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      if (spaceHoldTimer.current) clearTimeout(spaceHoldTimer.current)
    }
  }, [])

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
  const typingPlaceholder = useTypingPlaceholder(isActive || !connected, skills)

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
          <h1 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-neutral-100">{(() => {
            const hour = new Date().getHours()
            const greeting = hour < 12 ? 'Good Morning' : hour < 17 ? 'Good Afternoon' : 'Good Evening'
            return userName ? `${greeting}, ${userName.split(/\s+/)[0]}` : greeting
          })()}</h1>
        </div>
        <div className="flex items-center gap-2">
          {lastHeartbeat && (
            <span className="text-[10px] text-neutral-400 dark:text-neutral-500" title={`Last check: ${lastHeartbeat.time.toLocaleTimeString()}`}>
              {lastHeartbeat.status === 'started' ? 'Checking...' : lastHeartbeat.nextAt ? `Next ${lastHeartbeat.nextAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : `Checked ${lastHeartbeat.time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
            </span>
          )}
          <div
            title={connected ? 'Connected' : 'Disconnected'}
            className={cn('w-2 h-2 rounded-full', connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400')}
          />
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-7 py-5 flex flex-col gap-3">
          {messages.length === 0 && !isActive && (
            <div className="flex justify-start">
              <AgentBubble content={getWelcomeMessage(userName, userRole, onboarded)} files={files} />
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
              <div className="flex flex-col gap-1 px-2 py-3">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 bg-neutral-400 dark:bg-neutral-500 rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 bg-neutral-400 dark:bg-neutral-500 rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 bg-neutral-400 dark:bg-neutral-500 rounded-full animate-bounce [animation-delay:300ms]" />
                  {toolLabel && !researchAgents.length && (
                    <span className="text-[12px] ml-1 shimmer-text">{toolLabel}...</span>
                  )}
                </div>
                {researchAgents.length > 0 && (
                  <div className="flex flex-col gap-0.5 mt-1 ml-1">
                    {researchAgents.map((agent, i) => (
                      <div key={i} className="flex items-center gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
                        <span className={`w-3 text-center ${agent.status === 'done' ? 'text-green-500' : agent.status === 'error' ? 'text-red-400' : 'animate-spin'}`}>
                          {agent.status === 'done' ? '✓' : agent.status === 'error' ? '✗' : '⟳'}
                        </span>
                        <span className="truncate max-w-[200px] opacity-70">"{agent.query}"</span>
                        <span className={agent.status === 'done' ? 'text-green-500' : agent.status === 'error' ? 'text-red-400' : 'shimmer-text'}>
                          {agent.status === 'done' ? 'done' : agent.status === 'error' ? 'error' : agent.status === 'branching' ? 'branching out' : agent.status === 'enriching' ? 'enriching' : 'searching'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {streamingText !== null && (
            <div className="flex justify-start">
              <AgentBubble content={streamingText} files={files} />
            </div>
          )}

          {capabilityCard && onConfirmCapabilities && (
            <div className="flex justify-start">
              <CapabilityCard
                name={capabilityCard.name}
                capabilities={capabilityCard.capabilities}
                authFields={capabilityCard.authFields}
                onConfirm={onConfirmCapabilities}
              />
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
          <div className="relative flex-1">
            <Input
              ref={inputRef}
              className="flex-1 w-full text-[13.5px] dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-500"
              placeholder={isActive ? 'Type to steer the agent…' : !connected ? 'Starting up…' : ''}
              value={input}
              onChange={e => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              readOnly={dictation.recording}
            />
            {!isActive && connected && !input && !inputFocused && !dictation.recording && !dictation.transcribing && (
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[13.5px] text-neutral-400 dark:text-neutral-500 pointer-events-none">
                {typingPlaceholder}<span className="inline-block w-[1px] h-[14px] bg-neutral-400 dark:bg-neutral-500 ml-[1px] align-middle animate-pulse" />
              </span>
            )}
          </div>
          <button
            onMouseDown={(e) => { e.preventDefault(); dictation.start() }}
            onMouseUp={() => dictation.stop()}
            onMouseLeave={() => { if (dictation.recording) dictation.stop() }}
            disabled={!connected}
            className={cn(
              'p-1.5 rounded-md transition-colors disabled:opacity-30',
              dictation.recording
                ? 'text-red-500 bg-red-50 dark:bg-red-900/30 animate-pulse'
                : 'text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'
            )}
            title="Hold to dictate (or hold Space)"
          >
            <Mic size={16} />
          </button>
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
