import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Trash2, FileText, Sheet, Image, File, Folder, Pencil, LayoutGrid, List, ArrowUpDown, ArrowUp, ArrowDown, Search, X, ChevronLeft, ExternalLink } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import type { FileEntry } from '@coagent/shared'

interface FilesPaneProps {
  files: FileEntry[]
  folders: string[]
  searchResults: FileEntry[] | null
  onIngest: (filename: string, mimeType: string, data: string) => void
  onIngestPaths: (paths: string[], group?: string) => void
  onDelete: (id: string) => void
  onCreateFolder: (name: string) => void
  onMoveFile: (id: string, targetGroup: string) => void
  onRenameFile: (id: string, newName: string) => void
  onRenameFolder: (oldName: string, newName: string) => void
  onDeleteFolder: (name: string) => void
  onReorderFolders: (order: string[]) => void
  onMoveFolder: (folderPath: string, newParentPath: string) => void
  onSearchFiles: (query: string) => void
  organizing?: boolean
  onAutoOrganize?: () => void
}

type ContextMenu =
  | { kind: 'file'; id: string; currentName: string; path: string; x: number; y: number }
  | { kind: 'folder'; name: string; x: number; y: number }

/** Rubber band rect tracked in viewport (clientX/Y) coordinates. */
interface RubberBand {
  startX: number
  startY: number
  curX: number
  curY: number
  /** True once the pointer has moved >= 5px so we don't flash a band on plain clicks. */
  active: boolean
}

type SortField = 'name' | 'date' | 'size'
type SortDir = 'asc' | 'desc'
type ViewMode = 'grid' | 'list'

const STORAGE_VIEW_MODE = 'coagent_files_view_mode'
const STORAGE_SORT_FIELD = 'coagent_files_sort_field'
const STORAGE_SORT_DIR = 'coagent_files_sort_dir'

function fileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') return FileText
  if (['csv', 'xlsx', 'xls'].includes(ext ?? '')) return Sheet
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext ?? '')) return Image
  return File
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
}

/** Normalise a rubber-band into a { left, top, right, bottom } rect. */
function normRect(band: RubberBand) {
  return {
    left: Math.min(band.startX, band.curX),
    top: Math.min(band.startY, band.curY),
    right: Math.max(band.startX, band.curX),
    bottom: Math.max(band.startY, band.curY),
  }
}

/** True when two rectangles intersect. */
function rectsOverlap(
  a: { left: number; top: number; right: number; bottom: number },
  b: DOMRect,
): boolean {
  return (
    a.left < b.right &&
    a.right > b.left &&
    a.top < b.bottom &&
    a.bottom > b.top
  )
}

function sortFiles(files: FileEntry[], field: SortField, dir: SortDir): FileEntry[] {
  const sorted = [...files].sort((a, b) => {
    if (field === 'name') return a.filename.localeCompare(b.filename)
    if (field === 'date') return new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime()
    if (field === 'size') return a.sizeBytes - b.sizeBytes
    return 0
  })
  return dir === 'desc' ? sorted.reverse() : sorted
}

/** Returns folder leaf-names that are direct children of parentPath. */
function directChildFolders(allFolders: string[], parentPath: string): string[] {
  return allFolders
    .filter(f => {
      if (parentPath === '') return !f.includes('/')
      if (!f.startsWith(`${parentPath}/`)) return false
      return !f.slice(parentPath.length + 1).includes('/')
    })
    .map(f => f.split('/').pop()!)
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

function isImage(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTS.has(`.${ext}`)
}

// Module-level cache for image thumbnails: path → data URL
const imageThumbnailCache = new Map<string, string>()

function ImageThumbnail({ path, filename, size }: { path: string; filename: string; size: 'grid' | 'list' }) {
  const [dataUrl, setDataUrl] = useState<string | null>(imageThumbnailCache.get(path) ?? null)
  const [error, setError] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (imageThumbnailCache.has(path)) return
    const el = containerRef.current
    if (!el) return

    let cancelled = false
    const observer = new IntersectionObserver(
      async (entries) => {
        if (!entries[0]?.isIntersecting) return
        observer.disconnect()
        try {
          const bytes: number[] = await invoke('read_file_bytes', { path })
          const ext = filename.split('.').pop()?.toLowerCase() ?? 'png'
          const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }
          const mime = mimeMap[ext] ?? 'image/png'
          const blob = new Blob([new Uint8Array(bytes)], { type: mime })
          const url = URL.createObjectURL(blob)
          if (!cancelled) {
            imageThumbnailCache.set(path, url)
            setDataUrl(url)
          }
        } catch {
          if (!cancelled) setError(true)
        }
      },
      { threshold: 0.1 }
    )
    observer.observe(el)
    return () => { cancelled = true; observer.disconnect() }
  }, [path, filename])

  const cls = size === 'grid'
    ? 'w-full h-full object-cover rounded-lg'
    : 'w-full h-full object-cover rounded'

  if (error) {
    const Icon = fileIcon(filename)
    return (
      <div className={`w-full h-full flex items-center justify-center ${fileIconBg(filename)}`}>
        <Icon size={size === 'grid' ? 22 : 14} className={fileIconColor(filename)} />
      </div>
    )
  }
  return (
    <div ref={containerRef} className="w-full h-full">
      {dataUrl ? (
        <img src={dataUrl} alt={filename} className={cls} draggable={false} />
      ) : (
        <div className="w-full h-full rounded bg-neutral-100 dark:bg-neutral-800 animate-pulse" />
      )}
    </div>
  )
}

function isPdf(filename: string): boolean {
  return filename.toLowerCase().endsWith('.pdf')
}

// Module-level cache: fileId:size → data URL (survives re-renders, cleared on page reload)
const pdfThumbnailCache = new Map<string, string>()

// Set worker URL once at module load
import('pdfjs-dist').then(lib => {
  lib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).href
})

function PdfThumbnail({ fileId, path, size }: { fileId: string; path: string; size: 'grid' | 'list' }) {
  const cacheKey = `${fileId}:${size}`
  const [dataUrl, setDataUrl] = useState<string | null>(pdfThumbnailCache.get(cacheKey) ?? null)
  const [loading, setLoading] = useState(!pdfThumbnailCache.has(cacheKey))
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const cacheKey = `${fileId}:${size}`
    if (pdfThumbnailCache.has(cacheKey)) return
    const el = containerRef.current
    if (!el) return

    let cancelled = false

    const observer = new IntersectionObserver(
      async (entries) => {
        if (!entries[0]?.isIntersecting) return
        observer.disconnect()
        try {
          const pdfjsLib = await import('pdfjs-dist')
          // Read file bytes via Rust command (bypasses asset protocol CORS issues)
          const bytes: number[] = await invoke('read_file_bytes', { path })
          const data = new Uint8Array(bytes)
          const loadingTask = pdfjsLib.getDocument({ data })
          const pdf = await loadingTask.promise
          const page = await pdf.getPage(1)

          const viewport = page.getViewport({ scale: 1 })
          const targetHeight = size === 'grid' ? 96 : 32
          const scale = targetHeight / viewport.height
          const scaled = page.getViewport({ scale })

          const canvas = document.createElement('canvas')
          canvas.width = scaled.width
          canvas.height = scaled.height
          const ctx = canvas.getContext('2d')!
          await page.render({ canvasContext: ctx, viewport: scaled, canvas }).promise

          const url = canvas.toDataURL('image/jpeg', 0.85)
          canvas.width = 0   // release GPU texture

          if (!cancelled) {
            pdfThumbnailCache.set(cacheKey, url)
            setDataUrl(url)
          }
        } catch (err) {
          console.warn('[PdfThumbnail] render failed:', err)
        } finally {
          if (!cancelled) setLoading(false)
        }
      },
      { threshold: 0.1 }
    )
    observer.observe(el)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [fileId, path, size])

  const cls = size === 'grid'
    ? 'w-full h-full object-cover rounded-lg'
    : 'w-full h-full object-cover rounded'

  return (
    <div ref={containerRef} className="w-full h-full">
      {dataUrl ? (
        <img src={dataUrl} alt="PDF preview" className={cls} draggable={false} />
      ) : loading ? (
        <div className="w-full h-full rounded bg-neutral-100 dark:bg-neutral-800 animate-pulse" />
      ) : null}
    </div>
  )
}

const TEXT_EXTS = new Set(['.md', '.txt', '.json', '.csv', '.yml', '.yaml', '.xml', '.html', '.css', '.js', '.ts', '.py', '.sh', '.log'])

function isTextFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return TEXT_EXTS.has(`.${ext}`)
}

// Module-level cache for text previews: path → first lines
const textPreviewCache = new Map<string, string>()

function TextPreview({ path, size }: { path: string; size: 'grid' | 'list' }) {
  const [text, setText] = useState<string | null>(textPreviewCache.get(path) ?? null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (textPreviewCache.has(path)) return
    const el = containerRef.current
    if (!el) return

    let cancelled = false
    const observer = new IntersectionObserver(
      async (entries) => {
        if (!entries[0]?.isIntersecting) return
        observer.disconnect()
        try {
          const bytes: number[] = await invoke('read_file_bytes', { path })
          const decoder = new TextDecoder()
          const content = decoder.decode(new Uint8Array(bytes)).slice(0, 500)
          if (!cancelled) {
            textPreviewCache.set(path, content)
            setText(content)
          }
        } catch {
          // Ignore — fall back to empty
        }
      },
      { threshold: 0.1 }
    )
    observer.observe(el)
    return () => { cancelled = true; observer.disconnect() }
  }, [path])

  const fontSize = size === 'grid' ? 'text-[5px]' : 'text-[6px]'

  return (
    <div ref={containerRef} className={`w-full h-full overflow-hidden p-1.5 bg-white dark:bg-neutral-900 rounded ${size === 'grid' ? 'rounded-lg' : ''}`}>
      {text !== null ? (
        <p className={`${fontSize} leading-[1.3] text-neutral-400 dark:text-neutral-500 whitespace-pre-wrap break-all font-mono`}>
          {text}
        </p>
      ) : (
        <div className="w-full h-full rounded bg-neutral-100 dark:bg-neutral-800 animate-pulse" />
      )}
    </div>
  )
}

function fileIconBg(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (['docx', 'doc'].includes(ext)) return 'bg-blue-50 dark:bg-blue-950'
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'bg-emerald-50 dark:bg-emerald-950'
  if (['pptx', 'ppt'].includes(ext)) return 'bg-orange-50 dark:bg-orange-950'
  if (['zip', 'rar', '7z'].includes(ext)) return 'bg-purple-50 dark:bg-purple-950'
  return 'bg-neutral-50 dark:bg-neutral-800'
}

function fileIconColor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (['docx', 'doc'].includes(ext)) return 'text-blue-400 dark:text-blue-500'
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'text-emerald-400 dark:text-emerald-500'
  if (['pptx', 'ppt'].includes(ext)) return 'text-orange-400 dark:text-orange-500'
  if (['zip', 'rar', '7z'].includes(ext)) return 'text-purple-400 dark:text-purple-500'
  return 'text-neutral-400 dark:text-neutral-500'
}

export function FilesPane({
  files,
  folders,
  searchResults,
  onIngest,
  onIngestPaths,
  onDelete,
  onCreateFolder,
  onMoveFile,
  onRenameFile,
  onRenameFolder,
  onDeleteFolder,
  onReorderFolders,
  onMoveFolder,
  onSearchFiles,
  organizing,
  onAutoOrganize,
}: FilesPaneProps) {
  const [currentPath, setCurrentPath] = useState<string>('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const newFolderInputRef = useRef<HTMLInputElement>(null)

  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [renamingFile, setRenamingFile] = useState<string | null>(null)
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Rubber-band state
  const rubberBandRef = useRef<RubberBand | null>(null)
  const [rubberBandRect, setRubberBandRect] = useState<RubberBand | null>(null)

  // Map from item id → DOM element used for bounding-rect intersection.
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // The id of the last item that was clicked without shift, used for range selection.
  const lastSelectedRef = useRef<string | null>(null)

  const [openError, setOpenError] = useState<string | null>(null)

  // ── Search state ─────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── View mode + sort (persisted to localStorage) ─────────────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem(STORAGE_VIEW_MODE) as ViewMode | null) ?? 'grid'
  })
  const [sortField, setSortField] = useState<SortField>(() => {
    return (localStorage.getItem(STORAGE_SORT_FIELD) as SortField | null) ?? 'date'
  })
  const [sortDir, setSortDir] = useState<SortDir>(() => {
    return (localStorage.getItem(STORAGE_SORT_DIR) as SortDir | null) ?? 'desc'
  })

  // ── Folder drag-reorder state ─────────────────────────────────────────────────
  const [localFolders, setLocalFolders] = useState<string[]>(folders)
  const [dragOverFolderReorder, setDragOverFolderReorder] = useState<string | null>(null)
  const draggingFolderRef = useRef<string | null>(null)

  // ── Nest-on-hover state ────────────────────────────────────────────────────────
  const nestTargetRef = useRef<string | null>(null)
  const nestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [nestTarget, setNestTarget] = useState<string | null>(null)

  // Sync localFolders when server folders change
  useEffect(() => {
    setLocalFolders(folders)
  }, [folders])

  // ── Breadcrumb drop target state ─────────────────────────────────────────────
  const [dragOverBreadcrumb, setDragOverBreadcrumb] = useState(false)

  // Derived ordered arrays for the current view (stable identity within a render).
  const rawVisibleFiles = files.filter(f => f.group === currentPath)
  const visibleFiles = sortFiles(rawVisibleFiles, sortField, sortDir)
  const visibleFolders = directChildFolders(localFolders, currentPath)
  const isEmpty = visibleFolders.length === 0 && visibleFiles.length === 0 && !creatingFolder && !searchQuery

  // ── OS-level file drop via Tauri ──────────────────────────────────────────
  const [osDragFolder, setOsDragFolder] = useState<string | null>(null)
  const osDragFolderRef = useRef<string | null>(null)
  const currentPathRef = useRef(currentPath)
  useEffect(() => { currentPathRef.current = currentPath }, [currentPath])

  // No Tauri onDragDropEvent needed — HTML5 drag-drop is handled globally in useAgent

  // ── Clean up drag state on dragend outside component ─────────────────────
  useEffect(() => {
    const handleDragEnd = () => {
      setDraggingId(null)
      setDragOverFolder(null)
      setDragOverFolderReorder(null)
      draggingFolderRef.current = null
    }
    document.addEventListener('dragend', handleDragEnd)
    return () => document.removeEventListener('dragend', handleDragEnd)
  }, [])

  // ── Clean up nest timer on unmount ────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (nestTimerRef.current) clearTimeout(nestTimerRef.current)
      nestTargetRef.current = null
    }
  }, [])

  // ── Dismiss context menu on outside click ─────────────────────────────────
  useEffect(() => {
    if (!contextMenu) return
    const dismiss = () => setContextMenu(null)
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [contextMenu])

  // ── Focus new folder input when it appears ────────────────────────────────
  useEffect(() => {
    if (creatingFolder) newFolderInputRef.current?.focus()
  }, [creatingFolder])

  // ── Focus rename input when it appears ───────────────────────────────────
  useEffect(() => {
    if (renamingFile !== null || renamingFolder !== null) {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }
  }, [renamingFile, renamingFolder])

  // ── Persist view mode / sort prefs ───────────────────────────────────────
  useEffect(() => { localStorage.setItem(STORAGE_VIEW_MODE, viewMode) }, [viewMode])
  useEffect(() => { localStorage.setItem(STORAGE_SORT_FIELD, sortField) }, [sortField])
  useEffect(() => { localStorage.setItem(STORAGE_SORT_DIR, sortDir) }, [sortDir])

  // ── Search debounce ───────────────────────────────────────────────────────
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    if (!searchQuery.trim()) {
      setIsSearching(false)
      onSearchFiles('')
      return
    }
    setIsSearching(true)
    searchDebounceRef.current = setTimeout(() => {
      onSearchFiles(searchQuery)
    }, 300)
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    }
  }, [searchQuery, onSearchFiles])

  // When search results arrive, mark no longer searching
  useEffect(() => {
    if (searchResults !== null) setIsSearching(false)
  }, [searchResults])

  // ── Cmd+A / Ctrl+A — select all visible files; Backspace/Delete — delete selected ─────
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault()
        const allIds = visibleFiles.map(f => f.id)
        setSelected(new Set(allIds))
        lastSelectedRef.current = allIds[allIds.length - 1] ?? null
        return
      }

      if ((e.key === 'Backspace' || e.key === 'Delete') && selected.size > 0) {
        e.preventDefault()
        for (const id of selected) {
          onDelete(id)
        }
        setSelected(new Set())
        lastSelectedRef.current = null
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [visibleFiles, selected, onDelete])

  // ── Rubber-band mouse event handlers ─────────────────────────────────────
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      const band = rubberBandRef.current
      if (!band) return

      const dx = e.clientX - band.startX
      const dy = e.clientY - band.startY
      const wasActive = band.active
      band.curX = e.clientX
      band.curY = e.clientY

      if (!band.active && (Math.abs(dx) >= 5 || Math.abs(dy) >= 5)) {
        band.active = true
      }

      if (band.active) {
        setRubberBandRect({ ...band })
        e.preventDefault()

        const nr = normRect(band)
        const newSel = new Set<string>()
        for (const [id, el] of itemRefs.current.entries()) {
          const rect = el.getBoundingClientRect()
          if (rectsOverlap(nr, rect)) newSel.add(id)
        }
        setSelected(newSel)
      }
    }

    function onMouseUp(e: MouseEvent) {
      const band = rubberBandRef.current
      if (!band) return

      if (band.active) {
        band.curX = e.clientX
        band.curY = e.clientY
        const nr = normRect(band)
        const newSel = new Set<string>()
        for (const [id, el] of itemRefs.current.entries()) {
          const rect = el.getBoundingClientRect()
          if (rectsOverlap(nr, rect)) newSel.add(id)
        }
        setSelected(newSel)
        const lastInSel = visibleFiles.map(f => f.id).filter(id => newSel.has(id)).pop()
        lastSelectedRef.current = lastInSel ?? null
      }

      rubberBandRef.current = null
      setRubberBandRect(null)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [visibleFiles])

  // ── Helpers ───────────────────────────────────────────────────────────────

  function readAndSend(fileList: FileList, ingest: typeof onIngest) {
    for (const file of fileList) {
      const reader = new FileReader()
      reader.onload = (e) => {
        const result = e.target?.result as string
        const base64 = result.split(',')[1] ?? ''
        if (!base64) return
        ingest(file.name, file.type || 'application/octet-stream', base64)
      }
      reader.readAsDataURL(file)
    }
  }

  const handlePicker = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = (e) => {
      const f = (e.target as HTMLInputElement).files
      if (f) readAndSend(f, onIngest)
    }
    input.click()
  }, [onIngest])

  async function handleOpenFile(path: string) {
    console.log('[open] path:', path)
    try {
      await invoke('open_file', { path })
    } catch (err) {
      console.error('Failed to open file:', err)
      const msg = err instanceof Error ? err.message : JSON.stringify(err)
      setOpenError(`${msg} | path: ${path}`)
      setTimeout(() => setOpenError(null), 12000)
    }
  }

  // ── Item click – handles plain / Cmd / Shift ──────────────────────────────
  function handleItemClick(e: React.MouseEvent, id: string) {
    e.stopPropagation()

    if (e.shiftKey && lastSelectedRef.current) {
      const orderedIds = visibleFiles.map(f => f.id)
      const anchorIdx = orderedIds.indexOf(lastSelectedRef.current)
      const clickIdx = orderedIds.indexOf(id)
      if (anchorIdx !== -1 && clickIdx !== -1) {
        const [lo, hi] = anchorIdx < clickIdx
          ? [anchorIdx, clickIdx]
          : [clickIdx, anchorIdx]
        const rangeIds = orderedIds.slice(lo, hi + 1)
        setSelected(prev => {
          const next = new Set(prev)
          for (const rid of rangeIds) next.add(rid)
          return next
        })
        return
      }
    }

    if (e.metaKey || e.ctrlKey) {
      setSelected(prev => {
        const next = new Set(prev)
        next.has(id) ? next.delete(id) : next.add(id)
        return next
      })
      lastSelectedRef.current = id
      return
    }

    setSelected(new Set([id]))
    lastSelectedRef.current = id
  }

  function openContextMenu(e: React.MouseEvent, menu: ContextMenu) {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ ...menu, x: e.clientX, y: e.clientY })
  }

  function startRenameFile(id: string, currentName: string) {
    setContextMenu(null)
    setRenamingFile(id)
    setRenamingFolder(null)
    setRenameValue(currentName)
  }

  function startRenameFolder(name: string) {
    setContextMenu(null)
    setRenamingFolder(name)
    setRenamingFile(null)
    setRenameValue(name)
  }

  function commitRename() {
    const val = renameValue.trim()
    if (val) {
      if (renamingFile) onRenameFile(renamingFile, val)
      if (renamingFolder) onRenameFolder(renamingFolder, val)
    }
    setRenamingFile(null)
    setRenamingFolder(null)
    setRenameValue('')
  }

  function cancelRename() {
    setRenamingFile(null)
    setRenamingFolder(null)
    setRenameValue('')
  }

  // ── Folder drop – moves all selected files if the drag source is selected ─
  function handleFolderDrop(folderName: string, e: React.DragEvent) {
    // Only handle file-drag drops; folder reorder drops are handled separately
    if (e.dataTransfer.getData('folder-reorder')) return
    if (!draggingId) return
    const fullPath = currentPath ? `${currentPath}/${folderName}` : folderName
    const idsToMove =
      selected.has(draggingId) && selected.size > 1
        ? [...selected]
        : [draggingId]

    for (const id of idsToMove) {
      onMoveFile(id, fullPath)
    }

    setDraggingId(null)
    setDragOverFolder(null)
  }

  function commitNewFolder() {
    const name = newFolderName.trim()
    if (name) {
      const fullPath = currentPath ? `${currentPath}/${name}` : name
      setLocalFolders(prev => [...prev, fullPath])
      onCreateFolder(fullPath)
    }
    setCreatingFolder(false)
    setNewFolderName('')
  }

  // ── Sort helpers ──────────────────────────────────────────────────────────
  function handleSortField(field: SortField) {
    if (sortField === field) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) return <ArrowUpDown size={12} className="text-neutral-400 dark:text-neutral-500" />
    return sortDir === 'asc'
      ? <ArrowUp size={12} className="text-blue-500" />
      : <ArrowDown size={12} className="text-blue-500" />
  }

  // ── Folder reorder drag handlers ──────────────────────────────────────────
  function handleFolderDragStart(e: React.DragEvent, folderName: string) {
    e.dataTransfer.setData('folder-reorder', folderName)
    e.dataTransfer.effectAllowed = 'move'
    draggingFolderRef.current = folderName
  }

  function handleFolderReorderDragOver(e: React.DragEvent, targetFolder: string) {
    if (!e.dataTransfer.types.includes('folder-reorder')) return
    e.preventDefault()
    e.stopPropagation()
    setDragOverFolderReorder(targetFolder)
    setDragOverFolder(null)
  }

  function handleFolderReorderDrop(e: React.DragEvent, targetFolder: string) {
    const draggedFolder = e.dataTransfer.getData('folder-reorder')
    if (!draggedFolder || draggedFolder === targetFolder) {
      setDragOverFolderReorder(null)
      draggingFolderRef.current = null
      return
    }
    e.preventDefault()
    e.stopPropagation()

    const newOrder = [...localFolders]
    const fromIdx = newOrder.indexOf(draggedFolder)
    const toIdx = newOrder.indexOf(targetFolder)
    if (fromIdx !== -1 && toIdx !== -1) {
      newOrder.splice(fromIdx, 1)
      newOrder.splice(toIdx, 0, draggedFolder)
      setLocalFolders(newOrder)
      onReorderFolders(newOrder)
    }

    setDragOverFolderReorder(null)
    draggingFolderRef.current = null
  }

  // ── Shared drag handlers for folder items (grid + list) ──────────────────
  const makeFolderDragHandlers = (folder: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('folder-reorder')) {
        e.preventDefault()
        e.stopPropagation()
        if (draggingFolderRef.current && draggingFolderRef.current !== folder) {
          // Start nest timer if hovering a different folder
          if (nestTargetRef.current !== folder) {
            nestTargetRef.current = folder
            if (nestTimerRef.current) clearTimeout(nestTimerRef.current)
            nestTimerRef.current = setTimeout(() => {
              setNestTarget(folder)
              setDragOverFolderReorder(null)
            }, 400)
          }
        } else {
          handleFolderReorderDragOver(e, folder)
        }
      } else {
        e.preventDefault()
        e.stopPropagation()
        setDragOverFolder(folder)
        if (nestTimerRef.current) clearTimeout(nestTimerRef.current)
        nestTargetRef.current = null
        setNestTarget(null)
      }
    },
    onDragLeave: () => {
      setDragOverFolder(null)
      setDragOverFolderReorder(null)
      if (nestTimerRef.current) clearTimeout(nestTimerRef.current)
      nestTargetRef.current = null
      setNestTarget(null)
    },
    onDrop: (e: React.DragEvent) => {
      if (nestTargetRef.current === folder) {
        e.preventDefault()
        e.stopPropagation()
        const dragged = draggingFolderRef.current
        if (dragged && dragged !== folder) {
          const fullFolderPath = currentPath ? `${currentPath}/${dragged}` : dragged
          const fullTargetPath = currentPath ? `${currentPath}/${folder}` : folder
          onMoveFolder(fullFolderPath, fullTargetPath)
          setLocalFolders(prev => prev.filter(f => f !== fullFolderPath))
        }
        nestTargetRef.current = null
        setNestTarget(null)
        draggingFolderRef.current = null
      } else if (e.dataTransfer.types.includes('folder-reorder')) {
        handleFolderReorderDrop(e, folder)
      } else {
        e.preventDefault()
        handleFolderDrop(folder, e)
      }
      setDragOverFolder(null)
      setDragOverFolderReorder(null)
    },
  })

  // ── Grid mousedown – start rubber band when clicking on background ─────────
  function handleGridMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-item="true"]')) return

    setSelected(new Set())
    lastSelectedRef.current = null

    rubberBandRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      curX: e.clientX,
      curY: e.clientY,
      active: false,
    }
  }

  // ── Context menu delete label ─────────────────────────────────────────────
  function resolveDeleteLabel(): string {
    if (
      contextMenu?.kind === 'file' &&
      selected.size > 1 &&
      selected.has(contextMenu.id)
    ) {
      return `Delete ${selected.size} items`
    }
    return 'Delete'
  }

  function handleContextMenuDelete() {
    if (!contextMenu || contextMenu.kind !== 'file') return

    if (selected.size > 1 && selected.has(contextMenu.id)) {
      for (const id of selected) {
        onDelete(id)
      }
      setSelected(new Set())
    } else {
      onDelete(contextMenu.id)
    }

    setContextMenu(null)
  }

  // ── Rubber-band overlay style ─────────────────────────────────────────────
  const rubberBandStyle: React.CSSProperties | undefined = rubberBandRect?.active
    ? (() => {
        const nr = normRect(rubberBandRect)
        return {
          position: 'fixed' as const,
          left: nr.left,
          top: nr.top,
          width: nr.right - nr.left,
          height: nr.bottom - nr.top,
          background: 'rgba(59, 130, 246, 0.10)',
          border: '1.5px solid rgba(59, 130, 246, 0.55)',
          borderRadius: 4,
          pointerEvents: 'none' as const,
          zIndex: 100,
        }
      })()
    : undefined

  // ── Visible files for search/normal view ─────────────────────────────────
  const displayFiles = searchQuery.trim()
    ? (isSearching ? null : (searchResults ?? []))
    : visibleFiles

  // ── Reusable file item renderer ───────────────────────────────────────────
  function renderFileGrid(file: FileEntry) {
    const Icon = fileIcon(file.filename)
    const isSelected = selected.has(file.id)
    const isRenaming = renamingFile === file.id
    return (
      <div
        key={file.id}
        data-item="true"
        ref={el => {
          if (el) itemRefs.current.set(file.id, el)
          else itemRefs.current.delete(file.id)
        }}
        draggable={!isRenaming}
        title={!isRenaming && file.summary ? file.summary : undefined}
        onMouseDown={e => e.stopPropagation()}
        onDragStart={(e) => { e.dataTransfer.setData('text/plain', file.id); setDraggingId(file.id) }}
        onDragEnd={() => { setDraggingId(null); setDragOverFolder(null) }}
        onClick={(e) => { if (!isRenaming) handleItemClick(e, file.id) }}
        onDoubleClick={() => { if (!isRenaming) handleOpenFile(file.path) }}
        onContextMenu={(e) => openContextMenu(e, { kind: 'file', id: file.id, currentName: file.filename, path: file.path, x: 0, y: 0 })}
        className={`group relative flex flex-col items-center gap-1.5 p-2 rounded-xl cursor-pointer select-none transition-all duration-150 ${
          draggingId === file.id
            ? 'opacity-50 scale-95'
            : isSelected
              ? 'bg-blue-50 dark:bg-blue-950 ring-2 ring-blue-300 dark:ring-blue-700 scale-[1.01]'
              : 'hover:bg-neutral-50 dark:hover:bg-neutral-800 hover:scale-[1.02] hover:shadow-sm'
        }`}
      >
        <div className="w-14 h-14 rounded-xl bg-neutral-50 dark:bg-neutral-800 overflow-hidden flex items-center justify-center">
          {isImage(file.filename) ? (
            <ImageThumbnail path={file.path} filename={file.filename} size="grid" />
          ) : isPdf(file.filename) ? (
            <PdfThumbnail fileId={file.id} path={file.path} size="grid" />
          ) : isTextFile(file.filename) ? (
            <TextPreview path={file.path} size="grid" />
          ) : (
            <div className={`w-full h-full flex items-center justify-center rounded-xl ${fileIconBg(file.filename)}`}>
              <Icon size={22} className={fileIconColor(file.filename)} />
            </div>
          )}
        </div>
        {isRenaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') cancelRename()
            }}
            onClick={e => e.stopPropagation()}
            className="w-full text-[11px] text-center border border-blue-300 rounded px-1 py-0.5 outline-none focus:ring-1 focus:ring-blue-400 dark:bg-neutral-800 dark:border-blue-600 dark:text-neutral-100"
          />
        ) : (
          <p className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300 text-center leading-tight line-clamp-2 w-full">
            {file.filename}
          </p>
        )}
        {!isRenaming && (
          <p className="text-[10px] text-neutral-400 dark:text-neutral-500">{formatBytes(file.sizeBytes)}</p>
        )}
      </div>
    )
  }

  function renderFileList(file: FileEntry) {
    const Icon = fileIcon(file.filename)
    const isSelected = selected.has(file.id)
    const isRenaming = renamingFile === file.id
    return (
      <div
        key={file.id}
        data-item="true"
        ref={el => {
          if (el) itemRefs.current.set(file.id, el)
          else itemRefs.current.delete(file.id)
        }}
        draggable={!isRenaming}
        onMouseDown={e => e.stopPropagation()}
        onDragStart={(e) => { e.dataTransfer.setData('text/plain', file.id); setDraggingId(file.id) }}
        onDragEnd={() => { setDraggingId(null); setDragOverFolder(null) }}
        onClick={(e) => { if (!isRenaming) handleItemClick(e, file.id) }}
        onDoubleClick={() => { if (!isRenaming) handleOpenFile(file.path) }}
        onContextMenu={(e) => openContextMenu(e, { kind: 'file', id: file.id, currentName: file.filename, path: file.path, x: 0, y: 0 })}
        className={`flex items-center gap-3 px-2 py-2 rounded-lg cursor-pointer select-none transition-all duration-100 ${
          draggingId === file.id
            ? 'opacity-50'
            : isSelected
              ? 'bg-blue-50 dark:bg-blue-950 ring-1 ring-blue-300 dark:ring-blue-700'
              : 'hover:bg-neutral-50 dark:hover:bg-neutral-800'
        }`}
      >
        {/* Icon column */}
        <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center overflow-hidden rounded">
          {isImage(file.filename) ? (
            <ImageThumbnail path={file.path} filename={file.filename} size="list" />
          ) : isPdf(file.filename) ? (
            <PdfThumbnail fileId={file.id} path={file.path} size="list" />
          ) : isTextFile(file.filename) ? (
            <TextPreview path={file.path} size="list" />
          ) : (
            <Icon size={16} className={fileIconColor(file.filename)} />
          )}
        </div>
        {/* Name + summary column */}
        <div className="flex-1 min-w-0">
          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={e => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') cancelRename()
              }}
              onClick={e => e.stopPropagation()}
              className="w-full text-[12px] border border-blue-300 rounded px-1 py-0.5 outline-none focus:ring-1 focus:ring-blue-400 dark:bg-neutral-800 dark:border-blue-600 dark:text-neutral-100"
            />
          ) : (
            <>
              <p className="text-[12px] font-medium text-neutral-700 dark:text-neutral-300 truncate leading-tight">
                {file.filename}
              </p>
              {file.summary && (
                <p className="text-[11px] text-neutral-400 dark:text-neutral-500 truncate leading-snug mt-0.5">
                  {file.summary}
                </p>
              )}
            </>
          )}
        </div>
        {/* Size column */}
        <div className="flex-shrink-0 w-20 text-right">
          <p className="text-[11px] text-neutral-400 dark:text-neutral-500">{formatBytes(file.sizeBytes)}</p>
        </div>
        {/* Date column */}
        <div className="flex-shrink-0 w-24 text-right">
          <p className="text-[11px] text-neutral-400 dark:text-neutral-500">{formatDate(file.addedAt)}</p>
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex-1 bg-white dark:bg-neutral-950 flex flex-col overflow-hidden relative"
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
    >
      {/* Rubber-band overlay */}
      {rubberBandStyle && <div style={rubberBandStyle} />}

      {/* Header */}
      <div className="px-8 pt-7 pb-2 flex-shrink-0">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-1">Context</p>
            <div className="flex items-center gap-2">
              {currentPath !== '' && (
                <button
                  onClick={() => {
                    const parts = currentPath.split('/')
                    parts.pop()
                    setCurrentPath(parts.join('/'))
                    setSelected(new Set())
                    lastSelectedRef.current = null
                  }}
                  className="p-1 -ml-1 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                  title="Go back"
                >
                  <ChevronLeft size={18} />
                </button>
              )}
              <h1 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
                {currentPath === '' ? 'Files' : currentPath.split('/').pop()!}
              </h1>
            </div>
            {currentPath !== '' && (
              <nav className="flex items-center gap-0.5 mt-1 flex-wrap">
                <button
                  onClick={() => { setCurrentPath(''); setSelected(new Set()); lastSelectedRef.current = null }}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes('text/plain')) {
                      e.preventDefault()
                      setDragOverBreadcrumb(true)
                    }
                  }}
                  onDragLeave={() => setDragOverBreadcrumb(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragOverBreadcrumb(false)
                    const id = e.dataTransfer.getData('text/plain')
                    if (!id) return
                    const idsToMove = selected.has(id) && selected.size > 1 ? [...selected] : [id]
                    for (const fileId of idsToMove) onMoveFile(fileId, '')
                    setDraggingId(null)
                  }}
                  className={`text-[11px] transition-colors px-1 py-0.5 rounded ${
                    dragOverBreadcrumb
                      ? 'bg-blue-100 dark:bg-blue-900 text-blue-600'
                      : 'text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
                  }`}
                >
                  Files
                </button>
                {currentPath.split('/').map((segment, idx, arr) => {
                  const segPath = arr.slice(0, idx + 1).join('/')
                  const isLast = idx === arr.length - 1
                  return (
                    <React.Fragment key={segPath}>
                      <span className="text-[10px] text-neutral-300 dark:text-neutral-600">›</span>
                      {isLast ? (
                        <span className="text-[11px] text-neutral-600 dark:text-neutral-400 px-1">{segment}</span>
                      ) : (
                        <button
                          onClick={() => { setCurrentPath(segPath); setSelected(new Set()); lastSelectedRef.current = null }}
                          className="text-[11px] text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors px-1 py-0.5 rounded"
                        >
                          {segment}
                        </button>
                      )}
                    </React.Fragment>
                  )
                })}
              </nav>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* View toggle */}
            <div className="flex items-center border border-neutral-200 dark:border-neutral-700 rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                className={`p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900' : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800'}`}
                title="Grid view"
              >
                <LayoutGrid size={14} />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className={`p-1.5 transition-colors ${viewMode === 'list' ? 'bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900' : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800'}`}
                title="List view"
              >
                <List size={14} />
              </button>
            </div>

            {onAutoOrganize && files.length >= 3 && (
              <button
                type="button"
                onClick={onAutoOrganize}
                disabled={organizing}
                className="text-[12px] font-medium px-3 py-1.5 rounded-lg border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {organizing ? 'Organizing…' : 'Auto-organize'}
              </button>
            )}
            <button
              type="button"
              onClick={() => setCreatingFolder(true)}
              className="text-[12px] font-medium px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
            >
              + New Folder
            </button>
            <button
              type="button"
              onClick={handlePicker}
              className="text-[12px] font-medium px-3 py-1.5 rounded-lg bg-neutral-900 text-white hover:bg-neutral-700 transition-colors"
            >
              + Add Files
            </button>
          </div>
        </div>

        {/* Search bar */}
        <div className="mt-3 relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search files..."
            className="w-full pl-8 pr-8 py-1.5 text-[12px] bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg text-neutral-700 dark:text-neutral-300 placeholder-neutral-400 dark:placeholder-neutral-600 outline-none focus:ring-1 focus:ring-blue-400 dark:focus:ring-blue-600 transition-colors"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* Sort controls (shown when not searching) */}
        {!searchQuery && (
          <div className="mt-2 flex items-center gap-1 pb-2">
            <span className="text-[10px] text-neutral-400 dark:text-neutral-500 mr-1">Sort:</span>
            {(['name', 'date', 'size'] as SortField[]).map(field => (
              <button
                key={field}
                type="button"
                onClick={() => handleSortField(field)}
                className={`flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md transition-colors ${
                  sortField === field
                    ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950'
                    : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800'
                }`}
              >
                {field.charAt(0).toUpperCase() + field.slice(1)}
                <SortIcon field={field} />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content area */}
      {searchQuery.trim() ? (
        /* Search results view */
        <div className="flex-1 overflow-y-auto px-8 pb-8">
          {isSearching ? (
            <div className="flex items-center justify-center pt-12 gap-2 text-neutral-400 dark:text-neutral-500">
              <span className="text-[13px]">Searching...</span>
            </div>
          ) : displayFiles !== null && displayFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center pt-12 gap-2 text-neutral-400 dark:text-neutral-500">
              <Search size={20} />
              <p className="text-[13px]">No files found for "{searchQuery}"</p>
            </div>
          ) : displayFiles !== null ? (
            viewMode === 'grid' ? (
              <div
                className="grid gap-4 pt-2"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))' }}
              >
                {displayFiles.map(renderFileGrid)}
              </div>
            ) : (
              <div className="flex flex-col gap-0.5 pt-2">
                {/* List header */}
                <div className="flex items-center gap-3 px-2 py-1 mb-1">
                  <div className="w-5 flex-shrink-0" />
                  <div className="flex-1 text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Name</div>
                  <div className="w-20 text-right text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Size</div>
                  <div className="w-24 text-right text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Added</div>
                </div>
                {displayFiles.map(renderFileList)}
              </div>
            )
          ) : null}
        </div>
      ) : isEmpty ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
          <div className="w-12 h-12 rounded-full bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center">
            <File size={20} className="text-neutral-400 dark:text-neutral-500" />
          </div>
          <p className="text-[14px] font-medium text-neutral-500 dark:text-neutral-400">Drop files to share with CoAgent</p>
          <p className="text-[12px] text-neutral-400 dark:text-neutral-500 max-w-xs">
            Contracts, spreadsheets, docs — CoAgent reads them and uses them as context.
          </p>
        </div>
      ) : (
        <div
          className="flex-1 overflow-y-auto px-8 pb-8"
          onMouseDown={handleGridMouseDown}
        >
          {viewMode === 'grid' ? (
            /* Grid view */
            <div
              className="grid gap-4 pt-2"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))' }}
            >
              {/* Folder icons */}
              {visibleFolders.map(folder => (
                <div
                  key={folder}
                  data-item="true"
                  data-folder-path={currentPath ? `${currentPath}/${folder}` : folder}
                  draggable
                  onMouseDown={e => e.stopPropagation()}
                  onDragStart={(e) => handleFolderDragStart(e, folder)}
                  {...makeFolderDragHandlers(folder)}
                  className={`flex flex-col items-center gap-1.5 p-2 rounded-xl cursor-pointer select-none transition-all duration-150 ${
                    nestTarget === folder
                      ? 'bg-blue-50 dark:bg-blue-950 ring-2 ring-blue-400 dark:ring-blue-600 scale-105'
                      : dragOverFolder === folder
                        ? 'bg-blue-50 dark:bg-blue-950 ring-2 ring-blue-300 dark:ring-blue-700'
                        : dragOverFolderReorder === folder
                          ? 'bg-amber-50 dark:bg-amber-950 ring-2 ring-amber-300 dark:ring-amber-700'
                          : osDragFolder === (currentPath ? `${currentPath}/${folder}` : folder)
                            ? 'bg-blue-50 dark:bg-blue-950 ring-2 ring-blue-300 dark:ring-blue-700'
                            : 'hover:bg-neutral-50 dark:hover:bg-neutral-800 hover:scale-[1.02]'
                  }`}
                  onDoubleClick={() => {
                    if (renamingFolder === folder) return
                    const newPath = currentPath ? `${currentPath}/${folder}` : folder
                    setCurrentPath(newPath)
                    setSelected(new Set())
                    lastSelectedRef.current = null
                  }}
                  onContextMenu={(e) => openContextMenu(e, { kind: 'folder', name: folder, x: 0, y: 0 })}
                >
                  <Folder
                    size={56}
                    strokeWidth={1.25}
                    className={dragOverFolder === folder || nestTarget === folder ? 'text-blue-400' : 'text-neutral-700 dark:text-neutral-400'}
                    fill={dragOverFolder === folder || nestTarget === folder ? '#93c5fd' : 'currentColor'}
                    fillOpacity={dragOverFolder === folder || nestTarget === folder ? 1 : 0.12}
                  />
                  {renamingFolder === folder ? (
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitRename()
                        if (e.key === 'Escape') cancelRename()
                      }}
                      onClick={e => e.stopPropagation()}
                      className="w-full text-[11px] text-center border border-blue-300 rounded px-1 py-0.5 outline-none focus:ring-1 focus:ring-blue-400 dark:bg-neutral-800 dark:border-blue-600 dark:text-neutral-100"
                    />
                  ) : (
                    <p className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300 text-center leading-tight line-clamp-2 w-full">
                      {folder}
                    </p>
                  )}
                </div>
              ))}

              {/* File icons */}
              {visibleFiles.map(renderFileGrid)}

              {/* Inline new folder input */}
              {creatingFolder && (
                <div className="flex flex-col items-center gap-1.5 p-2 rounded-xl">
                  <Folder size={56} strokeWidth={1.25} className="text-neutral-700 dark:text-neutral-400" fill="currentColor" fillOpacity={0.12} />
                  <input
                    ref={newFolderInputRef}
                    value={newFolderName}
                    onChange={e => setNewFolderName(e.target.value)}
                    onBlur={commitNewFolder}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitNewFolder()
                      if (e.key === 'Escape') { setCreatingFolder(false); setNewFolderName('') }
                    }}
                    placeholder="Folder name"
                    className="w-full text-[11px] text-center border border-blue-300 rounded px-1 py-0.5 outline-none focus:ring-1 focus:ring-blue-400 dark:bg-neutral-800 dark:border-blue-600 dark:text-neutral-100 dark:placeholder-neutral-500"
                  />
                </div>
              )}
            </div>
          ) : (
            /* List view */
            <div className="flex flex-col gap-0.5 pt-2">
              {/* Folder rows */}
              {visibleFolders.map(folder => (
                <div
                  key={folder}
                  data-item="true"
                  data-folder-path={currentPath ? `${currentPath}/${folder}` : folder}
                  draggable
                  onMouseDown={e => e.stopPropagation()}
                  onDragStart={(e) => handleFolderDragStart(e, folder)}
                  {...makeFolderDragHandlers(folder)}
                  onDoubleClick={() => {
                    if (renamingFolder === folder) return
                    const newPath = currentPath ? `${currentPath}/${folder}` : folder
                    setCurrentPath(newPath)
                    setSelected(new Set())
                    lastSelectedRef.current = null
                  }}
                  onContextMenu={(e) => openContextMenu(e, { kind: 'folder', name: folder, x: 0, y: 0 })}
                  className={`flex items-center gap-3 px-2 py-2 rounded-lg cursor-pointer select-none transition-all duration-100 ${
                    nestTarget === folder
                      ? 'bg-blue-50 dark:bg-blue-950 ring-2 ring-blue-400 dark:ring-blue-600 scale-105'
                      : dragOverFolder === folder
                        ? 'bg-blue-50 dark:bg-blue-950 ring-1 ring-blue-300 dark:ring-blue-700'
                        : dragOverFolderReorder === folder
                          ? 'bg-amber-50 dark:bg-amber-950 ring-1 ring-amber-300 dark:ring-amber-700'
                          : osDragFolder === (currentPath ? `${currentPath}/${folder}` : folder)
                            ? 'bg-blue-50 dark:bg-blue-950 ring-1 ring-blue-300 dark:ring-blue-700'
                            : 'hover:bg-neutral-50 dark:hover:bg-neutral-800'
                  }`}
                >
                  <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
                    <Folder size={16} strokeWidth={1.5} className="text-neutral-600 dark:text-neutral-400" fill="currentColor" fillOpacity={0.15} />
                  </div>
                  <div className="flex-1 min-w-0">
                    {renamingFolder === folder ? (
                      <input
                        ref={renameInputRef}
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={e => {
                          if (e.key === 'Enter') commitRename()
                          if (e.key === 'Escape') cancelRename()
                        }}
                        onClick={e => e.stopPropagation()}
                        className="w-full text-[12px] border border-blue-300 rounded px-1 py-0.5 outline-none focus:ring-1 focus:ring-blue-400 dark:bg-neutral-800 dark:border-blue-600 dark:text-neutral-100"
                      />
                    ) : (
                      <p className="text-[12px] font-medium text-neutral-700 dark:text-neutral-300 truncate">{folder}</p>
                    )}
                  </div>
                  <div className="w-20" />
                  <div className="w-24" />
                </div>
              ))}

              {/* List column headers (only when files present) */}
              {visibleFiles.length > 0 && (
                <div className="flex items-center gap-3 px-2 py-1 mt-1 mb-0.5">
                  <div className="w-5 flex-shrink-0" />
                  <div className="flex-1 text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Name</div>
                  <div className="w-20 text-right text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Size</div>
                  <div className="w-24 text-right text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Added</div>
                </div>
              )}

              {/* File rows */}
              {visibleFiles.map(renderFileList)}

              {/* New folder inline for list view */}
              {creatingFolder && (
                <div className="flex items-center gap-3 px-2 py-2">
                  <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
                    <Folder size={16} strokeWidth={1.5} className="text-neutral-600 dark:text-neutral-400" fill="currentColor" fillOpacity={0.15} />
                  </div>
                  <input
                    ref={newFolderInputRef}
                    value={newFolderName}
                    onChange={e => setNewFolderName(e.target.value)}
                    onBlur={commitNewFolder}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitNewFolder()
                      if (e.key === 'Escape') { setCreatingFolder(false); setNewFolderName('') }
                    }}
                    placeholder="Folder name"
                    className="flex-1 text-[12px] border border-blue-300 rounded px-2 py-0.5 outline-none focus:ring-1 focus:ring-blue-400 dark:bg-neutral-800 dark:border-blue-600 dark:text-neutral-100 dark:placeholder-neutral-500"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Open error toast */}
      {openError && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-red-500 text-white text-[12px] font-medium px-4 py-2 rounded-lg shadow-lg pointer-events-none">
          {openError}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-xl shadow-lg dark:shadow-black/40 py-1 min-w-[140px]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onMouseDown={e => e.stopPropagation()}
        >
          {contextMenu.kind === 'file' && (
            <button
              className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
              onClick={() => {
                if (contextMenu.kind === 'file') {
                  invoke('reveal_in_file_manager', { path: contextMenu.path }).catch(console.error)
                }
                setContextMenu(null)
              }}
            >
              <ExternalLink size={13} className="text-neutral-400 dark:text-neutral-500" />
              {navigator.platform.includes('Mac') ? 'Show in Finder' : 'Show in Explorer'}
            </button>
          )}
          <button
            className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
            onClick={() => {
              if (contextMenu.kind === 'file') startRenameFile(contextMenu.id, contextMenu.currentName)
              else startRenameFolder(contextMenu.name)
            }}
          >
            <Pencil size={13} className="text-neutral-400 dark:text-neutral-500" />
            Rename
          </button>
          {contextMenu.kind === 'file' && (
            <button
              className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
              onClick={handleContextMenuDelete}
            >
              <Trash2 size={13} />
              {resolveDeleteLabel()}
            </button>
          )}
          {contextMenu.kind === 'folder' && (
            <button
              className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
              onClick={() => {
                if (contextMenu.kind === 'folder') {
                  onDeleteFolder(contextMenu.name)
                  setContextMenu(null)
                }
              }}
            >
              <Trash2 size={13} />
              Delete Folder
            </button>
          )}
        </div>
      )}
    </div>
  )
}
