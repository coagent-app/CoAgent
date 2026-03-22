# CoAgent — General Purpose Design

## Goal

Fork the real estate Co-Agent into a self-hosted, open source AI agent platform that anyone (individual, freelancer, small business) can install, configure through conversation, and run locally on their own machine.

## Core Principles

- **Local-first / privacy-first** — data never leaves the user's machine
- **No hardcoded vertical** — no assumptions about what the user does
- **Consumer self-serve** — set up through conversation, no config files or coding required
- **Adaptive, not scripted** — agent figures out what to ask based on context
- **Phone access** — relay architecture kept intact

---

## What Changes vs What Stays

### Stays exactly the same
- Cloudflare relay (WS, phone access)
- Event store + Voyage semantic search
- Composio integrations (all 13 — user picks what they need)
- Queue / approval system
- Desktop app UI
- MCP memory package
- Scheduler / heartbeat
- `mcp-memory` package (already generic)

### Removed / generalized
- System prompt: "AI assistant for a real estate agent" → generic
- Onboarding: hardcoded real estate questions → adaptive conversation
- Queue types: `contract | cma | analysis` → `task | document | message | request | other`
- `mcp-rentcast` package dropped entirely
- MCP config name: `coagent-real-estate` → `coagent`
- Memory categories: hardcoded real estate tags → agent infers from user context

---

## Onboarding Flow

No hardcoded question script. The agent opens with:

> "Hey, I'm CoAgent — your AI agent. What do you want to tackle first?"

From there the agent reads context from the user's answers and asks adaptive follow-ups:
- If they mention clients → asks about follow-up cadence
- If they mention email → surfaces Gmail / Outlook connection
- If they mention scheduling → surfaces Google Calendar
- Asks how automated they want things to be
- Asks what always needs their approval before acting

The agent writes its own configuration into memory from the conversation — what this person does, what matters to them, tone, approval threshold. No static config file.

---

## Integrations

All 13 Composio integrations available. User connects what they need through the existing integrations panel:

| Integration | Triggers | Actions |
|-------------|----------|---------|
| Gmail | ✅ | ✅ |
| Outlook | ✅ | ✅ |
| Google Calendar | ✅ | ✅ |
| Google Drive | ✅ | ✅ |
| Slack | ✅ | ✅ |
| HubSpot | ✅ | ✅ |
| Notion | ✅ | ✅ |
| DocuSign | — | ✅ |
| Dropbox | — | ✅ |
| Calendly | — | ✅ |
| LinkedIn | — | ✅ |
| Zoom | — | ✅ |
| HighLevel | — | ✅ |

A separate `INTEGRATIONS.md` will document each integration: what it can do, what triggers fire, example use cases.

---

## Memory System

The `mcp-memory` vector store is already generic. What changes is the system prompt:
- Remove hardcoded real estate categories (rent, showing, leads, etc.)
- Agent decides what to remember based on what the user told it during onboarding
- System prompt instructs: "After learning about this user, store what matters to their workflow — clients, projects, preferences, recurring tasks, whatever is relevant to them"

---

## Repo Structure

```
/Users/brettponters/AI-Projects/CoAgent/
  apps/
    desktop/                  ← same UI, no changes
  packages/
    agent-core/               ← generalized agent (main changes here)
    shared/                   ← generalized types
    mcp-memory/               ← unchanged
    relay/                    ← unchanged
  docs/
    plans/
    INTEGRATIONS.md           ← integration reference doc
  README.md
```

`mcp-rentcast` is not included. Real estate version stays frozen at:
`/Users/brettponters/AI-Projects/Real Estate Agent/coagent/`

---

## Implementation Tasks

1. Initialize git repo in `/Users/brettponters/AI-Projects/CoAgent/`
2. Remove `mcp-rentcast` from packages and all references
3. Generalize `agent.ts` system prompt and onboarding questions
4. Generalize queue types in `shared/index.ts`
5. Update `composio-setup.ts` config name
6. Write `INTEGRATIONS.md`
7. Update `README.md`
8. Install dependencies and verify build passes
