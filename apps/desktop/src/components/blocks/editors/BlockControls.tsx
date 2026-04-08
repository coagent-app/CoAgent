import { ArrowUp, ArrowDown, Copy, Trash2 } from 'lucide-react'

export function BlockControls({ onMoveUp, onMoveDown, onDuplicate, onDelete, visible }: {
  onMoveUp?: () => void     // undefined when block is at top
  onMoveDown?: () => void   // undefined when block is at bottom
  onDuplicate: () => void
  onDelete: () => void
  visible: boolean
}) {
  if (!visible) return null

  return (
    <div className="absolute -top-3 right-2 flex items-center gap-0.5 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-sm p-0.5 z-10">
      <button
        onClick={onMoveUp}
        disabled={!onMoveUp}
        className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-30 disabled:cursor-not-allowed text-neutral-600 dark:text-neutral-400 transition-colors"
        title="Move up"
        aria-label="Move block up"
      >
        <ArrowUp size={12} />
      </button>
      <button
        onClick={onMoveDown}
        disabled={!onMoveDown}
        className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-30 disabled:cursor-not-allowed text-neutral-600 dark:text-neutral-400 transition-colors"
        title="Move down"
        aria-label="Move block down"
      >
        <ArrowDown size={12} />
      </button>
      <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-700 mx-0.5" />
      <button
        onClick={onDuplicate}
        className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-600 dark:text-neutral-400 transition-colors"
        title="Duplicate"
        aria-label="Duplicate block"
      >
        <Copy size={12} />
      </button>
      <button
        onClick={onDelete}
        className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-neutral-600 dark:text-neutral-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
        title="Delete"
        aria-label="Delete block"
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
}
