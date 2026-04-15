# Known Issues & Fixes

Tracking critical bugs, root causes, and fixes so we can always revert or reference.

---

## 1. Composio MCP Toolkit Staleness (2026-04-15)

**Symptom:** Slack, Notion, Google Maps, and other integrations return zero tools. Only Gmail and Google Calendar work. `search_tools` can't find tools for connected integrations.

**Root Cause:** The Composio MCP server was created on 2026-02-22 with `["composio_search", "text_to_pdf", "gmail", "googlecalendar"]`. On every startup, the app PATCHes the server with the full toolkit list. The PATCH was going to the correct endpoint (`/mcp/${id}`) but the response was never checked — if it failed silently, toolkits stayed stale. As new integrations were added (Slack, Notion, Maps, etc.), they never got registered with Composio's MCP server.

**Fix:** `packages/agent-core/src/composio-setup.ts`
- Check PATCH response status
- Log existing vs requested toolkits on every startup
- If PATCH fails: delete and recreate the MCP server with all toolkits
- Fallback ensures self-healing on every app startup

**Verification:** Run `scripts/test-composio-audit.ts` — should show all toolkits on the MCP server and tools returned for each integration.

**Impact:** All users. Every user's MCP server was likely stuck at whatever toolkits they had when first onboarded. The code patch self-heals on next app startup.

---

## 2. Heartbeat Timer Blocked by MCP Timeout (2026-04-15)

**Symptom:** Heartbeats never fire. Scheduler appears to start but no heartbeat timer is set.

**Root Cause:** `mcpManager.ready()` had no timeout. If any MCP server (stdio or HTTP) hung during connection, `ready()` would block forever, preventing `scheduleHeartbeatTimer()` from running.

**Fix:** `packages/agent-core/src/mcp-manager.ts`
- 30s timeout on `ready()` — proceeds with available tools after timeout
- 15s timeout on individual stdio and HTTP MCP connections
- 15s timeout on all Composio API fetch calls (`composio-setup.ts`, `composio-integrations.ts`)

**Verification:** Start app, check logs for heartbeat scheduling within 30s of startup.

---

## 3. LanceDB Tool Index Stale Accumulation (ongoing)

**Symptom:** `search_tools` returns tools that no longer exist (e.g., tools from disconnected integrations or old Composio tool names). Tool count in LanceDB (939) far exceeds live tool count (131-143).

**Root Cause:** `tool-embeddings.ts` uses additive-only indexing — new tools are added but old tools are never purged. This was intentional to avoid removing tools during brief disconnects, but leads to stale accumulation over time.

**Current State:** Search filters results against live tools, so stale entries don't cause incorrect tool calls — they just waste search capacity and can cause misleading log output. With the Composio toolkit fix (issue #1), the live tool count is now ~1982, making the stale entries a smaller fraction.

**Potential Fix:** Periodic purge of tools not in the live set, with a grace period to handle brief disconnects. Not yet implemented — monitor whether the filtering approach is sufficient.

---

## 4. Relay PATCH Endpoint Routing (2026-04-15)

**Note:** The relay at `coagent-relay.brettponters.workers.dev` blocks `PATCH /v1/composio/mcp/servers/${id}` (403: "Composio endpoint not allowed") but allows `PATCH /v1/composio/mcp/${id}`. The Composio API supports both, but only `/mcp/${id}` works through our relay. If the relay routing changes, the PATCH will start failing — the new code handles this with delete+recreate fallback.

**Relay file:** `relay/src/index.ts` — check allowed path patterns if PATCH starts failing.
