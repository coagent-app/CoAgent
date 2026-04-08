import { useState, useRef, useEffect } from 'react'
import type { TextBlock } from '@coagent/shared'

export function TextEditor({ block, onCommit }: {
  block: TextBlock
  onCommit: (next: TextBlock) => void
}) {
  const [value, setValue] = useState(block.markdown)
  const ref = useRef<HTMLTextAreaElement>(null)

  // Auto-resize textarea to content height whenever value changes
  useEffect(() => {
    if (!ref.current) return
    ref.current.style.height = 'auto'
    ref.current.style.height = ref.current.scrollHeight + 'px'
  }, [value])

  // Also resize on initial mount
  useEffect(() => {
    if (!ref.current) return
    ref.current.style.height = 'auto'
    ref.current.style.height = ref.current.scrollHeight + 'px'
  }, [])

  const commit = () => {
    if (value === block.markdown) return
    onCommit({ ...block, markdown: value })
  }

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={e => setValue(e.target.value)}
      onBlur={commit}
      placeholder="Write markdown…"
      rows={1}
      className="w-full bg-transparent outline-none border-0 focus:ring-0 font-mono text-[12.5px] text-neutral-800 dark:text-neutral-200 resize-none leading-relaxed placeholder:text-neutral-300 dark:placeholder:text-neutral-600 overflow-hidden"
    />
  )
}
