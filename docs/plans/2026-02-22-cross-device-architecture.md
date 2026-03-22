# Cross-Device Architecture Decision

**Date:** 2026-02-22
**Status:** Decision made — relay approach chosen

---

## The Problem

Users run Co-Agent on their desktop (local machine). They need to query the agent from their phone — asking about contracts, documents, anything the agent knows — without being technical enough to set up networking themselves.

## What We're NOT Doing

- **Full cloud:** Moving agent + documents to cloud servers means we own users' sensitive data (contracts, client info, financials). That's liability, compliance overhead, and eventually SOC 2. Not where we are.
- **Tailscale / VPN:** Not realistic for non-technical users.
- **Local-only:** Kills the mobile use case entirely.

## The Approach: Cloud Relay

The user's computer stays the brain. We add a thin cloud relay — a WebSocket proxy — that forwards connections from the phone to the user's local machine.

```
Phone → Cloud Relay → User's Local Machine (agent + documents)
```

- User's data never lives in the cloud, it passes through
- Relay just routes by user ID / session
- Small, cheap infrastructure — not where the hard problems are
- Users just log in on their phone, relay handles the routing

**Why this is right for now:** Minimal infrastructure, no data liability, buys time to design the full cloud story properly when it's needed.

## Document Storage (Local First, Cloud-Ready)

When file upload is built, documents go into `~/.coagent/documents/`. The agent chunks them, embeds them with Voyage AI, and indexes them — same system as memory. Agent can then answer anything about a document instantly.

The storage layer should be built with a clean abstraction so it can be swapped to cloud (S3 + Pinecone/Supabase pgvector) when the product scales — without changing any agent logic.

## What File Upload Enables

- User drops a contract → agent extracts key terms, parties, dates, contingencies
- Client asks "what does my contract say about X?" → agent answers in seconds
- Cross-device: document on desktop, question from phone, answer everywhere (via relay)

## Proactive Actions: Webhook + Smart Heartbeat

The relay solves two problems at once — mobile access AND receiving webhooks from external services.

### The Flow

```
Email arrives  → Composio trigger → Relay → payload drops in local queue (no API call)
Email arrives  → Composio trigger → Relay → payload drops in local queue (no API call)
Email arrives  → Composio trigger → Relay → payload drops in local queue (no API call)
...
Heartbeat fires → Haiku reads full queue → triages all at once → "3 routine, 1 needs action"
               → Sonnet handles the 1 that matters
```

- **Payloads queue locally** — no API call when an email lands, just storage
- **Haiku for triage** — cheap, fast, runs every heartbeat regardless of queue size
- **Sonnet only for action** — only fires when Haiku says something actually needs handling
- **Queue visible in UI** — users can see everything that came in that hour, not just approval items

### Why This Beats Per-Event Webhooks

5 emails in an hour = 5 Sonnet calls (expensive, redundant) vs 1 Haiku triage + maybe 1 Sonnet. Savings compound at scale.

### Security

- **Per-user secret token** — generated when relay provisions the user's endpoint. Every Composio payload must include it in the header. Relay drops anything that doesn't match.
- **Composio payload signing** — Composio signs webhook payloads. Relay validates the signature before accepting. Unsigned payloads are rejected.
- **HTTPS only** — relay runs on a proper domain with TLS, all traffic encrypted.
- **Relay is stateless** — it forwards and forgets. No user data lives on our servers. Contracts, client info, emails stay on the user's machine. Even if the relay were compromised, attackers get raw event notifications, not the user's data.

### Setup Experience for Users

**Completely invisible.** User connects Gmail in the sidebar — same OAuth they already do. In the background:
1. Relay auto-provisions their endpoint + generates secret token
2. Composio webhook subscription auto-created pointing at their relay URL
3. Done — payloads start landing, heartbeat starts processing them

No URLs to configure, no tokens to copy, no technical steps.

### Relay Reliability

If the relay goes down, webhooks stop landing and heartbeat falls back to polling blind (hourly, same as today). Not catastrophic — just slower. Relay is small enough to run on a $5/month VPS or serverless function.

## Relay Implementation: Cloudflare Workers + Durable Objects

**Cost: $5/month flat.** Includes Durable Objects. Handles any realistic user count.

### Why Cloudflare Workers over a VPS

- No server to maintain ever — deploy once, runs forever
- Global edge network — low latency for users anywhere in the US
- Scales automatically — 10 million requests included, handles thousands of users at $5/month
- Durable Objects — Cloudflare's built-in persistent WebSocket connection state

### How It Works

```
User's local agent → outbound WebSocket → Cloudflare Worker (registers by user ID)
Phone              → Cloudflare Worker  → routed to user's local agent
Composio webhook   → Cloudflare Worker  → payload forwarded to user's local queue
```

### What Gets Built

1. **Cloudflare Worker** (~150 lines) — WebSocket proxy with Durable Objects, routes by user ID, validates per-user secret tokens
2. **Local agent change** — connect outbound to Worker on startup, accept forwarded payloads, drop webhook events into `~/.coagent/event-queue.json`
3. **Auto-provisioning** — when user connects an integration, Worker generates their secret token and Composio webhook subscription is created automatically

### Deployment

One command (`wrangler deploy`), live on Cloudflare's global network. Never touched again.

### User Experience

Completely invisible. App opens, connects to Worker automatically. Phone opens app, gets routed to their machine. Nothing to configure.

## Future Cloud Path

When ready to go full SaaS:
1. Replace local document store with S3 + vector DB
2. Replace local agent with cloud-hosted agent per user
3. Relay becomes unnecessary — clients connect directly

The relay approach is explicitly a stepping stone, not the final architecture.
