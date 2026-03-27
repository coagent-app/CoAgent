# Custom Integration Infrastructure Design

## Overview

Chat-driven system where the agent builds custom MCP servers from API docs, giving users access to any API. The agent uses web search to find API documentation, proposes capabilities via a structured card, collects credentials via a secure form, and scaffolds a stdio MCP server using the MCP SDK.

## Architecture

### Storage

Each custom integration lives at `~/.coagent/custom-mcps/{name}/`:

```
~/.coagent/custom-mcps/
├── registry.json            # All custom MCPs metadata
├── notion/
│   ├── index.js             # Compiled MCP server (MCP SDK, stdio)
│   ├── package.json         # Dependencies
│   ├── config.json          # Metadata (name, description, capabilities, auth type)
│   └── .env                 # Credentials (not in registry)
├── airtable/
│   ├── index.js
│   ├── package.json
│   ├── config.json
│   └── .env
```

### Registry (`registry.json`)

```json
[
  {
    "name": "notion",
    "displayName": "Notion",
    "description": "Create pages, search databases, update blocks",
    "capabilities": ["Create pages", "Search databases", "Update blocks"],
    "createdAt": "2026-03-27T00:00:00.000Z",
    "connected": false,
    "authFields": [
      { "name": "api_key", "displayName": "API Key", "description": "Your Notion integration token" }
    ]
  }
]
```

### Credentials

Stored in `~/.coagent/custom-mcps/{name}/.env` as standard env vars. Loaded into the subprocess environment when the MCP server spawns. Not encrypted — same security model as any local .env file.

## MCP Server Pattern

Each generated server follows the mcp-memory pattern:

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new Server(
  { name: 'coagent-custom-{name}', version: '0.0.1' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [/* tool definitions from capabilities */]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // HTTP calls to the target API using credentials from env
})

const transport = new StdioServerTransport()
await server.connect(transport)
```

## MCP Manager Integration

**On startup:** Read `registry.json`, connect all custom MCPs that have credentials (`.env` exists and non-empty). Spawn `node index.js` with `.env` vars loaded via stdio transport.

**Dynamic operations:**
- **Create:** Install deps (`npm install`), connect immediately after credential form is submitted
- **Disconnect:** Kill subprocess, mark disconnected in registry
- **Reconnect:** Respawn subprocess with existing credentials
- **Delete:** Kill subprocess, remove folder, remove from registry

**Tool discovery:** No changes needed. `search_tools` already queries all connected MCP servers — custom tools appear automatically alongside Composio tools.

## WebSocket Protocol

### Capability Confirmation Card

New message types for the agent to propose capabilities before building:

**Server → Client:**
```json
{
  "type": "capability_card",
  "name": "Notion",
  "capabilities": [
    { "name": "Create page", "description": "Create a new page in a database", "checked": true },
    { "name": "Search", "description": "Search across all pages", "checked": true },
    { "name": "Update block", "description": "Edit page content", "checked": true }
  ]
}
```

**Client → Server:**
```json
{
  "type": "capability_confirm",
  "capabilities": ["Create page", "Search"]
}
```

Frontend renders checkboxes in a chat card. User toggles capabilities, confirms. Agent receives confirmed list and builds only those tools.

### Credential Form

Reuses existing `integration_needs_fields` flow with `custom:` prefix:

```json
{ "type": "integration_needs_fields", "slug": "custom:notion", "fields": [...] }
```

Same secure form UI. User submits → server writes `.env` → connects MCP.

### Integration Management

Reuses existing `integration_connect` / `integration_disconnect` with `custom:` prefix:

```json
{ "type": "integration_connect", "slug": "custom:notion", "params": { "api_key": "..." } }
{ "type": "integration_disconnect", "slug": "custom:notion" }
```

## Integrations Modal

Custom integrations appear in the existing modal under a **"Custom"** category at the top. Same card layout — generic code/puzzle icon, name, connected status dot.

Detail view shows: description, capabilities list, connect/disconnect, and a **Delete** button (only for custom integrations).

The `Integration` type gets an optional `custom?: boolean` field. Server merges Composio + custom registry entries into one `integrations_update` response.

## User Flow

1. User says "connect to Notion API" in chat (triggers MCP creation skill)
2. Agent web searches for Notion API docs
3. Agent proposes capabilities via `capability_card`
4. User confirms capabilities via checkboxes
5. Agent generates MCP server code → writes to `~/.coagent/custom-mcps/notion/`
6. Agent installs dependencies
7. Server sends `integration_needs_fields` for API key
8. User fills in credential form
9. Server writes `.env`, spawns MCP server, connects
10. Custom integration appears in integrations modal as connected
11. Agent can now discover and use Notion tools via `search_tools` + `call_external_tool`

## Decisions

- **Code generation over declarative config** — APIs have quirks (pagination, auth refresh, nested responses) that a declarative config can't handle. The MCP SDK pattern is small and a skill template keeps output consistent.
- **Stdio over HTTP** — Matches mcp-memory pattern. Each integration is isolated. One crash doesn't affect others.
- **`.env` for credentials** — Simple, standard, local. Not encrypted — acceptable for a local desktop app.
- **`custom:` prefix in slugs** — Clean routing to distinguish custom from Composio integrations in the message flow.
- **Chat-driven, skill-triggered** — No dedicated creation UI. Agent handles everything conversationally with structured cards for confirmation and credentials.
