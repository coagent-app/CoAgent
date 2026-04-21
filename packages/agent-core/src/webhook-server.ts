import { createServer } from 'http'
import { timingSafeEqual } from 'crypto'
import type { Agent } from './agent.js'

// NOTE: This module is currently unused (no import sites). It is kept for future
// inbound-webhook use and hardened pre-emptively so that wiring it up later can
// never accidentally ship in an unsafe state.

const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT ?? '7831')
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET

function constantTimeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

export function startWebhookServer(agent: Agent): void {
  // Fail closed: never start the server without a shared secret. Previous behaviour
  // accepted unauthenticated requests when WEBHOOK_SECRET was unset.
  if (!WEBHOOK_SECRET) {
    console.warn('[Webhook] WEBHOOK_SECRET not set — webhook server will NOT be started.')
    return
  }

  const server = createServer((req, res) => {
    // Only accept POST /webhook
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404).end(JSON.stringify({ error: 'Not found' }))
      return
    }

    // Validate secret with constant-time compare to prevent byte-by-byte recovery.
    const provided = req.headers['x-webhook-secret']
    const providedStr = typeof provided === 'string' ? provided : ''
    if (!constantTimeEqualStrings(providedStr, WEBHOOK_SECRET)) {
      res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    // Read body
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      let payload: Record<string, unknown> = {}
      try { payload = JSON.parse(body) } catch { payload = { raw: body } }

      console.log('[Webhook] Received:', JSON.stringify(payload).slice(0, 200))
      agent.handleTrigger({ source: 'webhook', payload })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })

  // Bind explicitly to loopback so the webhook endpoint is never reachable from
  // the local network. Default Node listen() binds to 0.0.0.0.
  server.listen(WEBHOOK_PORT, '127.0.0.1', () => {
    console.log(`[Webhook] Listening on http://127.0.0.1:${WEBHOOK_PORT}/webhook`)
  })
}
