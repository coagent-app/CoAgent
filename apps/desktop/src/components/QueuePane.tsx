import React from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { ApprovalItem, DoneItem } from '@coagent/shared'

const BADGE_VARIANTS: Record<string, string> = {
  contract: 'bg-violet-50 text-violet-700 border-violet-100',
  analysis: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  cma:      'bg-amber-50 text-amber-700 border-amber-100',
  email:    'bg-sky-50 text-sky-700 border-sky-100',
  other:    'bg-neutral-100 text-neutral-600 border-neutral-200',
}

const BADGE_VARIANTS_DARK: Record<string, string> = {
  contract: 'dark:bg-violet-950 dark:text-violet-300 dark:border-violet-800',
  analysis: 'dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800',
  cma:      'dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800',
  email:    'dark:bg-sky-950 dark:text-sky-300 dark:border-sky-800',
  other:    'dark:bg-neutral-800 dark:text-neutral-300 dark:border-neutral-700',
}

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  return `${Math.floor(secs / 3600)}h ago`
}

interface QueuePaneProps {
  queue: ApprovalItem[]
  done: DoneItem[]
  selectedId: string | null
  onSelect: (item: ApprovalItem) => void
}

export function QueuePane({ queue, done, selectedId, onSelect }: QueuePaneProps) {
  return (
    <div className="w-72 bg-[#F5F5F4] dark:bg-neutral-900 border-r border-neutral-200 dark:border-neutral-800 flex flex-col flex-shrink-0 overflow-hidden">
      <div className="px-4 py-4 border-b border-neutral-200 dark:border-neutral-800">
        <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-1">
          Needs attention
        </p>
        <p className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
          {queue.length === 0 ? 'All clear' : `${queue.length} waiting`}
        </p>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2.5 flex flex-col gap-1.5">
          {queue.map(item => (
            <button
              key={item.id}
              onClick={() => onSelect(item)}
              className={cn(
                'w-full text-left bg-white dark:bg-neutral-900 rounded-xl p-3.5 border transition-all',
                selectedId === item.id
                  ? 'border-neutral-900 dark:border-neutral-400 shadow-sm'
                  : 'border-neutral-100 dark:border-neutral-800 shadow-sm hover:border-neutral-300 dark:hover:border-neutral-600'
              )}
            >
              <span
                className={cn(
                  'inline-block text-[10px] font-semibold uppercase tracking-wider border rounded px-1.5 py-0.5 mb-2',
                  BADGE_VARIANTS[item.type] ?? BADGE_VARIANTS.other,
                  BADGE_VARIANTS_DARK[item.type] ?? BADGE_VARIANTS_DARK.other
                )}
              >
                {item.type}
              </span>
              <p className="text-[13.5px] font-semibold text-neutral-900 dark:text-neutral-100 mb-1 leading-snug">
                {item.title}
              </p>
              <p className="text-[11px] text-neutral-400 dark:text-neutral-500">{timeAgo(item.createdAt)}</p>
            </button>
          ))}

          {done.length > 0 && (
            <>
              <div className="flex items-center gap-2 px-1 py-2">
                <Separator className="flex-1 dark:bg-neutral-800" />
                <span className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest">
                  Done today
                </span>
                <Separator className="flex-1 dark:bg-neutral-800" />
              </div>
              {done.map(item => (
                <div key={item.id} className="flex items-start gap-2 px-1 py-1.5">
                  <span className="text-emerald-500 text-[13px] flex-shrink-0 mt-0.5">&#10003;</span>
                  <span className="text-[12px] text-neutral-500 dark:text-neutral-400 leading-relaxed">{item.description}</span>
                </div>
              ))}
            </>
          )}

          {queue.length === 0 && done.length === 0 && (
            <p className="text-[13px] text-neutral-400 dark:text-neutral-500 px-1 py-6">
              Nothing yet. Co-Agent is watching.
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
