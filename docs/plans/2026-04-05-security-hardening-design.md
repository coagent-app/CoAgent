# Security Hardening — Approach A (Practical)

**Date:** 2026-04-05
**Status:** Approved

## Context

Security review identified 5 open vulnerabilities in CoAgent's local-first desktop architecture. All stem from the same root assumption: localhost = trusted. This holds against remote attackers but not against malicious AI-generated code, local process snooping, or compromised webview content.

## 1. Custom MCP Environment Isolation

**Problem:** `mcp-manager.ts` passes `{ ...process.env, ...config.env }` to all child MCP processes. AI-generated custom integrations inherit `RELAY_TOKEN`, `EXA_API_KEY`, `OPENAI_API_KEY`, etc.

**Fix:** For servers whose name starts with `custom:`, pass only:
- The integration's own `.env` vars (from `loadCustomMcpEnv`)
- Minimal system vars: `PATH`, `HOME`, `NODE_ENV`, `LANG`
- `COAGENT_DATA_DIR`

Built-in MCPs (`mcp-memory`, `mcp-exa`) keep inheriting `process.env` since they're trusted first-party code.

**File:** `packages/agent-core/src/mcp-manager.ts`

## 2. WebSocket Authentication (Startup Nonce)

**Problem:** Any local process can connect to `ws://localhost:7830` and receive full agent state, relay tokens, admin access.

**Fix:**
1. `server.ts` generates `crypto.randomBytes(32).toString('hex')` on startup, writes to `DATA_DIR/.ws-nonce` with `0o600` permissions
2. `main.rs` adds `get_ws_nonce` Tauri command that reads the nonce file
3. Frontend sends `{ type: 'auth', nonce }` as the first WS message after connecting
4. Server starts a 2-second auth timer per connection. No valid auth = socket closed. All non-auth messages ignored until authenticated.
5. On server restart, new nonce generated. Frontend reconnect calls `get_ws_nonce` again to get the fresh value.

**Files:** `packages/agent-core/src/server.ts`, `apps/desktop/src-tauri/src/main.rs`, `apps/desktop/src/hooks/useAgent.ts`

## 3. Relay Credentials via Tauri IPC

**Problem:** `sendFullState()` broadcasts relay token over the unauthenticated WebSocket.

**Fix:**
1. Remove `relay_credentials` WS message from `sendFullState()` and `get_relay_credentials` handler
2. Bun sidecar writes resolved relay credentials to `DATA_DIR/.relay-credentials` (JSON, `0o600`)
3. `main.rs` adds `get_relay_credentials` Tauri command that reads this file
4. Frontend calls `invoke('get_relay_credentials')` instead of WS message

Credentials never touch the WebSocket. Tauri IPC is scoped to the webview origin.

**Files:** `packages/agent-core/src/server.ts`, `apps/desktop/src-tauri/src/main.rs`, `apps/desktop/src/hooks/useAgent.ts`

## 4. Tauri Path Validation

**Problem:** `open_file` and `read_file_bytes` accept arbitrary absolute paths.

**Fix:** Add `is_allowed_path()` in `main.rs`:
- **Allowed:** `~/.coagent/`, `~/Downloads`, `~/Desktop`, `~/Documents`, system temp dir
- **Denied:** All dotfile dirs (except `.coagent`), `/etc`, `/var`, `/usr`, system dirs
- Uses `canonicalize()` to resolve symlinks before checking, preventing symlink escapes
- `open_file` also rejects executable extensions: `.command`, `.terminal`, `.app`, `.sh`, `.bash`, `.workflow`

**File:** `apps/desktop/src-tauri/src/main.rs`

## 5. CSP Hardening

**Problem:** `script-src` includes `'unsafe-eval'`, enabling `eval()` and `new Function()` in the webview.

**Fix:** Remove `'unsafe-eval'` from the CSP in `tauri.conf.json`. Keep `'unsafe-inline'` for Vite dev mode compatibility. No frontend code uses `eval()` or dynamic code generation.

**File:** `apps/desktop/src-tauri/tauri.conf.json`

## Files Summary

| File | Changes |
|------|---------|
| `packages/agent-core/src/mcp-manager.ts` | Conditional env passing for custom vs built-in MCPs |
| `packages/agent-core/src/server.ts` | Nonce generation, auth gate on WS connections, remove relay_credentials broadcast, write .relay-credentials file |
| `apps/desktop/src-tauri/src/main.rs` | `get_ws_nonce`, `get_relay_credentials` commands, `is_allowed_path()` validation |
| `apps/desktop/src/hooks/useAgent.ts` | Send nonce on WS connect, invoke Tauri for relay creds |
| `apps/desktop/src-tauri/tauri.conf.json` | Remove `'unsafe-eval'` from CSP |
