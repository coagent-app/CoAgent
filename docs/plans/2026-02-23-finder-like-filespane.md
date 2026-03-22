# Finder-Like FilesPane Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Upgrade FilesPane with nested folders (drag-to-nest), real image/PDF preview thumbnails, and fluid hover/drag animations — making it feel like a polished, CoAgent-branded Finder.

**Architecture:** Folders become real nested directories on disk (`~/.coagent/files/Work/Reports/`). `listFolders` does a recursive scan and returns all paths as a flat `string[]`. The UI computes direct children at the current path. Preview thumbnails use Tauri's `convertFileSrc` for images and `pdfjs-dist` for PDFs.

**Tech Stack:** React, TypeScript, Tauri v2 (`convertFileSrc`, `core:asset`), `pdfjs-dist`, `lucide-react`, Tailwind CSS, WebSocket (existing)

---

### Key files to understand before starting

- `packages/shared/src/index.ts` — `FileEntry`, `WSClientMessage`, `WSServerMessage` types
- `packages/agent-core/src/file-store.ts` — all file/folder operations
- `packages/agent-core/src/server.ts` — WS message handlers, `sendFilesAndFolders()`
- `apps/desktop/src/hooks/useAgent.ts` — all WS state + callbacks
- `apps/desktop/src/App.tsx` — renders FilesPane with its props
- `apps/desktop/src/components/FilesPane.tsx` — the main component to modify
- `apps/desktop/src-tauri/capabilities/default.json` — Tauri permissions

---

### Task 1: Backend — nested folder support + `moveFolder`

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/agent-core/src/file-store.ts`

**Step 1: Add `move_folder` to shared WSClientMessage**

In `packages/shared/src/index.ts`, add to the `WSClientMessage` union (after line 93 `reorder_folders`):

```ts
| { type: 'move_folder'; folderPath: string; newParentPath: string }
```

**Step 2: Update `listFolders` to scan recursively**

Replace the existing `listFolders` function in `file-store.ts` (lines 53–63) with:

```ts
export async function listFolders(dataDir: string): Promise<string[]> {
  const filesDir = join(dataDir, FILES_DIR)
  if (!existsSync(filesDir)) return []

  async function scan(dir: string, prefix: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true })
    const dirs = entries.filter(e => e.isDirectory())
    const result: string[] = []
    for (const d of dirs) {
      const fullPath = prefix ? `${prefix}/${d.name}` : d.name
      result.push(fullPath)
      const children = await scan(join(dir, d.name), fullPath)
      result.push(...children)
    }
    return result
  }

  const allPaths = await scan(filesDir, '')
  const savedOrder = await loadFolderOrder(dataDir)

  // Sort: saved-order items first (in order), remaining alphabetically
  const savedFiltered = savedOrder.filter(n => allPaths.includes(n))
  const remaining = allPaths.filter(n => !savedFiltered.includes(n)).sort()
  return [...savedFiltered, ...remaining]
}
```

**Step 3: Update `moveFile` to support nested paths**

Replace lines 112–140 (`moveFile`) in `file-store.ts`:

```ts
export async function moveFile(dataDir: string, id: string, targetGroup: string): Promise<void> {
  const index = await readIndex(dataDir)
  const entry = index.find(e => e.id === id)
  if (!entry) throw new Error(`File ${id} not found`)

  // Sanitize the group path: allow slashes for nesting, but block traversal
  const safeGroup = targetGroup
    ? targetGroup.replace(/\.\./g, '').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/')
    : ''

  const targetDir = safeGroup
    ? join(dataDir, FILES_DIR, ...safeGroup.split('/'))
    : join(dataDir, FILES_DIR)
  await mkdir(targetDir, { recursive: true })
  const newPath = join(targetDir, entry.filename)

  if (entry.path !== newPath && existsSync(entry.path)) {
    try {
      await rename(entry.path, newPath)
    } catch (err) {
      throw new Error(`Failed to move file: ${(err as Error).message}`)
    }
  }

  const updated = index.map(e =>
    e.id === id ? { ...e, path: newPath, group: safeGroup } : e
  )
  await writeIndex(dataDir, updated)
}
```

**Step 4: Add `moveFolder` function**

Add this new export to `file-store.ts` after `deleteFolder`:

```ts
export async function moveFolder(dataDir: string, folderPath: string, newParentPath: string): Promise<void> {
  // e.g. folderPath="Reports", newParentPath="Work" → moves to "Work/Reports"
  const folderName = folderPath.split('/').pop()!
  const newPath = newParentPath ? `${newParentPath}/${folderName}` : folderName

  if (newPath === folderPath) return  // no-op

  // Check that newPath is not a descendant of folderPath (can't move a folder into itself)
  if (newPath.startsWith(`${folderPath}/`)) {
    throw new Error('Cannot move a folder into one of its own subfolders')
  }

  const oldDir = join(dataDir, FILES_DIR, ...folderPath.split('/'))
  const newDir = join(dataDir, FILES_DIR, ...newPath.split('/'))
  const parentDir = join(dataDir, FILES_DIR, ...newPath.split('/').slice(0, -1))

  if (existsSync(oldDir)) {
    await mkdir(parentDir, { recursive: true })
    try {
      await rename(oldDir, newDir)
    } catch (err) {
      throw new Error(`Failed to move folder: ${(err as Error).message}`)
    }
  }

  // Update all files whose group starts with folderPath
  const index = await readIndex(dataDir)
  const updated = index.map(e => {
    if (e.group === folderPath || e.group.startsWith(`${folderPath}/`)) {
      const newGroup = newPath + e.group.slice(folderPath.length)
      const newFilePath = join(dataDir, FILES_DIR, ...newGroup.split('/'), e.filename)
      return { ...e, group: newGroup, path: newFilePath }
    }
    return e
  })
  await writeIndex(dataDir, updated)

  console.log(`[FileStore] Moved folder: ${folderPath} → ${newPath}`)
}
```

**Step 5: Update the import in `server.ts`**

In `packages/agent-core/src/server.ts` line 10, add `moveFolder` to the import:

```ts
import { listFiles, listFolders, ingestFile, deleteFileEntry, createFolder, moveFile, moveFolder, renameFile, renameFolder, deleteFolder, saveFolderOrder, searchFiles } from './file-store.js'
```

**Step 6: Build and verify types compile**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/shared && pnpm build
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core && pnpm build 2>&1 | tail -20
```

Expected: no TypeScript errors.

**Step 7: Commit**

```bash
cd /Users/brettponters/AI-Projects/CoAgent
git add packages/shared/src/index.ts packages/agent-core/src/file-store.ts
git commit -m "feat: add nested folder support and moveFolder to file-store"
```

---

### Task 2: Backend — WS handler + useAgent + App.tsx wiring

**Files:**
- Modify: `packages/agent-core/src/server.ts`
- Modify: `apps/desktop/src/hooks/useAgent.ts`
- Modify: `apps/desktop/src/App.tsx`

**Step 1: Add `move_folder` handler in `server.ts`**

In `server.ts`, find the block `if (msg.type === 'reorder_folders')` (around line 358) and add AFTER it:

```ts
if (msg.type === 'move_folder') {
  try {
    await moveFolder(DATA_DIR, msg.folderPath, msg.newParentPath)
    await sendFilesAndFolders(ws)
  } catch (err: any) {
    send(ws, { type: 'error', message: `Failed to move folder: ${err.message}` })
  }
}
```

**Step 2: Add `moveFolder` callback to `useAgent.ts`**

In `apps/desktop/src/hooks/useAgent.ts`, add after `reorderFolders` (line 128):

```ts
const moveFolder = useCallback((folderPath: string, newParentPath: string) => {
  send({ type: 'move_folder', folderPath, newParentPath })
}, [send])
```

And add `moveFolder` to the return object on line 140.

**Step 3: Add `onMoveFolder` prop to FilesPane in `App.tsx`**

In `apps/desktop/src/App.tsx`, destructure `moveFolder` from `useAgent()` (line 28), then add it to the `<FilesPane>` block (around line 116–131):

```tsx
onMoveFolder={moveFolder}
```

**Step 4: Add `onMoveFolder` to `FilesPaneProps` interface**

In `apps/desktop/src/components/FilesPane.tsx`, add to the `FilesPaneProps` interface:

```ts
onMoveFolder: (folderPath: string, newParentPath: string) => void
```

And destructure it in the component signature.

**Step 5: Build and verify**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core && pnpm build 2>&1 | tail -5
cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop && pnpm tsc --noEmit 2>&1 | tail -20
```

Expected: no errors.

**Step 6: Commit**

```bash
cd /Users/brettponters/AI-Projects/CoAgent
git add packages/agent-core/src/server.ts apps/desktop/src/hooks/useAgent.ts apps/desktop/src/App.tsx apps/desktop/src/components/FilesPane.tsx
git commit -m "feat: wire move_folder through server, useAgent, and App"
```

---

### Task 3: FilesPane — nested navigation + folder-to-folder drag

**Files:**
- Modify: `apps/desktop/src/components/FilesPane.tsx`

This is the largest task. Make the following changes:

**Step 1: Replace `currentFolder` state with `currentPath`**

Replace line 112:
```ts
const [currentFolder, setCurrentFolder] = useState<string>('')
```
with:
```ts
const [currentPath, setCurrentPath] = useState<string>('')
```

Then find/replace ALL uses of `currentFolder` with `currentPath` and `setCurrentFolder` with `setCurrentPath` throughout the file.

**Step 2: Add `directChildFolders` helper**

After the `sortFiles` function (before the component), add:

```ts
/** Returns folder names that are direct children of parentPath. */
function directChildFolders(allFolders: string[], parentPath: string): string[] {
  return allFolders
    .filter(f => {
      if (parentPath === '') {
        // Root: folders with no slash
        return !f.includes('/')
      }
      // Children of parentPath: starts with "parentPath/" and has no further slash after prefix
      if (!f.startsWith(`${parentPath}/`)) return false
      const rest = f.slice(parentPath.length + 1)
      return !rest.includes('/')
    })
}
```

**Step 3: Update derived state to use `directChildFolders`**

Replace line 166–168:
```ts
const rawVisibleFiles = files.filter(f => f.group === currentFolder)
const visibleFiles = sortFiles(rawVisibleFiles, sortField, sortDir)
const visibleFolders = currentFolder === '' ? localFolders : []
```
with:
```ts
const rawVisibleFiles = files.filter(f => f.group === currentPath)
const visibleFiles = sortFiles(rawVisibleFiles, sortField, sortDir)
const visibleFolders = directChildFolders(localFolders, currentPath)
```

**Step 4: Replace back-button breadcrumb with full path breadcrumb**

Find the breadcrumb section in the header (lines 726–755, the `currentFolder !== ''` block). Replace it with:

```tsx
{currentPath !== '' && (
  <nav className="flex items-center gap-0.5 mt-1 flex-wrap">
    <button
      onClick={() => { setCurrentPath(''); setSelected(new Set()); lastSelectedRef.current = null }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('text/plain')) {
          e.preventDefault()
          setDragOverBreadcrumb(true)
        }
      }}
      onDragLeave={() => setDragOverBreadcrumb(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOverBreadcrumb(false)
        const id = e.dataTransfer.getData('text/plain')
        if (!id) return
        const idsToMove = selected.has(id) && selected.size > 1 ? [...selected] : [id]
        for (const fileId of idsToMove) onMoveFile(fileId, '')
        setDraggingId(null)
      }}
      className={`text-[11px] transition-colors px-1 py-0.5 rounded ${
        dragOverBreadcrumb
          ? 'bg-blue-100 dark:bg-blue-900 text-blue-600'
          : 'text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
      }`}
    >
      Files
    </button>
    {currentPath.split('/').map((segment, idx, arr) => {
      const segPath = arr.slice(0, idx + 1).join('/')
      const isLast = idx === arr.length - 1
      return (
        <React.Fragment key={segPath}>
          <span className="text-[10px] text-neutral-300 dark:text-neutral-600">›</span>
          {isLast ? (
            <span className="text-[11px] text-neutral-600 dark:text-neutral-400 px-1">{segment}</span>
          ) : (
            <button
              onClick={() => { setCurrentPath(segPath); setSelected(new Set()); lastSelectedRef.current = null }}
              className="text-[11px] text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors px-1 py-0.5 rounded"
            >
              {segment}
            </button>
          )}
        </React.Fragment>
      )
    })}
  </nav>
)}
```

**Step 5: Add folder-to-folder nesting via hover-delay**

Add these new state refs near the top of the component (after `draggingFolderRef`):

```ts
const nestTargetRef = useRef<string | null>(null)
const nestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
const [nestTarget, setNestTarget] = useState<string | null>(null)
```

Add a cleanup effect:
```ts
useEffect(() => {
  return () => {
    if (nestTimerRef.current) clearTimeout(nestTimerRef.current)
  }
}, [])
```

**Step 6: Update folder `onDragOver` handlers to support nest-on-hover**

For the folder items in BOTH grid view and list view, replace the `onDragOver` handler with:

```tsx
onDragOver={(e) => {
  if (e.dataTransfer.types.includes('folder-reorder')) {
    e.preventDefault()
    e.stopPropagation()
    // If dragging a FOLDER over another FOLDER for 400ms → nest mode
    if (draggingFolderRef.current && draggingFolderRef.current !== folder) {
      if (nestTargetRef.current !== folder) {
        nestTargetRef.current = folder
        if (nestTimerRef.current) clearTimeout(nestTimerRef.current)
        nestTimerRef.current = setTimeout(() => {
          setNestTarget(folder)
          setDragOverFolderReorder(null)
        }, 400)
      }
    } else {
      handleFolderReorderDragOver(e, folder)
    }
  } else {
    e.preventDefault()
    e.stopPropagation()
    setDragOverFolder(folder)
    // Clear any nest timer when a file is being dragged
    if (nestTimerRef.current) clearTimeout(nestTimerRef.current)
    nestTargetRef.current = null
    setNestTarget(null)
  }
}}
onDragLeave={() => {
  setDragOverFolder(null)
  setDragOverFolderReorder(null)
  if (nestTimerRef.current) clearTimeout(nestTimerRef.current)
  nestTargetRef.current = null
  setNestTarget(null)
}}
onDrop={(e) => {
  if (nestTarget === folder) {
    // Nest folder into this folder
    e.preventDefault()
    e.stopPropagation()
    const dragged = draggingFolderRef.current
    if (dragged && dragged !== folder) {
      const parentPath = currentPath ? currentPath : ''
      onMoveFolder(
        parentPath ? `${parentPath}/${dragged}` : dragged,
        currentPath ? `${currentPath}/${folder}` : folder
      )
      setLocalFolders(prev => prev.filter(f => f !== dragged))
    }
    setNestTarget(null)
    nestTargetRef.current = null
    draggingFolderRef.current = null
  } else if (e.dataTransfer.types.includes('folder-reorder')) {
    handleFolderReorderDrop(e, folder)
  } else {
    e.preventDefault()
    handleFolderDrop(folder, e)
  }
  setDragOverFolder(null)
  setDragOverFolderReorder(null)
}}
```

**Step 7: Update folder item className to show nest highlight**

In the className for folder items, add nest highlight condition:

```ts
nestTarget === folder
  ? 'bg-blue-50 dark:bg-blue-950 ring-2 ring-blue-400 dark:ring-blue-600 scale-105'
  : dragOverFolder === folder
  ? 'bg-blue-50 dark:bg-blue-950 ring-2 ring-blue-300 dark:ring-blue-700'
  : dragOverFolderReorder === folder
  ? 'bg-amber-50 dark:bg-amber-950 ring-2 ring-amber-300 dark:ring-amber-700'
  : 'hover:bg-neutral-50 dark:hover:bg-neutral-800'
```

**Step 8: Update folder double-click to navigate using full path**

In both grid and list folder items, update `onDoubleClick`:

```tsx
onDoubleClick={() => {
  if (renamingFolder === folder) return
  const newPath = currentPath ? `${currentPath}/${folder}` : folder
  setCurrentPath(newPath)
  setSelected(new Set())
  lastSelectedRef.current = null
}}
```

**Step 9: Update folder display name**

Folders in `visibleFolders` are now just the leaf name (direct children), so the display name is just `folder` (unchanged). The `folder` variable is already the leaf name (e.g. `"Reports"`, not `"Work/Reports"`).

Wait — `directChildFolders` returns the FULL path from `allFolders`, like `"Work/Reports"`. Update it to return leaf names:

Actually, update `directChildFolders` to return just the leaf names:
```ts
function directChildFolders(allFolders: string[], parentPath: string): string[] {
  return allFolders
    .filter(f => {
      if (parentPath === '') return !f.includes('/')
      if (!f.startsWith(`${parentPath}/`)) return false
      return !f.slice(parentPath.length + 1).includes('/')
    })
    .map(f => f.split('/').pop()!)  // ← leaf name only
}
```

And when calling `onMoveFolder`, reconstruct the full path:
```ts
// In the nest drop handler:
const fullFolderPath = currentPath ? `${currentPath}/${folder}` : folder
const fullTargetPath = currentPath ? `${currentPath}/${nestTarget}` : nestTarget!
onMoveFolder(fullFolderPath, fullTargetPath)
```

And when moving files into a folder:
```ts
// In handleFolderDrop:
const fullFolderPath = currentPath ? `${currentPath}/${folderName}` : folderName
onMoveFile(id, fullFolderPath)
```

Update `handleFolderDrop` to compute the full group path:
```ts
function handleFolderDrop(folderName: string, e: React.DragEvent) {
  if (e.dataTransfer.getData('folder-reorder')) return
  if (!draggingId) return
  const fullPath = currentPath ? `${currentPath}/${folderName}` : folderName
  const idsToMove = selected.has(draggingId) && selected.size > 1 ? [...selected] : [draggingId]
  for (const id of idsToMove) onMoveFile(id, fullPath)
  setDraggingId(null)
  setDragOverFolder(null)
}
```

**Step 10: Update `isEmpty` check**

```ts
const isEmpty = visibleFolders.length === 0 && visibleFiles.length === 0 && !creatingFolder && !searchQuery
```

This stays the same — `visibleFolders` now uses `directChildFolders` which returns leaf names.

**Step 11: Update page title to show leaf folder name**

```tsx
<h1 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
  {currentPath === '' ? 'Files' : currentPath.split('/').pop()!}
</h1>
```

**Step 12: Type-check and commit**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop && pnpm tsc --noEmit 2>&1 | tail -20
```

```bash
cd /Users/brettponters/AI-Projects/CoAgent
git add apps/desktop/src/components/FilesPane.tsx
git commit -m "feat: nested folder navigation and drag-to-nest in FilesPane"
```

---

### Task 4: Tauri asset protocol permission

**Files:**
- Modify: `apps/desktop/src-tauri/capabilities/default.json`

**Step 1: Add asset protocol permission**

Replace the file contents with:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capabilities",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "shell:allow-open",
    "core:asset:allow-fetch-asset"
  ]
}
```

> **Note:** If `core:asset:allow-fetch-asset` doesn't compile, try `"fs:allow-read-all"` or check the generated schema at `apps/desktop/src-tauri/gen/schemas/desktop-schema.json` for the correct permission identifier for the asset protocol.

**Step 2: Build and verify**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop && pnpm tauri build --no-bundle 2>&1 | grep -i "error\|warn" | head -20
```

If the permission name is wrong, open `apps/desktop/src-tauri/gen/schemas/desktop-schema.json`, search for `asset`, and use the correct identifier. Common alternatives:
- `"core:asset:default"`
- `"asset:allow-read"`

**Step 3: Commit**

```bash
cd /Users/brettponters/AI-Projects/CoAgent
git add apps/desktop/src-tauri/capabilities/default.json
git commit -m "feat: add asset protocol permission for local file thumbnails"
```

---

### Task 5: Image thumbnails with `convertFileSrc`

**Files:**
- Modify: `apps/desktop/src/components/FilesPane.tsx`

**Step 1: Add import at top of FilesPane.tsx**

Add to the existing imports (after line 4 `import { open } from '@tauri-apps/plugin-shell'`):

```ts
import { convertFileSrc } from '@tauri-apps/api/core'
```

**Step 2: Add `ImageThumbnail` component**

Add this component before `FilesPane` (after the `sortFiles` function):

```tsx
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

function isImage(filename: string): boolean {
  return IMAGE_EXTS.has(filename.split('.').pop()?.toLowerCase() ? `.${filename.split('.').pop()!.toLowerCase()}` : '')
}

function ImageThumbnail({ path, filename, size }: { path: string; filename: string; size: 'grid' | 'list' }) {
  const [error, setError] = useState(false)
  const src = convertFileSrc(path)
  const cls = size === 'grid'
    ? 'w-full h-full object-cover rounded-lg'
    : 'w-8 h-8 object-cover rounded flex-shrink-0'

  if (error) return null
  return (
    <img
      src={src}
      alt={filename}
      className={cls}
      onError={() => setError(true)}
      draggable={false}
    />
  )
}
```

**Step 3: Update `renderFileGrid` to show image thumbnail**

In `renderFileGrid`, find the icon div (lines 615–617):

```tsx
<div className="w-12 h-12 rounded-lg bg-neutral-50 dark:bg-neutral-800 flex items-center justify-center">
  <Icon size={22} className="text-neutral-400 dark:text-neutral-500" />
</div>
```

Replace with:

```tsx
<div className="w-12 h-12 rounded-lg bg-neutral-50 dark:bg-neutral-800 overflow-hidden flex items-center justify-center">
  {isImage(file.filename) ? (
    <ImageThumbnail path={file.path} filename={file.filename} size="grid" />
  ) : (
    <Icon size={22} className="text-neutral-400 dark:text-neutral-500" />
  )}
</div>
```

**Step 4: Update `renderFileList` to show image thumbnail**

In `renderFileList`, find the icon column div (lines 667–669):

```tsx
<div className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
  <Icon size={16} className="text-neutral-400 dark:text-neutral-500" />
</div>
```

Replace with:

```tsx
<div className="flex-shrink-0 w-5 h-5 flex items-center justify-center overflow-hidden rounded">
  {isImage(file.filename) ? (
    <ImageThumbnail path={file.path} filename={file.filename} size="list" />
  ) : (
    <Icon size={16} className="text-neutral-400 dark:text-neutral-500" />
  )}
</div>
```

**Step 5: Type-check**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop && pnpm tsc --noEmit 2>&1 | tail -10
```

**Step 6: Commit**

```bash
cd /Users/brettponters/AI-Projects/CoAgent
git add apps/desktop/src/components/FilesPane.tsx
git commit -m "feat: add image thumbnail preview using convertFileSrc"
```

---

### Task 6: PDF thumbnails with pdfjs-dist

**Files:**
- Modify: `apps/desktop/package.json` (install dependency)
- Modify: `apps/desktop/src/components/FilesPane.tsx`

**Step 1: Install pdfjs-dist**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop && pnpm add pdfjs-dist
```

**Step 2: Add `PdfThumbnail` component**

Add after `ImageThumbnail` in `FilesPane.tsx`:

```tsx
// Shared PDF thumbnail cache: file id → data URL
const pdfThumbnailCache = new Map<string, string>()

function PdfThumbnail({ fileId, path, size }: { fileId: string; path: string; size: 'grid' | 'list' }) {
  const [dataUrl, setDataUrl] = useState<string | null>(pdfThumbnailCache.get(fileId) ?? null)
  const [loading, setLoading] = useState(!pdfThumbnailCache.has(fileId))
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (pdfThumbnailCache.has(fileId)) return
    // Lazy-render via IntersectionObserver
    const el = containerRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      async (entries) => {
        if (!entries[0]?.isIntersecting) return
        observer.disconnect()
        try {
          const pdfjsLib = await import('pdfjs-dist')
          pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
            'pdfjs-dist/build/pdf.worker.min.mjs',
            import.meta.url
          ).href

          const assetUrl = convertFileSrc(path)
          const loadingTask = pdfjsLib.getDocument(assetUrl)
          const pdf = await loadingTask.promise
          const page = await pdf.getPage(1)

          const viewport = page.getViewport({ scale: 1 })
          const targetHeight = size === 'grid' ? 96 : 32
          const scale = targetHeight / viewport.height
          const scaled = page.getViewport({ scale })

          const canvas = document.createElement('canvas')
          canvas.width = scaled.width
          canvas.height = scaled.height
          const ctx = canvas.getContext('2d')!
          await page.render({ canvasContext: ctx, viewport: scaled }).promise

          const url = canvas.toDataURL('image/jpeg', 0.85)
          pdfThumbnailCache.set(fileId, url)
          setDataUrl(url)
        } catch (err) {
          console.warn('[PdfThumbnail] render failed:', err)
        } finally {
          setLoading(false)
        }
      },
      { threshold: 0.1 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [fileId, path, size])

  const cls = size === 'grid'
    ? 'w-full h-full object-cover rounded-lg'
    : 'w-8 h-8 object-cover rounded flex-shrink-0'

  return (
    <div ref={containerRef} className={size === 'grid' ? 'w-full h-full' : 'w-5 h-5'}>
      {dataUrl ? (
        <img src={dataUrl} alt="PDF preview" className={cls} draggable={false} />
      ) : loading ? (
        <div className={`${size === 'grid' ? 'w-12 h-12' : 'w-5 h-5'} rounded bg-neutral-100 dark:bg-neutral-800 animate-pulse`} />
      ) : null}
    </div>
  )
}
```

**Step 3: Add `isPdf` helper**

```ts
function isPdf(filename: string): boolean {
  return filename.toLowerCase().endsWith('.pdf')
}
```

**Step 4: Update `renderFileGrid` to include PDF thumbnail**

In the icon container inside `renderFileGrid`, update the conditional:

```tsx
<div className="w-12 h-12 rounded-lg bg-neutral-50 dark:bg-neutral-800 overflow-hidden flex items-center justify-center">
  {isImage(file.filename) ? (
    <ImageThumbnail path={file.path} filename={file.filename} size="grid" />
  ) : isPdf(file.filename) ? (
    <PdfThumbnail fileId={file.id} path={file.path} size="grid" />
  ) : (
    <Icon size={22} className="text-neutral-400 dark:text-neutral-500" />
  )}
</div>
```

**Step 5: Update `renderFileList` similarly**

```tsx
<div className="flex-shrink-0 w-5 h-5 flex items-center justify-center overflow-hidden rounded">
  {isImage(file.filename) ? (
    <ImageThumbnail path={file.path} filename={file.filename} size="list" />
  ) : isPdf(file.filename) ? (
    <PdfThumbnail fileId={file.id} path={file.path} size="list" />
  ) : (
    <Icon size={16} className="text-neutral-400 dark:text-neutral-500" />
  )}
</div>
```

**Step 6: Type-check**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop && pnpm tsc --noEmit 2>&1 | tail -10
```

**Step 7: Commit**

```bash
cd /Users/brettponters/AI-Projects/CoAgent
git add apps/desktop/package.json apps/desktop/src/components/FilesPane.tsx
git commit -m "feat: add PDF first-page thumbnail preview using pdfjs-dist"
```

---

### Task 7: Fluid animations and visual polish

**Files:**
- Modify: `apps/desktop/src/components/FilesPane.tsx`

**Step 1: Grid item hover + drag animations**

In `renderFileGrid`, update the outer div's `className` to add transitions:

```tsx
className={`group relative flex flex-col items-center gap-1.5 p-2 rounded-xl cursor-pointer select-none transition-all duration-150 ${
  draggingId === file.id
    ? 'opacity-50 scale-95'
    : isSelected
      ? 'bg-blue-50 dark:bg-blue-950 ring-2 ring-blue-300 dark:ring-blue-700 scale-[1.01]'
      : 'hover:bg-neutral-50 dark:hover:bg-neutral-800 hover:scale-[1.02] hover:shadow-sm'
}`}
```

**Step 2: List item hover animation**

In `renderFileList`, update the outer div's `className`:

```tsx
className={`flex items-center gap-3 px-2 py-2 rounded-lg cursor-pointer select-none transition-all duration-100 ${
  draggingId === file.id
    ? 'opacity-50'
    : isSelected
      ? 'bg-blue-50 dark:bg-blue-950 ring-1 ring-blue-300 dark:ring-blue-700'
      : 'hover:bg-neutral-50 dark:hover:bg-neutral-800'
}`}
```

**Step 3: Folder item hover animation (grid)**

In the grid folder item className, add `transition-all duration-150`:

```tsx
className={`flex flex-col items-center gap-1.5 p-2 rounded-xl cursor-pointer select-none transition-all duration-150 ${
  nestTarget === folder
    ? 'bg-blue-50 dark:bg-blue-950 ring-2 ring-blue-400 dark:ring-blue-600 scale-105'
    : dragOverFolder === folder
      ? 'bg-blue-50 dark:bg-blue-950 ring-2 ring-blue-300 dark:ring-blue-700'
      : dragOverFolderReorder === folder
        ? 'bg-amber-50 dark:bg-amber-950 ring-2 ring-amber-300 dark:ring-amber-700'
        : 'hover:bg-neutral-50 dark:hover:bg-neutral-800 hover:scale-[1.02]'
}`}
```

**Step 4: Folder item hover animation (list)**

In the list folder item className, add `transition-all duration-100`.

**Step 5: Add `draggingId` tracking for visual feedback on file items**

`draggingId` is already tracked. Just reference it in the className as shown above.

**Step 6: Larger grid thumbnail area**

The current icon area is `w-12 h-12` (48×48). Make it bigger for a more Finder-like feel:

In `renderFileGrid`, change the icon container from `w-12 h-12` to `w-14 h-14`:

```tsx
<div className="w-14 h-14 rounded-xl bg-neutral-50 dark:bg-neutral-800 overflow-hidden flex items-center justify-center">
```

**Step 7: Better non-image/non-PDF icons (colored file type badges)**

In `renderFileGrid`, for non-image/non-PDF files, replace the plain icon with a colored badge:

```tsx
) : (
  <div className={`w-full h-full flex items-center justify-center rounded-xl ${fileIconBg(file.filename)}`}>
    <Icon size={22} className={fileIconColor(file.filename)} />
  </div>
)}
```

Add these helpers before the component:

```ts
function fileIconBg(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (['docx', 'doc'].includes(ext)) return 'bg-blue-50 dark:bg-blue-950'
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'bg-emerald-50 dark:bg-emerald-950'
  if (['pptx', 'ppt'].includes(ext)) return 'bg-orange-50 dark:bg-orange-950'
  if (['zip', 'rar', '7z'].includes(ext)) return 'bg-purple-50 dark:bg-purple-950'
  return 'bg-neutral-50 dark:bg-neutral-800'
}

function fileIconColor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (['docx', 'doc'].includes(ext)) return 'text-blue-400 dark:text-blue-500'
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'text-emerald-400 dark:text-emerald-500'
  if (['pptx', 'ppt'].includes(ext)) return 'text-orange-400 dark:text-orange-500'
  if (['zip', 'rar', '7z'].includes(ext)) return 'text-purple-400 dark:text-purple-500'
  return 'text-neutral-400 dark:text-neutral-500'
}
```

**Step 8: Type-check and verify**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/apps/desktop && pnpm tsc --noEmit 2>&1 | tail -10
```

**Step 9: Commit**

```bash
cd /Users/brettponters/AI-Projects/CoAgent
git add apps/desktop/src/components/FilesPane.tsx
git commit -m "feat: fluid animations and colored file type icons in FilesPane"
```

---

### Final: Launch and smoke test

```bash
cd /Users/brettponters/AI-Projects/CoAgent && pnpm tauri dev
```

Smoke test checklist:
- [ ] Navigate into a folder — breadcrumb shows `Files › FolderName`
- [ ] Click breadcrumb segment to go back up
- [ ] Drag a file into a subfolder
- [ ] Drag a folder over another folder, hold 400ms → turns blue → release → folder is nested
- [ ] Image files show actual photo thumbnail in grid view
- [ ] PDF files show first-page preview (with spinner while loading)
- [ ] Non-image/non-PDF files show colored icon badge
- [ ] Grid items scale up on hover, scale down when dragging
- [ ] Double-click file → opens in system default app
