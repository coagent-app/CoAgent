# CoAgent Codebase Audit — 2026-04-08 (follow-up)

**Scope:** Full-monorepo scan across security, architecture & tech debt, and code quality.
**Method:** 5 parallel exploration agents (agent-core, desktop, mobile + shared, MCP packages + team + relay, root/CI/scripts/hygiene).
**Baseline:** This is a *follow-up* to `2026-04-08-codebase-review.md` from earlier today. Each agent was instructed to confirm, refute, or move prior findings, and to surface new ones.
**Severity legend:** `HIGH` = fix soon, `MEDIUM` = plan a fix, `LOW` = nice to have.

> Line numbers are approximate — verify before editing.

---

## Executive summary

**Nothing from the prior report's HIGH list has been fixed.** Every HIGH finding from the morning scan still applies, in most cases at the same file and approximately the same line. Two items did improve (OAuth poll timeout in `useAgent.ts`; `build-edition.sh` now has `set -euo pipefail`), but no HIGH was closed.

**Seven NEW HIGH findings surfaced in this pass:**

1. **`apps/desktop/src-tauri/src/main.rs:644-650` — `write_file_bytes()` does NOT call `is_allowed_path()` before writing.** Arbitrary file write anywhere the desktop process can reach. This is the most urgent new finding. Fix: add `is_allowed_path(&path)?;` before `std::fs::write`.
2. **`apps/mobile/lib/useAgent.ts:100` — Unguarded `JSON.parse(event.data)` in the WS handler.** A single malformed relay packet throws, kills the handler, and hangs the mobile UI. Fix: wrap in try/catch and surface to UI error state.
3. **`apps/mobile/lib/useAgent.ts:65` — WebSocket token embedded in query string.** Same class of bug as `team-client.ts`; proxies and intermediaries can log the URL. Fix: move to `Authorization` header / WS subprotocol.
4. **`.github/workflows/build.yml:50` — Node.js downloaded via `curl -fsSL` with no checksum verification.** Supply-chain risk: a compromised CDN response bundles arbitrary binaries into the signed release. Fix: pin and verify SHA256 from `nodejs.org/dist/.../SHASUMS256.txt`.
5. **`apps/mobile/lib/useAgent.ts` (315 lines) — Mobile has its own god-hook.** Same pattern as desktop. Fix: split by domain (useChat, useVoice, useFileRequests).
6. **`apps/desktop/src/App.tsx:25` — 70+ state/methods destructured from `useAgent()` and drilled to children.** Context providers by domain would eliminate this. Fix: introduce ChatContext / IntegrationContext / RelayContext.
7. **`apps/mobile/lib/useAgent.ts:278-295` — Promise timeout leak in `requestFileContent()`.** Timeout `resolve(null)`s but never cleans up the pending Map entry, and the Promise can outlive the component. Fix: reject on timeout and delete Map entry in a `finally`.

**Top confirmed-unresolved HIGHs** that deserve action this week:

- `packages/agent-core/src/server.ts:1529,1534,1543,1595,1599` — PID command injection (unchanged).
- `apps/desktop/src-tauri/tauri.conf.json` — CSP `unsafe-inline` (unchanged).
- `packages/mcp-imessage/src/index.ts:362-378` — AppleScript injection (unchanged).
- `packages/relay/src/relay-do.ts:329` — HMAC verification is early-`return true`; lines 330-355 are dead code.
- `packages/mcp-exa/src/index.ts:33,36` — `RELAY_USER_ID` path traversal (unchanged).
- `packages/mcp-exa/src/exa-client.ts:189` — API key header, no redaction (unchanged).
- `.env` in repo root with real Google OAuth credentials (unchanged).
- `packages/agent-core/src/mcp-manager.ts:172-178` — Raw MCP stderr printed to console (unchanged).

**Suggested immediate batch (< 1 hour total):**

- Add `is_allowed_path` guard to `write_file_bytes` in `main.rs`.
- Wrap the mobile WS `JSON.parse` in try/catch.
- Harden `build-release.sh` with `set -euo pipefail`.
- Validate PIDs with `/^\d+$/` before interpolation in `server.ts` and `scripts/start-dev.js`.
- Add `*.mov`, `*.pdf`, `*.PNG`, `docs/plans/`, `docs/research/`, `packages/agent-core/test-*.{mjs,ts}`, `packages/agent-core/evals/`, `packages/agent-core/analyze-usage.js` to `.gitignore`.

---

## packages/agent-core

### Prior report status
- **Confirmed still present:** command injection in PID handling (`server.ts:1529,1534,1543,1595,1599`), sudoers temp-file race window (`scheduler.ts:56-72`), swallowed `.catch(() => {})` patterns, `agent.ts` (2,988 lines) and `server.ts` (3,244 lines) god-files, raw MCP stderr logging without redaction (`mcp-manager.ts:172-178`), path traversal sanitization fragile (`file-store.ts:249-251`), webhook-secret missing-safety path (`webhook-server.ts:16-22`).
- **Fixed since prior report:** none detected.
- **Moved/shifted:** PID kill commands now also at 1534 and 1597 — prior range was 1534-1599; verified.

### New findings

#### Security
- **HIGH** `src/server.ts:1599` — `lsof -ti:${PORT} | xargs kill -9` pipes unvalidated lsof output into `xargs kill`. Fix: read PIDs to array, validate `^\d+$` per entry, spawn `kill` via argv.

#### Architecture & tech debt
- **MEDIUM** `src/mcp-manager.ts:107-189` — Reconnect state spread across 6 Maps (`clients`, `serverConfigs`, `reconnectTimers`, `reconnectAttempts`, `connectingNow`, `pendingInits`); invariants are implicit. Fix: replace with `Map<name, ServerState>` where each server owns a single state object/enum.
- **MEDIUM** `src/file-store.ts:375-420` — k-means clustering lives inside the file store. Fix: extract to a standalone utility module so storage stays focused on persistence.
- **MEDIUM** `src/scheduler.ts:262-287, 314-375, 433-519, 527-616` — Generation-counter race guards are correct but subtle across multiple timer callbacks. Fix: consolidate into a single scheduler state machine.

#### Code quality
- **MEDIUM** `src/agent.ts:843-848, 1439, 1500, 1598` — `.catch(() => {})` swallows MCP and file-embed failures; UI gets no error signal. Fix: central error registry the UI can subscribe to.
- **MEDIUM** `src/sub-agent.ts:129-131` — OpenAI/Anthropic responses cast to `any` with no schema validation; streaming shape changes will break silently. Fix: small runtime schema check before proceeding.
- **MEDIUM** `src/relay-client.ts:313-316, 400-412` — Ping `setInterval` and reconnect `setTimeout` have no explicit cleanup if the client is destroyed unexpectedly. Fix: store timer ids, clear on disconnect, explicit destructor.
- **MEDIUM** `src/file-store.ts:176-181, 1022` — File type inferred purely from extension. Fix: validate magic bytes at upload/load time.
- **LOW** `src/custom-mcp.ts:55-65` — Credentials written to `.env` with only quote escaping; newlines corrupt the file. Fix: use a real dotenv serializer.
- **LOW** `src/research.ts:116-122` — Silent empty `exaTools` array if Exa MCP fails to load. Fix: surface the failure at startup.

### Notable positives
- MCPManager reconnect logic (exponential backoff, `connectingNow` dedupe, on-demand reconnect before tool calls) is genuinely well-designed.
- Shell sandbox (`shell.test.ts`) shows a thoughtful threat model (rm -rf /, sudo, chmod 777, fork bombs).
- Sub-agent guardrails (BLOCKED_TOOLS + per-action read-only constraints) limit blast radius.
- Timer cleanup in `mcp-manager.ts` and `scheduler.ts` is generally complete.
- Conversation history capping and cache breakpointing in `agent.ts` show careful token-budget management.
- WebSocket auth timeout at `server.ts:1932` is a good defensive practice.

---

## apps/desktop

### Prior report status
- **Confirmed still present:** plaintext localStorage caching of messages + integration auth (`src/hooks/useAgent.ts:15-25`), CSP `unsafe-inline` (`src-tauri/tauri.conf.json`), raw ObjC FFI scattered in `main.rs:350-550`, `ChatPane.tsx` (~983 lines) still un-split, global mutable state in `lib/voice.ts`, QR code embeds relay token + userId with no single-use semantics (`IntegrationsModal.tsx:44-49`), watchdog does not emit UI events on repeated crash (`main.rs:749`).
- **Fixed since prior report:** OAuth poll now has a hard cap of ~18 attempts (~90s) with cleanup via a `pollIntervals` array — prior "no timeout" finding at `useAgent.ts:220-280` is **resolved**. Hand-rolled base64 decoder in `main.rs:590-637` is now length-validated and appears correct — downgrade the prior MEDIUM to LOW.
- **Moved/shifted:** OAuth poll cleanup moved to `useAgent.ts:114-115`.

### New findings

#### Security
- **HIGH** `src-tauri/src/main.rs:644-650` — `write_file_bytes()` does not call `is_allowed_path()` before `std::fs::write`. Arbitrary file write. Fix: `is_allowed_path(&path)?;` before write.
- **MEDIUM** `src-tauri/src/main.rs:365-393` — `reveal_in_file_manager()` validates via `is_allowed_path()` but then passes the non-canonical `&path` into the subsequent `open()` calls on lines 370, 373. A symlink flipped between check and use bypasses the guard. Fix: use canonical path from validation throughout.

#### Architecture & tech debt
- **HIGH** `src/App.tsx:25` — Single destructuring pulls 70+ state variables and methods from `useAgent()` and prop-drills to children. Fix: domain context providers (ChatContext, IntegrationContext, RelayContext).
- **MEDIUM** `src/lib/voice.ts:6-18, 31, 74, 176-178, 186-189` — Global module-level mutable state (`audioChunks`, `speechCheckInterval`, `cachedStream`, `ttsQueue`, `ttsPlaying`, `ttsOnAllDone`) with no cleanup guarantees on error paths. Fix: encapsulate in a class / Zustand store with explicit lifecycle.
- **MEDIUM** `src/components/CanvasPane.tsx:42` — Tailwind Play CDN script is injected inline as `<script>${tailwindPlayRaw}</script>`. If `tailwindPlayRaw` is ever dynamically updated, XSS. Fix: add a code comment + test asserting the file is static, and/or hash-check at build time.

#### Code quality
- **MEDIUM** `src/components/ChatPane.tsx:428, 458, 819, 848, 890, 909` — Multiple `.map()` loops use the array index as React `key`. Reorder/filter causes stale component state. Fix: use stable unique ids.
- **LOW** `src/lib/voice.ts:200-209` — `playNextTtsSegment()` only `URL.revokeObjectURL()`s on success; `onerror` leaks the object URL. Fix: revoke in `onended` AND `onerror`.
- **LOW** `src/components/ChatPane.tsx:428-437` — Drag-drop `FileReader` has no `onerror`. Fix: add `reader.onerror = () => { console.error(...) }`.
- **LOW** `src/components/DetailPane.tsx:129-137` — Metadata rendered without guarding against non-string values; objects show as `[object Object]`. Fix: `JSON.stringify` non-strings.

### Notable positives
- Voice pill event system (`emitTo`) is cleanly decoupled from the chat loop and properly cleaned up on unmount.
- Canvas iframe uses `sandbox="allow-same-origin allow-modals"` to isolate agent-generated code.
- `is_allowed_path()` logic (canonicalize + prefix check + dotfile deny) is sound — the issue is inconsistent application across callers.
- Dictation hook properly unlistens on unmount.
- File drag-drop handler removes listeners on cleanup.

---

## apps/mobile + packages/shared

### Prior report status
- **Confirmed still present:** deep-link handler accepts token/relay/userId without origin validation (`apps/mobile/app/_layout.tsx:15-30`), WS JSON parse failures swallowed (`apps/mobile/lib/useAgent.ts:30-50`), `fileContentPending` map leaks unresolved promises (`apps/mobile/lib/useAgent.ts:60-80`), shared package exposes 30+ types with no runtime validators.
- **Fixed since prior report:** none; secure-storage usage for tokens remains in place (no regression).
- **Moved/shifted:** none.

### New findings

#### Security
- **HIGH** `apps/mobile/lib/useAgent.ts:100` — Unguarded `JSON.parse(event.data)` in the WebSocket handler. A single malformed relay packet throws synchronously and kills the handler. Fix: wrap in try/catch; emit error state to the UI.
- **HIGH** `apps/mobile/lib/useAgent.ts:65` — WS URL builds token as query param (`ws://...?token=${creds.token}`). Tokens may appear in proxy logs. Fix: move to `Authorization` header / WS subprotocol.
- **MEDIUM** `apps/mobile/app/_layout.tsx:22-28` — Deep-link URL parsing trusts any `token`, `relay`, `userId` without validating format; `coagent://scan?token=ANYTHING` silently overwrites stored credentials. Fix: validate length/format, add origin pinning or signing.
- **MEDIUM** `apps/mobile/lib/useAgent.ts:78-83` — Push token registration sends plaintext token over WS with no scheme assertion. Fix: require `wss://` in production builds.

#### Architecture & tech debt
- **HIGH** `apps/mobile/lib/useAgent.ts:1-315` — 315-line monolithic hook managing chat, streaming, tools, voice, files, settings, notifications, push tokens. Fix: split into domain hooks (useChat, useVoice, useFileRequests).
- **MEDIUM** `packages/shared/src/index.ts` — 384-line type surface with no runtime validators; `WSClientMessage`/`WSServerMessage` are compile-time only. A malformed relay response crashes at runtime. Fix: export zod/valibot schemas alongside types.
- **MEDIUM** `apps/mobile/lib/voice.ts:199-211` — Uses `globalThis.__ttsChunkHandler`, `__ttsDoneHandler`. Re-registration between screens races. Fix: callback manager keyed by sessionId instead of globals.

#### Code quality
- **HIGH** `apps/mobile/lib/useAgent.ts:278-295` — `requestFileContent()` timeout `resolve(null)`s but never cleans up the pending-map entry and the Promise can outlive the component. Fix: reject on timeout, delete from map in `finally`, use `AbortSignal`.
- **MEDIUM** `apps/mobile/app/_layout.tsx:30` — Silent `catch {}` swallows deep-link parse errors; app stays on the scan screen with no feedback. Fix: log and surface to user.
- **MEDIUM** `apps/mobile/lib/useAgent.ts:196` — `Notifications.scheduleNotificationAsync(...).catch(() => {})` silently drops notification failures. Fix: log + consider fallback UX.
- **LOW** `apps/mobile/lib/voice.ts:114` — `atob(base64Chunk)` in `handleTtsChunk()` with no try/catch; invalid base64 crashes TTS playback. Fix: validate or wrap.

### Notable positives
- `expo-secure-store` is correctly used for credentials, push tokens, and notification prefs — no plaintext secret caching.
- `setError()` UI state (auto-clear after 5s) is a good surfacing pattern for user-facing issues.
- Voice cleanup (haptics, recording, handlers) is well-structured with explicit teardown on unmount and blur.
- Push token registration is correctly gated behind device check and permission request.

---

## MCP packages + team-core + relay

### Prior report status
- **Confirmed still present:** `memory-store.ts:257` string-concat LanceDB delete, `mcp-imessage/src/index.ts:378` AppleScript injection, `packages/relay/src/relay-do.ts:329` HMAC verification disabled, `packages/mcp-exa/src/index.ts:33,36` `RELAY_USER_ID` path traversal, `packages/mcp-exa/src/exa-client.ts:189` API key logging, `args!` unvalidated casts across MCP servers.
- **Fixed since prior report:** none detected.
- **Moved/shifted:** none detected.

### New findings

#### packages/mcp-memory
- **HIGH** `src/memory-store.ts:488` — `saveIndexedAt()` `writeFile` is `.catch(() => {})`'d; write failures silently lose indexing state. Fix: await and propagate error.
- **MEDIUM** `src/memory-store.ts:176-182` — `assertSafePath()` uses `startsWith(memoryDir + '/')` without symlink resolution or case normalization. Fix: `realpath()` + canonical compare.
- **LOW** `src/memory-store.ts:156, 575-578` — Bare `catch {}` in multiple spots suppress DB errors silently.

#### packages/mcp-contacts
- **MEDIUM** `src/index.ts:195-197` — Opens DBs `{ readonly: true }` but never asserts enforcement. Fix: belt-and-suspenders write-attempt test at startup.

#### packages/mcp-exa
- **MEDIUM** `src/exa-client.ts:129-133` — `loadLeadSchema()` silently returns `null` on missing/invalid schema; agents don't know whether custom schema is in effect. Fix: log a warning or surface the absence.
- **LOW** `src/exa-client.ts:298-300` — `listMonitors()` normalizes three different response shapes into `[]`, hiding API changes. Fix: log which shape was returned.

#### packages/mcp-imessage
- **MEDIUM** `src/index.ts:362-378` — Recipient regex `/^[\d+\-() ]+$/` allows spaces, which can cause AppleScript buddy lookup ambiguity and interact poorly with the existing quote-escape. Fix: normalize to canonical E.164 or whitelist without spaces.
- **LOW** `src/index.ts:293` — `prefetch = limit * 4` unbounded; `limit=100` fetches 400 messages. Fix: cap at `min(limit*4, 500)`.

#### packages/team-core
- **MEDIUM** `src/team-log.ts:162-183` — `embed()` has no timeout; a hanging relay stalls all future embeddings. Fix: AbortController timeout mirroring `memory-store.ts`.
- **MEDIUM** `src/team-client.ts:81` — WebSocket URL still embeds `relayToken` in query string despite prior report. Header auth landed in `fetchRoster()` but not the WS upgrade. Fix: move to `Authorization` header.

#### packages/relay
- **MEDIUM** `src/relay-do.ts:73-80` — First-connection token registration accepts any `?token=` length/shape. A 10MB token persists to DO storage. Fix: validate length `< 1024` and `^[A-Za-z0-9_\-]+$`.
- **MEDIUM** `src/relay-do.ts:171` — Push token stored without format validation. Fix: validate Expo token shape.
- **MEDIUM** `src/relay-do.ts:329` — `return true` makes lines 330-355 dead code; HMAC verification entirely bypassed. Fix: remove the early return and restore verification (or delete the dead path and own the risk explicitly).

### Cross-cutting observations
- **Timeout inconsistency:** `memory-store.ts` has a 15s embedding timeout; `team-log.ts` has none; relay has no rate limits on first-connection. Standardize.
- **Silent error swallowing:** 5+ `.catch(() => {})` / bare `catch {}` across memory-store, team-log, relay. Introduce `logAndThrow()` and migrate.
- **Validation gaps in data flows:** `args!` casts in MCP servers; unvalidated push tokens in relay; unvalidated envelope shapes in team-client. A shared `validateToolArgs(schema, args)` middleware in `packages/shared` would eliminate a class of bugs.
- **Response-shape normalization fragility:** Exa `listMonitors()` silently coalesces 3 shapes; relay HMAC silently passes. Fail loudly on unexpected shapes.

### Notable positives
- Bounds checking in `parseAttributedBody()` (mcp-imessage) is defensive and correct.
- `memory-store.ts` AbortController timeout is a good pattern to replicate.
- `mcp-contacts` SQL is properly parameterized.
- `mcp-manager` + `relay-client` reconnect/backoff patterns are consistent and testable.

---

## Root, scripts, CI, hygiene

### Prior report status
- **Confirmed still present:** `scripts/build-release.sh:2` missing `set -euo pipefail`, `scripts/start-dev.js:3,15,19,24` template-string subprocess composition, `.env` with plaintext Google OAuth, `sleep 5` race workaround in `.github/workflows/build.yml:178`, untracked media files, missing `.gitignore` entries.
- **Fixed since prior report:** `scripts/build-edition.sh` now uses `set -euo pipefail` (one-line improvement).
- **Moved/shifted:** none.

### New findings

#### Security
- **HIGH** `.github/workflows/build.yml:50` — Node.js tarball downloaded via `curl -fsSL` with no checksum verification. A compromised CDN response bundles arbitrary binaries into a signed release. Fix: pin a version and verify against `SHASUMS256.txt` before extracting.
- **MEDIUM** `scripts/start-dev.js:19` — Windows branch uses `split(/\s+/).pop()` into `taskkill /PID ${pid}`; macOS branch uses `parseInt` but Windows path has no validation. Fix: validate `^\d+$` on both platforms before interpolation.

#### Scripts
- **HIGH** `scripts/build-release.sh:2` — Still only `set -e`. Fix: `set -euo pipefail`.
- **MEDIUM** `scripts/start-dev.js:77, 101` — Child processes spawned with full `process.env`; `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `COMPOSIO_API_KEY` leak to processes that don't need them. Fix: explicit env allowlist per child.

#### CI/CD
- **LOW** `.github/workflows/build.yml:178` — `sleep 5` rename-assets race workaround remains. Fix: poll `gh release view` until assets appear.

#### Repo hygiene
**Current untracked that should be gitignored or moved out of the working tree:**
- `Replit Checkpoints.mov` (~106 MB) — violates any reasonable repo size policy.
- `IMG_1955.PNG` and 6 `Screenshot 2026-04-08 at *.png` files.
- 3 committed-target PDFs at root: `Customer_Win_Vertex_Manufacturing.pdf`, `Product_Launch_Retrospective.pdf`, `Q1_2026_Paid_Media_Performance_Report.pdf`.
- `TOKEN_OPTIMIZATION_REPORT.md`, `setup.md` at root.
- Scratch utilities: `packages/agent-core/analyze-usage.js`, `packages/mcp-memory/inspect.js`, `packages/mcp-memory/test-search.js`.
- Scratch tests: 9+ `packages/agent-core/test-*.mjs` / `test-*.ts` files (same as prior report).
- New: `packages/agent-core/evals/` test-harness directory.
- New: `packages/agent-core/presets/` — decide if committed artifact or scratch.
- `scripts/test-brian-live.ts` — untracked despite being in `scripts/`.

**Current untracked that may be intentional and should be committed or explicitly ignored:**
- `docs/plans/2026-04-0{7,8}-*.md` (4 planning docs).
- `docs/research/` (empty or nearly so — check).
- `docs/reviews/2026-04-08-codebase-review.md` (the earlier report itself — currently untracked).
- `coagent-logo.png`.

**`.gitignore` gaps (still unfixed from prior report):**
- No patterns for `*.mov`, `*.pdf`, `*.PNG`.
- No patterns for `docs/plans/`, `docs/research/`.
- No patterns for `packages/agent-core/test-*.{mjs,ts}`.
- No patterns for `packages/agent-core/evals/`, `packages/agent-core/presets/`.
- No pattern for `packages/agent-core/analyze-usage.js`, `packages/mcp-memory/{inspect,test-search}.js`.

**Total untracked count:** ~35 files (up from the prior snapshot — `evals/`, `presets/`, and new scratch scripts have been added since).

### Notable positives
- `build-edition.sh` was upgraded to `set -euo pipefail` since this morning.
- `pnpm-lock.yaml` committed and current.
- No `pull_request_target` workflows; CI triggers only on tag push / manual dispatch.
- All secrets referenced via `${{ secrets.* }}`.
- `build-release.sh` degrades gracefully when `APPLE_SIGNING_IDENTITY` is absent.

---

## Suggested next actions

### Quick wins (under 1 hour total)
1. Add `is_allowed_path(&path)?;` to `write_file_bytes` in `apps/desktop/src-tauri/src/main.rs:644`.
2. Wrap `JSON.parse(event.data)` in a try/catch at `apps/mobile/lib/useAgent.ts:100`.
3. `set -euo pipefail` in `scripts/build-release.sh`.
4. PID regex validation (`^\d+$`) in both `packages/agent-core/src/server.ts:1529-1599` and `scripts/start-dev.js`.
5. `.gitignore` additions: `*.mov`, `*.pdf`, `*.PNG`, `docs/plans/`, `docs/research/`, `packages/agent-core/test-*.{mjs,ts}`, `packages/agent-core/evals/`, `packages/agent-core/analyze-usage.js`, `packages/mcp-memory/{inspect,test-search}.js`.
6. Remove `.env` from the working tree; move creds to Keychain / `~/.config/coagent/`.

### Focused security sprint (half day)
- Re-enable HMAC verification in `packages/relay/src/relay-do.ts:329` (delete `return true`).
- Fix `reveal_in_file_manager()` to use the canonical path end-to-end.
- Fix AppleScript injection in `mcp-imessage` (argv form of `osascript`, strict recipient normalization).
- Validate `RELAY_USER_ID` against `^[A-Za-z0-9_\-]+$` in `mcp-exa`.
- Pin+verify Node.js tarball checksum in `.github/workflows/build.yml`.
- Central redaction helper + run MCP stderr, Exa headers, and team-log request logs through it.
- Move desktop WS + team-core WS + mobile WS token handling to `Authorization` / subprotocol consistently.

### Architecture work (multi-day)
- Split `apps/desktop/src/hooks/useAgent.ts` AND `apps/mobile/lib/useAgent.ts` into domain hooks (same operation, both codebases).
- Introduce context providers in `apps/desktop/src/App.tsx` so `ChatPane`/`DetailPane`/`FilesPane` consume per-domain contexts instead of prop-drilling 70+ values.
- Begin extraction of `agent.ts` / `server.ts` — start with `ToolRunner` / `MessageExecutor`.
- Export runtime validators (zod/valibot) from `packages/shared` and migrate every MCP server, WS client, and relay handler to them.
- Introduce `safeExecAppleScript()` in `packages/shared` and migrate both `agent-core` and `mcp-imessage`.
- Consolidate timer management and cleanup across `mcp-manager`, `scheduler`, `relay-client`, `voice`.

### Nice-to-have
- Replace `file-store` k-means with an extracted utility.
- Replace hand-rolled base64 in `main.rs` with the `base64` crate (now downgraded to LOW — current implementation appears correct).
- Add timeouts to `exa-client.ts` and `team-log.ts` embedding calls.
- Watchdog emits a Tauri event when giving up so the UI can show "repeated crash — reload" instead of silently dying.
- `pnpm` workspace: add `.gitignore` entries for scratch files so `git status` stays meaningful.

---

*Generated from 5 parallel exploration passes. Line numbers are approximate; verify before editing. Follow-up to `2026-04-08-codebase-review.md`.*
