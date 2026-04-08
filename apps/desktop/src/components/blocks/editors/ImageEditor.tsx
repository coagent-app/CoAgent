import { useState } from 'react'
import type { ImageBlock } from '@coagent/shared'

export function ImageEditor({ block, onCommit }: {
  block: ImageBlock
  onCommit: (next: ImageBlock) => void
}) {
  const [caption, setCaption] = useState(block.caption ?? '')

  const commit = () => {
    if (caption === (block.caption ?? '')) return
    onCommit({ ...block, caption: caption || undefined })
  }

  return (
    <figure className="my-2 space-y-1.5">
      <img
        src={block.src}
        alt={block.alt || ''}
        className="rounded-lg w-full border border-neutral-200 dark:border-neutral-700"
        style={{ maxWidth: block.maxWidth || '100%' }}
      />
      <input
        value={caption}
        onChange={e => setCaption(e.target.value)}
        onBlur={commit}
        placeholder="Add a caption…"
        className="w-full text-[11px] italic text-neutral-500 dark:text-neutral-400 text-center bg-transparent outline-none border-0 focus:ring-0 placeholder:text-neutral-300 dark:placeholder:text-neutral-600"
      />
    </figure>
  )
}
