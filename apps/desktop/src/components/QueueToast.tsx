import React, { useEffect, useState } from 'react'
import { Inbox } from 'lucide-react'
import type { ApprovalItem } from '@coagent/shared'

interface QueueToastProps {
  items: ApprovalItem[]
  onReview: () => void
  onDismiss: () => void
}

export function QueueToast({ items, onReview, onDismiss }: QueueToastProps) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Animate in
    requestAnimationFrame(() => setVisible(true))
  }, [])

  if (items.length === 0) return null

  const label = items.length === 1
    ? items[0].title
    : `${items.length} items need your approval`

  return (
    <div
      className={`absolute bottom-20 left-1/2 -translate-x-1/2 z-40 transition-all duration-300 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}
    >
      <div className="flex items-center gap-3 bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 rounded-xl px-4 py-2.5 shadow-lg">
        <Inbox size={15} className="flex-shrink-0" />
        <span className="text-[13px] font-medium truncate max-w-[260px]">{label}</span>
        <button
          onClick={onReview}
          className="text-[12px] font-semibold px-2.5 py-1 rounded-md bg-white/20 dark:bg-black/10 hover:bg-white/30 dark:hover:bg-black/20 transition-colors whitespace-nowrap"
        >
          Review
        </button>
        <button
          onClick={onDismiss}
          className="text-white/50 dark:text-neutral-400 hover:text-white dark:hover:text-neutral-900 transition-colors text-[16px] leading-none"
        >
          &times;
        </button>
      </div>
    </div>
  )
}
