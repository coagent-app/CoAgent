# Integrations Modal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the sidebar's inline "More" expand with a modal showing all supported integrations, and update the sidebar primary list to the 6 most common integrations.

**Architecture:** Move `INTEGRATION_ICONS` to a shared lib file so both Sidebar and the new IntegrationsModal can use it without circular imports. IntegrationsModal is a new standalone component wired into App.tsx with open/close state. Sidebar gets a new `onOpenModal` prop replacing the old expand behavior.

**Tech Stack:** React, TypeScript, Tailwind CSS, lucide-react, existing `useAgent` hook

---

### Task 1: Move INTEGRATION_ICONS to shared lib

**Files:**
- Create: `apps/desktop/src/lib/integrationIcons.ts`
- Modify: `apps/desktop/src/components/Sidebar.tsx`

**Step 1: Create `apps/desktop/src/lib/integrationIcons.ts`**

```typescript
import {
  Mail, Calendar, HardDrive, Cloud, CalendarClock,
  FileText, Video, Zap, Building2, Users, FileSignature,
  Linkedin, type LucideIcon
} from 'lucide-react'

export const INTEGRATION_ICONS: Record<string, LucideIcon> = {
  gmail: Mail,
  googlecalendar: Calendar,
  outlook: Mail,
  docusign: FileSignature,
  hubspot: Building2,
  follow_up_boss: Users,
  googledrive: HardDrive,
  dropbox: Cloud,
  calendly: CalendarClock,
  notion: FileText,
  zoom: Video,
  linkedin: Linkedin,
  highlevel: Zap,
  slack: Zap,
}
```

**Step 2: Update Sidebar.tsx to import from lib instead of defining inline**

In `apps/desktop/src/components/Sidebar.tsx`, remove the `INTEGRATION_ICONS` const declaration and add this import at the top:

```typescript
import { INTEGRATION_ICONS } from '@/lib/integrationIcons'
```

Also remove these imports that were only used for INTEGRATION_ICONS (keep ones still needed):
```typescript
// Remove if no longer used elsewhere in Sidebar:
import { Building2, Users, FileSignature, HardDrive, Cloud, CalendarClock, FileText, Video, Linkedin, Zap } from 'lucide-react'
```

**Step 3: Verify the app still renders**

Run: `pnpm --filter @coagent/desktop dev` (or check existing dev server)
Expected: Sidebar renders with icons intact, no TypeScript errors.

**Step 4: Commit**

```bash
git add apps/desktop/src/lib/integrationIcons.ts apps/desktop/src/components/Sidebar.tsx
git commit -m "refactor: move INTEGRATION_ICONS to shared lib"
```

---

### Task 2: Update Sidebar to show top 6 + "More" opens modal

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx`

**Step 1: Replace STATIC_INTEGRATIONS and MORE_INTEGRATIONS with a single PRIMARY list**

Remove both `STATIC_INTEGRATIONS` and `MORE_INTEGRATIONS` constants. Add:

```typescript
const PRIMARY_INTEGRATION_SLUGS = [
  'gmail',
  'googlecalendar',
  'googledrive',
  'notion',
  'hubspot',
  'outlook',
]
```

**Step 2: Add `onOpenModal` prop to SidebarProps**

```typescript
interface SidebarProps {
  view: View
  onViewChange: (v: View) => void
  queueCount: number
  todoCount: number
  integrations: Integration[]
  onConnect: (slug: string) => void
  onDisconnect: (slug: string) => void
  onOpenModal: () => void  // ← add this
}
```

**Step 3: Update the Sidebar function signature**

```typescript
export function Sidebar({ view, onViewChange, queueCount, todoCount, integrations, onConnect, onDisconnect, onOpenModal }: SidebarProps) {
```

**Step 4: Replace the integrations rendering section**

Remove the `showMore` state and the two `useState`/`showMore` map blocks. Replace the entire integrations section (from `<p className="px-2.5 text-[10px]...">Integrations</p>` down to the "More/Show less" button) with:

```tsx
<p className="px-2.5 text-[10px] font-semibold text-neutral-400 uppercase tracking-widest mb-2">
  Integrations
</p>
<div className="flex flex-col gap-0.5">
  {PRIMARY_INTEGRATION_SLUGS.map(slug => {
    const integration = integrations.find(i => i.slug === slug) ?? { slug, name: slug, connected: false }
    return (
      <IntegrationItem
        key={slug}
        integration={integration}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
      />
    )
  })}
  <button
    onClick={onOpenModal}
    className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-neutral-400 hover:text-neutral-600 transition-colors"
  >
    <ChevronRight size={12} />
    More
  </button>
</div>
```

**Step 5: Remove unused imports**

Remove `useState`, `ChevronDown` from imports if no longer used.

**Step 6: Verify TypeScript compiles**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop && npx tsc --noEmit
```
Expected: no errors (App.tsx will error until Task 4 — that's fine, fix in Task 4).

**Step 7: Commit**

```bash
git add apps/desktop/src/components/Sidebar.tsx
git commit -m "feat: sidebar shows top 6 integrations, More opens modal"
```

---

### Task 3: Create IntegrationsModal component

**Files:**
- Create: `apps/desktop/src/components/IntegrationsModal.tsx`

**Step 1: Create the component**

```tsx
import React, { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { INTEGRATION_ICONS } from '@/lib/integrationIcons'
import type { Integration } from '@coagent/shared'

interface IntegrationsModalProps {
  open: boolean
  onClose: () => void
  integrations: Integration[]
  onConnect: (slug: string) => void
  onDisconnect: (slug: string) => void
}

export function IntegrationsModal({ open, onClose, integrations, onConnect, onDisconnect }: IntegrationsModalProps) {
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!open) { setSearch(''); return }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const filtered = integrations.filter(i =>
    i.name.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-[520px] max-h-[600px] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-neutral-100">
          <h2 className="text-[15px] font-semibold text-neutral-900">Integrations</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="px-6 py-3 border-b border-neutral-100">
          <input
            autoFocus
            type="text"
            placeholder="Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full text-[13px] bg-neutral-50 border border-neutral-200 rounded-lg px-3 py-2 outline-none focus:border-neutral-400 transition-colors"
          />
        </div>

        {/* Grid */}
        <div className="overflow-y-auto flex-1 px-6 py-4">
          {filtered.length === 0 ? (
            <p className="text-[13px] text-neutral-400 text-center py-8">No integrations found.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {filtered.map(integration => {
                const Icon = INTEGRATION_ICONS[integration.slug]
                return (
                  <div
                    key={integration.slug}
                    className="flex items-center gap-3 p-3 rounded-xl border border-neutral-100 hover:border-neutral-200 transition-colors"
                  >
                    {Icon && <Icon size={16} strokeWidth={1.75} className="text-neutral-500 flex-shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-neutral-800 truncate">{integration.name}</p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={cn('w-1.5 h-1.5 rounded-full', integration.connected ? 'bg-emerald-400' : 'bg-neutral-300')} />
                      <button
                        onClick={() => integration.connected ? onDisconnect(integration.slug) : onConnect(integration.slug)}
                        className={cn(
                          'text-[11px] font-medium px-2.5 py-1 rounded-lg transition-colors',
                          integration.connected
                            ? 'text-neutral-500 hover:text-red-500 hover:bg-red-50'
                            : 'text-neutral-600 bg-neutral-100 hover:bg-neutral-200'
                        )}
                      >
                        {integration.connected ? 'Disconnect' : 'Connect'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-neutral-100">
          <p className="text-[12px] text-neutral-400">
            Need something else?{' '}
            <a
              href="https://github.com/brettponters/coagent/issues"
              target="_blank"
              rel="noreferrer"
              className="text-neutral-600 hover:underline"
            >
              Request an integration →
            </a>
          </p>
        </div>
      </div>
    </div>
  )
}
```

**Step 2: Verify TypeScript**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop && npx tsc --noEmit
```
Expected: no errors for this file (App.tsx may still error until Task 4).

**Step 3: Commit**

```bash
git add apps/desktop/src/components/IntegrationsModal.tsx
git commit -m "feat: add IntegrationsModal component"
```

---

### Task 4: Wire modal into App.tsx

**Files:**
- Modify: `apps/desktop/src/App.tsx`

**Step 1: Add modal import and state**

Add import at top:
```typescript
import { IntegrationsModal } from '@/components/IntegrationsModal'
```

Add state inside `App()`:
```typescript
const [modalOpen, setModalOpen] = useState(false)
```

**Step 2: Pass `onOpenModal` to Sidebar**

```tsx
<Sidebar
  view={view}
  onViewChange={setView}
  queueCount={queue.length}
  todoCount={todos.length}
  integrations={integrations}
  onConnect={connectIntegration}
  onDisconnect={disconnectIntegration}
  onOpenModal={() => setModalOpen(true)}
/>
```

**Step 3: Add IntegrationsModal to JSX**

Inside the `<>` fragment, after the `<div className="app-body">` block:

```tsx
<IntegrationsModal
  open={modalOpen}
  onClose={() => setModalOpen(false)}
  integrations={integrations}
  onConnect={connectIntegration}
  onDisconnect={disconnectIntegration}
/>
```

**Step 4: Verify TypeScript**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop && npx tsc --noEmit
```
Expected: clean — no errors.

**Step 5: Manually verify in the app**

- Sidebar shows exactly 6 integrations
- "More" button opens the modal
- Search filters the list
- Connect/Disconnect buttons work
- Clicking backdrop or pressing Escape closes modal

**Step 6: Commit**

```bash
git add apps/desktop/src/App.tsx
git commit -m "feat: wire IntegrationsModal into App"
```
