import React, { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { BADGE_VARIANTS, BADGE_VARIANTS_DARK } from '@/lib/badge-variants'
import { markdownComponents } from '@/lib/markdown-components'
import type { ApprovalItem } from '@coagent/shared'

interface DetailPaneProps {
  item: ApprovalItem | null
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onEdit: (id: string, newDetail: string) => void
}

export function DetailPane({ item, onApprove, onReject, onEdit }: DetailPaneProps) {
  const [editMode, setEditMode] = useState(false)
  const [draftDetail, setDraftDetail] = useState('')

  // Reset edit state whenever the selected item changes
  useEffect(() => {
    setEditMode(false)
    setDraftDetail(item?.detail ?? '')
  }, [item?.id])

  if (!item) {
    return (
      <div className="flex-1 bg-white dark:bg-neutral-950 flex items-center justify-center">
        <p className="text-[14px] text-neutral-400 dark:text-neutral-500">Select an item from the queue to review it.</p>
      </div>
    )
  }

  function handleEditClick() {
    setDraftDetail(item!.detail ?? '')
    setEditMode(true)
  }

  function handleSave() {
    onEdit(item!.id, draftDetail)
    setEditMode(false)
  }

  function handleCancel() {
    setEditMode(false)
    setDraftDetail(item!.detail ?? '')
  }

  return (
    <div className="flex-1 bg-white dark:bg-neutral-950 flex flex-col overflow-hidden">
      <div className="px-7 py-5 border-b border-neutral-100 dark:border-neutral-800">
        <span
          className={cn(
            'inline-block text-[10px] font-semibold uppercase tracking-wider border rounded px-1.5 py-0.5 mb-3',
            BADGE_VARIANTS[item.type] ?? BADGE_VARIANTS.other,
            BADGE_VARIANTS_DARK[item.type] ?? BADGE_VARIANTS_DARK.other
          )}
        >
          {item.type}
        </span>
        <h1 className="text-[22px] font-bold tracking-tight text-neutral-900 dark:text-neutral-100 leading-tight">
          {item.title}
        </h1>
        <p className="text-[13px] text-neutral-500 dark:text-neutral-400 mt-1">{item.description}</p>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-7 py-5 flex flex-col gap-5">
          {item.metadata && Object.keys(item.metadata).length > 0 && (
            <>
              <div className="flex flex-wrap gap-x-7 gap-y-3">
                {Object.entries(item.metadata).map(([key, val]) => (
                  <div key={key}>
                    <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-0.5">
                      {key}
                    </p>
                    <p className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-100">{val}</p>
                  </div>
                ))}
              </div>
              <Separator className="dark:bg-neutral-800" />
            </>
          )}

          {item.detail && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">
                  Detail
                </p>
                {!editMode && (
                  <button
                    onClick={handleEditClick}
                    className="text-[10px] font-medium text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 transition-colors px-1.5 py-0.5 rounded border border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600 leading-none"
                  >
                    Edit
                  </button>
                )}
              </div>

              {editMode ? (
                <div className="flex flex-col gap-2">
                  <textarea
                    value={draftDetail}
                    onChange={e => setDraftDetail(e.target.value)}
                    rows={12}
                    style={{ fontFamily: 'monospace', fontSize: '12.5px' }}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-[#F7F7F5] dark:bg-neutral-800 px-3.5 py-3 text-neutral-700 dark:text-neutral-100 leading-relaxed resize-y focus:outline-none focus:border-neutral-400 dark:focus:border-neutral-500 focus:ring-1 focus:ring-neutral-300 dark:focus:ring-neutral-600 dark:placeholder-neutral-500"
                  />
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={handleSave}>
                      Save
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleCancel} className="text-neutral-500 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800">
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="bg-[#F7F7F5] dark:bg-neutral-900 border border-neutral-100 dark:border-neutral-800 rounded-lg px-4 py-3.5 text-[13px] text-neutral-600 dark:text-neutral-300 leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {item.detail}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          )}

          {item.notes && (
            <div>
              <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-2">
                Co-Agent notes
              </p>
              <div className="bg-[#F7F7F5] dark:bg-neutral-900 border border-neutral-100 dark:border-neutral-800 rounded-lg px-4 py-3.5 text-[13px] text-neutral-600 dark:text-neutral-300 leading-relaxed">
                {item.notes}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="px-7 py-4 border-t border-neutral-100 dark:border-neutral-800 flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onReject(item.id)}
          className="text-red-600 border-red-100 hover:bg-red-50 hover:text-red-700 hover:border-red-200 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950 dark:hover:text-red-300 dark:hover:border-red-800"
        >
          Reject
        </Button>
        <div className="flex-1" />
        <Button size="sm" onClick={() => onApprove(item.id)}>
          {item.action || 'Approve'} &rarr;
        </Button>
      </div>
    </div>
  )
}
