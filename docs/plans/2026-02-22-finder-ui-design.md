# Finder-Like FilesPane Design

**Goal:** Replace the current grouped grid with a macOS Finder icon-view UI — folders and files in one grid, drag-to-organize, disk-synced.

**Architecture:** Frontend manages current-folder navigation state and renders a mixed grid of folder icons and file icons. All folder and file operations go through WS messages to the server, which performs the actual disk operations and updates the index.

**Tech Stack:** React, Tauri, existing WS infrastructure, `@tauri-apps/api/event` for OS drag-drop.

---

## UI Layout

Single panel — no sidebar. Top bar contains:
- Back arrow (visible only when inside a folder) + breadcrumb showing current path
- `+ New Folder` button (always visible)

Below: icon grid of folder icons and file icons mixed together, identical to macOS Finder icon view.

### Icon types
- **Folder icon:** rendered with a folder SVG, folder name below
- **File icon:** existing type-based icons (FileText, Sheet, Image, File), filename below + small size/date meta

### Navigation
- Double-click folder → navigate in (update `currentFolder` state, back arrow appears)
- Back arrow → navigate up one level

### Selection
- Single click → select/deselect
- Click multiple items → multi-select (highlight with ring)

### Drag-to-organize
- Drag a file icon onto a folder icon → sends `move_file` WS message → server moves file on disk + updates index
- Uses HTML5 drag events (intra-app drag, not OS-level — those still use `tauri://drag-drop`)

---

## Data Model Changes

### FileEntry.group
- Empty string `""` = file lives at root (`~/.coagent/files/<filename>`)
- Non-empty string = file lives in that folder (`~/.coagent/files/<group>/<filename>`)

### New WS messages

**Client → Server:**
```ts
| { type: 'create_folder'; name: string }
| { type: 'move_file'; id: string; targetGroup: string }  // '' = move to root
```

**Server → Client:**
```ts
| { type: 'folders_update'; folders: string[] }
```

---

## Backend Changes

### file-store.ts
- `listFolders(dataDir)` — reads subdirs of `~/.coagent/files/`, returns `string[]`
- `moveFile(dataDir, id, targetGroup)` — renames file on disk, updates `path` and `group` in index
- `createFolder(dataDir, name)` — `mkdir ~/.coagent/files/<name>/`
- `ingestFile` — no longer calls `generateSummaryAndGroup` for the group; Haiku still generates the summary (for embeddings), but the file always lands at root (`group: ''`)

### server.ts
- On connection: send `folders_update` alongside `files_update`
- Handle `create_folder` and `move_file` WS messages
- After any folder/file operation: re-send both `files_update` and `folders_update`

---

## Frontend Changes

### useAgent.ts
- Add `folders: string[]` state + `folders_update` handler
- Add `createFolder(name: string)` and `moveFile(id: string, targetGroup: string)` callbacks

### FilesPane.tsx (full rewrite)
- State: `currentFolder: string` ('' = root), `selected: Set<string>`, `draggingId: string | null`, `dragOverFolder: string | null`
- Derive from props: what folders + files are visible at `currentFolder`
  - Visible folders: all folders from `folders` prop (only shown at root for now — one level deep)
  - Visible files: `files.filter(f => f.group === currentFolder)`
- Render mixed grid: folders first, then files
- Drag file onto folder: `onDragStart` sets `draggingId`, `onDragOver` on folder sets `dragOverFolder` (for highlight), `onDrop` calls `moveFile`
- New Folder: inline input that appears in the grid, on blur/enter calls `createFolder`
- OS drag-drop (`tauri://drag-drop`): unchanged — files land at root (group = '')
- File picker: unchanged — files land at root

---

## Folder depth
One level only for now — folders exist only at root. Files can be inside a folder or at root. No nested folders.
