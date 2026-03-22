import { createServer } from 'http'
import type { Agent } from './agent.js'

const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT ?? '7831')
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET

export function startWebhookServer(agent: Agent): void {
  const server = createServer((req, res) => {
    // Only accept POST /webhook
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404).end(JSON.stringify({ error: 'Not found' }))
      return
    }

    // Validate secret if configured
    if (WEBHOOK_SECRET) {
      const provided = req.headers['x-webhook-secret']
      if (provided !== WEBHOOK_SECRET) {
        res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
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

  server.listen(WEBHOOK_PORT, () => {
    console.log(`[Webhook] Listening on http://localhost:${WEBHOOK_PORT}/webhook`)
  })
}
