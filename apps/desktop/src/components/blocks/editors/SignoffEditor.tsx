import { useState } from 'react'
import type { SignoffBlock } from '@coagent/shared'

export function SignoffEditor({ block, onCommit }: {
  block: SignoffBlock
  onCommit: (next: SignoffBlock) => void
}) {
  const [name, setName] = useState(block.name)
  const [title, setTitle] = useState(block.title ?? '')
  const [date, setDate] = useState(block.date ?? '')

  const commit = () => {
    if (
      name === block.name &&
      title === (block.title ?? '') &&
      date === (block.date ?? '')
    ) return
    onCommit({
      ...block,
      name,
      title: title || undefined,
      date: date || undefined,
    })
  }

  return (
    <div className="pt-6 border-t space-y-1" style={{ borderColor: 'var(--canvas-primary-soft)' }}>
      {block.signatureDataUri && (
        <img src={block.signatureDataUri} alt="Signature" className="h-14 mb-2" />
      )}
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        onBlur={commit}
        placeholder="Name"
        className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-50 bg-transparent outline-none w-full border-0 focus:ring-0 placeholder:text-neutral-300 dark:placeholder:text-neutral-600"
      />
      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        onBlur={commit}
        placeholder="Title"
        className="text-[12px] text-neutral-500 dark:text-neutral-400 bg-transparent outline-none w-full border-0 focus:ring-0 placeholder:text-neutral-300 dark:placeholder:text-neutral-600"
      />
      <input
        value={date}
        onChange={e => setDate(e.target.value)}
        onBlur={commit}
        placeholder="Date"
        className="text-[11px] text-neutral-400 dark:text-neutral-500 bg-transparent outline-none w-full border-0 focus:ring-0 placeholder:text-neutral-300 dark:placeholder:text-neutral-600"
      />
    </div>
  )
}
