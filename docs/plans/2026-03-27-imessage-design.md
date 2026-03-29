# iMessage Integration + CoAgent Category Design

**Goal:** Add iMessage as a first-party CoAgent integration — read conversations via chat.db, send via AppleScript — under a new "CoAgent" category in the integrations modal.

## Architecture

A new `packages/mcp-imessage` MCP server package (like mcp-memory). Appears in the integrations modal under a "CoAgent" category. Dormant until user clicks Connect, which checks/guides Full Disk Access. No API keys — just the system permission.

## MCP Server (`packages/mcp-imessage`)

SQLite reads against `~/Library/Messages/chat.db` (read-only). AppleScript for sending via `osascript`.

### Tools

- **`search_messages`** — search by contact name/number, keyword, date range
- **`get_conversation`** — get recent messages from a specific conversation
- **`list_recent_conversations`** — list conversations with last message preview
- **`send_message`** — send iMessage via AppleScript

### Pull-based only

No polling, no triggers, no background sync. The agent calls tools when it has a reason to — user asks, a scheduled task fires, or another tool's context requires it.

## Full Disk Access Grant Flow

1. User clicks Connect on iMessage in integrations modal
2. Server checks if `~/Library/Messages/chat.db` is readable (try opening SQLite)
3. If not accessible: send guidance message — "Open System Settings > Privacy & Security > Full Disk Access, enable CoAgent, then click Connect again"
4. If accessible: connect MCP, embed tools, mark connected

## CoAgent Category

- New "CoAgent" category in integrations modal, sorts first (before Custom, before Composio categories)
- Uses a CoAgent icon (not Composio logo, not generic "+")
- `coagent:` prefix for built-in integration slugs (like `custom:` for custom MCPs)
- iMessage is the only entry for now

## Server Wiring

- `sendIntegrations` merges CoAgent built-ins + custom + Composio
- `integration_connect` routes `coagent:imessage` to the FDA check + MCP connect flow
- `integration_disconnect` routes `coagent:imessage` to mcpManager.disconnect

## Autonomy-Aware Sending

The MCP server itself is stateless — it just sends when called. Approval logic stays in the agent layer:

- Agent system prompt includes: "For iMessage sends, if autonomy is not 'autonomous', use queue_approval with the full message draft before calling send_message"
- If autonomous: agent calls send_message directly
- If balanced/ask_first: agent uses queue_approval first, sends after approval

## Error Handling

- **chat.db locked** — SQLite opens read-only (`SQLITE_OPEN_READONLY`), no lock contention with Messages.app
- **FDA revoked** — tool call fails with SQLITE_CANTOPEN, agent tells user to re-enable Full Disk Access
- **AppleScript send fails** — osascript stderr returned so agent can relay the error
- **Contact not found** — agent uses search_messages first to find phone/email, then passes to send_message
- **MCP crash** — stderr capture surfaces actual error for self-diagnosis

## Data Flow

```
User clicks Connect → server checks chat.db access →
  if no access: sends FDA guidance message
  if accessible: mcpManager.connect(mcp-imessage) → embedToolsFromMcp() → mark connected

Agent uses tool → search_tools("imessage") → finds search_messages →
  call_external_tool("search_messages", {query: "Nathan"}) →
  SQLite query on chat.db → returns messages

Agent sends → checks autonomy setting →
  if autonomous: osascript send directly
  if not: queue_approval with draft → user approves → osascript send
```
