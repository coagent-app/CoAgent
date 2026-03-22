# File Store

## What It Is

A context library for the agent. Not file management — briefing. You manage what the agent knows. Drop files in, the agent reads just enough to understand what they are, organizes them, and remembers them. That's it.

Everything lives in `~/.coagent/files/` on the user's machine. The folders the user sees in the UI **are** the actual folders on disk — `~/.coagent/files/Contracts/`, `~/.coagent/files/Clients/`, etc. No abstraction layer. Open Finder, it's all there. The UI is just a window into the real file system. If they ever stop using CoAgent, their files are just files in normal folders — no lock-in, no export needed.

---

## Framing

**Wrong:** "Upload files" / "Manage your files"
**Right:** "What CoAgent knows about"

Clean separation of concerns:
- **Files section** → what context the agent has
- **Chat** → where you talk to the agent, including about those files

No chat bar in the Files section. If someone wants to ask about a file, they go to Chat. The agent already has it — it'll answer. Two chat interfaces creates confusion.

---

## UI — Own Section

Files is a full sidebar nav item like Chat, Queue, Settings. Not a modal. You might spend real time here managing context.

### Layout

Full view. Agent-created folders displayed as a grid or grouped list. Files sit inside folders as cards with thumbnails.

```
┌─────────────────────────────────────────────────────┐
│  Files                                    + Add      │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Contracts                    Clients               │
│  ┌──────┐ ┌──────┐           ┌──────┐ ┌──────┐     │
│  │[pdf] │ │[pdf] │           │[csv] │ │[doc] │     │
│  │      │ │      │           │      │ │      │     │
│  └──────┘ └──────┘           └──────┘ └──────┘     │
│  johnson  smith               leads    contacts     │
│                                                     │
│  Company                                            │
│  ┌──────┐                                           │
│  │[img] │                                           │
│  │      │                                           │
│  └──────┘                                           │
│  brand-guide                                        │
│                                                     │
│         Drop files anywhere                         │
└─────────────────────────────────────────────────────┘
```

### Interactions

- **Drag and drop anywhere on the screen** — drop on a folder → goes in that folder. Drop on empty space → agent decides the group automatically.
- **Click a file** → opens in OS default app (Preview, Excel, Photos, etc.). No built-in previewer — hand off to the system.
- **Hover a file** → trash icon appears. Click → deleted, no confirmation.
- **+ Add button** → opens file picker as alternative to drag/drop.
- **Delete = no confirmation.** If they want a new version, drop it again.

### File cards

System-generated thumbnail (first page for PDFs, actual image for photos, type icon for CSVs/DOCX). Filename truncated below. That's it.

---

## Agent-Driven Folders

Folders are created and organized by the agent — not the user. No manual folder creation. The agent assigns each file to a group based on its content and the user's profile.

Groups are tailored to the person:
- Real estate agent → "Listings", "Contracts", "Clients"
- Sales person → "Deals", "Leads", "Accounts"
- Generic → "Documents", "Spreadsheets", "Images"

The organization emerges from the agent's understanding. Zero user effort. This is the key difference from Cowork — Cowork requires you to organize, CoAgent organizes for you.

If a file is dropped onto a specific folder, it goes there regardless of what the agent would have chosen.

---

## Ingestion — Light Pass

Read just enough to understand what the file is. One pass with Haiku. Never read the whole thing.

| File Type | What We Read |
|-----------|-------------|
| PDF | First 2 pages of text |
| DOCX | First 500 words |
| CSV | First 20 rows |
| XLSX / PowerPoint | First page rendered as image |
| Images | Full image — Claude reads natively |
| Plain text | First 1,000 chars |

**Model:** Haiku for everything file-related — ingestion, summary generation, group assignment, storage stats. Sonnet is never used for files.

On ingestion, Haiku:
1. Samples the file (per table above)
2. Writes a 2-3 sentence summary of what it is
3. Assigns a group/folder
4. Embeds the summary via Voyage
5. Stores raw file + updates index

**Silent.** No message to the user. No confirmation. The file just appears in the right folder.

---

## Core Data Design

### Two Things Stored Separately

1. **The raw file** — sits in `~/.coagent/files/` untouched after ingestion. Only read again if agent needs full content.
2. **The metadata summary** — AI-written, embedded for semantic search. This is what the agent searches, not the raw file.

### Index Entry Shape

```json
{
  "id": "abc123",
  "filename": "johnson-contract.pdf",
  "path": "~/.coagent/files/johnson-contract.pdf",
  "added": "2026-02-22T14:30:00Z",
  "last_accessed": "2026-02-22T14:30:00Z",
  "summary": "Purchase agreement for 123 Main St between Brett Ponters and Tom Johnson. Closing date March 15. Price $450k. Contingencies: inspection and financing.",
  "group": "Contracts",
  "embedding": [...],
  "size_bytes": 204800
}
```

The embedding is of the **summary**, not the raw file. Fast, cheap, works regardless of file size.

---

## Retrieval

Agent calls `search_files(query)` → cosine similarity against summary embeddings → right file comes back.

Summary is usually enough context. Agent only calls `read_file(id)` if it needs the actual content — to answer a detailed question or attach to an email.

### @ Mentions in Chat

In the main Chat, users can type `@` to get an inline file picker and reference a specific file explicitly:

> "Summarize @johnson-contract.pdf"

Agent knows exactly which file without having to search. This is a Chat feature, not a Files feature.

---

## Sending Files

Agent retrieves a stored file and attaches it to an outbound email via Composio Gmail/Outlook. Key differentiator — Cowork can't do this because it has no app integrations.

Flow:
1. "Send Tom the contract" → agent searches files, finds it
2. Reads raw file bytes
3. Passes as attachment in Composio tool call
4. Updates `last_accessed` in index

---

## Storage

Files just sit in `~/.coagent/files/`. No auto-cleanup. Storage is cheap and auto-deletion risks removing something still relevant.

Agent has `get_storage_stats` — total files, total size, largest files. If user asks to clean up, agent surfaces what's there and helps decide. Never automatic.

---

## Agent Tools

| Tool | Description |
|------|-------------|
| `save_file` | Store file, light ingestion via Haiku, embed metadata summary |
| `search_files` | Semantic search across file summaries |
| `read_file` | Read full content of a file by ID |
| `delete_file` | Remove file and index entry |
| `get_storage_stats` | Total files, total size, largest files |

---

## Out of Scope (for now)

- Search bar in the Files UI (agent handles retrieval, not the user)
- Bulk select / bulk delete
- File previewer inside the app
- Manual folder creation by the user
- Chat bar inside the Files section

---

## Open Questions

- [ ] Voyage key not set — fall back to keyword search on filename/summary?
- [ ] Agent-generated files (text_to_pdf output) — auto-save here?
- [ ] Max file size limit before warning?
- [ ] XLSX/PPT image rendering — LibreOffice headless or just extract text at launch?
- [ ] Cap on number of folders before UI gets unwieldy?
