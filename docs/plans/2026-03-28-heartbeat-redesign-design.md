# Heartbeat Redesign — Event-Driven Batch Processor

## Goal

Transform the heartbeat from a dumb periodic "check everything" timer into an event-driven batch processor that digests trigger events that have accumulated since the last heartbeat.

## The Problem Today

- Triggers are subscribed (Gmail, Slack, Calendar) but fire into the void — no relay server to receive webhooks
- The event store exists (with embedding, semantic search, TTL) but is permanently empty
- The heartbeat wakes up every hour, reads routines.md, checks the schedule, and says "All clear" — burning tokens for nothing
- All the infrastructure exists, nothing is connected

## The Redesign

### Triggers → Event Store → Heartbeat

1. **Triggers fire** — Composio sends webhook when new email arrives, Slack message received, calendar event created, etc.
2. **Relay receives** — relay server catches the webhook, forwards to local CoAgent via WebSocket
3. **Events accumulate** — each event gets stored in the event store (already built: embedded, timestamped, 24h TTL)
4. **Heartbeat wakes up** — reads all unprocessed events from the event store
5. **One agent turn** — processes the entire batch: triages, acts on what matters, ignores noise, marks events done

### What the heartbeat turn looks like

The agent gets a message like:

```
Heartbeat — 4 new events since last check:

1. [Gmail] New email from alex@fanaticaldetailing.com — Subject: "Re: Website Quote"
2. [Gmail] New email from newsletter@substack.com — Subject: "Weekly Digest"
3. [Slack] DM from Nathan: "did you push the latest changes?"
4. [Calendar] Event starting soon: "Living Green Meeting" tomorrow 5:30 PM
```

Agent processes in one turn:
- Alex replied to the quote → mark the follow-up as done
- Newsletter → ignore, mark event done
- Nathan's Slack → queue a reply or notify user
- Meeting tomorrow → check if prep is needed

### What changes

| Before | After |
|--------|-------|
| Heartbeat reads routines.md and schedule | Heartbeat reads event store |
| Goes and fetches data (tool calls) | Data already arrived via triggers |
| Mostly says "All clear" | Only fires when there are events to process |
| Fixed interval (every 60 min) | Still interval-based, but skip if event store is empty |
| Expensive (multiple tool calls per beat) | Cheap (one turn, data is local) |

### Skip-if-empty

If the event store has 0 unprocessed events when the heartbeat fires, skip the turn entirely. No agent call, no tokens. The heartbeat only costs money when there's something to process.

## Dependencies

### Relay Server (blocker)

The entire pipeline depends on the relay server being set up. Without it, Composio webhooks have nowhere to go and the event store stays empty.

The relay needs to:
- Accept WebSocket connections from local CoAgent instances
- Receive Composio webhook POSTs
- Forward webhook payloads to the connected CoAgent instance
- Queue events if CoAgent is offline (deliver on reconnect)

### Event Store (already built)

- `appendToEventStore()` — stores events with embeddings
- `searchEventStore()` — semantic search over events
- `markEventsDone()` — mark processed events
- 24h TTL auto-expiry
- Noise filtering (`shouldKeepEvent()`)

### Existing Trigger Subscriptions (already working)

- `GMAIL_NEW_GMAIL_MESSAGE`
- `GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER`
- `GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER`
- `SLACKBOT_RECEIVE_MESSAGE`
- `SLACKBOT_RECEIVE_THREAD_REPLY`
- `SLACKBOT_RECEIVE_DIRECT_MESSAGE`

## Setting

The heartbeat interval setting remains. It controls how often events are batched and processed. A shorter interval means more responsive (but more turns). A longer interval means bigger batches (cheaper but slower).

The heartbeat toggle (enabled/disabled) stays too — user can turn off event processing entirely.

## Integration with Follow-Up System

When the heartbeat processes events, it can automatically resolve follow-ups:
- Follow-up watching for Alex's reply + Gmail trigger shows Alex replied → agent marks follow-up done (silent, no notification needed)
- This is where the two systems connect naturally

## Out of Scope

- Relay server implementation (separate plan needed)
- Real-time push notifications on trigger events (events batch, not stream)
- Per-trigger routing rules (all events go through the same heartbeat for now)
