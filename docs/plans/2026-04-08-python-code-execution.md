# Python Code Execution — Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task.

**Date:** 2026-04-08 (revised 2026-04-08 evening)
**Status:** Approved, ready to implement
**Owner:** Brett
**Depends on:** None for Phases 1–5 + 7. Phase 6 (document embedding) waits on the canvas/HTML-document system landing.

---

## Goal

Give CoAgent a Perplexity-style in-app code execution capability so the agent can run real analysis: scrape and parse websites, analyze CSVs/spreadsheets, compute metrics, generate charts, transform data. Results render inline in the chat as code cells, and any SVG/PNG charts produced can be embedded directly into HTML documents.

## Why

Freelancer lead qualification and analytics work require real computation — Lighthouse-style website audits, competitor comparisons, spreadsheet analysis, chart generation from scraped data. Purpose-built tools can cover some of it, but the long tail needs actual code. Perplexity, ChatGPT, and Claude all ship this; it's table stakes for a "personal operator" agent.

## Non-goals

- General developer coding environment (we are not Cursor/Claude Code).
- Persistent cross-conversation kernels.
- JavaScript/Node/SQL execution (Python only for v1).
- Arbitrary network access from inside the sandbox (proxied only).
- Replacing HTML document architecture — code execution is a separate surface.

## Architecture decision

**Two separate surfaces, one data flow:**

1. **Code execution = chat-side tool.** Renders as inline code cell in ChatPane. This is where analysis happens.
2. **HTML documents = canvas surface.** Authored output. Consumes code execution artifacts (charts, tables) via embed.

This mirrors how Perplexity separates "code interpreter cell in chat" from "Gamma-style presentations." Keeps concerns clean: chat = investigation, canvas = deliverable.

## Sandbox choice: Pyodide in a Web Worker (bundled)

**Why Pyodide over E2B/Firecracker/CPython subprocess:**

| | E2B (cloud) | uv + CPython subprocess | Pyodide (local) |
|---|---|---|---|
| Per-user cost | ~$0.0001/sec | free | free |
| Offline | no | yes | yes |
| Local-first stance | breaks it | matches it | matches it |
| Stateful kernel | native | per-process | in-worker |
| pandas/numpy/matplotlib/bs4 | yes | yes | yes |
| Headless browser | yes | yes | no |
| Sandboxed by default | VM | **NO — full host access** | **WASM sandbox** |
| Cross-platform | yes | needs Python install | yes |

CPython-via-`uv` would be faster and have a fuller ecosystem, but it is **not sandboxed** — an agent that takes natural-language instructions and runs arbitrary code with full host access is a `rm -rf ~` accident (or prompt injection from a scraped webpage) waiting to happen. OS-level sandboxing (sandbox-exec / AppArmor / AppContainer) is a significant cross-platform project; park it for a future "trusted code mode."

Pyodide matches CoAgent's local-first stance, has zero per-user cost, covers 90% of freelancer analytics work, and isolates by default via WASM. E2B becomes an optional "power mode" in a future phase only if users need headless browser automation.

### Bundling

**Bundle Pyodide in the Tauri app, do not download on first use.**

- Pyodide base + preloaded packages is ~10 MB
- Current Co-Agent bundle is already ~150 MB; the delta is rounding error
- Works offline immediately, no "downloading runtime…" UX
- Same Pyodide version for every user — predictable behavior
- No first-run latency penalty
- Updates ship through normal Tauri auto-updater
- Local-first stance is intact — no surprise downloads

## Architecture

### Worker pool (not 1-per-conversation)

- **Pool of max N=3 Pyodide workers**, LRU evict on overflow
- Each worker is owned by at most one conversation at a time
- Pyodide is ~150 MB resident per worker; capping at 3 keeps total ≤ ~500 MB
- Conversation kernel state (imports, in-memory variables) is lost on eviction
- Workspace state (files on disk) persists in `~/.coagent/workspace/<conv_id>/`
- Re-importing pandas/numpy on a fresh worker is cheap (~1s warm), so eviction is acceptable
- Workers spawned in the desktop app (Tauri side), not in the agent-core sidecar
- One worker is preloaded eagerly on app launch so the first `run_python` call has no cold-start latency
- Worker terminated when its owning conversation is closed or after 30 min idle

### Cancel + timeout from day one

- Every `run_python` call enforces a default **60-second wall-clock timeout**, configurable in settings
- Chat code cells render a **stop button** while running
- Cancel = `worker.terminate()` + immediately spawn a fresh worker into the same slot (Pyodide cannot be soft-interrupted reliably)
- Cancelled cell renders as `cancelled` state with whatever stdout/stderr was captured before termination

### Agent tool

```
run_python({
  code: string,
  conversation_id: string  // used to resolve kernel + workspace
}) → {
  stdout: string,
  stderr: string,
  result_repr?: string,     // last-expression repr, like Jupyter
  figures: Array<{ mime: "image/svg+xml" | "image/png", data: string }>,
  files_created: string[],  // paths under the workspace
  error?: { type: string, message: string, traceback: string }
}
```

Single tool, stateful across calls within a conversation. The agent writes ~20 lines of pandas/bs4/matplotlib, runs it, sees the output, iterates.

### Preloaded libraries

Loaded into Pyodide at worker init:
- `pandas` — dataframes, CSV/Excel parsing
- `numpy` — numerics
- `matplotlib` — charts (SVG output preferred)
- `beautifulsoup4` + `lxml` — HTML parsing
- `requests` — via Pyodide's http shim (proxied through host, see below)
- `openpyxl` — Excel files
- `python-dateutil` — dates
- `pillow` — image handling
- `scikit-learn` — only if first call imports it (lazy)

Runtime `micropip.install(...)` allowed for anything else.

### Filesystem

Pyodide has an in-memory FS by default. We mount a workspace directory per conversation:

```
~/.coagent/workspace/<conversation_id>/
```

- Synced bidirectionally with Pyodide's virtual FS on worker init/teardown
- Agent can read files the user uploaded to `~/.coagent/files/` via a bridge
- Agent writes outputs (CSVs, images, reports) to workspace, they appear in FilesPane
- Workspace persists across worker restarts within the same conversation

### Network

Pyodide can't do raw sockets. Options:
- **(a)** Block all network from Python, agent uses separate `fetch_url` tool then passes bytes to Python. Simplest, most secure.
- **(b)** Proxy `requests` / `urllib` through a host-side bridge that enforces rate limiting + domain rules.

**Decision: (b).** Proxied fetches only — the worker posts fetch requests to the main thread, which uses Tauri's http client to execute them. Enforces:
- http/https only
- No localhost / private IPs
- Rate limit: 20 req/sec per conversation
- Max response size: 10 MB
- Timeout: 30s

### Chat UI — Perplexity-style code cells

New message type: `code_cell`. Renders inline inside the assistant's bubble (not as a separate panel), so the agent can narrate around it: *"Let me check that…"* → [cell] → *"As you can see, the highest is X."* Multiple cells can stack within a single assistant turn.

**Spec (matches Perplexity's code interpreter behavior):**

1. **Code is collapsed by default.** What shows is the **result** (stdout summary + figures + files). Small chevron / "View code" toggle reveals the source. Output is the deliverable; code is the receipt.
2. **Streaming stdout while running.** Lines appear as they print, mono font, scrolls to bottom. No "spinner then dump." Cap visible at ~200 lines with "view full output" expand.
3. **Figures render inline at full bubble width.** Charts are first-class — they show with no click required. SVG preferred over PNG for crispness.
4. **Multi-cell per turn.** Agent can run 2–3 cells in sequence in a single reply (e.g. scrape → parse → chart). Each is its own card stacked in order, separated by the agent's narration text.
5. **Errors auto-expand in red, with traceback.** Don't make the user click to see what broke.
6. **Header chips:** language ("Python"), runtime version ("3.11"), duration ("1.2s"), copy-code button, optional "rerun" button.
7. **Subtle styling.** Thin border, light background tint, no heavy chrome — feels integrated into the bubble, not a bolted-on dev tool.
8. **Stateful kernel across cells in the same conversation.** Imports persist, variables persist (until worker eviction).
9. **Auto-collapse to a one-line summary after completion.** Live streaming during, clean line after: `✓ Analyzed sales.csv — 3 charts below`. Figures stay visible below the summary; code stays hidden behind the toggle.
10. **Narrated framing.** The agent is prompted to introduce the cell in plain language ("Analyzing the data…", "Fetching the page…", "Plotting results…") rather than dumping raw code with no context. Makes it feel like a "thinking step," not a developer console.

**States:**
- `running` — spinner + live streaming stdout, code expanded *unless* short-running heuristic kicks in
- `done` — collapsed one-line summary + figures + files, code hidden behind toggle
- `error` — expanded, red border, traceback shown, code visible
- `cancelled` — collapsed, "stopped" badge, partial output preserved

**"Insert into document" button** appears on any figure in a `done` cell → sends the SVG to the active canvas/HtmlDocument as a new `.sec-gallery` patch (Phase 6, depends on canvas).

### Document embedding

When the agent runs code that produces a chart, the SVG can flow into an HTML document via:
1. Agent calls `run_python` and gets SVG back
2. Agent calls `patch_canvas` with `insert_after` and content = `<section class="sec-gallery" id="chart-1"><figure>{svg}</figure><figcaption class="ed-caption" id="cap-1">Caption</figcaption></section>`
3. Whitelist already allows `<svg>` implicitly via figure/img — **confirm and extend if needed**

## Phases

Reordered so the **biggest "wow" (charts in chat)** lands as early as possible. Phase 6 (document embedding) is the only phase that depends on canvas — everything else can ship before canvas lands.

Phase order: **1 → 2 → 4 → 3 → 5 → 7 → 6**

### Phase 1 — Worker pool + basic execution + cancel/timeout

1. Bundle `pyodide` and its asset files into the Tauri app (verify they're under `apps/desktop/src-tauri` resources or served by Vite as static assets — confirm during implementation)
2. Create `apps/desktop/src/python/pyodide-worker.ts` — Web Worker that loads Pyodide, preloads libraries (`pandas`, `numpy`, `matplotlib`, `beautifulsoup4`, `lxml`, `requests`, `openpyxl`, `python-dateutil`, `pillow`), handles `execute` and `cancel` messages
3. Create `apps/desktop/src/python/python-kernel.ts` — main-thread controller that manages a **pool of N=3 workers** with LRU eviction, conversation-to-worker mapping, eager preload of one worker on app launch
4. Stdout/stderr capture via Pyodide's `setStdout`/`setStderr` — emit incremental chunks back to the main thread, **not buffered until completion**
5. Last-expression repr capture (Jupyter-style)
6. **Cancel button + 60-second wall-clock timeout from day one.** Cancel = `worker.terminate()` + spawn fresh worker into the same slot. Cancelled cells return whatever stdout was captured before termination.

**Verify:** call `executePython("import time; [print(i) or time.sleep(0.5) for i in range(5)]")` from a dev console, see lines 0–4 stream in over ~2.5s. Then call with a 70-second sleep and confirm timeout fires at 60s.

### Phase 2 — Agent tool + chat UI (Perplexity-style)

1. Add `run_python` tool to agent-core, flag-gated behind `experimental.pythonSandbox` (default off)
2. Server-side handler forwards to desktop via a new WS message `python_run` and receives streamed `python_result` chunks (`python_stdout`, `python_done`, `python_error`)
3. Desktop handles `python_run`, dispatches to the conversation's worker, streams stdout chunks back as they arrive
4. New ChatMessage type `code_cell` with `running` / `done` / `error` / `cancelled` states; supports **multi-cell per assistant turn** (cells render inline within the bubble, with agent narration text between them)
5. Rendering component `CodeCell.tsx`:
   - Code collapsed by default behind a chevron toggle, expanded on `error`
   - Streaming stdout while `running`, auto-collapses to one-line summary on `done`
   - Header chips: "Python", runtime version, duration, copy-code button
   - Stop button while `running`
   - Subtle styling: thin border, light background tint
6. Agent system prompt updated to:
   - Introduce code cells in plain language ("Analyzing the data…", "Fetching the page…")
   - Run multiple cells in sequence when appropriate (scrape → parse → chart)
   - Treat `run_python` as a thinking step, not a developer feature

**Verify:** enable flag, ask agent "what's 2+2 in python," code cell renders, collapses to "✓ 4". Ask "show me a list of squares from 1 to 100" and watch lines stream in.

### Phase 3 — Matplotlib + figure pipeline

1. Configure matplotlib to default SVG backend (`matplotlib.use('svg')` or `agg` + savefig to SVG)
2. Capture figures after `plt.show()` or explicit `savefig` via Pyodide's figure-capture API
3. Return figures in `run_python` result as `{ mime: 'image/svg+xml', data: '<svg>…</svg>' }`
4. Render inline in `CodeCell` at full bubble width; figures stay visible after the cell auto-collapses
5. Add a copy-figure button (copies SVG to clipboard)

**Verify:** "make me a bar chart of [1,2,3,4,5]" → chart renders in chat below the collapsed summary.

### Phase 4 — Filesystem bridge

1. Mount `~/.coagent/workspace/<conv_id>/` into Pyodide FS at `/workspace`
2. Bridge `~/.coagent/files/` (user uploads) at `/files` (read-only from Python)
3. Files created in `/workspace` auto-appear in FilesPane via existing file watcher
4. Agent system prompt updated: "User files are at /files (read-only). Write outputs to /workspace."

**Verify:** upload a CSV via FilesPane, ask "analyze sales.csv," agent reads from `/files/sales.csv`, produces summary, optionally saves a `summary.csv` to `/workspace` which appears in FilesPane.

### Phase 5 — Proxied network

1. Main-thread fetch bridge using Tauri's `http` client, with:
   - http/https only
   - No localhost / private IPs (RFC1918 + loopback blocklist)
   - Rate limit: 20 req/sec per conversation
   - Max response size: 10 MB
   - Per-request timeout: 30s
2. Override `requests.get` / `requests.post` / `urllib.urlopen` in Pyodide to post to main thread, return bytes
3. No allowlist by default (block by classification, not by domain); expose a setting to tighten rules per user

**Verify:** "fetch https://example.com and extract h1," agent uses `requests` + `bs4`, returns text. Then verify `requests.get('http://localhost:7830')` is blocked.

### Phase 6 — Document embedding (depends on canvas)

1. Add "Insert into document" button on figures in `done` code cells
2. Wire to `patch_canvas` (or canvas equivalent — check the final API after canvas lands) with a gallery section containing the SVG
3. Confirm HTML/canvas whitelist allows inline SVG inside figures; extend if not
4. Agent system prompt update: "to put a chart in a document, call patch_canvas after run_python"

**Verify:** full flow — run code → chart → click "insert" → shows up in canvas/HtmlDocumentPane.

### Phase 7 — Polish

1. Worker idle timeout + cleanup beyond the 30-min default
2. `micropip.install(...)` for arbitrary packages, surfaced as "loading package…" status in the cell
3. Memory limits per worker (Pyodide supports a soft limit via WebAssembly memory cap)
4. Error formatting: Python tracebacks rendered with file/line highlighting
5. "Rerun" button on completed cells
6. Full output expand for cells where stdout exceeded the visible cap

## Resolved decisions (was "Open questions")

1. **Bundle size.** ✅ **Bundle Pyodide in the Tauri app.** ~10 MB delta on a ~150 MB bundle is rounding error; offline-first wins.
2. **Cold start.** ✅ **Eager-preload one worker on app launch** so the first `run_python` call has no wait. Subsequent workers in the pool spin up lazily on demand.
3. **Worker pool vs one-per-conversation.** ✅ **Pool of N=3, LRU evict.** Caps memory at ~500 MB total. Workspace persists on disk; only in-memory imports are lost on eviction (cheap to re-import).
4. **Cancel + timeout placement in plan.** ✅ **Day-one in Phase 1**, not Phase 7. A python cell that runs forever with no stop button is a tester rage-quit waiting to happen.
5. **Streaming vs buffered output.** ✅ **Streaming from day one.** Auto-collapse to a one-line summary on completion; figures stay visible.
6. **E2B fallback for browser automation?** Future — park it, revisit if a user explicitly needs Playwright-level scraping.
7. **CPython subprocess via `uv` as a "trusted code mode"?** Future — would require cross-platform OS sandboxing (sandbox-exec / AppArmor / AppContainer). Park.

## Success criteria

1. Agent can answer "analyze this CSV" with real pandas output rendered inline in chat.
2. Agent can fetch a prospect's website, parse HTML, extract key signals (title, meta, CTAs, tech), report them.
3. Agent can generate a chart from data and insert it into an HTML document.
4. Kernel state persists across turns within a conversation (import pandas once, use many times).
5. Code execution works offline for anything that doesn't require network.
6. No per-user cost, no cloud dependency.
7. Chat-side code cells and document canvas remain conceptually separate surfaces.

## Out of scope

- JavaScript/Node/SQL execution
- Persistent cross-conversation kernels
- Real-time collaborative code editing
- Voice-driven code execution
- General-purpose IDE features
