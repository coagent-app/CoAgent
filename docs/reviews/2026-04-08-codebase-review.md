# CoAgent Codebase Review — 2026-04-08

**Scope:** High-level scan of the entire monorepo across architecture & tech debt, security, and code quality.
**Method:** 4 parallel exploration agents (agent-core, desktop/mobile apps, other packages + relay, root/CI/secrets).
**Severity legend:** `HIGH` = fix soon, `MEDIUM` = plan a fix, `LOW` = nice to have.

> This is a scan, not a line-by-line audit. Findings reference files + approximate line numbers; verify before acting.

---

## Top priorities (do these first)

These are the findings with the highest blast-radius relative to effort:

1. **HIGH — Command injection surface in `server.ts` PID handling.** `packages/agent-core/src/server.ts:1534-1599` interpolates PIDs extracted from `execSync(netstat/lsof)` output directly into kill commands. A malformed or malicious PID could execute arbitrary shell. Fix: validate `/^\d+$/` before use, or pass as argv to `spawnSync`.
2. **HIGH — AppleScript injection in `mcp-imessage`.** `packages/mcp-imessage/src/index.ts:378` escapes single quotes but not newlines, so a message body containing `\nend tell\n` can break out of the script context. Fix: use `osascript -e` with argv rather than template strings, or strip/escape newlines explicitly.
3. **HIGH — `.env` in repo root contains real Google OAuth credentials.** File is gitignored and not tracked, but still lives in the working tree. If a backup, sync, or screen-share happens, those secrets are exposed. Fix: move to macOS Keychain / 1Password / Tauri vault for dev, keep only `.env.example` in tree.
4. **HIGH — Relay HMAC webhook verification disabled.** `packages/relay/src/relay-do.ts:329` has a TODO comment and unverified webhook path for Composio. Any attacker who can reach the relay endpoint can forge webhooks. Fix: re-enable HMAC check, drop the TODO.
5. **HIGH — CSP allows `unsafe-inline`.** `apps/desktop/src-tauri/tauri.conf.json` (and verified in `App.tsx:70-80` review) allows inline scripts and styles. With agent-rendered markdown/HTML flowing through the UI, this is an XSS amplifier. Fix: move to hashed or nonced CSP, strip `unsafe-inline`.
6. **HIGH — Exa API key may leak via logs.** `packages/mcp-exa/src/exa-client.ts:189` passes the key as a header with no log redaction. If any middleware or error path dumps headers, the key is in stdout. Fix: central redaction utility.
7. **HIGH — Exa webhook URL built from unvalidated `RELAY_USER_ID`.** `packages/mcp-exa/src/index.ts:33,36` string-interpolates `RELAY_USER_ID` into a URL path with no validation — allows path traversal. Fix: validate against `^[A-Za-z0-9_-]+$`.
8. **HIGH — `useAgent.ts` is a 1000+ line god-hook.** `apps/desktop/src/hooks/useAgent.ts` — managing chat, queue, messages, settings, integrations, files, relay, team, and canvas in a single hook is a major maintenance risk. Split by domain (useChat, useIntegrations, useFiles...).
9. **HIGH — `agent.ts` (2,959 lines) and `server.ts` (3,244 lines) are god-files.** `packages/agent-core/src/agent.ts`, `src/server.ts`. Both mix too many concerns to reason about safely. Incremental extraction (tool-executor, message-handler, state-manager, calendar) will pay back quickly.
10. **HIGH — Mobile/desktop localStorage caches sensitive state in plaintext.** `apps/desktop/src/hooks/useAgent.ts:15-25` caches messages and integration auth state across restarts. Fix: encrypt at rest via Tauri vault, or exclude auth state from the cache.

---

## packages/agent-core

### Architecture & tech debt
- **MEDIUM** `src/agent.ts:2959` and `src/server.ts:3244` — Monolithic files (~3k lines each) mixing message handling, tool execution, state, settings, calendar, file ops, and integrations. Extract focused modules.
- **MEDIUM** `src/mcp-manager.ts:107-151` — Reconnect state spread across many Maps (`clients`, `serverConfigs`, `reconnectTimers`, `reconnectAttempts`, `connectingNow`, `pendingInits`). Consider a per-server state enum/class so invariants are enforced in one place.
- **MEDIUM** `src/file-store.ts:380-410` — k-means clustering lives inside the file store. Move ML logic to a dedicated utility so storage stays focused on persistence.
- **MEDIUM** `src/scheduler.ts` — Heartbeat/brief/task/routine timers use generation counters for race prevention; logic is hard to follow. A single scheduler state machine would be clearer.
- **LOW** `src/sub-agent.ts:42` — `BLOCKED_TOOLS` is a denylist; any new side-effecting tool silently bypasses the guard unless someone remembers to update it. Prefer an allowlist or explicit permissions schema.

### Security
- **HIGH** `src/server.ts:1534,1538,1543,1597,1599` — Command injection risk: PIDs from `execSync(netstat/lsof)` interpolated directly into kill commands. Validate `^\d+$` or use argv form.
- **HIGH** `src/server.ts:1529` — Fragile Windows netstat parsing (`split(/\s+/).pop()`). Defensive parsing + validation required.
- **HIGH** `src/mcp-manager.ts:161-173` — Raw subprocess stderr is printed with a `[MCP:name]` prefix. Stderr can contain API keys from misbehaving servers. Add redaction before logging.
- **MEDIUM** `src/scheduler.ts:44-60` — Sudoers setup via `osascript` writes to `/tmp` then admin-moves it, leaving a read-window during which a local attacker could see the content. Use a secure temp file with restricted perms.
- **MEDIUM** `src/file-store.ts:234-290` — Path traversal sanitization strips literal `..` but does not normalize percent-encoded variants. Fine today, but fragile if callers add URL decoding.
- **MEDIUM** `src/webhook-server.ts:16-18` — If `WEBHOOK_SECRET` is unset the comparison path accepts any request in some code paths. Explicitly fail closed when secret is missing.

### Code quality
- **MEDIUM** `src/agent.ts:843-848` et al. — Many `.catch(console.error)` patterns swallow failures (including MCP connection errors) without surfacing state. Consider an error registry the UI can read.
- **MEDIUM** `src/sub-agent.ts:91,166` — OpenAI/Anthropic responses cast to `any`; no schema validation. Streaming shapes will break this silently.
- **MEDIUM** `src/scheduler.ts:262-287` — Generation-counter race guards are correct but subtle. Add an assertion and a comment describing the invariant.
- **MEDIUM** `src/file-store.ts:176-181` — File type inferred purely from extension. A renamed PDF will be treated as text. Validate magic bytes or at least the declared mimeType.
- **MEDIUM** `src/mcp-manager.ts:261-274` — `cacheVersion` as integer; won't overflow in practice, but a `Symbol()` bust is clearer and can't surprise you in very long-running processes.
- **LOW** `src/custom-mcp.ts:78-85` — Credentials written to `.env` with only quote escaping. Newlines or special chars will corrupt the file. Use a real dotenv serializer.
- **LOW** `src/research.ts:120-125` — Silent empty `exaTools` array if Exa MCP fails; sub-agents then fail opaquely. Fail loudly at startup or surface the absence.

### Notable positives
- MCPManager reconnect logic is genuinely well-designed: exponential backoff, dedupe via `connectingNow`, on-demand reconnect before tool calls, explicit `disconnect()` bookkeeping.
- Shell sandbox (`shell.test.ts`) demonstrates a thoughtful threat model (rm -rf /, sudo, chmod 777, fork bombs) with HOME override and cwd lock.
- Sub-agent guardrails (BLOCKED_TOOLS + per-action read-only constraints) limit blast radius of compromise.
- EPIPE detection → reconnect → retry is a nice resilience pattern.

---

## apps/desktop & apps/mobile

### Architecture & tech debt
- **HIGH** `apps/desktop/src/hooks/useAgent.ts` — 1000+ line monolithic hook managing all agent state. Split into domain hooks (chat, integrations, files, relay, team, canvas).
- **MEDIUM** `apps/desktop/src/components/ChatPane.tsx` — ~500 lines handling rendering, uploads, dictation, skill autocomplete, streaming, placeholders. Extract FileDeck, PdfInlinePreview, Lightbox, dictation.
- **MEDIUM** `apps/desktop/src/App.tsx:40-45` — 50+ props spread from `useAgent` down into children. Introduce context providers by domain.
- **HIGH** `apps/desktop/src-tauri/src/main.rs:350-550` — Raw Objective-C FFI (sel_registerName, objc_msgSend, unsafe pointers) scattered across the Rust side. Isolate in a dedicated `macos_ffi` module with safe wrappers and tests.
- **LOW** `apps/desktop/src/lib/voice.ts:1-100` — Global mutable state (mediaRecorder, audioChunks, cachedStream, ttsQueue). Encapsulate in a class or Zustand store.
- **MEDIUM** `apps/mobile/lib/useAgent.ts:60-80` — WebSocket JSON parse failures are logged then swallowed; malformed relay messages can leave the UI hung without feedback.

### Security
- **HIGH** `apps/desktop/src/hooks/useAgent.ts:15-25` — Sensitive state (messages, integration auth) cached to localStorage in plaintext across app restarts. Encrypt at rest or exclude.
- **HIGH** `apps/desktop/src-tauri/tauri.conf.json` (see `App.tsx:70-80`) — CSP allows `'unsafe-inline'` for both script-src and style-src. With agent-rendered content flowing through, this is an XSS amplifier. Move to nonced/hashed CSP.
- **MEDIUM** `apps/desktop/src-tauri/src/main.rs:200-250` — `is_allowed_path()` canonicalizes before prefix-checking, but edge cases (symlinks through non-existent intermediate paths) can bypass. Audit every `open_file`/`read_file_bytes` call site.
- **MEDIUM** `apps/desktop/src/components/IntegrationsModal.tsx:180-220` — QR code embeds relay token, URL, and userId directly. If screen-captured or logged, the pairing secret is compromised. Issue short-lived single-use codes instead.
- **MEDIUM** `apps/desktop/src-tauri/src/main.rs:540-560` — Hand-rolled base64 decoder for `write_file_bytes`. Replace with the `base64` crate.
- **MEDIUM** `apps/mobile/app/_layout.tsx:15-30` — Deep-link handler accepts token/relay/userId from URL params without origin validation, replay protection, or PKCE/nonce.
- **LOW** `apps/desktop/src/lib/voice.ts:350-370` — Audio upload size check (`< 1000 bytes`) is too loose; add duration/entropy validation.

### Code quality
- **HIGH** `apps/desktop/src/hooks/useAgent.ts:220-280` — OAuth poll `setInterval` with no timeout or failure path. Wrap in `Promise.race` with a max lifetime.
- **MEDIUM** `apps/desktop/src/components/ChatPane.tsx:250-300` — `useDictation` uses `globalThis.__ttsChunkHandler` and custom events without type safety; race-prone if multiple listeners attach.
- **MEDIUM** `apps/desktop/src/lib/voice.ts:600-650` — `startDictation`/`stopRecordingAndSend` can leak `MediaStream`/`AudioContext` resources on error paths.
- **LOW** `apps/desktop/src/components/DetailPane.tsx:100-130` — `ReactMarkdown` with `remark-gfm` rendering agent output — React escapes by default but any custom renderer could re-introduce XSS. Keep an eye on this.
- **MEDIUM** `apps/desktop/src-tauri/src/main.rs:600-700` — Watchdog gives up after N crashes and emits nothing to the UI. Surface a Tauri event so the user sees repeated failures.
- **MEDIUM** `apps/mobile/lib/useAgent.ts:30-50` — `fileContentPending` map can leak unresolved promises if the relay never responds past the 15s timeout.
- **LOW** `apps/desktop/src/components/ChatPane.tsx:600-650` — pdfjs-dist worker loaded via `import.meta.url`; silent failure → blank preview. Add a fallback.

### Notable positives
- Tauri capabilities are scoped per IPC command rather than blanket filesystem access — good defense in depth.
- Mobile app uses `expo-secure-store` for tokens/push tokens (not AsyncStorage).
- Desktop WebSocket performs nonce validation before sending sensitive state.
- Voice pill architecture is cleanly event-driven, decoupled from the chat loop.

---

## Other packages & relay

### packages/mcp-memory
- **HIGH** `src/memory-store.ts:257` — `.delete()` builds a `path = '${escaped}'` filter via string concat + quote escaping instead of parameterization. LanceDB's API may be limited, but the pattern is risky; at minimum centralize and document the escape rule.
- **MEDIUM** `src/memory-store.ts:176-181` — `startsWith(memoryDir + '/')` path check won't catch symlinks or case differences on macOS. Use `realpath` + canonical compare.
- **MEDIUM** `src/memory-store.ts:488-489` — `saveIndexedAt` silently `.catch(() => {})`s write errors; indexing state can be silently lost.
- **MEDIUM** `src/index.ts:122,127,132,137,142` — Tool args cast with `args!` and `as string` without validation. Add a schema-check middleware.
- **LOW** `src/memory-store.ts:156,307,348,412,483` — Bare `catch {}` blocks hide I/O and DB errors.

### packages/mcp-contacts
- **MEDIUM** `src/index.ts:195-224` — Opens SQLite with `readonly: true` but never asserts readonly mode before querying. Cheap to add a belt-and-suspenders check.
- **MEDIUM** `src/index.ts:237-243` — Dedupes contacts by lowercased name only; two different people with the same name collapse silently.
- **LOW** `src/index.ts:248-250` — DB handles cleaned up in `finally` but only after push to `allDbs`; partial setup failures can leak handles.

### packages/mcp-exa
- **HIGH** `src/exa-client.ts:189` — API key passed in headers with no redaction hook. Add a logger that scrubs `x-api-key`.
- **HIGH** `src/index.ts:33,36` — Webhook URL built from `RELAY_USER_ID` with no validation — path traversal possible. Regex-validate.
- **MEDIUM** `src/exa-client.ts:169-178` — `getDefaultContents()` hardcodes a schema that agents can override via `save_lead_schema`, producing inconsistent validation expectations.
- **MEDIUM** `src/index.ts:178-189` — Regex-based contact parsing accepts malformed inputs that downstream validation rejects — wasted API calls.
- **LOW** `src/exa-client.ts:298-300` — `listMonitors()` silently coalesces `json.data`/`json.monitors`/missing into `[]`.

### packages/mcp-imessage
- **HIGH** `src/index.ts:378` — AppleScript injection: only single quotes are escaped; a `\n end tell \n` in message text can break out. Use argv form of `osascript` or strip newlines.
- **HIGH** `src/index.ts:364` — Recipient regex allows spaces in phone numbers and permits characters that can enable semicolon injection downstream. Use real phone/email parsers.
- **MEDIUM** `src/index.ts:251-254` — SQL is parameterized correctly, but `limit * 4` prefetch can OOM on large message databases. Cap the multiplier.
- **MEDIUM** `src/index.ts:37-78` — `parseAttributedBody()` typedstream parser reads `buf[p+2]`, `buf[p+3]` without bounds checks. Malformed blobs may crash or produce garbage.
- **LOW** `src/index.ts:328-349` — Post-prefetch filtering over possibly-corrupted text can return false matches.

### packages/shared
- **LOW** `src/index.ts` — Large type surface with no versioning or deprecation markers. A breaking change to `WSClientMessage` or `ApprovalItem` will silently desync clients.
- **LOW** — No runtime validation helpers exported alongside the types; dynamic message construction has no compile-time safety net.

### packages/team-core
- **MEDIUM** `src/team-client.ts:81` — WebSocket URL embeds `relayToken` in the query string. Move to `Authorization: Bearer`.
- **MEDIUM** `src/team-log.ts:162-174` — Embedding requests send the token in plaintext with no HTTPS assertion; a proxy downgrade would leak it.
- **MEDIUM** `src/team-log.ts:87-105` — DM filter uses `dmId.replace('-agent', '')` to recover user IDs. Any ID containing `-agent` collapses wrong.
- **MEDIUM** `src/team-client.ts:96` — `JSON.parse` + shallow type check but no schema validation on `envelope.message`.

### relay
- **HIGH** `packages/relay/src/relay-do.ts:329` — HMAC verification for Composio webhooks is commented out with a TODO. Currently unverified against tampering.
- **HIGH** `packages/relay/src/relay-do.ts:73-88` — First-connection token registration accepts any query param with no length/character validation.
- **MEDIUM** `packages/relay/src/relay-do.ts:150-151` — Token validation via both header and query; without rate limiting, brute force is possible at the Worker edge.
- **MEDIUM** `packages/relay/src/relay-do.ts:171` — Push token written to storage without validation; spoofable if an attacker can send a crafted client message.
- **MEDIUM** `packages/relay/src/index.ts:44-50` — Role validation uses hardcoded string comparisons; typo-fragile.

### Cross-cutting observations
- **Shared AppleScript/shell helper is missing.** `agent-core` and `mcp-imessage` both shell out to `osascript`; neither does the escaping right. Build a single `safeExecAppleScript()` in `shared` and use it everywhere.
- **MCP servers need a unified argument-validation layer.** Every server manually casts `args!` to the expected type. A `validateToolArgs(schema, args)` middleware in `shared` would eliminate a whole class of bugs.
- **Swallowed-error pattern is endemic.** 10+ bare `catch {}` blocks across memory-store, team-log, contacts. Replace with a `logAndThrow()` helper so failures become visible to clients and users.
- **Inconsistent timeouts on external APIs.** `memory-store.ts:745` has a 15s embedding timeout, `exa-client.ts` has none, `relay-do.ts` has no rate limiting, `team-log.ts` does unbounded embedding fan-out.
- **Tokens are inconsistently placed.** Team-client puts them in query strings, relay-do accepts either header or query. Standardize on `Authorization: Bearer`.
- **String-concat SQL should move to parameterized queries** in both `memory-store.ts` and `mcp-imessage/index.ts`; both underlying libraries support it.

---

## Root, scripts, CI, secrets

### Architecture & tech debt
- **HIGH** `scripts/build-release.sh:2` — Uses only `set -e`. Missing `-u` and `-o pipefail` hides undefined-variable and pipe-failure bugs. Similar pattern in `build-edition.sh`.
- **MEDIUM** `turbo.json:1-9` — Minimal pipeline: only `build`/`dev`/`test`/`lint`, no `outputs` for lint, no cache on `dev`. Missing cacheable tasks across workspace packages.
- **MEDIUM** `scripts/start-dev.js:3,15,19,24` — `execSync()` template strings for `netstat`/`lsof`/`taskkill` without input validation. Ports are hardcoded today, but the pattern invites mistakes.
- **LOW** `.github/workflows/build.yml:178` — `sleep 5` in rename-assets job is a race-condition workaround; replace with polling.
- **LOW** `scripts/start-dev.js:76,98-102` — Spawns children with the full `process.env`; could leak `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `COMPOSIO_API_KEY` to processes that don't need them.

### Security
- **HIGH** `.env` — Contains real Google OAuth client ID + secret in plaintext. File is gitignored and untracked, but it's still sitting in your working tree. Move to Keychain/vault; keep only `.env.example` in the repo.
- **HIGH** `scripts/test-team-agent.ts:12,27` — Reads `RELAY_TOKEN` from env and uses it in WebSocket/HTTP headers. If this script is ever run in CI or a shared shell, the token is in process listings.
- **MEDIUM** `.github/workflows/build.yml:94-106` — Apple signing cert decoded from base64 and imported into a temporary keychain with hardcoded password `actions`. Relies on GH Actions default secret masking; consider explicit masking and `set +x` discipline.
- **MEDIUM** `.github/workflows/build.yml:147-156` — Multiple Apple/Tauri secrets passed as env to the Tauri action. Again, relies on implicit masking; audit the action's logs for leaks.
- **LOW** `.github/workflows/build.yml:9-10` — Job-level `permissions: { contents: write }` on all runs. Tighten for non-release runs, or scope releases behind approval gates.

### Code quality
- **MEDIUM** `scripts/build-edition.sh:37-48` — Uses inline `node -e` to patch JSON + restore from backup. If the build dies mid-run, backup isn't restored. Prefer `jq` or a small Node script with a `try/finally`.
- **MEDIUM** `scripts/start-dev.js:36-43` — `isPortFree()` via `net.createServer` + 200ms polling is slow and race-prone. Swap for a direct connect probe.
- **LOW** `scripts/build-release.sh:37-38` — Version extracted via `grep`+`sed` from `tauri.conf.json`. Use `jq`.
- **LOW** `.github/workflows/build.yml:165-205` — Rename-assets step has no error handling on bash commands.

### Hygiene / repo cleanliness
- **~7 untracked media files in repo root** — PDFs, screenshots, and a 111 MB `.mov`. Not gitignored. Either commit with Git LFS or add ignore patterns.
- **Untracked planning docs** — `TOKEN_OPTIMIZATION_REPORT.md`, `setup.md`, multiple files under `docs/plans/` and `docs/research/`. Decide whether these are committed artifacts; if not, add `docs/plans/` and `docs/research/` to `.gitignore`.
- **~20+ untracked `test-*.mjs`/`test-*.ts` scratch files in `packages/agent-core/`** — These clutter `git status` and make it hard to see real changes. Move to `packages/agent-core/scratch/` (gitignored) or delete.
- **`.gitignore` suggestions** — add `*.pdf`, `*.mov`, `*.PNG`, `docs/plans/`, `docs/research/`, `packages/agent-core/test-*.mjs`, `packages/agent-core/test-*.ts`.

### Notable positives
- `pnpm-lock.yaml` is committed and current.
- No `pull_request_target` workflows — CI only triggers on tag pushes / manual dispatch. Good.
- All secrets in CI use `${{ secrets.* }}`.
- `build-release.sh` gracefully degrades when `APPLE_SIGNING_IDENTITY` is absent.
- Workspace structure (`apps/*`, `packages/*`) is clean and consistent.

---

## Suggested next actions

If you want to act on this report, here's a reasonable order:

1. **Quick wins (minutes each):**
   - Move `.env` out of the repo root into Keychain or `~/.config/coagent/`.
   - Add `*.pdf`, `*.mov`, `*.PNG`, `docs/plans/`, `docs/research/`, `packages/agent-core/test-*.{mjs,ts}` to `.gitignore`.
   - Harden `scripts/build-release.sh` and `build-edition.sh` with `set -euo pipefail`.
   - Validate PIDs with `/^\d+$/` in `server.ts` before shelling out.

2. **Focused security sprint (half day):**
   - Re-enable HMAC webhook verification in `relay-do.ts`.
   - Tighten CSP in `tauri.conf.json` — drop `unsafe-inline`, use hashes/nonces.
   - Fix AppleScript injection in `mcp-imessage` (use argv, not template strings).
   - Add URL-safety validation for `RELAY_USER_ID` in `mcp-exa`.
   - Introduce a redaction helper and run stderr/tool-arg logging through it.

3. **Architecture work (multi-day, not urgent but high ROI):**
   - Split `useAgent.ts` and `ChatPane.tsx` into domain hooks/components.
   - Begin extraction of `agent.ts`/`server.ts` into focused modules (start with tool execution).
   - Build a shared `validateToolArgs(schema, args)` middleware and migrate every MCP server to it.
   - Build a `safeExecAppleScript()` helper and migrate `agent-core` + `mcp-imessage` to it.

4. **Nice-to-have:**
   - Replace hand-rolled base64 in `src-tauri/src/main.rs` with the `base64` crate.
   - Audit `is_allowed_path()` with symlink + non-existent intermediate-path tests.
   - Add timeouts + rate limits to `exa-client.ts` and `team-log.ts` embedding calls.

---

*Generated from 4 parallel exploration passes. Line numbers are approximate; verify before editing.*
