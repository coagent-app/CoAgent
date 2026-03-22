# Finder-Like FilesPane Design

**Date:** 2026-02-23

## Goal

Transform the FilesPane into a fluid, Finder-like file browser with nested folders, real preview thumbnails, and smooth interactions.

## Architecture

Three independent improvements applied to the existing FilesPane:

1. **Nested folders** via path-based `group` strings
2. **Preview thumbnails** for images and PDFs
3. **Fluid visual feel** via transitions, hover states, and drag polish

---

## 1. Nested Folder Architecture

### Data model

`FileEntry.group` is already a string. We extend it to support path strings:

- `""` — root
- `"Work"` — top-level folder
- `"Work/Reports"` — nested folder

No schema migration needed. Existing flat folder names remain valid.

### Server changes

- `folders_update` sends all folder paths as a flat `string[]` (e.g. `["Work", "Work/Reports", "Personal"]`). The UI computes which to display at the current level.
- New `move_folder` WS client message: `{ type: 'move_folder'; folderPath: string; newParentPath: string }`. Server renames the folder and re-prefixes all affected `FileEntry.group` values and sub-folder paths.
- `file-store.ts`: add `moveFolder(dataDir, folderPath, newParentPath)`.

### UI changes

- `currentFolder: string` → `currentPath: string` (supports `"Work/Reports"`)
- Direct children at current path = folders where path is `currentPath + "/" + name` with no further `/`
- Breadcrumb replaces single back button: `Files › Work › Reports`, each segment clickable
- Drag folder onto another folder → calls `onMoveFolder(draggedFolder, targetFolder)` which nests dragged under target

---

## 2. Preview Thumbnails

### Images (jpg/png/gif/webp)

- Use `convertFileSrc(path)` from `@tauri-apps/api/core` to get a safe asset URL
- Render `<img src={url} className="object-cover w-full h-full rounded" />`
- Needs `asset` protocol permission added to Tauri capability config

### PDFs

- Use `pdfjs-dist` to render first page to canvas → convert to blob URL
- Cache blob URLs in a `Map<string, string>` ref (keyed by file id) — renders once per session
- Lazy rendering via `IntersectionObserver` — only render when thumbnail enters viewport
- Show a spinner placeholder while rendering

### Other files

- Larger colored icon area filling the thumbnail space
- Blue background for docs, green for spreadsheets, neutral for unknown
- Icon centered, styled to fill the `96×96` grid area

### Sizes

- Grid view: `96×96` full thumbnail
- List view: `32×32` square thumbnail

---

## 3. Fluid Visual Feel

- Grid items: `transition-all duration-150 hover:scale-[1.02] hover:shadow-sm`
- Dragged item: `opacity-50 scale-95` during drag
- Folder drop target: smooth background fill transition
- Breadcrumb: `›`-separated path segments, each clickable, with hover underline
- All transitions use `duration-150` for snappiness without lag

---

## Files to Modify

- `packages/shared/src/index.ts` — add `move_folder` to `WSClientMessage`
- `packages/agent-core/src/file-store.ts` — add `moveFolder()`
- `packages/agent-core/src/server.ts` — handle `move_folder` message
- `apps/desktop/src/hooks/useAgent.ts` — add `moveFolder` handler + state
- `apps/desktop/src/App.tsx` — pass `onMoveFolder` to FilesPane
- `apps/desktop/src/components/FilesPane.tsx` — all UI changes
- `apps/desktop/src-tauri/capabilities/default.json` — add `asset` protocol permission

## Dependencies to Add

- `pdfjs-dist` in `apps/desktop`
