# Relay Server Update Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add WebSocket Durable Object with hibernation, replace webhook tunnel stub with DO-based push, swap Voyage for OpenAI embeddings, and deploy.

**Architecture:** The existing relay Worker at `/relay/` already handles API proxying, auth, usage metering, and Stripe. We add a Durable Object (`UserSession`) per user for WebSocket connections. Composio webhooks route through the DO to push events in real-time. Offline events queue in DO SQLite.

**Tech Stack:** Cloudflare Workers, Durable Objects (WebSocket Hibernation API), KV, TypeScript, Wrangler

---

### Task 1: Update wrangler.toml for Durable Objects

**Files:**
- Modify: `relay/wrangler.toml`

**Step 1: Update wrangler.toml**

Replace the current content with:

```toml
name = "coagent-relay"
main = "src/index.ts"
compatibility_date = "2026-03-01"

[[kv_namespaces]]
binding = "TOKENS"
id = "8d749fb9446e41eb987d9d6f39a72486"

[[durable_objects.bindings]]
name = "USER_SESSION"
class_name = "UserSession"

[[migrations]]
tag = "v3"
new_sqlite_classes = ["UserSession"]
```

**Step 2: Verify config is valid**

Run: `cd relay && npx wrangler deploy --dry-run 2>&1 | head -20`
Expected: No config errors (may warn about unimplemented class, that's fine)

**Step 3: Commit**

```bash
git add relay/wrangler.toml
git commit -m "feat(relay): add Durable Object binding for UserSession"
```

---

### Task 2: Add UserSession Durable Object with WebSocket Hibernation

**Files:**
- Modify: `relay/src/index.ts`

**Step 1: Add Env update and UserSession class**

Add `USER_SESSION: DurableObjectNamespace` to the `Env` interface. Add `OPENAI_API_KEY: string` and remove `VOYAGE_API_KEY: string`.

Add the `UserSession` class after the helpers section (before the main router). The class:

```typescript
export class UserSession {
  private state: DurableObjectState
  private env: Env

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
    // Create queue table on first use
    this.state.blockConcurrencyWhile(async () => {
      await this.state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS webhook_queue (
          id TEXT PRIMARY KEY,
          trigger_name TEXT NOT NULL,
          payload TEXT NOT NULL,
          received_at TEXT NOT NULL
        )
      `)
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair()
      this.state.acceptWebSocket(pair[1])
      // Flush queued webhooks
      this.flushQueue(pair[1])
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    // Webhook push (internal, from main worker)
    if (url.pathname === '/push' && request.method === 'POST') {
      const payload = await request.json() as { trigger: string; data: Record<string, unknown> }
      const sockets = this.state.getWebSockets()
      const msg = JSON.stringify({ type: 'webhook', payload })

      if (sockets.length > 0) {
        for (const ws of sockets) ws.send(msg)
      } else {
        // Queue for later delivery
        await this.state.storage.sql.exec(
          `INSERT INTO webhook_queue (id, trigger_name, payload, received_at) VALUES (?, ?, ?, ?)`,
          crypto.randomUUID(),
          payload.trigger || 'UNKNOWN',
          JSON.stringify(payload),
          new Date().toISOString()
        )
      }
      return new Response('OK')
    }

    return new Response('Not found', { status: 404 })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Handle ping/pong keepalive
    if (message === 'ping') {
      ws.send('pong')
      return
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason)
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    ws.close(1011, 'WebSocket error')
  }

  private async flushQueue(ws: WebSocket): Promise<void> {
    // Purge events older than 48h
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    await this.state.storage.sql.exec(
      `DELETE FROM webhook_queue WHERE received_at < ?`, cutoff
    )

    const rows = this.state.storage.sql.exec(
      `SELECT id, trigger_name, payload, received_at FROM webhook_queue ORDER BY received_at ASC`
    ).toArray()

    for (const row of rows) {
      ws.send(JSON.stringify({
        type: 'webhook',
        payload: JSON.parse(row.payload as string),
        queued: true,
        receivedAt: row.received_at,
      }))
    }

    if (rows.length > 0) {
      await this.state.storage.sql.exec(`DELETE FROM webhook_queue`)
    }
  }
}
```

**Step 2: Verify TypeScript compiles**

Run: `cd relay && npx tsc --noEmit 2>&1`
Expected: No errors

**Step 3: Commit**

```bash
git add relay/src/index.ts
git commit -m "feat(relay): add UserSession Durable Object with WebSocket hibernation and offline queue"
```

---

### Task 3: Add WebSocket Route and Update Webhook Route

**Files:**
- Modify: `relay/src/index.ts`

**Step 1: Add /ws/:userId route**

In the main router `fetch` handler, add before the Stripe webhook route:

```typescript
// --- WebSocket connection ---
if (request.headers.get('Upgrade') === 'websocket' && url.pathname.startsWith('/ws/')) {
  const userId = url.pathname.split('/')[2]
  const token = url.searchParams.get('token')
  if (!token) return new Response('Missing token', { status: 401 })
  const data = await getToken(env, token)
  if (!data || !data.active) return new Response('Invalid token', { status: 401 })

  const doId = env.USER_SESSION.idFromName(userId)
  const stub = env.USER_SESSION.get(doId)
  return stub.fetch(request)
}
```

**Step 2: Replace webhook tunnel stub**

Replace the existing webhook handler (lines 562-574) with:

```typescript
// --- Composio webhook → push to user's DO ---
if (request.method === 'POST' && url.pathname.startsWith('/webhook/')) {
  const userId = url.pathname.split('/')[2]
  if (!userId) return new Response('Missing userId', { status: 400 })

  const payload = await request.json()
  const doId = env.USER_SESSION.idFromName(userId)
  const stub = env.USER_SESSION.get(doId)

  // Fire and forget — respond 200 immediately
  ctx.waitUntil(
    stub.fetch(new Request('https://internal/push', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
    }))
  )

  return new Response('OK', { status: 200, headers: corsHeaders() })
}
```

**Step 3: Verify TypeScript compiles**

Run: `cd relay && npx tsc --noEmit 2>&1`
Expected: No errors

**Step 4: Commit**

```bash
git add relay/src/index.ts
git commit -m "feat(relay): add WebSocket route and replace webhook tunnel stub with DO push"
```

---

### Task 4: Swap Voyage Proxy for OpenAI Embeddings

**Files:**
- Modify: `relay/src/index.ts`
- Modify: `relay/.dev.vars` (already has OPENAI_API_KEY)

**Step 1: Replace proxyVoyage with proxyOpenAIEmbeddings**

Replace the `proxyVoyage` function and update the cost constant:

```typescript
// OpenAI text-embedding-3-small pricing: $0.02 per 1M tokens
const OPENAI_EMBED_COST_PER_TOKEN = 0.00000002

async function proxyOpenAIEmbeddings(request: Request, env: Env, token: string, data: TokenData): Promise<Response> {
  const body = await request.json() as { input: string | string[]; model?: string; dimensions?: number }

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      input: body.input,
      model: body.model || 'text-embedding-3-small',
      ...(body.dimensions ? { dimensions: body.dimensions } : {}),
    }),
  })

  if (res.status === 200) {
    try {
      const clone = res.clone()
      const resBody = await clone.json() as { usage?: { total_tokens?: number } }
      const tokens = resBody.usage?.total_tokens || 0
      const cost = tokens * OPENAI_EMBED_COST_PER_TOKEN
      data.usage.embeddingTokens += tokens
      data.usage.embeddingCostUsd += cost
      data.usage.totalCostUsd += cost
      saveToken(env, token, data).catch(() => {})
    } catch {}
  }

  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  })
}
```

**Step 2: Update the /v1/embeddings route**

Replace `proxyVoyage` call with `proxyOpenAIEmbeddings`:

```typescript
if (request.method === 'POST' && url.pathname === '/v1/embeddings') {
  const result = await validateRequest(request, env)
  if (result instanceof Response) return result
  return proxyOpenAIEmbeddings(request, env, result.token, result.data)
}
```

**Step 3: Remove VOYAGE_API_KEY from Env interface, remove VOYAGE_COST_PER_TOKEN constant**

**Step 4: Verify TypeScript compiles**

Run: `cd relay && npx tsc --noEmit 2>&1`
Expected: No errors

**Step 5: Commit**

```bash
git add relay/src/index.ts
git commit -m "feat(relay): swap Voyage embedding proxy for OpenAI text-embedding-3-small"
```

---

### Task 5: Deploy and Test

**Step 1: Set secrets on Cloudflare**

```bash
cd relay
echo "sk-ant-api03-..." | npx wrangler secret put ANTHROPIC_API_KEY
echo "sk-proj-..." | npx wrangler secret put OPENAI_API_KEY
echo "ak_..." | npx wrangler secret put COMPOSIO_API_KEY
echo "" | npx wrangler secret put STRIPE_WEBHOOK_SECRET
echo "6cb46b..." | npx wrangler secret put TUNNEL_SECRET
```

(Use actual values from `.dev.vars`)

**Step 2: Deploy**

Run: `cd relay && npx wrangler deploy 2>&1`
Expected: Deployed to `coagent-relay.<account>.workers.dev`

**Step 3: Test WebSocket connection**

Use wscat or a quick node script to verify WebSocket connects:

```bash
npx wscat -c "wss://coagent-relay.<subdomain>.workers.dev/ws/test-user?token=<valid-token>"
```

Expected: Connection opens. Send "ping", receive "pong".

**Step 4: Test webhook push**

```bash
curl -X POST https://coagent-relay.<subdomain>.workers.dev/webhook/test-user \
  -H "Content-Type: application/json" \
  -d '{"trigger_name":"GMAIL_NEW_GMAIL_MESSAGE","data":{"sender":"test@example.com","subject":"Hello"}}'
```

Expected: 200 OK. If WebSocket is connected, message arrives. If not, queued in DO.

**Step 5: Test API proxy**

```bash
curl -X POST https://coagent-relay.<subdomain>.workers.dev/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: <valid-token>" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-haiku-4-5","max_tokens":100,"messages":[{"role":"user","content":"Say hello"}]}'
```

Expected: Claude response. Check `/v1/account` to verify usage was tracked.

**Step 6: Commit any fixes**

```bash
git add relay/
git commit -m "fix(relay): deployment fixes"
```
