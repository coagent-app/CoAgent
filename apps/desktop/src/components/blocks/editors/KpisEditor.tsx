import { useState } from 'react'
import type { KpisBlock, KpiItem } from '@coagent/shared'
import { X, Plus } from 'lucide-react'

export function KpisEditor({ block, onCommit }: {
  block: KpisBlock
  onCommit: (next: KpisBlock) => void
}) {
  const [items, setItems] = useState<KpiItem[]>(block.items)

  const update = (next: KpiItem[]) => {
    setItems(next)
    onCommit({ ...block, items: next })
  }

  const updateItem = (i: number, patch: Partial<KpiItem>) => {
    update(items.map((it, idx) => idx === i ? { ...it, ...patch } : it))
  }

  const addItem = () => update([...items, { label: 'New', value: '0' }])

  const removeItem = (i: number) => update(items.filter((_, idx) => idx !== i))

  const colCount = Math.min(Math.max(1, items.length + 1), 6)

  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))` }}
    >
      {items.map((item, i) => (
        <div
          key={i}
          className="relative rounded-lg px-3 py-2 border flex flex-col group"
          style={{ borderColor: 'var(--canvas-primary-soft)', background: 'var(--canvas-primary-bg)' }}
        >
          {/* Remove button */}
          <button
            onClick={() => removeItem(i)}
            className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-500 transition-opacity"
            aria-label="Remove KPI"
          >
            <X size={11} />
          </button>
          {/* Label */}
          <input
            value={item.label}
            onChange={e => updateItem(i, { label: e.target.value })}
            placeholder="Label"
            className="text-[10.5px] uppercase tracking-wide font-semibold text-neutral-500 dark:text-neutral-400 bg-transparent outline-none border-0 focus:ring-0 w-full truncate placeholder:text-neutral-300"
          />
          {/* Value */}
          <input
            value={item.value}
            onChange={e => updateItem(i, { value: e.target.value })}
            placeholder="Value"
            className="text-[22px] font-bold text-neutral-900 dark:text-neutral-50 leading-tight bg-transparent outline-none border-0 focus:ring-0 w-full break-words placeholder:text-neutral-300"
          />
          {/* Delta */}
          <input
            value={item.delta ?? ''}
            onChange={e => updateItem(i, { delta: e.target.value || undefined })}
            placeholder="Δ change"
            className="text-[11px] font-medium text-neutral-500 bg-transparent outline-none border-0 focus:ring-0 w-full placeholder:text-neutral-300"
          />
        </div>
      ))}
      {/* Add KPI button */}
      <button
        onClick={addItem}
        className="flex items-center justify-center gap-1 rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 p-3 text-[11px] text-neutral-500 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors min-h-[72px]"
      >
        <Plus size={12} /> Add KPI
      </button>
    </div>
  )
}
