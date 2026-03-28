import React, { useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Capability {
  name: string
  description: string
  checked: boolean
}

interface CapabilityCardProps {
  name: string
  capabilities: Capability[]
  onConfirm: (selected: string[]) => void
}

export function CapabilityCard({ name, capabilities, onConfirm }: CapabilityCardProps) {
  const [items, setItems] = useState(capabilities)
  const [confirmed, setConfirmed] = useState(false)

  function toggle(idx: number) {
    if (confirmed) return
    setItems(prev => prev.map((item, i) => i === idx ? { ...item, checked: !item.checked } : item))
  }

  function handleConfirm() {
    const selected = items.filter(i => i.checked).map(i => i.name)
    if (selected.length === 0) return
    setConfirmed(true)
    onConfirm(selected)
  }

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 p-4 max-w-md">
      <p className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-200 mb-3">
        Set up {name} — select capabilities:
      </p>
      <div className="flex flex-col gap-1.5 mb-4">
        {items.map((cap, i) => (
          <button
            key={cap.name}
            type="button"
            onClick={() => toggle(i)}
            disabled={confirmed}
            className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors',
              cap.checked
                ? 'bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800'
                : 'bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700',
              !confirmed && 'hover:border-neutral-300 dark:hover:border-neutral-600'
            )}
          >
            <div className={cn(
              'w-4 h-4 rounded border flex items-center justify-center flex-shrink-0',
              cap.checked
                ? 'bg-emerald-500 border-emerald-500'
                : 'border-neutral-300 dark:border-neutral-600'
            )}>
              {cap.checked && <Check size={10} className="text-white" strokeWidth={3} />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">{cap.name}</p>
              <p className="text-[11px] text-neutral-400 dark:text-neutral-500">{cap.description}</p>
            </div>
          </button>
        ))}
      </div>
      {!confirmed ? (
        <button
          type="button"
          onClick={handleConfirm}
          disabled={items.every(i => !i.checked)}
          className="text-[13px] font-medium px-4 py-2 rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Confirm
        </button>
      ) : (
        <p className="text-[12px] text-emerald-500 font-medium">Confirmed — building integration...</p>
      )}
    </div>
  )
}
