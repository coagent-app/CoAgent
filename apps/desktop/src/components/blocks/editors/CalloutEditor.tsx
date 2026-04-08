import { useState, useRef, useEffect } from 'react'
import type { CalloutBlock, CalloutVariant } from '@coagent/shared'

const VARIANTS: CalloutVariant[] = ['info', 'warn', 'success', 'tip']

const VARIANT_STYLES: Record<CalloutVariant, { bg: string; border: string; label: string }> = {
  info:    { bg: 'bg-blue-50 dark:bg-blue-950/30',       border: 'border-blue-200 dark:border-blue-800',     label: 'Info'    },
  warn:    { bg: 'bg-amber-50 dark:bg-amber-950/30',     border: 'border-amber-200 dark:border-amber-800',   label: 'Warning' },
  success: { bg: 'bg-emerald-50 dark:bg-emerald-950/30', border: 'border-emerald-200 dark:border-emerald-800', label: 'Success' },
  tip:     { bg: 'bg-violet-50 dark:bg-violet-950/30',   border: 'border-violet-200 dark:border-violet-800', label: 'Tip'     },
}

export function CalloutEditor({ block, onCommit }: {
  block: CalloutBlock
  onCommit: (next: CalloutBlock) => void
}) {
  const [variant, setVariant] = useState<CalloutVariant>(block.variant)
  const [title, setTitle] = useState(block.title ?? '')
  const [markdown, setMarkdown] = useState(block.markdown)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize the markdown textarea
  useEffect(() => {
    if (!textareaRef.current) return
    textareaRef.current.style.height = 'auto'
    textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px'
  }, [markdown])

  useEffect(() => {
    if (!textareaRef.current) return
    textareaRef.current.style.height = 'auto'
    textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px'
  }, [])

  const commit = (
    v: CalloutVariant = variant,
    t: string = title,
    m: string = markdown,
  ) => {
    if (v === block.variant && t === (block.title ?? '') && m === block.markdown) return
    onCommit({ ...block, variant: v, title: t || undefined, markdown: m })
  }

  const handleVariantChange = (v: CalloutVariant) => {
    setVariant(v)
    commit(v, title, markdown)
  }

  const style = VARIANT_STYLES[variant]

  return (
    <div className={`rounded-lg border px-4 py-3.5 space-y-2 ${style.bg} ${style.border}`}>
      {/* Variant selector */}
      <select
        value={variant}
        onChange={e => handleVariantChange(e.target.value as CalloutVariant)}
        className="text-[10.5px] font-semibold uppercase tracking-wide bg-transparent outline-none border-0 focus:ring-0 cursor-pointer text-neutral-600 dark:text-neutral-400"
      >
        {VARIANTS.map(v => (
          <option key={v} value={v}>{VARIANT_STYLES[v].label}</option>
        ))}
      </select>
      {/* Title */}
      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        onBlur={() => commit()}
        placeholder="Title (optional)"
        className="w-full font-semibold text-[13px] text-neutral-900 dark:text-neutral-50 bg-transparent outline-none border-0 focus:ring-0 leading-tight placeholder:text-neutral-400 dark:placeholder:text-neutral-600"
      />
      {/* Markdown body */}
      <textarea
        ref={textareaRef}
        value={markdown}
        onChange={e => setMarkdown(e.target.value)}
        onBlur={() => commit()}
        placeholder="Write markdown…"
        rows={1}
        className="w-full bg-transparent outline-none border-0 focus:ring-0 font-mono text-[12.5px] text-neutral-700 dark:text-neutral-200 resize-none leading-relaxed overflow-hidden placeholder:text-neutral-400 dark:placeholder:text-neutral-600"
      />
    </div>
  )
}
