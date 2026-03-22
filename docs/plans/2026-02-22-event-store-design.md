# Event Store Design

**Date:** 2026-02-22
**Status:** Implemented (2026-02-22)

---

## The Problem

Webhook events come in constantly from connected integrations (Gmail, Calendar, HubSpot, etc.). The current event queue (`event-queue.json`) is a flat buffer that gets dumped to the agent on heartbeat. At scale this becomes a context dump of 50+ raw events — expensive, noisy, and the agent has to wade through everything to find what's relevant.

## The Approach: Searchable Semantic Event Store

Instead of a queue that gets dumped, build a **queryable event store**. Events come in, get embedded, and persist. When the agent wakes up it searches the store based on what it's actively working on — pulling only what's relevant, not receiving everything.

```
Webhook arrives → embed → store with embedding (not a buffer, a store)

Heartbeat fires:
  Agent reads active deals from memory
  For each deal → search_events("123 Main St counter offer")
  Gets back 3 relevant events, not 50 random ones
  Acts on them → marks done
  Events expire after 24h automatically
```

## What Changes

### 1. event-store.json (replaces event-queue.json)

Events persist with their embeddings instead of being cleared on read:

```json
[
  {
    "id": "uuid",
    "receivedAt": "2026-02-22T16:00:00Z",
    "event": { "trigger": "GMAIL_NEW_EMAIL", "from": "seller@...", "subject": "...", "snippet": "..." },
    "embedding": [0.123, -0.456, ...],
    "done": false
  }
]
```

Events auto-expire after 24h. Agent marks them `done` after acting.

### 2. search_events internal tool (new)

Agent calls this like it calls `search_tools` — same mental model:

```typescript
{
  name: 'search_events',
  description: 'Search queued incoming events by semantic similarity. Use on heartbeat to find events relevant to active deals, clients, or tasks.',
  input_schema: {
    query: 'string — describe what you are looking for, e.g. "counter offer 123 Main St" or "new leads"',
    limit: 'number — max results to return (default 5)'
  }
}
```

Returns matching events ranked by similarity. Agent controls what it pulls.

### 3. Heartbeat flow (new)

```
Agent wakes up
→ reads agent.md (active deals, clients, routines)
→ calls search_events("new leads unread emails urgent") — broad sweep
→ for each active deal: search_events("123 Main St")
→ acts only on what it finds
→ marks handled events done
→ no dump, no noise, no wasted context
```

### 4. Pre-processor (at write time — still needed)

Three generic layers, no per-integration logic, works for any Composio tool:

**Layer 1 — Trigger deny-list** (structural noise by pattern)
```
*_READ, *_VIEWED, *_SYNC, *_OPENED, *_DELETED, *_MODIFIED, *_BOUNCED
```

**Layer 2 — System sender detection** (automated source, no human behind it)
First check: if `bot_id` field is present → drop (Slack bot messages always have this).
Then check sender field (`from`, `sender`, `email`, `organizer`):
```
no-reply@, noreply@, notifications@, bot@, donotreply@, automated@, digest@
```

**Layer 3 — Empty content check** (strongest generic signal)
If the payload has none of these fields with actual content → drop:
```
subject, message, snippet, description, title, body, content, text, note
```
A CRM contact view, a calendar sync, a file modified event — no human text.
An email from a real person, a Slack message, a deal note — always has text.

After these three filters, trim to essential fields only (from, subject, snippet, title — not full body) before embedding.

## Why This Works Across Domains

The agent queries based on whatever is in its memory. A legal agent has `cases/*.md` instead of `deals/*.md`. It calls `search_events("Smith v. Jones filing deadline")`. Same tool, same code, different queries driven by the profile.

The event store has no domain-specific logic. The intelligence is entirely in:
1. What the agent has in memory (its active work)
2. How the agent queries the store (driven by its profile)

## Handling New / Unknown Things

The agent only queries by what it knows — active deals, clients, contacts in memory. A new lead or unknown sender never gets searched for because it doesn't exist in memory yet.

**Solution: two-pass heartbeat**

Every event in the store has a `retrieved: false` flag. The heartbeat runs two passes:

```
Pass 1 — known context:
  Agent reads active deals/clients from memory
  Searches event store per deal → matched events marked retrieved: true

Pass 2 — discovery:
  Agent pulls all events still retrieved: false from last 24h
  These are genuinely new — nothing in memory matched them
  Agent handles: new lead, new contact, unexpected email, or noise
```

Pass 2 is self-healing — even if pass 1 misses something, it surfaces within the hour. The new pile stays small because most events are about existing deals. What falls through is the actually interesting stuff.

---

## What's Still Unresolved

- **Embedding model**: voyage-3-lite tested, scores run lower than expected (0.65 threshold in tests). May need voyage-3 for better clustering or threshold tuning.
- **Store size management**: Beyond 24h expiry, need a max-size cap so the store doesn't grow unbounded if agent is offline for days.
- **Deduplication**: Similar events that arrive in quick succession (e.g., 5 follow-up emails on the same thread) should merge rather than creating 5 separate store entries. Vector clustering at write time (tested, works at 0.65) handles this.
- **search_events result format**: Decide what fields to return to the agent — probably `{ trigger, from/title, subject/snippet, receivedAt }` without the embedding.
- **Mark done UX**: How does the agent mark events done? Tool call `mark_events_done([id1, id2])` or implicit on act?
- **Cold start**: New user with no memory and no active deals — agent can't query by deal context. Fallback: broad sweep query on first few heartbeats until memory is populated.

## Test Results (2026-02-22)

Ran clustering test on 10 realistic real estate events using voyage-3-lite:
- Same-thread email deduplication works well at 0.65 (counter offer follow-ups merged, open house follow-ups merged)
- Cross-type signals about same property (email + calendar + inspection) score 0.37-0.52 — don't auto-cluster, but agent can connect them via search
- The search approach (agent queries by deal) is better than clustering for cross-type deal signals

## Implementation (2026-02-22)

- `packages/agent-core/src/relay-client.ts` — 3-layer pre-processor, Voyage embed at write time, `event-store.json` with `{id, receivedAt, trigger, event, embedding, retrieved, done}`. Exports: `searchEventStore`, `markEventsDone`, `hasUnreadEvents`.
- `packages/agent-core/src/agent.ts` — `search_events` and `mark_events_done` added to INTERNAL_TOOLS with handlers in runLoop. Heartbeat message updated: agent reads agent.md for deals/clients, calls search_events per deal then broad sweep, marks done.
- `packages/agent-core/src/scheduler.ts` — early exit via `hasUnreadEvents` + due todos check (no more raw queue dump). If nothing to do, skips entirely.
- Haiku heartbeat triage removed — scheduler early exit is cheaper and more accurate.
- Domain-specific part: only the heartbeat message's "read agent.md for deals/clients" section — the agent's own memory drives what it searches for.

## Test Files (can delete)
- `test-queue-clustering.mjs` — threshold exploration, superseded
- `test-thresholds.mjs` — threshold exploration, superseded
- `test-preprocessor.mjs` — pre-processor logic now in relay-client.ts
- `test-two-phase.mjs` — design validation, architecture now implemented
