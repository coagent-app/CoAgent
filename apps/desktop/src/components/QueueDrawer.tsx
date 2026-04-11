import React, { useState, useEffect } from 'react'
import { X, CheckCheck, XCircle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { ApprovalItem } from '@coagent/shared'

const BADGE_VARIANTS: Record<string, string> = {
  contract: 'bg-violet-50 text-violet-700 border-violet-100 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-800',
  analysis: 'bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800',
  cma:      'bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800',
  email:    'bg-sky-50 text-sky-700 border-sky-100 dark:bg-sky-950 dark:text-sky-300 dark:border-sky-800',
  task:     'bg-violet-50 text-violet-700 border-violet-100 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-800',
  message:  'bg-sky-50 text-sky-700 border-sky-100 dark:bg-sky-950 dark:text-sky-300 dark:border-sky-800',
  request:  'bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800',
  other:    'bg-neutral-100 text-neutral-600 border-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:border-neutral-700',
}

const markdownComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  h1: ({ children }) => <h1 style={{ fontSize: '1em', fontWeight: 700, marginBottom: '0.4em', marginTop: '0.75em' }}>{children}</h1>,
  h2: ({ children }) => <h2 style={{ fontSize: '1em', fontWeight: 600, marginBottom: '0.35em', marginTop: '0.75em' }}>{children}</h2>,
  h3: ({ children }) => <h3 style={{ fontSize: '1em', fontWeight: 600, marginBottom: '0.3em', marginTop: '0.6em' }}>{children}</h3>,
  p: ({ children }) => <p style={{ marginBottom: '0.5em', lineHeight: '1.6' }}>{children}</p>,
  strong: ({ children }) => <strong style={{ fontWeight: 600 }}>{children}</strong>,
  em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
  ul: ({ children }) => <ul style={{ paddingLeft: '1.25em', marginBottom: '0.5em', listStyleType: 'disc' }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ paddingLeft: '1.25em', marginBottom: '0.5em', listStyleType: 'decimal' }}>{children}</ol>,
  li: ({ children }) => <li style={{ marginBottom: '0.2em', lineHeight: '1.6' }}>{children}</li>,
  hr: ({}) => <hr className="border-none border-t border-neutral-200 dark:border-neutral-700 my-3" />,
  code: ({ children, className }) => {
    const isBlock = className?.startsWith('language-')
    if (isBlock) {
      return (
        <pre className="bg-neutral-100 dark:bg-neutral-800 rounded px-3 py-2.5 overflow-x-auto mb-2" style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>
          <code>{children}</code>
        </pre>
      )
    }
    return <code className="bg-neutral-100 dark:bg-neutral-800 rounded px-1" style={{ fontFamily: 'monospace', fontSize: '0.85em', padding: '0 0.3em' }}>{children}</code>
  },
  blockquote: ({ children }) => (
    <blockquote className="border-l-[3px] border-neutral-300 dark:border-neutral-600 pl-3 text-neutral-500 dark:text-neutral-400 my-2">{children}</blockquote>
  ),
}

interface QueueDrawerProps {
  open: boolean
  queue: ApprovalItem[]
  onClose: () => void
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onApproveAll: () => void
  onRejectAll: () => void
  onEdit: (id: string, newDetail: string) => void
}

export function QueueDrawer({ open, queue, onClose, onApprove, onReject, onApproveAll, onRejectAll, onEdit }: QueueDrawerProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftDetail, setDraftDetail] = useState('')

  const pending = queue.filter(i => i.status === 'pending')

  // Auto-expand the single item, or first item of batch
  useEffect(() => {
    if (pending.length === 1) {
      setExpandedId(pending[0].id)
    } else if (pending.length > 0 && !expandedId) {
      setExpandedId(pending[0].id)
    }
  }, [pending.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close drawer when queue empties
  useEffect(() => {
    if (pending.length === 0 && open) onClose()
  }, [pending.length, open]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleEdit(item: ApprovalItem) {
    setDraftDetail(item.detail ?? '')
    setEditingId(item.id)
  }

  function handleSave(id: string) {
    onEdit(id, draftDetail)
    setEditingId(null)
  }

  if (!open) return null

  return (
      <div
        className="w-[540px] min-w-[540px] flex-shrink-0 bg-white dark:bg-neutral-950 border-l border-neutral-200 dark:border-neutral-800 flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100 dark:border-neutral-800">
          <h2 className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">
            {pending.length === 1 ? 'Review' : `${pending.length} items to review`}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            <X size={16} className="text-neutral-400" />
          </button>
        </div>

        {/* Batch controls — only show when 2+ items */}
        {pending.length > 1 && (
          <div className="flex items-center gap-2 px-5 py-3 border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900">
            <Button size="sm" onClick={onApproveAll} className="gap-1.5">
              <CheckCheck size={14} />
              Approve all
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onRejectAll}
              className="gap-1.5 text-red-600 border-red-100 hover:bg-red-50 hover:text-red-700 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
            >
              <XCircle size={14} />
              Reject all
            </Button>
          </div>
        )}

        {/* Items */}
        <ScrollArea className="flex-1">
          <div className="flex flex-col">
            {pending.map((item, idx) => {
              const isExpanded = expandedId === item.id
              const isEditing = editingId === item.id

              return (
                <div key={item.id}>
                  {idx > 0 && <Separator className="dark:bg-neutral-800" />}

                  {/* Item header — clickable to expand in batch mode */}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : item.id)}
                    className={cn(
                      'w-full text-left px-5 py-3.5 transition-colors',
                      isExpanded ? 'bg-white dark:bg-neutral-950' : 'hover:bg-neutral-50 dark:hover:bg-neutral-900'
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={cn(
                          'inline-block text-[10px] font-semibold uppercase tracking-wider border rounded px-1.5 py-0.5 mt-0.5 flex-shrink-0',
                          BADGE_VARIANTS[item.type] ?? BADGE_VARIANTS.other
                        )}
                      >
                        {item.type}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13.5px] font-semibold text-neutral-900 dark:text-neutral-100 leading-snug break-words">
                          {item.title}
                        </p>
                        <p className="text-[12px] text-neutral-500 dark:text-neutral-400 mt-0.5 break-words">
                          {item.description}
                        </p>
                      </div>
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="px-5 pb-4">
                      {/* Metadata */}
                      {Object.keys(item.metadata).length > 0 && (
                        <div className="flex flex-wrap gap-x-5 gap-y-2 mb-3">
                          {Object.entries(item.metadata).map(([key, val]) => (
                            <div key={key}>
                              <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-0.5">
                                {key}
                              </p>
                              <p className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100 break-words">{val}</p>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Detail content */}
                      {item.detail && (
                        <div className="mb-3">
                          <div className="flex items-center gap-2 mb-1.5">
                            <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">Detail</p>
                            {!isEditing && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleEdit(item) }}
                                className="text-[10px] font-medium text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 transition-colors px-1.5 py-0.5 rounded border border-neutral-200 dark:border-neutral-700 leading-none"
                              >
                                Edit
                              </button>
                            )}
                          </div>

                          {isEditing ? (
                            <div className="flex flex-col gap-2">
                              <textarea
                                value={draftDetail}
                                onChange={e => setDraftDetail(e.target.value)}
                                rows={8}
                                style={{ fontFamily: 'monospace', fontSize: '12.5px' }}
                                className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 px-3 py-2.5 text-neutral-700 dark:text-neutral-100 leading-relaxed resize-y focus:outline-none focus:border-neutral-400 dark:focus:border-neutral-500"
                              />
                              <div className="flex gap-2">
                                <Button size="sm" onClick={() => handleSave(item.id)}>Save</Button>
                                <Button variant="outline" size="sm" onClick={() => setEditingId(null)} className="dark:border-neutral-700 dark:text-neutral-400">Cancel</Button>
                              </div>
                            </div>
                          ) : (
                            <div className="bg-neutral-50 dark:bg-neutral-900 border border-neutral-100 dark:border-neutral-800 rounded-lg px-3.5 py-3 text-[13px] text-neutral-600 dark:text-neutral-300 leading-relaxed break-words overflow-hidden">
                              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                                {item.detail}
                              </ReactMarkdown>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Notes */}
                      {item.notes && (
                        <div className="mb-3">
                          <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-1.5">Co-Agent notes</p>
                          <div className="bg-neutral-50 dark:bg-neutral-900 border border-neutral-100 dark:border-neutral-800 rounded-lg px-3.5 py-3 text-[13px] text-neutral-600 dark:text-neutral-300 leading-relaxed">
                            {item.notes}
                          </div>
                        </div>
                      )}

                      {/* Action buttons */}
                      <div className="flex items-center gap-3 pt-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onReject(item.id)}
                          className="text-red-600 border-red-100 hover:bg-red-50 hover:text-red-700 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                        >
                          Reject
                        </Button>
                        <div className="flex-1" />
                        <Button size="sm" onClick={() => onApprove(item.id)}>
                          {item.action || 'Approve'} &rarr;
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </div>
  )
}
