# CoAgent Generalization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Strip all real-estate-specific code from the CoAgent fork and replace it with a generic, adaptive, consumer-friendly AI agent platform.

**Architecture:** The agent's identity and behavior come entirely from a `~/.coagent/memory/agent.md` file it writes during onboarding. If that file doesn't exist the agent starts an open-ended adaptive conversation to learn about the user. No hardcoded vertical, no fixed question script.

**Tech Stack:** TypeScript, Node.js, Anthropic SDK, Composio, MCP, pnpm monorepo

---

### Task 1: Remove mcp-rentcast

**Files:**
- Delete: `packages/mcp-rentcast/` (entire directory)
- Modify: `packages/agent-core/src/server.ts:19-36`
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json` (root)

**Step 1: Delete the rentcast package**

```bash
rm -rf /Users/brettponters/AI-Projects/CoAgent/packages/mcp-rentcast
```

**Step 2: Remove rentcast from server.ts**

In `packages/agent-core/src/server.ts`, remove these lines entirely:

```typescript
// DELETE these lines:
const mcpRentcastPath = (() => { try { return require.resolve('@coagent/mcp-rentcast') } catch { return null } })()

// DELETE this block from mcpConfigs:
...(process.env.RENTCAST_API_KEY && mcpRentcastPath ? [{
  name: 'rentcast',
  command: 'node',
  args: [mcpRentcastPath],
  env: { RENTCAST_API_KEY: process.env.RENTCAST_API_KEY } as Record<string, string>
}] : [])
```

**Step 3: Remove from pnpm-workspace.yaml**

Open `pnpm-workspace.yaml`. Remove `packages/mcp-rentcast` from the packages list. The file should only list packages that still exist.

**Step 4: Build to verify no errors**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core
npm run build 2>&1
```

Expected: clean build, no TypeScript errors.

**Step 5: Commit**

```bash
cd /Users/brettponters/AI-Projects/CoAgent
git add -A
git commit -m "chore: remove mcp-rentcast (real estate specific)"
```

---

### Task 2: Generalize queue types in shared package

**Files:**
- Modify: `packages/shared/src/index.ts:10-21`

**Step 1: Update ApprovalItem type**

In `packages/shared/src/index.ts`, change the `type` field of `ApprovalItem` from:

```typescript
type: 'contract' | 'analysis' | 'cma' | 'email' | 'other'
```

To:

```typescript
type: 'task' | 'document' | 'message' | 'request' | 'other'
```

**Step 2: Build shared**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/shared
npm run build 2>&1
```

Expected: clean build.

**Step 3: Build agent-core (catches type mismatches)**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core
npm run build 2>&1
```

Expected: clean build. If there are errors, they'll be in `agent.ts` line 35 — update the enum there too:

```typescript
// In INTERNAL_TOOLS, queue_approval tool, change:
type: { type: 'string', enum: ['contract', 'analysis', 'cma', 'email', 'other'] },
// To:
type: { type: 'string', enum: ['task', 'document', 'message', 'request', 'other'] },
```

**Step 4: Commit**

```bash
cd /Users/brettponters/AI-Projects/CoAgent
git add -A
git commit -m "feat: generalize queue approval types"
```

---

### Task 3: Update composio-setup.ts config name

**Files:**
- Modify: `packages/agent-core/src/composio-setup.ts:7`

**Step 1: Change the MCP config name**

In `packages/agent-core/src/composio-setup.ts`, change:

```typescript
const MCP_CONFIG_NAME = 'coagent-real-estate'
```

To:

```typescript
const MCP_CONFIG_NAME = 'coagent'
```

**Step 2: Build to verify**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core
npm run build 2>&1
```

Expected: clean build.

**Step 3: Commit**

```bash
cd /Users/brettponters/AI-Projects/CoAgent
git add packages/agent-core/src/composio-setup.ts
git commit -m "chore: rename composio MCP config from coagent-real-estate to coagent"
```

---

### Task 4: Generalize the agent system prompt and onboarding

This is the main task. Three things to change in `packages/agent-core/src/agent.ts`:

1. The `buildSystemPrompt` function (lines 164–232)
2. The `SYNONYMS` map (line 121) — remove `rent` entry
3. The `buildTriggerMessage` heartbeat text (line 502) — remove real estate references

**Files:**
- Modify: `packages/agent-core/src/agent.ts`

**Step 1: Remove the `rent` synonym**

Find in `agent.ts`:
```typescript
rent: ['rental', 'estimate', 'rentcast', 'lease'],
```
Delete that line entirely.

**Step 2: Replace buildSystemPrompt**

Replace the entire `buildSystemPrompt` function (lines 164–232) with:

```typescript
function buildSystemPrompt(connectedServices: string[], agentProfilePath: string): string {
  const isFirstRun = !existsSync(agentProfilePath)

  const serviceSection = connectedServices.length > 0
    ? `Connected external services: ${connectedServices.join(', ')}. Use search_tools to find the right tool before calling it.`
    : 'No external services are connected yet. If the user wants to connect tools, tell them to open Settings and connect their integrations.'

  const onboardingSection = isFirstRun ? `

ONBOARDING — this user has not set up their profile yet. Start with:
"Hey, I'm CoAgent — your AI agent. What do you want to tackle first?"

From their answer, ask natural follow-up questions one at a time to learn:
- What they do (work, projects, life — whatever they share)
- What they want help with day-to-day
- Which connected integrations they want you to monitor (based on what's connected)
- How automated they want things — what should you handle without asking vs always queue for approval
- Any recurring tasks or routines they want you to run

Do NOT follow a fixed script. Let the conversation guide you. Ask smarter follow-ups based on what they tell you.

When you have enough context, write their profile to agent.md:
# [Name or "You"]
**About**: [what they do, in their words]
**Focus**: [what they want help with most]

## Routines
- [what to monitor, how often]
- [what to handle automatically]
- [what always needs approval]

Then say: "You're all set. I'll run quietly in the background and flag anything that needs your attention."` : ''

  return `You are CoAgent — a capable, private AI agent that runs locally on the user's machine. Help with anything asked: email, scheduling, research, calculations, analysis, writing, coding. Never refuse by saying something is outside your scope.

Always-available tools: memory tools, search_tools, queue_approval, add_done_item, add_todo, complete_todo, run_python.

Use run_python for any calculations, data processing, or formatting that benefits from code.

${serviceSection}

How to use external tools:
1. Call search_tools("what you want to do") to find relevant tool schemas
2. The matching tools are then available to call directly
3. Never guess a tool name — always search first

Memory is your long-term brain — conversation history only shows the last 15 messages. Write anything important to memory immediately or it will be lost.

Memory structure — adapt to what the user does:
- agent.md — user profile and routines
- Use subdirectories and filenames that match their world (clients/, projects/, contacts/, etc.)

After every action: update the relevant memory file with what you did, to whom, when, and why. Prune stale or resolved entries — outdated information is worse than none.

For routine tasks: act, then call add_done_item.
For high-stakes or irreversible actions: call queue_approval instead.
On heartbeat: read agent.md to know what routines to run. Search events for anything relevant. If nothing is due, reply "All clear." immediately.

Keep responses concise. No emojis. Markdown only when helpful.${onboardingSection}`
}
```

**Step 3: Generalize buildTriggerMessage heartbeat text**

Find the heartbeat case in `buildTriggerMessage` (around line 502):

```typescript
return `[Heartbeat — ${time}] Check for incoming events using search_events. Read agent.md for your active deals and clients, then call search_events once per deal/client to find relevant events. Finish with a broad sweep: search_events("new leads unread messages urgent"). Handle what you find and call mark_events_done with the event IDs when done. Read agent.md for your routines and run any that are due.${dueSection} Reply with a brief summary of what you did, or "All clear." if nothing needed action.`
```

Replace with:

```typescript
return `[Heartbeat — ${time}] Read agent.md to know your routines and who/what to check on. Search for incoming events with search_events — use specific queries based on what you know about this user's world, then finish with a broad sweep: search_events("unread messages urgent follow-up"). Handle what you find and call mark_events_done when done. Run any routines that are due.${dueSection} Reply with a brief summary of what you did, or "All clear." if nothing needed action.`
```

**Step 4: Generalize memory_cleanup trigger message**

Find (around line 504):
```typescript
if (trigger.source === 'memory_cleanup') return `[Memory cleanup — ${time}] Review all memory files with list_memories, then read each one. Delete or rewrite files that are stale, resolved, or no longer relevant (closed deals, old leads that went cold, outdated market notes, etc.). Consolidate duplicate entries. Keep only what is actively useful. Reply with a brief summary of what you cleaned up.`
```

Replace with:
```typescript
if (trigger.source === 'memory_cleanup') return `[Memory cleanup — ${time}] Review all memory files with list_memories, then read each one. Delete or rewrite files that are stale, resolved, or no longer relevant. Consolidate duplicates. Keep only what is actively useful. Reply with a brief summary of what you cleaned up.`
```

**Step 5: Build**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core
npm run build 2>&1
```

Expected: clean build.

**Step 6: Commit**

```bash
cd /Users/brettponters/AI-Projects/CoAgent
git add packages/agent-core/src/agent.ts
git commit -m "feat: generalize agent system prompt and adaptive onboarding"
```

---

### Task 5: Write INTEGRATIONS.md

**Files:**
- Create: `docs/INTEGRATIONS.md`

**Step 1: Create the file**

Create `/Users/brettponters/AI-Projects/CoAgent/docs/INTEGRATIONS.md` with this content:

```markdown
# CoAgent Integrations

Connect your tools through the Settings panel in the desktop app. CoAgent uses [Composio](https://composio.dev) to connect to external services.

---

## Integrations with Triggers (Real-time monitoring)

These integrations can notify CoAgent when something happens — new emails, calendar events, messages, etc.

### Gmail
- **Triggers:** New email received
- **Actions:** Send email, reply, search inbox, read threads, manage labels
- **Use cases:** Auto-draft replies to leads, flag urgent emails, summarize threads

### Outlook
- **Triggers:** New email received
- **Actions:** Send email, reply, search inbox, read threads
- **Use cases:** Same as Gmail for Microsoft 365 users

### Google Calendar
- **Triggers:** Event created, event starting soon
- **Actions:** Create event, update event, list upcoming events, delete event
- **Use cases:** Meeting reminders, schedule follow-ups, block focus time

### Google Drive
- **Triggers:** File created, file shared with you
- **Actions:** Upload file, list files, read file contents, create folder
- **Use cases:** Auto-file documents, monitor shared folders

### Slack
- **Triggers:** New message in channel, thread reply, direct message
- **Actions:** Send message, reply to thread, list channels
- **Use cases:** Monitor team channels, post summaries, send notifications

### HubSpot
- **Triggers:** New contact created, deal stage updated
- **Actions:** Create/update contact, log activity, manage deals and pipelines
- **Use cases:** CRM automation, lead follow-up, deal tracking

### Notion
- **Triggers:** New page added, new comment
- **Actions:** Create page, update page, search workspace
- **Use cases:** Auto-log notes, create project pages, track tasks

---

## Action-Only Integrations

These integrations support actions (CoAgent can do things) but do not send real-time trigger events.

### DocuSign
- **Actions:** Send document for signature, check signature status
- **Use cases:** Send contracts, track signing progress

### Dropbox
- **Actions:** Upload/download files, list folder contents, share files
- **Use cases:** File storage and retrieval

### Calendly
- **Actions:** Get availability, list scheduled events
- **Use cases:** Check schedule, reference upcoming bookings

### LinkedIn
- **Actions:** Search profiles, get profile details, send connection request
- **Use cases:** Research contacts, outreach

### Zoom
- **Actions:** Create meeting, get meeting details, list meetings
- **Use cases:** Schedule calls, get join links

### HighLevel (GHL)
- **Actions:** Manage contacts, pipelines, and conversations
- **Use cases:** Marketing CRM automation

---

## Coming Soon

Have an integration you need? [Open an issue](https://github.com/your-org/coagent/issues).
```

**Step 2: Commit**

```bash
cd /Users/brettponters/AI-Projects/CoAgent
git add docs/INTEGRATIONS.md
git commit -m "docs: add INTEGRATIONS.md with all Composio integrations"
```

---

### Task 6: Install dependencies and verify full build

**Step 1: Install all dependencies**

```bash
cd /Users/brettponters/AI-Projects/CoAgent
pnpm install 2>&1
```

If pnpm is not available, use npm workspaces:
```bash
cd /Users/brettponters/AI-Projects/CoAgent
npm install 2>&1
```

**Step 2: Build all packages in order**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/shared && npm run build 2>&1
cd /Users/brettponters/AI-Projects/CoAgent/packages/mcp-memory && npm run build 2>&1
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core && npm run build 2>&1
```

Expected: all three build clean with no TypeScript errors.

**Step 3: Run existing tests**

```bash
cd /Users/brettponters/AI-Projects/CoAgent/packages/agent-core && npm test 2>&1
```

Expected: all tests pass. The queue test may need updating — if it references `type: 'contract'` or `type: 'cma'`, update those to `type: 'task'` or `type: 'document'`.

**Step 4: Commit**

```bash
cd /Users/brettponters/AI-Projects/CoAgent
git add -A
git commit -m "chore: install deps and verify full build passes"
```

---

### Task 7: Update README.md

**Files:**
- Modify or Create: `README.md`

**Step 1: Write README**

Create `/Users/brettponters/AI-Projects/CoAgent/README.md`:

```markdown
# CoAgent

A private, local AI agent for your work and life. Runs on your machine — your data never leaves.

## What it does

- Monitors your email, calendar, Slack, and other connected tools
- Handles routine tasks automatically, queues high-stakes ones for your approval
- Learns your workflow through conversation — no config files
- Accessible from your phone via the relay

## Setup

1. Clone the repo
2. Run `pnpm install`
3. Copy `.env.example` to `~/.coagent/.env` and fill in your API keys
4. Run `pnpm dev` to start the agent
5. Open the desktop app — CoAgent will introduce itself and ask what you want help with

## Integrations

See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) for the full list of supported integrations.

## API Keys needed

- `ANTHROPIC_API_KEY` — [get one here](https://console.anthropic.com)
- `COMPOSIO_API_KEY` — [get one here](https://composio.dev) (for integrations)
- `VOYAGE_API_KEY` — [get one here](https://www.voyageai.com) (for semantic event search)
- `RELAY_URL`, `RELAY_USER_ID`, `RELAY_TOKEN` — deploy the Cloudflare relay for phone access (optional)

## Open Source

MIT License.
```

**Step 2: Commit**

```bash
cd /Users/brettponters/AI-Projects/CoAgent
git add README.md
git commit -m "docs: add README for open source CoAgent"
```
