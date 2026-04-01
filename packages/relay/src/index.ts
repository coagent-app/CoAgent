/// <reference types="@cloudflare/workers-types" />

import { RelayDO } from './relay-do'

// ---------------------------------------------------------------------------
// Environment bindings declared in wrangler.toml
// ---------------------------------------------------------------------------

export interface Env {
  RELAY: DurableObjectNamespace
  COMPOSIO_WEBHOOK_SECRET?: string
}

// ---------------------------------------------------------------------------
// Worker entrypoint — routes requests to the correct RelayDO instance.
//
// URL scheme:
//   WS   /agent/:userId   — local agent machine connects outbound here
//   WS   /client/:userId  — mobile / browser client connects here
//   POST /webhook/:userId — Composio webhook delivery
//
// The Durable Object ID is derived from the userId string, so each user gets
// their own isolated DO instance with independent token, agent socket, and
// client socket set.
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Expect paths of the form /<role>/<userId>
    // e.g.  /agent/user-abc-123
    //        /client/user-abc-123
    //        /webhook/user-abc-123
    const segments = url.pathname.split('/').filter(Boolean)

    if (segments.length !== 2) {
      return new Response(
        JSON.stringify({ error: 'Invalid path. Use /<role>/<userId>' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const [role, userId] = segments

    if (role !== 'agent' && role !== 'client' && role !== 'webhook' && role !== 'ws') {
      return new Response(
        JSON.stringify({ error: 'Unknown role. Use agent, client, webhook, or ws.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Derive a stable DO ID from the userId so all connections for the same
    // user land on the same DO instance regardless of which Worker replica
    // handles the request.
    const id = env.RELAY.idFromName(userId)
    const stub = env.RELAY.get(id)

    // Forward the full request to the DO, preserving the path so the DO can
    // distinguish agent vs. client vs. webhook internally.
    return stub.fetch(request)
  },
}

// Re-export the Durable Object class so Wrangler can find it.
export { RelayDO }
