# Team Message Context System Design

## Goal

Give agents relevant conversation context when they receive team messages, using a hybrid of recent messages + semantic search over embedded team history.

## Architecture

### Separate Team Thread

Team messages are processed on a **separate conversation history** from personal chat. The `Agent` class gets a new `teamChat()` method with:

- Its own `teamConversationHistory` stored at `{dataDir}/team-history.json`
- Its own system prompt (roster, roles, team instructions)
- Access to all existing tools (memory, integrations, send_team_message)
- Uses **Haiku** by default (fast, cheap — team interactions are simpler)
- Capped at ~50 messages, same as personal chat

Personal `chat()` is unchanged. If a user says "tell the team about X" in personal chat, the agent composes a message from personal context and uses `send_team_message` — no cross-contamination.

### TeamLog Embeddings

`TeamLog` gains embedding capabilities:

- New LanceDB table at `{dataDir}/team-embeddings/`
- On `append(message)`, embed `visible + agentContext` concatenated
- Schema: `{ id, from, timestamp, to, content, vector }`
- Same model as memory: `text-embedding-3-small`, 512 dims, via relay
- Graceful degradation: if relay is down, skip embedding, store message in JSON only. Catch up on un-embedded messages next time (mtime-style check).

Privacy boundary: only messages that arrive through your TeamClient get embedded. The relay already enforces visibility — it only sends you broadcasts and messages where you're a sender or recipient. Brian-to-Betty DMs never reach Brett's agent, so they never enter Brett's embeddings. No extra filtering needed.

New methods:

- `getRecentMessages(n: number, filter?)` — last N from team-log.json, optionally filtered by channel (broadcast-only or specific DM thread)
- `searchMessages(query: string, topK: number)` — vector search over team-embeddings (all messages you've seen)

### Context Assembly

When a tagged message arrives at `onTaggedMessage`:

1. `getRecentMessages(5, channel)` — last 5 messages **in the same channel** (General or specific DM thread) for conversational flow
2. `searchMessages(incomingMessage.visible, 5)` — top 5 semantic matches from **all** your team history (excluding the recent 5)
3. Build context block:

```
[Recent team messages]
- Brian (2min ago): "The Acme renewal is at $50k"
- Brett's Agent (5min ago): "I'll check the contract terms"
...

[Relevant older context]
- Brian (3 days ago): "Acme Corp wants to renew, initial ask was $45k"
- Brett's Agent (3 days ago): "Found the original contract in files — signed at $40k/yr"
...
```

4. Pass to `agent.teamChat(message, contextBlock)`

### Data Flow

```
Team message arrives via relay WebSocket
  → TeamClient.handleMessage()
  → onTaggedMessage callback (server.ts)
  → TeamLog.getRecentMessages(5)
  → TeamLog.searchMessages(visible, 5)
  → agent.teamChat(message, assembledContext)
    → uses Haiku, separate history, same tools
  → agent calls send_team_message tool to respond
  → response goes to relay → fans out to team
```

## What Changes

| Component | Change |
|-----------|--------|
| `TeamLog` (team-core) | Add LanceDB embedding on append, add `getRecentMessages()` and `searchMessages()` methods |
| `Agent` (agent-core) | Add `teamChat()` method with separate conversation history, Haiku model |
| `server.ts` (agent-core) | Update `onTaggedMessage` to assemble context and call `teamChat()` instead of `chat()` |

## What Doesn't Change

- TeamClient, relay, WebSocket routing — all unchanged
- Personal chat — completely unaffected
- Memory system — still separate, still accessible from team thread via tools
- Frontend TeamPane — no changes needed
- send_team_message tool — same tool, works from both personal and team threads
