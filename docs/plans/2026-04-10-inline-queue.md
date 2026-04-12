# Inline Queue Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Surface queue items inline in the chat view via toasts and a slide-over drawer, so users never leave chat to approve/reject items.

**Architecture:** When new queue items arrive while the user is in the chat view, a toast notification appears at the bottom of the chat area. Clicking it (or the sidebar badge) opens a right-side drawer overlay that shows item details with approve/reject/edit controls. Batch queued items show as a stack with "Approve all" / "Reject all". The full-page Queue view in the sidebar remains as a fallback.

**Tech Stack:** React, Tailwind CSS, CSS transitions (no animation library), existing shadcn/ui components (Button, ScrollArea, Separator, Badge).

---

### Task 1: Track new queue items in useAgent hook

**Files:**
- Modify: `apps/desktop/src/hooks/useAgent.ts`

**Step 1: Add state for new-item tracking**

In the `useAgent` hook, add state to track items that arrived since the user last dismissed them. This drives the toast.

Add after the existing `const [queue, setQueue]` and `const [done, setDone]` lines:

```typescript
const [newQueueIds, setNewQueueIds] = useState<Set<string>>(new Set())
```

**Step 2: Update the queue_update handler to detect new items**

Replace the existing `if (msg.type === 'queue_update') setQueue(msg.items)` line with:

```typescript
if (msg.type === 'queue_update') {
  setQueue(prev => {
    const prevIds = new Set(prev.map(i => i.id))
    const fresh = msg.items.filter(i => i.status === 'pending' && !prevIds.has(i.id))
    if (fresh.length > 0) {
      setNewQueueIds(old => {
        const next = new Set(old)
        fresh.forEach(i => next.add(i.id))
        return next
      })
    }
    return msg.items
  })
}
```

**Step 3: Add a dismiss function**

Add a `dismissQueueToast` callback that clears the new-item set:

```typescript
const dismissQueueToast = useCallback(() => setNewQueueIds(new Set()), [])
```

**Step 4: Expose new state from the hook**

Add `newQueueIds` and `dismissQueueToast` to the return object of `useAgent`.

**Step 5: Verify build**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && pnpm tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: 0 errors

---

### Task 2: Create QueueToast component

**Files:**
- Create: `apps/desktop/src/components/QueueToast.tsx`

**Step 1: Build the toast component**

This is a small bar that appears at the bottom of the chat area. It shows how many items need attention and a "Review" button to open the drawer.

```tsx
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
```

**Step 2: Verify build**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && pnpm tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: 0 errors

---

### Task 3: Create QueueDrawer component (single + batch)

**Files:**
- Create: `apps/desktop/src/components/QueueDrawer.tsx`

**Step 1: Build the drawer**

A right-side slide-over panel. Shows a single item's full details when only one is pending, or a scrollable list with batch controls when multiple are pending. Reuses the same markdown rendering and badge styling from DetailPane.

```tsx
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
  other:    'bg-neutral-100 text-neutral-600 border-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:border-neutral-700',
}

const markdownComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  p: ({ children }) => <p style={{ marginBottom: '0.5em', lineHeight: '1.6' }}>{children}</p>,
  strong: ({ children }) => <strong style={{ fontWeight: 600 }}>{children}</strong>,
  ul: ({ children }) => <ul style={{ paddingLeft: '1.25em', marginBottom: '0.5em', listStyleType: 'disc' }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ paddingLeft: '1.25em', marginBottom: '0.5em', listStyleType: 'decimal' }}>{children}</ol>,
  li: ({ children }) => <li style={{ marginBottom: '0.2em', lineHeight: '1.6' }}>{children}</li>,
  code: ({ children, className }) => {
    const isBlock = className?.startsWith('language-')
    if (isBlock) {
      return (
        <pre className="bg-neutral-100 dark:bg-neutral-800 rounded px-3 py-2.5 overflow-x-auto mb-2" style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>
          <code>{children}</code>
        </pre>
      )
    }
    return <code className="bg-neutral-100 dark:bg-neutral-800 rounded px-1" style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>{children}</code>
  },
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

  // Auto-expand the single item, or first item of batch
  useEffect(() => {
    if (queue.length === 1) setExpandedId(queue[0].id)
    else if (queue.length > 0 && !expandedId) setExpandedId(queue[0].id)
  }, [queue.length])

  // Close drawer when queue empties
  useEffect(() => {
    if (queue.length === 0 && open) onClose()
  }, [queue.length, open])

  const pending = queue.filter(i => i.status === 'pending')

  function handleEdit(item: ApprovalItem) {
    setDraftDetail(item.detail ?? '')
    setEditingId(item.id)
  }

  function handleSave(id: string) {
    onEdit(id, draftDetail)
    setEditingId(null)
  }

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/20 dark:bg-black/40 transition-opacity"
          onClick={onClose}
        />
      )}

      {/* Drawer panel */}
      <div
        className={cn(
          'fixed top-0 right-0 z-50 h-full w-[420px] max-w-[90vw] bg-white dark:bg-neutral-950 shadow-2xl flex flex-col transition-transform duration-300 ease-out',
          open ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100 dark:border-neutral-800">
          <div>
            <h2 className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">
              {pending.length === 1 ? 'Review' : `${pending.length} items to review`}
            </h2>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors">
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
                        <p className="text-[13.5px] font-semibold text-neutral-900 dark:text-neutral-100 leading-snug truncate">
                          {item.title}
                        </p>
                        <p className="text-[12px] text-neutral-500 dark:text-neutral-400 mt-0.5 truncate">
                          {item.description}
                        </p>
                      </div>
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="px-5 pb-4">
                      {/* Metadata */}
                      {item.metadata && Object.keys(item.metadata).length > 0 && (
                        <div className="flex flex-wrap gap-x-5 gap-y-2 mb-3">
                          {Object.entries(item.metadata).map(([key, val]) => (
                            <div key={key}>
                              <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-0.5">
                                {key}
                              </p>
                              <p className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">{val}</p>
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
                            <div className="bg-neutral-50 dark:bg-neutral-900 border border-neutral-100 dark:border-neutral-800 rounded-lg px-3.5 py-3 text-[13px] text-neutral-600 dark:text-neutral-300 leading-relaxed">
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
    </>
  )
}
```

**Step 2: Verify build**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && pnpm tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: 0 errors

---

### Task 4: Wire QueueToast + QueueDrawer into App.tsx

**Files:**
- Modify: `apps/desktop/src/App.tsx`

**Step 1: Add imports**

Add at the top of App.tsx:

```typescript
import { QueueToast } from '@/components/QueueToast'
import { QueueDrawer } from '@/components/QueueDrawer'
```

**Step 2: Add drawer state**

After the existing `const [tourDone, setTourDone]` line, add:

```typescript
const [drawerOpen, setDrawerOpen] = useState(false)
```

**Step 3: Extract new queue tracking from useAgent**

Add `newQueueIds` and `dismissQueueToast` to the destructured useAgent return.

**Step 4: Compute new items for the toast**

After the `setSelectedItem` callback, add:

```typescript
const newQueueItems = useMemo(() => queue.filter(i => newQueueIds.has(i.id) && i.status === 'pending'), [queue, newQueueIds])
```

(Import `useMemo` — already imported in App.tsx header? Check and add if needed.)

**Step 5: Add batch approve/reject handlers**

After `handleReject`, add:

```typescript
function handleApproveAll() {
  queue.filter(i => i.status === 'pending').forEach(i => approve(i.id))
  setDrawerOpen(false)
}

function handleRejectAll() {
  queue.filter(i => i.status === 'pending').forEach(i => reject(i.id))
  setDrawerOpen(false)
}
```

**Step 6: Update handleApprove and handleReject to work with drawer**

Modify the existing `handleApprove` and `handleReject` to also dismiss from newQueueIds:

```typescript
function handleApprove(id: string) {
  approve(id)
  setSelectedItemId(null)
  setNewQueueIds(prev => { const next = new Set(prev); next.delete(id); return next })
}

function handleReject(id: string) {
  reject(id)
  setSelectedItemId(null)
  setNewQueueIds(prev => { const next = new Set(prev); next.delete(id); return next })
}
```

Wait — `setNewQueueIds` is inside useAgent, not exposed as a setter. We need dismissQueueToast which clears all. For individual dismissal, the queue_update from the backend will remove approved/rejected items, and the newQueueIds filter checks `i.status === 'pending'`, so approved items auto-disappear from the toast. No extra work needed.

Simplify: keep handleApprove/handleReject as-is. The queue_update broadcast after approve/reject will remove the item from the pending list, which removes it from newQueueItems automatically.

**Step 7: Add QueueToast inside the chat view**

Inside the `{view === 'chat' && (...)}` block, after ChatPane and before the CanvasPane conditional, add:

```tsx
{newQueueItems.length > 0 && !drawerOpen && (
  <QueueToast
    items={newQueueItems}
    onReview={() => { setDrawerOpen(true); dismissQueueToast() }}
    onDismiss={dismissQueueToast}
  />
)}
```

**Step 8: Add QueueDrawer (renders regardless of view)**

After the `</div>` that closes the `app-body` div (before IntegrationsModal), add:

```tsx
<QueueDrawer
  open={drawerOpen}
  queue={queue}
  onClose={() => setDrawerOpen(false)}
  onApprove={handleApprove}
  onReject={handleReject}
  onApproveAll={handleApproveAll}
  onRejectAll={handleRejectAll}
  onEdit={editQueueItem}
/>
```

**Step 9: Make sidebar Queue badge also open the drawer**

In the Sidebar's onViewChange handler, intercept 'queue' clicks to open the drawer instead:

Actually, keep the sidebar queue view as-is for now. The drawer is an *additional* way to review. Users can still click Queue in sidebar for the full two-pane view. But we should also open the drawer when clicking the badge. We can add this as a prop to Sidebar later — for now, the toast is the primary entry point.

**Step 10: Verify build**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && pnpm tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: 0 errors

**Step 11: Commit**

```bash
git add apps/desktop/src/components/QueueToast.tsx apps/desktop/src/components/QueueDrawer.tsx apps/desktop/src/App.tsx apps/desktop/src/hooks/useAgent.ts
git commit -m "feat(queue): inline queue toast + slide-over drawer for chat view"
```

---

### Task 5: Make sidebar badge open the drawer (when in chat view)

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/components/Sidebar.tsx`

**Step 1: Add onQueueBadgeClick prop to Sidebar**

In `Sidebar.tsx`, add to `SidebarProps`:

```typescript
onQueueBadgeClick?: () => void
```

**Step 2: Update NavItem for Queue to use the callback**

Change the Queue NavItem to call `onQueueBadgeClick` when provided (i.e., when in chat view), otherwise navigate to full queue view:

```tsx
<NavItem
  icon={Inbox}
  label="Queue"
  active={view === 'queue'}
  onClick={() => {
    if (onQueueBadgeClick && view === 'chat') {
      onQueueBadgeClick()
    } else {
      onViewChange('queue')
    }
  }}
  badge={queueCount}
/>
```

**Step 3: Pass the callback from App.tsx**

In App.tsx, add to the Sidebar component:

```tsx
onQueueBadgeClick={() => { setDrawerOpen(true); dismissQueueToast() }}
```

**Step 4: Verify build**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && pnpm tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: 0 errors

**Step 5: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/components/Sidebar.tsx
git commit -m "feat(queue): sidebar badge opens drawer when in chat view"
```

---

### Task 6: Visual test + polish

**Files:**
- Possibly modify: `apps/desktop/src/components/QueueDrawer.tsx`, `apps/desktop/src/components/QueueToast.tsx`

**Step 1: Start the dev environment**

Run: `cd /Users/brettponters/AI-Projects/CoAgent && pnpm tauri dev`

**Step 2: Test with mock queue item**

Send a WebSocket message to add a test queue item (the `add_test_queue_item` message type already exists in the shared types). Verify:
- Toast appears at bottom of chat
- Clicking "Review" opens drawer from right
- Approve/reject works
- Drawer closes when queue empties
- Dark mode looks correct

**Step 3: Test batch**

Add 3+ test items. Verify:
- Toast shows "3 items need your approval"
- Drawer shows batch controls (Approve all / Reject all)
- Individual items are expandable
- Approve all clears everything

**Step 4: Fix any visual issues found during testing**

**Step 5: Commit any polish fixes**

```bash
git add -u
git commit -m "fix(queue): visual polish for inline queue drawer"
```
