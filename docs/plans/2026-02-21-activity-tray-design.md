# Activity Tray Design

**Goal:** Show users a transparent, real-time view of what the agent is doing, with ability to stop and queue corrections.

**Architecture:** Backend emits tool lifecycle WS events; frontend renders a collapsible tray above the input bar with an expandable step-by-step popup.

---

## Components

### Backend
- New WS events: `tool_start { tool: string, label: string }` and `tool_end { tool: string }`
- `stop_agent` WS message sets an abort flag checked between tool calls in the run loop
- Friendly label mapper: converts raw tool names (e.g. `get_rental_estimate`) to human-readable strings (e.g. "Getting rental estimate")

### Frontend — Activity Tray
- Slim bar rendered between scroll area and input, visible only while agent is active
- Shows current tool label with animated indicator, Stop button, and expand chevron
- Collapses and disappears on `chat_response`

### Frontend — Activity Popup
- Slides up from tray (~280px tall), non-blocking — chat visible behind
- Shows numbered step list: completed (✓), in-progress (⟳)
- Each step shows friendly label + brief input context (e.g. "1000 Brickell Ave...")
- Correction input at bottom — held client-side, sent as normal chat message once `chat_response` fires
- Stop button kills agent immediately via `stop_agent` WS message

## Friendly Name Mapping
Raw tool names → human-readable:
- Underscores/hyphens → spaces, title-cased
- Known overrides: `search_tools` → "Searching available tools", `read_memory` → "Reading memory", `write_memory` → "Saving to memory", `search_memory` → "Searching memory", `list_memories` → "Listing memories"
- Composio tools (ALL_CAPS): `GMAIL_SEND_EMAIL` → "Sending email via Gmail"

## Data Flow
1. Agent calls tool → server emits `tool_start`
2. Tool returns → server emits `tool_end`
3. User clicks Stop → client sends `stop_agent` → server sets abort flag → loop exits after current tool → server sends `chat_response`
4. User types correction → held in state → auto-sent on `chat_response`
