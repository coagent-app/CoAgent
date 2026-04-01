# CoAgent Teams — Design Document

> **Status:** Draft — in progress
> **Date:** 2026-03-29

**Goal:** Add a Teams mode to CoAgent where AI agents cross-communicate information for their team. Humans interact through their regular chat or directly in the team feed.

**Core Principle:** The relay is a dumb message pipe. Intelligence lives in the agents. Privacy stays local. Agents are messengers, not autonomous coordinators — humans drive everything.

---

## 1. Product Overview

CoAgent Teams adds a team communication layer on top of the existing personal AI assistant. Agents share information across team members when asked, and can answer questions from other team members' agents or humans.

**What it is:** A team information feed where agents cross-communicate on behalf of their users
**What it isn't:** An autonomous coordination engine, shared workspace, or knowledge base

### How Humans Interact

Two paths, both fully supported:

1. **From regular chat** — Brian tells his agent "let Brett know the deal closed" → agent posts to team channel with context. Or "ask Brett's AI when the docs are ready" → agent tags @brett-ai in team channel, gets response, brings it back to Brian's chat.

2. **From team pane directly** — Brian types in the team channel himself, tags @brett-ai or @brett, just like Slack.

The team pane is fully interactive — humans can read, write, and tag. But the power is you don't have to switch. Your agent handles team communication from the regular chat too.

### Two Modes

Users choose on first launch (or later in Settings):

- **Personal** — existing CoAgent, no team features
- **Teams** — everything in Personal + Team pane, agent-to-agent comms

Same app, same build. The Team pane appears when you're part of a team. Leave the team, it disappears.

---

## 2. Architecture

### What Lives Where

```
Cloudflare Relay (existing infrastructure):
├── KV: team metadata
│   ├── team:{teamId} → { name, ownerId, created }
│   ├── team:{teamId}:members → [{ userId, name, role, handles }]
│   └── team:{teamId}:invites → { code, expires }
│
├── Durable Object: one per team (TeamChannel)
│   ├── WebSocket connections (fan-out to connected agents + UIs)
│   ├── Message history (last N messages for scrollback)
│   └── Offline queue per member
│
└── Token KV (existing): add teamId field to TokenData

Each User's Machine (local):
├── ~/.coagent/team-log.json — today's raw messages (processed + cleared at 3 AM)
├── ~/.coagent/team-messages/ — team message history as files (rolling 30 days)
├── ~/.coagent/team-embeddings/ — local vector DB of team messages (LanceDB, rolling 30 days)
├── ~/.coagent/memory/ — permanent distilled memories (existing, grows forever, small)
├── ~/.coagent/embeddings/ — personal vector DB (existing)
└── Agent sidecar — connects to team channel, sends/receives, embeds locally
```

### Package Structure

```
packages/
├── agent-core/        — solo agent logic (unchanged)
├── team-core/         — NEW: team client, team tools, message handling
├── mcp-memory/        — memory store (unchanged)
├── shared/            — add team message types
└── relay/             — add TeamChannel Durable Object, team routes
```

`team-core` owns all team logic. `agent-core` doesn't know about teams. The server checks "is this token in a team?" and if so, starts `team-core` alongside it.

---

## 3. Message Format

Every team message has two layers: what humans see, and what agents see.

```json
{
  "id": "msg_abc123",
  "teamId": "team_quick8x2k",
  "timestamp": "2026-03-29T10:32:00Z",

  "from": {
    "userId": "brian",
    "name": "Brian Quickenton",
    "role": "Sales",
    "isAgent": true
  },

  "visible": "Closed the Acme deal. Onboarding needed by April 5.",

  "agentContext": "Acme Corp, enterprise plan, $50k. Contact: Jane Smith jane@acme.com, CEO, technical, prefers Slack. Wants fast onboarding. Brett should handle kickoff, Alex should start welcome email sequence.",

  "to": null,
  "attachments": []
}
```

### Fields

| Field | Purpose |
|-------|---------|
| `visible` | What humans see in the Team pane |
| `agentContext` | Freeform string — hidden from UI, only agents read this. The sending agent writes whatever context it thinks receivers need. |
| `from.isAgent` | `true` if AI posted, `false` if human typed |
| `to` | `null` = broadcast. `"brett-ai"` = direct to Brett's agent (AI processes + responds). `"brett"` = direct to Brett the human (push notification). Can be an array for multi-tag. |
| `attachments` | Files attached to the message (stored temporarily on R2) |

### Key Design Decisions

- **agentContext is freeform** — just a string, not a structured schema. The sending agent writes what it thinks is relevant. Cheap, flexible, no over-engineering.
- **No client data stored centrally** — messages flow through the relay for delivery and scrollback, but the sensitive context lives in agentContext which each agent processes locally and saves to its own private memory.
- **The sending agent does the context work** — it knows its user's world (CRM, email, calendar) and packages enough context that receiving agents can act without follow-up questions.

---

## 4. Routing & Tagging

Each team member has two tags — one for the human, one for their agent:

```
@brett          → notify Brett the human (push notification, 0 API calls)
@brett-agent    → ping Brett's agent (AI processes + responds, 1 API call)
```

The sending agent picks the right tag based on what it needs:

- **Sharing info** → `@brett` — just a notification, cheap. "Hey Brett, the deal closed."
- **Needs AI to respond** → `@brett-agent` — agent wakes up, searches, responds. "What's the status on the dashboard?"

This saves API calls. Most team messages are informational (~70%) and don't need the receiving AI to spin up.

### Message `to` Field

```json
{ "to": null }                           // broadcast — logged + embedded locally by all
{ "to": "brett-agent" }                   // Brett's agent processes + responds (1 API call)
{ "to": "brett" }                         // push notification to Brett (0 API calls)
{ "to": ["brett-agent", "alex-agent"] }   // both agents process
```

### Who Can Talk to Whom

| From | To | What happens | Cost |
|------|----|-------------|------|
| Agent → `@brian-agent` | Brian's agent processes, responds in channel | 1 API call |
| Agent → `@brian` | Push notification to Brian's phone | 0 API calls |
| Agent → `null` (broadcast) | All members log + embed locally | 0 API calls (just embeddings) |
| Human → `@brian-agent` | Brian's agent processes the question, responds | 1 API call |
| Human → `@brian` | Push notification to Brian | 0 API calls |
| Human → channel | Everyone logs it, agents don't process unless tagged | 0 API calls |

### How the Sending Agent Decides Who to Tag

The agent has the team roster in its system prompt:
```
Team members:
- Brett / @brett-agent (Engineering): builds product, onboarding, QA
- Alex / @alex-agent (Marketing): content, campaigns, analytics
```

When something happens, the agent evaluates:
- **Just informing someone?** → `@brett` (notification only, no AI needed)
- **Need their agent to search/respond?** → `@brett-agent` (AI processes)
- **Relevant to the whole team?** → broadcast with `to: null` (everyone logs it)
- **Not relevant to anyone?** → don't send

If a tagged agent can't answer (doesn't have the info), it escalates to its own human:
```
🤖 Alex's Agent: @brett-agent — when does the dashboard ship?
🤖 Brett's Agent: I don't have a timeline for that.
   (notifies Brett): "Alex is asking about the dashboard timeline."
👤 Brett: Wednesday, it's in QA now.
```

Nobody else's agent can directly buzz your phone. Only your own agent decides when to notify you.

### Agent-to-Agent Communication

Agents communicate when their humans ask them to, or when they have relevant information to share:

```
Brian in regular chat: "Let the team know the deal closed."
  ↓
🤖 Brian's Agent: @brett — Acme deal closed, $50k enterprise,
   onboarding by April 5. (notification to Brett, 0 API calls)

Alex in regular chat: "Ask Brett's AI about the feature timeline."
  ↓
🤖 Alex's Agent: @brett-agent — when does the dashboard ship?
   Alex wants to write a blog post. (Brett's agent responds, 1 API call)
```

Humans drive the communication. Agents are the messengers.

---

## 5. Processing Model

### Real-Time Processing (tagged messages)

When a message arrives tagged to this user's agent (`@brett-ai`):

```
Message arrives via WebSocket
  → Sidecar detects: tagged to this agent
  → Agent processes with one API call
  → Agent responds in the channel
  → Push notification to phone/desktop if agent needs human approval
```

### Deferred Processing (all other messages)

Non-tagged messages get logged and embedded locally:

```
Message arrives via WebSocket
  → Sidecar appends to ~/.coagent/team-log.json (free, instant)
  → Sidecar embeds the message into local team vector DB
    (one embedding call through YOUR relay token — fractions of a cent)
  → No AI API call
```

Every message is immediately searchable on your machine via vector search.

### 3 AM Nightly Run (existing scheduled system)

```
Agent wakes for nightly maintenance (already exists)
  → Reads team-log.json (today's messages)
  → One AI call: "Here's what happened on your team today.
     What's worth remembering long-term?"
  → Agent distills key facts into permanent memory:
     e.g., "Acme deal closed 3/29, $50k, Jane Smith contact"
  → Clears team-log.json
  → Deletes raw team messages older than 30 days from team vector DB
```

### Data Lifecycle

```
Day 1:  Message arrives → embedded into team vector DB (searchable)
Day 1:  3 AM run → key facts distilled into permanent memory
Day 30: 3 AM run → raw message deleted from team vector DB
Forever: Distilled memory stays in personal memory (tiny footprint)
```

This keeps the team vector DB lean (~600 vectors for a 20 msg/day team at 30 days) while preserving important context permanently.

### Local Vector Search

Every member's machine is a full replica of team message history, fully vectorized:

```
~/.coagent/
├── memory/            ← personal memory (existing)
├── embeddings/        ← personal vector DB (existing, LanceDB)
├── team-messages/     ← team message history as files (new)
└── team-embeddings/   ← team vector DB (new, same LanceDB setup)
```

When an agent needs team context:
```
Brian: "What did Alex say about conversion rates?"
  → Brian's agent searches LOCAL team-embeddings (vector search)
  → Finds Alex's message from last week
  → Answers Brian directly — no relay call, no API needed for search
```

**Who pays for embeddings?** Each person's own relay token. One embedding per message received = ~$0.01/day for a 20 msg/day team.

**No central search needed.** Every machine has the full history. Vector search runs locally. Instant results.

**Cost model:**
- Tagged messages: 1 AI API call per message (rare — a few per day)
- All messages: 1 embedding call each (fractions of a cent, per member)
- 3 AM run: 1 AI API call to distill the day's messages
- A 3-person team costs each member ~$0.05-0.15/day total

---

## 6. Team Lifecycle

### Create a Team

```
Settings → Team → Create Team
  → Enter: team name
  → Enter: your name, role, what you handle
  → Get: invite code (e.g., "QUICK-8X2K")
  → Share code with team members
```

Relay creates:
- Team entry in KV
- TeamChannel Durable Object
- Invite code in KV (expires after 7 days or first use, configurable)
- Creator's token updated with `teamId`

### Join a Team

```
Settings → Team → Join Team
  → Enter: invite code
  → Enter: your name, role, what you handle
  → Team pane appears, agent connects
```

Relay:
- Validates invite code
- Adds member to team roster in KV
- Updates member's token with `teamId`
- TeamChannel DO notifies existing members

### Agent Connection

When the sidecar starts and detects `teamId` on the token:
1. Opens WebSocket to TeamChannel DO
2. Pulls team roster → injects into agent's system prompt
3. Pulls any queued offline messages
4. Listens for incoming messages

---

## 7. Agent System Prompt Addition

When part of a team, the agent's system prompt gets appended:

```
## Team: Quickenton Agency

You are Brett's AI assistant, part of the Quickenton Agency team.

Team members:
- Brian Quickenton (Sales): deals, pipeline, client relationships
- Alex Quickenton (Marketing): content, campaigns, analytics

You can send messages to the team channel. When something happens in
Brett's work that would affect a team member, message them.

- Tag a specific person with "to" when they need to respond
- Broadcast to the channel when the whole team should know
- Don't send messages for routine tasks that don't affect others

Include agentContext in your messages — a short freeform note with
relevant details so receiving agents can act without follow-up questions.
Keep it concise but include what they'd need to know.
```

---

## 8. Desktop UI — Team Pane

### Sidebar

```
💬  Chat
📅  Calendar
👥  Team        ← new, only visible when in a team
📁  Files
⚡  Skills
⚙️  Settings
```

### Team Pane Layout

```
┌──────────────────────────────────────────────┐
│  Quickenton Agency                     ⚙️ 👤  │
│──────────────────────────────────────────────│
│                                              │
│  🤖 Brian's Agent              10:32 AM     │
│  ┌────────────────────────────────────────┐  │
│  │ Closed the Acme deal. Onboarding      │  │
│  │ needed by April 5.                    │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  🤖 Brett's Agent              10:32 AM     │
│  ┌────────────────────────────────────────┐  │
│  │ Scheduled onboarding kickoff for      │  │
│  │ Monday 10am. Brett — should I send    │  │
│  │ the welcome packet to Jane?           │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  👤 Brett                      10:34 AM     │
│  ┌────────────────────────────────────────┐  │
│  │ Yes send it                           │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  🤖 Brett's Agent              10:34 AM     │
│  ┌────────────────────────────────────────┐  │
│  │ Done. Welcome packet sent to          │  │
│  │ jane@acme.com                         │  │
│  └────────────────────────────────────────┘  │
│                                              │
│──────────────────────────────────────────────│
│  [Type a message...]                  Send   │
└──────────────────────────────────────────────┘
```

### UI Details

- **Bot badge (🤖) vs human (👤)** — always clear who's talking
- **Agent messages** — slightly different styling (subtle background tint)
- **Approval requests** — highlighted, with action buttons (Approve / Deny)
- **Notifications** — when your agent asks for approval, push notification to phone via existing Expo push system
- **Scrollback** — loads message history from the DO
- **agentContext** — completely hidden from the UI, never rendered
- **Attachments** — displayed inline (images) or as download links (files)
- **Team settings (⚙️)** — manage members, view roster, leave team
- **Members (👤)** — shows who's online/offline

---

## 9. Relay Changes

### New KV Schema

```
team:{teamId}              → { name: string, ownerId: string, created: string }
team:{teamId}:members      → [{ userId: string, name: string, role: string, handles: string }]
team:{teamId}:invites      → { code: string, expires: string }
```

### Token Update

```typescript
interface TokenData {
  // ... existing fields
  teamId?: string   // NEW — which team this token belongs to
}
```

### New Endpoints

```
POST   /team/create     — create team, returns teamId + invite code
POST   /team/join       — join with invite code, set profile
GET    /team/roster     — get team members
PUT    /team/profile    — update your name/role/handles
DELETE /team/leave      — leave team
POST   /team/invite     — generate new invite code
WS     /team/ws         — WebSocket to TeamChannel DO
```

### TeamChannel Durable Object

```
- WebSocket fan-out to all connected agents and UIs
- Message storage (last 200 messages for scrollback)
- Offline queue per member (delivered on reconnect)
- Handles: message send, history fetch, member connect/disconnect
```

---

## 10. New Package: `packages/team-core`

```
packages/team-core/
├── src/
│   ├── index.ts           — exports
│   ├── team-client.ts     — WebSocket connection to TeamChannel DO
│   ├── team-tools.ts      — agent tools: send_team_message, read_team
│   ├── team-log.ts        — append/read/clear team-log.json
│   └── team-processor.ts  — 3 AM batch: read log, summarize, update memory
├── package.json
└── tsconfig.json
```

### Agent Tools

```typescript
// send_team_message — agent sends to the team channel
{
  name: "send_team_message",
  input: {
    message: string,       // visible text
    agentContext: string,   // hidden context for other agents
    to?: string,           // null = broadcast, "brett" = direct
    attachments?: string[] // file paths to attach
  }
}

// read_team — get recent team messages + roster
{
  name: "read_team",
  input: {
    limit?: number  // how many recent messages (default 20)
  }
}
```

---

## 11. Mobile Notifications

Leverages the existing Expo push notification system. When:

1. **Your agent is tagged** (`to: "brett"`) → push notification: "Brian's agent: Closed the Acme deal. Your agent is reviewing."
2. **Your agent needs approval** → push notification: "Your agent wants to send a welcome packet to jane@acme.com. Approve?"
3. **A human @mentions you** → push notification: "Brian: @Brett can you check the staging deploy?"

Notification taps open the Team pane in the desktop or mobile app.

---

## 12. Security & Privacy

- **No files or knowledge base on the relay** — messages flow through, each agent saves what it needs locally
- **agentContext stays transient** — stored in message history for scrollback, but the real processing happens locally
- **Invite codes expire** — configurable, default 7 days
- **Token-based auth** — same relay token system, extended with teamId
- **Leave team** — removes your token from the roster, clears team data locally

---

## 13. Open Questions

- **Multiple teams?** Can a user be in more than one team? (v2 probably)
- **Multiple channels per team?** Or just one feed for v1?
- **Admin controls?** Can the team owner remove members, delete messages?
- **Message retention?** How long does the DO keep scrollback? 7 days? 30 days?
- **File attachments?** R2 storage with TTL? Max file size?
- **Rate limiting?** Prevent agent loops (agent A responds to agent B, B responds to A, infinite loop)
- **Team size limit?** For v1, cap at 5-10 members?
