# Relay Server Design — Cloudflare Worker (Updated)

## Status

The relay at `/relay/` is 90% built. This doc covers what exists and what needs to be added.

## What Already Exists

### Proxies (all working)
- **Anthropic Messages** (`POST /v1/messages`) — transparent SDK proxy, injects API key, tracks streaming + non-streaming usage
- **Voyage Embeddings** (`POST /v1/embeddings`) — proxies to Voyage AI, tracks embedding tokens
- **Composio** (`/v1/composio/*`) — whitelisted endpoints, tracks action counts
- **Stripe Webhooks** (`POST /stripe/webhook`) — handles checkout.session.completed (generate token) and subscription.deleted (revoke token)

### Auth & Metering (all working)
- Token-based auth via KV store (`TOKENS` namespace)
- Per-user `TokenData`: stripe customer ID, chosen model, usage counters, active flag
- Monthly billing period auto-reset
- Cost calculation with cache-aware pricing (input, output, cache write, cache read)
- Model selection per user (Opus, Sonnet, Haiku)

### Infrastructure
- `wrangler.toml` configured with KV namespace
- `.dev.vars` with all API keys (Anthropic, OpenAI, Voyage, Composio, Stripe)
- KV namespace `coagent-relay-TOKENS` exists on Cloudflare

## What Needs to Be Added

### 1. WebSocket Durable Object (NEW)

Add a Durable Object (`UserSession`) with WebSocket Hibernation API:

```
Client connects: GET /ws/:userId?token=xxx
  → Worker validates token against KV
  → Routes to user's DO (idFromName(userId))
  → DO accepts WebSocket with hibernation
  → Flushes any queued webhooks from offline period
```

Handlers:
- `webSocketMessage` — ping/pong keepalive
- `webSocketClose` — cleanup
- `webSocketOpen` — flush offline queue

### 2. Webhook → WebSocket Push (REPLACE STUB)

Current code at line 562 forwards webhooks to a fake tunnel URL. Replace with:

```
POST /webhook/:userId
  → Worker gets user's DO stub
  → Forwards payload to DO
  → DO pushes to connected WebSocket if online
  → If offline, stores in DO SQLite queue
  → Responds 200 immediately
```

### 3. Offline Queue (NEW)

DO SQLite table for pending webhooks:

```sql
CREATE TABLE webhook_queue (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL
);
```

- Webhooks stored when no WebSocket is connected
- Flushed in order on reconnect
- 48h TTL — stale events dropped

### 4. Token/Usage Verification

Review and verify:
- Streaming usage scanning correctly captures all token types
- Cache tokens (read + write) are tracked
- Monthly reset works correctly
- Composio action counting is accurate
- Embedding token tracking matches Voyage response format

## Updated wrangler.toml

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

## Updated Routes

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/ws/:userId` | GET (upgrade) | token | WebSocket connection (NEW) |
| `/webhook/:userId` | POST | tunnel secret | Composio webhook push (UPDATED) |
| `/v1/messages` | POST | token | Anthropic proxy (existing) |
| `/v1/embeddings` | POST | token | Voyage proxy (existing) |
| `/v1/composio/*` | ALL | token | Composio proxy (existing) |
| `/v1/models` | GET | none | Available models (existing) |
| `/v1/model` | POST | token | Set model (existing) |
| `/v1/account` | GET | token | Usage/account info (existing) |
| `/stripe/webhook` | POST | stripe sig | Stripe events (existing) |

## Local App Changes (Later)

After the relay is deployed and working:
- Update `relay-client.ts` to connect via WebSocket to `/ws/:userId`
- Webhook events arrive via WebSocket → stored in event store
- Heartbeat processes event store batches

## Implementation Order

1. Add Durable Object class with WebSocket hibernation + SQLite queue
2. Add `/ws/:userId` route with token validation
3. Replace webhook stub with DO-based push
4. Update wrangler.toml with DO bindings and migration
5. Verify token tracking across all proxies
6. Deploy with `wrangler deploy`
7. Test: connect from local, send test webhook, verify push
