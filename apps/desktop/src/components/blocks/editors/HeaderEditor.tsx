import { useState } from 'react'
import type { HeaderBlock } from '@coagent/shared'

export function HeaderEditor({ block, onCommit }: {
  block: HeaderBlock
  onCommit: (next: HeaderBlock) => void
}) {
  const [title, setTitle] = useState(block.title)
  const [subtitle, setSubtitle] = useState(block.subtitle ?? '')
  const [eyebrow, setEyebrow] = useState(block.eyebrow ?? '')

  const commit = () => {
    if (
      title === block.title &&
      subtitle === (block.subtitle ?? '') &&
      eyebrow === (block.eyebrow ?? '')
    ) return
    onCommit({
      ...block,
      title,
      subtitle: subtitle || undefined,
      eyebrow: eyebrow || undefined,
    })
  }

  return (
    <div className="pb-4 border-b space-y-1" style={{ borderColor: 'var(--canvas-primary-soft)' }}>
      {/* eyebrow */}
      <input
        value={eyebrow}
        onChange={e => setEyebrow(e.target.value)}
        onBlur={commit}
        placeholder="Eyebrow"
        className="text-[10.5px] font-semibold tracking-[0.12em] uppercase bg-transparent outline-none w-full border-0 focus:ring-0 placeholder:text-neutral-300 dark:placeholder:text-neutral-600"
        style={{ color: eyebrow ? 'var(--canvas-primary)' : undefined }}
      />
      {/* title */}
      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        onBlur={commit}
        placeholder="Title"
        className="text-[26px] font-bold text-neutral-900 dark:text-neutral-50 leading-tight bg-transparent outline-none w-full border-0 focus:ring-0 placeholder:text-neutral-300 dark:placeholder:text-neutral-600"
      />
      {/* subtitle */}
      <input
        value={subtitle}
        onChange={e => setSubtitle(e.target.value)}
        onBlur={commit}
        placeholder="Subtitle"
        className="text-[13.5px] text-neutral-500 dark:text-neutral-400 bg-transparent outline-none w-full border-0 focus:ring-0 placeholder:text-neutral-300 dark:placeholder:text-neutral-600"
      />
    </div>
  )
}
