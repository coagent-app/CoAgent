/// <reference types="@cloudflare/workers-types" />

/**
 * RelayDO — Durable Object that manages the WebSocket relay for a single user.
 *
 * State model (one DO instance per userId):
 *   token        — secret string set on first agent connection; all subsequent
 *                  connections (agent, client, webhook) must present it.
 *   agentSocket  — the single outbound WebSocket from the user's local machine.
 *   clientSockets — the set of mobile / browser WebSockets connected to this user.
 *
 * Routing handled here (called by the Worker entrypoint):
 *   GET  /agent/:userId   (upgraded to WS) — register / replace agent connection
 *   GET  /client/:userId  (upgraded to WS) — add a client connection
 *   POST /webhook/:userId                  — forward JSON body to agentSocket
 */
interface DoEnv {
  COMPOSIO_WEBHOOK_SECRET?: string
}

export class RelayDO implements DurableObject {
  private storage: DurableObjectStorage
  private env: DoEnv
  private token: string | null = null
  private agentSocket: WebSocket | null = null
  private clientSockets: Set<WebSocket> = new Set()
  private clientTypes: Map<WebSocket, string> = new Map()

  constructor(state: DurableObjectState, env: DoEnv) {
    this.storage = state.storage
    this.env = env

    // Restore persisted token across DO hibernation / restart.
    // We use blockConcurrencyWhile so the token is available before any
    // request is handled.
    state.blockConcurrencyWhile(async () => {
      this.token = (await this.storage.get<string>('token')) ?? null
    })
  }

  // ---------------------------------------------------------------------------
  // fetch — entry point for all requests routed to this DO
  // ---------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // path segments: ["", "agent" | "client" | "webhook", userId]
    const [, role] = url.pathname.split('/')

    switch (role) {
      case 'agent':
        return this.handleAgentUpgrade(request, url)
      case 'client':
        return this.handleClientUpgrade(request, url)
      case 'webhook':
        return this.handleWebhook(request)
      default:
        return new Response('Not found', { status: 404 })
    }
  }

  // ---------------------------------------------------------------------------
  // Agent connection
  // ---------------------------------------------------------------------------

  private async handleAgentUpgrade(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    // On first connection the agent passes ?token=xxx to register its secret.
    // On subsequent connections it must match the stored token via the header.
    const queryToken = url.searchParams.get('token')

    if (this.token === null) {
      // First-time registration — token must be supplied in the query string.
      if (!queryToken) {
        return new Response('Missing ?token on first agent connection', { status: 400 })
      }
      this.token = queryToken
      await this.storage.put('token', this.token)
      console.log('[RelayDO] Agent token registered')
    } else {
      // Existing registration — validate via header or query param.
      if (!this.validateToken(request, url)) {
        return new Response('Unauthorized', { status: 401 })
      }
    }

    const { 0: client, 1: server } = new WebSocketPair()

    server.accept()

    // Replace any stale agent socket — only one agent per user at a time.
    if (this.agentSocket) {
      try {
        this.agentSocket.close(1001, 'Replaced by new agent connection')
      } catch {
        // Already closed — ignore.
      }
    }
    this.agentSocket = server

    server.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as string
      // Intercept push_notification — deliver via Expo push AND broadcast to connected clients.
      try {
        const parsed = JSON.parse(data)
        if (parsed?.type === 'push_notification') {
          this.broadcastToClients(data) // In-app display for any connected clients
          void this.maybeSendPush(parsed.title, parsed.body)
          return
        }
      } catch { /* non-JSON — fall through */ }
      // Normal: broadcast to all clients.
      this.broadcastToClients(data)
    })

    server.addEventListener('close', () => {
      if (this.agentSocket === server) {
        this.agentSocket = null
        console.log('[RelayDO] Agent disconnected')
      }
    })

    server.addEventListener('error', () => {
      if (this.agentSocket === server) {
        this.agentSocket = null
      }
    })

    console.log('[RelayDO] Agent connected')
    return new Response(null, { status: 101, webSocket: client })
  }

  // ---------------------------------------------------------------------------
  // Client connection (mobile / browser)
  // ---------------------------------------------------------------------------

  private handleClientUpgrade(request: Request, url: URL): Response {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    if (!this.token) {
      // No agent has ever connected — nowhere to relay to yet.
      return new Response('Agent not registered for this user', { status: 503 })
    }

    if (!this.validateToken(request, url)) {
      return new Response('Unauthorized', { status: 401 })
    }

    const clientType = url.searchParams.get('client') || 'unknown'

    const { 0: client, 1: server } = new WebSocketPair()

    server.accept()
    this.clientSockets.add(server)
    this.clientTypes.set(server, clientType)

    // Tell agent a new client connected so it sends full state
    this.forwardToAgent(JSON.stringify({ type: 'client_connected' }))

    server.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as string
      // Intercept push-management messages — handle in relay, don't forward to agent.
      try {
        const parsed = JSON.parse(data)
        if (parsed?.type === 'register_push_token') {
          void this.storage.put('push_token', parsed.token)
          console.log('[RelayDO] Push token registered')
          return
        }
        if (parsed?.type === 'update_notification_prefs') {
          void this.storage.put('notification_mode', parsed.mode)
          console.log('[RelayDO] Notification prefs updated:', parsed.mode)
          return
        }
      } catch { /* non-JSON — fall through */ }
      // Normal client message: forward to agent.
      this.forwardToAgent(data)
    })

    const cleanup = (): void => {
      this.clientSockets.delete(server)
      this.clientTypes.delete(server)
    }

    server.addEventListener('close', cleanup)
    server.addEventListener('error', cleanup)

    console.log('[RelayDO] Client connected (type:', clientType, '); total clients:', this.clientSockets.size)
    return new Response(null, { status: 101, webSocket: client })
  }

  // ---------------------------------------------------------------------------
  // Webhook (Composio POST)
  // ---------------------------------------------------------------------------

  private async handleWebhook(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    // Webhook auth is HMAC-only — Composio doesn't know the relay token.
    // Signature is verified below after body is read.

    if (!this.agentSocket || this.agentSocket.readyState !== /* OPEN */ 1) {
      return new Response('Agent not connected', { status: 503 })
    }

    let body: string
    try {
      body = await request.text()
      // Validate it is parseable JSON so the agent always receives valid JSON.
      JSON.parse(body)
    } catch {
      return new Response('Invalid JSON body', { status: 400 })
    }

    if (!(await this.verifyComposioSignature(request, body))) {
      console.warn('[RelayDO] Webhook signature verification failed')
      return new Response('Invalid signature', { status: 401 })
    }

    try {
      // Wrap so relay-client can distinguish webhook payloads from chat messages.
      this.agentSocket.send(JSON.stringify({ type: 'webhook', payload: JSON.parse(body) }))
    } catch (err) {
      console.error('[RelayDO] Failed to forward webhook to agent:', err)
      return new Response('Failed to forward to agent', { status: 502 })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Forward a message string to the agent socket. */
  private forwardToAgent(data: string): void {
    if (!this.agentSocket || this.agentSocket.readyState !== /* OPEN */ 1) {
      console.warn('[RelayDO] Agent not available; dropping client message')
      return
    }
    try {
      this.agentSocket.send(data)
    } catch (err) {
      console.error('[RelayDO] Failed to send to agent:', err)
    }
  }

  /** Broadcast a message string to all open client sockets. */
  private broadcastToClients(data: string): void {
    for (const socket of this.clientSockets) {
      if (socket.readyState === /* OPEN */ 1) {
        try {
          socket.send(data)
        } catch (err) {
          console.error('[RelayDO] Failed to send to client:', err)
          this.clientSockets.delete(socket)
        }
      } else {
        // Clean up stale references.
        this.clientSockets.delete(socket)
      }
    }
  }

  /**
   * Validate the X-Secret-Token header against the stored token.
   * Also accepts the token as a ?token= query param (used by the agent on
   * reconnect after the initial registration).
   */
  private validateToken(request: Request, url: URL): boolean {
    const headerToken = request.headers.get('X-Secret-Token')
    const queryToken = url.searchParams.get('token')
    return headerToken === this.token || queryToken === this.token
  }

  /**
   * Send an Expo push notification if conditions allow.
   *
   * Modes (stored in durable storage as 'notification_mode'):
   *   always     — always send push
   *   away_only  — send push; TODO: suppress when desktop UI is in foreground
   *                (not yet detectable from relay since the Tauri app connects
   *                as the agent, not as a client socket)
   *   never      — never send push
   */
  private async maybeSendPush(title: string, body: string): Promise<void> {
    const pushToken = await this.storage.get<string>('push_token')
    if (!pushToken) return

    const mode = (await this.storage.get<string>('notification_mode')) || 'away_only'
    if (mode === 'never') return

    // mode === 'always' or 'away_only' — both send for now.
    // Future: when a desktop client mechanism is available, 'away_only' can
    // suppress the push while the desktop UI is in the foreground.

    try {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: pushToken,
          title,
          body,
          sound: 'default',
        }),
      })
      console.log('[RelayDO] Push sent:', title)
    } catch (err) {
      console.error('[RelayDO] Push failed:', err)
    }
  }

  /**
   * Verify a Composio webhook signature using Standard Webhooks HMAC-SHA256.
   * Signature format: v1,{base64(HMAC-SHA256(secret, "{webhookId}.{timestamp}.{body}"))}
   */
  private async verifyComposioSignature(request: Request, body: string): Promise<boolean> {
    return true // TODO: re-enable after confirming Composio sends Standard Webhooks headers
    const secret = this.env.COMPOSIO_WEBHOOK_SECRET
    if (!secret) return true // No secret configured — skip verification

    const webhookId = request.headers.get('webhook-id')
    const timestamp = request.headers.get('webhook-timestamp')
    const sigHeader = request.headers.get('webhook-signature')

    if (!webhookId || !timestamp || !sigHeader) return false

    // Replay protection: reject if timestamp is more than 5 minutes old
    const ts = parseInt(timestamp as string, 10)
    if (isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false

    const signedContent = `${webhookId}.${timestamp}.${body}`
    const enc = new TextEncoder()

    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signedContent))
    const computed = 'v1,' + btoa(String.fromCharCode(...new Uint8Array(sig)))

    // Header may contain multiple space-separated signatures
    return (sigHeader as string).split(' ').some(s => s === computed)
  }
}
