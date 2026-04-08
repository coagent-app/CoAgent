import { useState } from 'react'
import type { FooterBlock } from '@coagent/shared'

export function FooterEditor({ block, onCommit }: {
  block: FooterBlock
  onCommit: (next: FooterBlock) => void
}) {
  const [note, setNote] = useState(block.note ?? '')

  const commit = () => {
    if (note === (block.note ?? '')) return
    onCommit({ ...block, note: note || undefined })
  }

  return (
    <div className="pt-4 mt-2 border-t" style={{ borderColor: 'var(--canvas-primary-soft)' }}>
      <input
        value={note}
        onChange={e => setNote(e.target.value)}
        onBlur={commit}
        placeholder="Footer note (leave blank for default)"
        className="w-full text-center text-[10.5px] text-neutral-400 dark:text-neutral-500 bg-transparent outline-none border-0 focus:ring-0 placeholder:text-neutral-300 dark:placeholder:text-neutral-600"
      />
    </div>
  )
}
