import { useState, useRef, useEffect } from 'react'
import { X, Pencil, Eye, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

interface DocumentPanelProps {
  document: { id: string; filename: string; content: string }
  onUpdate: (id: string, content: string) => void
  onClose: () => void
}

export function DocumentPanel({ document, onUpdate, onClose }: DocumentPanelProps) {
  const [localContent, setLocalContent] = useState(document.content)
  const [isEditMode, setIsEditMode] = useState(false)
  const [isVisible, setIsVisible] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isEditingRef = useRef(false)

  // Slide-in animation on mount
  useEffect(() => {
    requestAnimationFrame(() => setIsVisible(true))
  }, [])

  // Reset to view mode and local state when a different document is opened
  useEffect(() => {
    setLocalContent(document.content)
    setIsEditMode(false)
    isEditingRef.current = false
  }, [document.id])

  // Sync external content changes (e.g. AI updates):
  // - In view mode: always update immediately
  // - In edit mode: respect the isEditingRef guard so in-progress typing isn't clobbered
  useEffect(() => {
    if (!isEditMode || !isEditingRef.current) {
      setLocalContent(document.content)
    }
  }, [document.content]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup pending debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value
    setLocalContent(value)
    isEditingRef.current = true

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      onUpdate(document.id, value)
      isEditingRef.current = false
    }, 1500)
  }

  function handleToggleMode() {
    if (isEditMode) {
      // Switching from edit → view: flush any pending debounce immediately
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
        onUpdate(document.id, localContent)
        isEditingRef.current = false
      }
      setIsEditMode(false)
    } else {
      setIsEditMode(true)
    }
  }

  const isStreaming = document.id === '_streaming'
  // During streaming, render directly from the prop to avoid useEffect delay
  const displayContent = isStreaming ? document.content : localContent
  const displayName = document.filename.replace(/\.md$/i, '')

  return (
    <div className={cn(
      "flex flex-col border-l border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 transition-transform duration-300 ease-out w-[48%] max-w-full",
      // Small screens: overlay on top of chat
      "absolute right-0 top-0 bottom-0 z-10 shadow-2xl",
      // Large screens: inline alongside chat
      "lg:relative lg:shadow-none lg:z-auto",
      isVisible ? 'translate-x-0' : 'translate-x-full'
    )}>
      {/* Title bar */}
      <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between flex-shrink-0">
        <div>
          <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-0.5">
            Document
          </p>
          <h2 className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100 leading-tight">
            {displayName}
          </h2>
        </div>
        <div className="flex items-center gap-1">
          {isStreaming ? (
            <Loader2 size={15} className="animate-spin text-neutral-400 dark:text-neutral-500 mr-1" />
          ) : (
            <button
              onClick={handleToggleMode}
              className="p-1.5 rounded-md text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              aria-label={isEditMode ? 'Switch to view mode' : 'Switch to edit mode'}
            >
              {isEditMode ? <Eye size={15} /> : <Pencil size={15} />}
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            aria-label="Close document"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Body */}
      {isEditMode ? (
        <textarea
          className="flex-1 w-full px-5 py-4 font-mono text-[13.5px] leading-relaxed text-neutral-800 dark:text-neutral-200 bg-transparent resize-none outline-none placeholder-neutral-300 dark:placeholder-neutral-600"
          value={localContent}
          onChange={handleChange}
          spellCheck={false}
          placeholder="Start writing…"
        />
      ) : (
        <ScrollArea className="flex-1">
          <div className="px-6 py-5 text-[14px] leading-relaxed text-neutral-800 dark:text-neutral-200">
            {!displayContent ? (
              <p className="text-neutral-300 dark:text-neutral-600">Nothing to preview yet.</p>
            ) : isStreaming ? (
              <pre className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed">{displayContent}</pre>
            ) : (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                urlTransform={(url) => url}
                components={{
                  table: ({ children }) => (
                    <div className="overflow-x-auto my-3">
                      <table className="text-[13px] border-collapse w-full">{children}</table>
                    </div>
                  ),
                  thead: ({ children }) => (
                    <thead className="bg-neutral-100 dark:bg-neutral-700">{children}</thead>
                  ),
                  th: ({ children }) => (
                    <th className="border border-neutral-200 dark:border-neutral-600 px-3 py-2 text-left font-semibold text-neutral-700 dark:text-neutral-200">
                      {children}
                    </th>
                  ),
                  td: ({ children }) => (
                    <td className="border border-neutral-200 dark:border-neutral-600 px-3 py-2 text-neutral-600 dark:text-neutral-300">
                      {children}
                    </td>
                  ),
                  tr: ({ children }) => (
                    <tr className="even:bg-neutral-50 dark:even:bg-neutral-700/50">{children}</tr>
                  ),
                  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
                  ul: ({ children }) => (
                    <ul className="mb-3 ml-5 list-disc space-y-1">{children}</ul>
                  ),
                  ol: ({ children }) => (
                    <ol className="mb-3 ml-5 list-decimal space-y-1">{children}</ol>
                  ),
                  li: ({ children }) => <li>{children}</li>,
                  strong: ({ children }) => (
                    <strong className="font-semibold text-neutral-900 dark:text-neutral-100">
                      {children}
                    </strong>
                  ),
                  h1: ({ children }) => (
                    <h1 className="text-[20px] font-bold text-neutral-900 dark:text-neutral-100 mt-4 mb-2">
                      {children}
                    </h1>
                  ),
                  h2: ({ children }) => (
                    <h2 className="text-[17px] font-semibold text-neutral-900 dark:text-neutral-100 mt-4 mb-2">
                      {children}
                    </h2>
                  ),
                  h3: ({ children }) => (
                    <h3 className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100 mt-4 mb-2">
                      {children}
                    </h3>
                  ),
                  code: ({ children }) => (
                    <code className="bg-neutral-200 dark:bg-neutral-700 rounded px-1 py-0.5 text-[13px] font-mono">
                      {children}
                    </code>
                  ),
                  pre: ({ children }) => (
                    <pre className="bg-neutral-100 dark:bg-neutral-800 rounded-lg p-4 overflow-x-auto mb-3 text-[13px] font-mono">
                      {children}
                    </pre>
                  ),
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      className="text-blue-600 dark:text-blue-400 underline"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {children}
                    </a>
                  ),
                  hr: () => (
                    <hr className="border-neutral-200 dark:border-neutral-700 my-4" />
                  ),
                }}
              >
                {displayContent}
              </ReactMarkdown>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
