# Security Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the 5 open security vulnerabilities identified in the CoAgent security review.

**Architecture:** Harden the local-first desktop app by isolating custom MCP env vars, adding WebSocket nonce auth, moving relay credentials to Tauri IPC, validating Tauri file paths, and removing `unsafe-eval` from CSP.

**Tech Stack:** TypeScript (server), Rust (Tauri), React (frontend)

---

### Task 1: Custom MCP Environment Isolation

**Files:**
- Modify: `packages/agent-core/src/mcp-manager.ts:77-83`

**Step 1: Modify `connect()` to conditionally pass env vars**

Replace line 82:
```typescript
env: { ...process.env, ...config.env } as Record<string, string>,
```

With:
```typescript
env: (config.name.startsWith('custom:')
  ? {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: process.env.NODE_ENV ?? 'production',
      LANG: process.env.LANG ?? '',
      COAGENT_DATA_DIR: process.env.COAGENT_DATA_DIR ?? '',
      ...config.env,
    }
  : { ...process.env, ...config.env }
) as Record<string, string>,
```

**Step 2: Verify the build compiles**

Run: `cd packages/agent-core && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/agent-core/src/mcp-manager.ts
git commit -m "security: isolate custom MCP env — only pass own .env vars, not server secrets"
```

---

### Task 2: WebSocket Nonce Generation (Server Side)

**Files:**
- Modify: `packages/agent-core/src/server.ts:1274` (after WSS creation)
- Modify: `packages/agent-core/src/server.ts:1623-1624` (attachWssHandlers)

**Step 1: Generate and write the nonce on startup**

After line 1274 (`wss = new WebSocketServer(...)`) add:

```typescript
// Generate a one-time WebSocket auth nonce
import { randomBytes, writeFileSync } from 'fs'
const WS_NONCE = randomBytes(32).toString('hex')
const noncePath = join(DATA_DIR, '.ws-nonce')
writeFileSync(noncePath, WS_NONCE, { mode: 0o600 })
console.log(`[Server] WS nonce written to ${noncePath}`)
```

Note: `randomBytes` should be imported from `crypto` at the top of the file. Check existing imports — `crypto` may already be imported. `writeFileSync` from `fs` is likely already imported too.

**Step 2: Add auth gate in `attachWssHandlers`**

Replace the connection handler opening in `attachWssHandlers` (line 1624):

```typescript
function attachWssHandlers(server: WebSocketServer): void {
  server.on('connection', (ws) => {
```

With:

```typescript
function attachWssHandlers(server: WebSocketServer): void {
  server.on('connection', (ws) => {
    let authenticated = false
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        console.warn('[Server] WS client failed to authenticate within 2s — closing')
        ws.close(4001, 'Auth timeout')
      }
    }, 2000)

    const originalOnMessage = ws.onmessage
    ws.onmessage = null // clear any existing

    ws.on('message', function authHandler(raw) {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'auth' && msg.nonce === WS_NONCE) {
          authenticated = true
          clearTimeout(authTimer)
          ws.removeListener('message', authHandler)
          // Now set up real handlers and send initial state
          handleAuthenticatedConnection(ws)
        } else {
          console.warn('[Server] WS auth failed — invalid nonce')
          ws.close(4003, 'Invalid nonce')
        }
      } catch {
        ws.close(4002, 'Invalid auth message')
      }
    })
  })
}
```

**Step 3: Extract post-auth logic into `handleAuthenticatedConnection`**

Move the existing body of the `server.on('connection', (ws) => { ... })` callback (everything after the opening line 1624, which is the `sendFullState` call and the `ws.on('message', ...)` handler) into a new function:

```typescript
function handleAuthenticatedConnection(ws: WebSocket): void {
  sendFullState(ws).catch(console.error)
  // ... rest of existing connection handler (the giant ws.on('message') with all the if-chains)
}
```

**Step 4: Verify the build compiles**

Run: `cd packages/agent-core && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add packages/agent-core/src/server.ts
git commit -m "security: add WebSocket nonce auth — reject unauthenticated local connections"
```

---

### Task 3: WebSocket Nonce Auth (Frontend + Tauri)

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs` (add `get_ws_nonce` command)
- Modify: `apps/desktop/src-tauri/src/main.rs:653` (register command in invoke_handler)
- Modify: `apps/desktop/src/hooks/useAgent.ts:84-93` (send nonce on connect)

**Step 1: Add `get_ws_nonce` Tauri command in `main.rs`**

Add before the `open_file` command (around line 276):

```rust
#[tauri::command]
fn get_ws_nonce() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let nonce_path = home.join(".coagent").join(".ws-nonce");
    std::fs::read_to_string(&nonce_path)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("Failed to read WS nonce: {}", e))
}
```

Check if the `dirs` crate is already a dependency. If not, it can use `std::env::var("HOME")` instead:

```rust
#[tauri::command]
fn get_ws_nonce() -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let nonce_path = std::path::Path::new(&home).join(".coagent").join(".ws-nonce");
    std::fs::read_to_string(&nonce_path)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("Failed to read WS nonce: {}", e))
}
```

**Step 2: Register in invoke_handler**

Update line 653:
```rust
.invoke_handler(tauri::generate_handler![open_file, read_file_bytes, reveal_in_file_manager, server_status, get_ws_nonce])
```

**Step 3: Update frontend `connect()` to send nonce as first message**

In `useAgent.ts`, add `invoke` import at the top:
```typescript
import { invoke } from '@tauri-apps/api/core'
```

Update `socket.onopen` (lines 88-94) to:

```typescript
socket.onopen = async () => {
  try {
    const nonce = await invoke<string>('get_ws_nonce')
    socket.send(JSON.stringify({ type: 'auth', nonce }))
  } catch (err) {
    console.error('[WS] Failed to get nonce:', err)
    socket.close()
    return
  }
  setConnected(true)
  reconnectDelay.current = RECONNECT_BASE
  socket.send(JSON.stringify({ type: 'get_team_info' }))
  socket.send(JSON.stringify({ type: 'team_history', limit: 50 }))
  socket.send(JSON.stringify({ type: 'get_google_calendar_status' }))
}
```

Note: The nonce must be sent BEFORE any other messages because the server ignores everything until auth succeeds.

**Step 4: Check `@tauri-apps/api/core` is available**

Run: `grep '@tauri-apps/api' apps/desktop/package.json`

If `@tauri-apps/api` is listed, `invoke` is available from `@tauri-apps/api/core`. If using older Tauri v1 API, it may be `@tauri-apps/api/tauri` instead — check existing imports in the codebase.

**Step 5: Verify builds**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/main.rs apps/desktop/src/hooks/useAgent.ts
git commit -m "security: frontend sends WS nonce on connect via Tauri IPC"
```

---

### Task 4: Relay Credentials via Tauri IPC

**Files:**
- Modify: `packages/agent-core/src/server.ts:1604-1610` (remove from sendFullState)
- Modify: `packages/agent-core/src/server.ts:2769-2774` (remove get_relay_credentials handler)
- Modify: `packages/agent-core/src/server.ts` (add credential file writer near startup)
- Modify: `apps/desktop/src-tauri/src/main.rs` (add `get_relay_credentials` command)
- Modify: `apps/desktop/src-tauri/src/main.rs:653` (register command)
- Modify: `apps/desktop/src/hooks/useAgent.ts:572-575` (switch to Tauri invoke)
- Modify: `apps/desktop/src/hooks/useAgent.ts:276-278` (remove WS handler)

**Step 1: Write relay credentials file on server startup**

In `server.ts`, after relay credentials are loaded (near the relay status initialization area), add:

```typescript
// Write relay credentials to a file for Tauri IPC access
function writeRelayCredentialsFile() {
  const relayUrl = process.env.RELAY_URL ?? ''
  const token = process.env.RELAY_TOKEN ?? ''
  const userId = process.env.RELAY_USER_ID ?? 'default'
  if (relayUrl && token) {
    const credPath = join(DATA_DIR, '.relay-credentials')
    writeFileSync(credPath, JSON.stringify({ relayUrl, token, userId }), { mode: 0o600 })
  }
}
writeRelayCredentialsFile()
```

Also call `writeRelayCredentialsFile()` after relay activation succeeds (in the `activate_relay` handler) so the file stays current.

**Step 2: Remove relay_credentials from sendFullState**

Delete lines 1604-1610 (the `relay_credentials` block in `sendFullState`).

**Step 3: Remove `get_relay_credentials` WS handler**

Delete lines 2769-2774 (the `if (msg.type === 'get_relay_credentials')` block).

**Step 4: Add Tauri command in `main.rs`**

```rust
#[tauri::command]
fn get_relay_credentials() -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let cred_path = std::path::Path::new(&home).join(".coagent").join(".relay-credentials");
    std::fs::read_to_string(&cred_path)
        .map_err(|e| format!("Failed to read relay credentials: {}", e))
}
```

**Step 5: Register in invoke_handler**

```rust
.invoke_handler(tauri::generate_handler![open_file, read_file_bytes, reveal_in_file_manager, server_status, get_ws_nonce, get_relay_credentials])
```

**Step 6: Update frontend `getRelayCredentials`**

In `useAgent.ts`, change the `getRelayCredentials` callback:

```typescript
const getRelayCredentials = useCallback(async () => {
  setRelayCredentials(null)
  try {
    const json = await invoke<string>('get_relay_credentials')
    const creds = JSON.parse(json)
    setRelayCredentials({ type: 'relay_credentials', ...creds })
  } catch (err) {
    console.error('[Relay] Failed to get credentials via IPC:', err)
  }
}, [])
```

**Step 7: Remove the WS `relay_credentials` message handler**

Remove lines 276-278 in `useAgent.ts`:
```typescript
if (msg.type === 'relay_credentials') {
  setRelayCredentials(msg)
}
```

**Step 8: Verify builds**

Run both:
- `cd packages/agent-core && npx tsc --noEmit`
- `cd apps/desktop && npx tsc --noEmit`

Expected: No errors

**Step 9: Commit**

```bash
git add packages/agent-core/src/server.ts apps/desktop/src-tauri/src/main.rs apps/desktop/src/hooks/useAgent.ts
git commit -m "security: move relay credentials from WS broadcast to Tauri IPC"
```

---

### Task 5: Tauri Path Validation

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs:277-332` (add validation to open_file, read_file_bytes, reveal_in_file_manager)

**Step 1: Add `is_allowed_path` function**

Add before the `open_file` command:

```rust
/// Validate that a path is within allowed directories to prevent arbitrary file access.
fn is_allowed_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(path);

    // Resolve symlinks to prevent escapes
    let canonical = p.canonicalize()
        .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?;

    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
    let home_path = std::path::Path::new(&home);

    let allowed_prefixes: Vec<std::path::PathBuf> = vec![
        home_path.join(".coagent"),
        home_path.join("Downloads"),
        home_path.join("Desktop"),
        home_path.join("Documents"),
        std::env::temp_dir(),
    ];

    // Explicitly deny dotfile dirs (except .coagent)
    if let Ok(rel) = canonical.strip_prefix(home_path) {
        if let Some(first) = rel.components().next() {
            let first_str = first.as_os_str().to_string_lossy();
            if first_str.starts_with('.') && first_str != ".coagent" {
                return Err(format!("Access denied: path is in a hidden directory: {}", path));
            }
        }
    }

    for prefix in &allowed_prefixes {
        if let Ok(canon_prefix) = prefix.canonicalize() {
            if canonical.starts_with(&canon_prefix) {
                return Ok(canonical);
            }
        }
        // If prefix doesn't exist yet (e.g., temp), check without canonicalize
        if canonical.starts_with(prefix) {
            return Ok(canonical);
        }
    }

    Err(format!("Access denied: path '{}' is outside allowed directories", path))
}

/// Dangerous file extensions that could execute code when opened
const DANGEROUS_EXTENSIONS: &[&str] = &[
    "command", "terminal", "app", "sh", "bash", "workflow", "action", "scpt", "applescript",
];
```

**Step 2: Add validation to `open_file`**

```rust
#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    let canonical = is_allowed_path(&path)?;

    // Block executable file extensions
    if let Some(ext) = canonical.extension() {
        let ext_lower = ext.to_string_lossy().to_lowercase();
        if DANGEROUS_EXTENSIONS.contains(&ext_lower.as_str()) {
            return Err(format!("Cannot open executable file type: .{}", ext_lower));
        }
    }

    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(target_os = "windows")]
    let cmd = "cmd";
    #[cfg(target_os = "linux")]
    let cmd = "xdg-open";

    let path_str = canonical.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    let args = vec!["/C".to_string(), "start".to_string(), "".to_string(), path_str.clone()];
    #[cfg(not(target_os = "windows"))]
    let args = vec![path_str.clone()];

    Command::new(cmd)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to open '{}': {}", path_str, e))?;
    Ok(())
}
```

**Step 3: Add validation to `read_file_bytes`**

```rust
#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    let canonical = is_allowed_path(&path)?;
    std::fs::read(&canonical).map_err(|e| format!("Failed to read '{}': {}", path, e))
}
```

**Step 4: Add validation to `reveal_in_file_manager`**

Add `is_allowed_path(&path)?;` as the first line inside the function body.

**Step 5: Verify Rust builds**

Run: `cd apps/desktop/src-tauri && cargo check`
Expected: No errors

**Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/main.rs
git commit -m "security: validate Tauri file paths against directory allowlist"
```

---

### Task 6: CSP Hardening

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json:15`

**Step 1: Remove `'unsafe-eval'` from script-src**

In the CSP string on line 15, change:
```
script-src 'self' 'unsafe-inline' 'unsafe-eval'
```
to:
```
script-src 'self' 'unsafe-inline'
```

**Step 2: Verify the app launches (manual test)**

Run: `pnpm tauri dev`
Check that the app loads without console errors about eval() or CSP violations.

**Step 3: Commit**

```bash
git add apps/desktop/src-tauri/tauri.conf.json
git commit -m "security: remove unsafe-eval from CSP — blocks eval() in webview"
```

---

### Task 7: Smoke Test

**Step 1: Full dev restart**

Run: `pnpm tauri dev`

**Step 2: Verify these work:**
- App launches and connects (nonce auth succeeds)
- Chat works (messages send/receive)
- Team pane loads (if relay configured)
- Settings pane loads
- Files pane can open/reveal files in Downloads/Desktop/Documents
- Files pane rejects paths outside allowed dirs (check console for errors if attempted)
- Voice pill renders in idle state

**Step 3: Final commit (if any adjustments needed)**
