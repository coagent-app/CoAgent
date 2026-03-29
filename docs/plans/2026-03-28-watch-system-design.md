# Follow-Up System Design

## Goal

Give CoAgent the ability to track outbound actions that expect a response and proactively follow up — turning the agent from reactive to proactive for freelancers who live and die by follow-ups.

## Core Concept

After the agent completes an outbound action (sends a quote, emails a client, submits a proposal), it asks the user: "Want me to follow up if you don't hear back? How long should I give them?" If the user says yes, the agent creates a **follow-up** — a calendar entry that fires at the specified time, checks the outcome, and either resolves silently or escalates to the user.

No new infrastructure. Follow-ups are calendar entries with `type: "followup"`. The scheduler already fires tasks at due times. Follow-ups fire the same way.

## Data Model

New calendar entry type alongside `routine | task | event`:

```typescript
// packages/shared/src/index.ts
export type CalendarEntryType = 'routine' | 'task' | 'event' | 'followup'

// CalendarEntry gains one new optional field:
stage?: number  // follow-up only: 1 = autonomous check, 2 = escalate to user
```

Example follow-up entry the agent creates:

```json
{
  "type": "followup",
  "label": "Follow up: Alex — website quote",
  "due": "2026-03-31T09:00:00",
  "stage": 1,
  "instruction": "Check Gmail for reply from alex@fanaticaldetailing.com about the website quote sent 03-28. If replied, mark done. If no reply, notify Brett and ask if he wants to send a follow-up.",
  "notes": "Original quote: $5k for website redesign"
}
```

## Setting

New boolean in `AgentSettings`:

```typescript
followup_enabled: boolean  // default depends on template
```

- Toggle in Settings UI: "Auto Follow-Ups"
- When OFF: the follow-up system prompt paragraph is not injected, agent has no concept of follow-ups
- When ON: the system prompt includes follow-up behavior instructions
- Existing follow-ups still fire even if toggled off (to honor commitments already made) — but no new ones are created

## Template Defaults

| Template | Default |
|----------|---------|
| Sales / Biz Dev | ON |
| Real Estate | ON |
| Creative Services | OFF |
| Consulting | ON |
| Service Providers | ON |

## Agent Behavior

### Creation Flow

1. Agent completes an outbound action that expects a response (email, proposal, invoice, meeting invite)
2. Agent asks: "Want me to follow up if you don't hear back? How long should I give them?"
3. User responds with timing ("check in 2 days", "give him a week") or declines ("nah don't worry about it")
4. If yes: agent creates a follow-up entry with appropriate instruction
5. In chat, agent confirms naturally: "Got it, I'll check in 2 days."

The agent does NOT silently create follow-ups. It always asks first.

### Stage 1 — Silent Check

When the follow-up fires:
- Full agent turn (can use integration tools — search Gmail, check CRM, etc.)
- If resolved (reply received, payment made) → mark follow-up done. No chat notification.
- If not resolved → escalate to Stage 2. Agent surfaces in chat: "Alex hasn't responded to the quote from Tuesday. Want me to follow up or drop it?"

Stage 1 runs silently like a heartbeat. User only hears about it if something needs attention.

### Stage 2 — User Decision

Agent presents the situation and asks what to do:
- "Send a follow-up" → agent drafts and sends (or queues for approval), no further follow-up
- "Give it more time" → agent creates a new follow-up with user-specified timing
- "Drop it" → done, no more tracking

No Stage 3. After two checks (one autonomous, one escalated), the user decides. The agent doesn't nag indefinitely.

## System Prompt (conditional)

Only injected when `followup_enabled` is true:

```
Follow-ups: After completing an outbound action that expects a response (email, proposal, invoice, meeting invite), ask the user if they want you to follow up and how long to wait. If yes, create a follow-up entry (type: "followup") with the due time and an instruction describing what to check and what to do for each outcome. Follow-ups fire silently — only notify the user if the expected response hasn't arrived.
```

## Calendar UI

- New color in `TYPE_COLORS`: follow-up gets its own distinct color (e.g. purple/violet)
- Agenda view: "Follow-Ups" section alongside Tasks / Routines / Events
- Follow-up entries show an eye icon
- User can edit due date (override timing) or delete (cancel the follow-up)
- User cannot manually create follow-ups — only the agent does
- Completed follow-ups disappear like completed tasks

## Scheduler

Follow-ups fire exactly like tasks:
- `getTasksDue()` query includes follow-ups (or a parallel `getFollowUpsDue()`)
- Fires at exact due time regardless of active hours
- After firing, the agent's response determines next action (mark done, escalate, or create new follow-up)
- Stale follow-up handling: follow-ups overdue >24 hours from a previous session still fire (don't auto-complete like tasks — a missed follow-up is still worth checking)

## Scope

### In scope
- `follow-up` calendar entry type with `stage` field
- `followup_enabled` setting with toggle in Settings UI
- System prompt conditional injection
- Scheduler fires follow-ups like tasks
- Calendar UI: color, icon, section in agenda view
- Agent behavior: ask before creating, silent stage 1, visible stage 2

### Out of scope (future)
- Template system (Sales, Real Estate, Creative, etc.) — separate feature
- Pre-built follow-up playbooks per template
- Follow-up analytics ("you had 12 follow-ups this week, 8 resolved automatically")
- Batch follow-up review ("here are all your open follow-ups")

## Architecture

```
User says "send Alex the quote"
        │
        ▼
Agent sends email via Gmail
        │
        ▼
Agent asks: "Want me to follow up? How long?"
        │
    ┌───┴───┐
    No      Yes (+ timing)
    │       │
    ▼       ▼
  Done    Creates follow-up entry
            │
            ▼ (due time hits)
        Scheduler fires follow-up
            │
            ▼
        Agent checks (full turn, uses tools)
            │
        ┌───┴───┐
    Resolved    Not resolved
        │           │
        ▼           ▼
    Mark done   Surface in chat:
    (silent)    "Alex hasn't replied. Want me to follow up?"
                    │
                ┌───┼───┐
            Send it  More time  Drop it
                │       │         │
                ▼       ▼         ▼
            Agent    New follow-up   Done
            follows  (user picks
            up       timing)
```
