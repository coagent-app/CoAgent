/**
 * Simulates a team agent for testing.
 *
 * Usage:
 *   RELAY_URL=https://coagent-relay.brettponters.workers.dev \
 *   RELAY_TOKEN=<token> \
 *   USER_ID=brian \
 *   USER_NAME=Brian \
 *   USER_ROLE=Sales \
 *   npx tsx scripts/test-team-agent.ts
 */

import type { TeamMessage } from '../packages/shared/src/index.js'

const RELAY_URL = (process.env.RELAY_URL || 'https://coagent-relay.brettponters.workers.dev').replace(/\/$/, '')
const RELAY_TOKEN = process.env.RELAY_TOKEN
const USER_ID = process.env.USER_ID || 'brian'
const USER_NAME = process.env.USER_NAME || 'Brian'
const USER_ROLE = process.env.USER_ROLE || 'Sales'

if (!RELAY_TOKEN) {
  console.error('[Test Agent] RELAY_TOKEN is required')
  process.exit(1)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMessage(
  teamId: string,
  visible: string,
  agentContext: string = '',
  to: string | string[] | null = null
): TeamMessage {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    teamId,
    timestamp: new Date().toISOString(),
    from: { userId: USER_ID, name: USER_NAME, role: USER_ROLE, isAgent: true },
    visible,
    agentContext,
    to,
    attachments: []
  }
}

async function sendMessage(
  teamId: string,
  visible: string,
  agentContext: string = '',
  to: string | string[] | null = null
): Promise<void> {
  const msg = makeMessage(teamId, visible, agentContext, to)
  const res = await fetch(`${RELAY_URL}/team/message`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RELAY_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(msg)
  })
  const toLabel = to ? ` → ${Array.isArray(to) ? to.join(', ') : to}` : ' (broadcast)'
  console.log(`[Send${toLabel}] "${visible}" — ${res.status}`)
}

function formatFrom(m: TeamMessage): string {
  return m.from.isAgent ? `${m.from.name}'s Agent` : m.from.name
}

function formatTo(m: TeamMessage): string {
  if (!m.to) return ''
  return ` → ${Array.isArray(m.to) ? m.to.join(', ') : m.to}`
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n[Test Agent] Starting as ${USER_NAME} (${USER_ROLE})`)
  console.log(`[Test Agent] Relay: ${RELAY_URL}`)
  console.log(`[Test Agent] User ID: ${USER_ID}\n`)

  // Fetch team roster — bail if not in a team
  const rosterRes = await fetch(`${RELAY_URL}/team/roster`, {
    headers: { 'Authorization': `Bearer ${RELAY_TOKEN}` }
  })
  if (!rosterRes.ok) {
    console.error(`[Test Agent] Roster fetch failed: ${rosterRes.status} ${await rosterRes.text()}`)
    process.exit(1)
  }

  const roster = await rosterRes.json() as { teamId?: string; name?: string; members?: { name: string; role: string }[] }
  if (!roster.teamId) {
    console.error('[Test Agent] This token is not in a team. Join a team first.')
    process.exit(1)
  }

  const teamId = roster.teamId
  const memberList = roster.members?.map(m => `${m.name} (${m.role})`).join(', ') ?? 'none'
  console.log(`[Test Agent] Team: ${roster.name} (${roster.members?.length ?? 0} members)`)
  console.log(`[Test Agent] Members: ${memberList}\n`)

  // Build WebSocket URL — mirrors TeamClient.openConnection()
  const wsBase = RELAY_URL.replace(/^https?:\/\//, (p) => p === 'https://' ? 'wss://' : 'ws://')
  const wsUrl = `${wsBase}/team/ws?token=${RELAY_TOKEN}&userId=${USER_ID}`

  const ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    console.log('[Test Agent] WebSocket connected\n')
    printHelp()

    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', async (data: string) => {
      const line = data.trim()
      if (!line) return

      if (line === 'quit' || line === 'exit') {
        ws.close()
        process.exit(0)
      }

      if (line === 'help') {
        printHelp()
        return
      }

      if (line === 'roster') {
        console.log(`[Roster] ${memberList}`)
        return
      }

      if (line.startsWith('send ')) {
        await sendMessage(teamId, line.slice(5))
      } else if (line.startsWith('tag ')) {
        // tag <userId-agent> <message...>
        const parts = line.slice(4).split(' ')
        const target = parts[0]
        const msg = parts.slice(1).join(' ')
        if (!msg) { console.log('[Usage] tag <userId-agent> <message>'); return }
        await sendMessage(teamId, msg, `Sent by ${USER_NAME}'s test agent`, target)
      } else if (line.startsWith('notify ')) {
        // notify <userId> <message...>
        const parts = line.slice(7).split(' ')
        const target = parts[0]
        const msg = parts.slice(1).join(' ')
        if (!msg) { console.log('[Usage] notify <userId> <message>'); return }
        await sendMessage(teamId, msg, '', target)
      } else {
        // Bare input defaults to broadcast
        await sendMessage(teamId, line)
      }
    })
  }

  ws.onmessage = (event: MessageEvent) => {
    const raw = typeof event.data === 'string' ? event.data : event.data.toString()
    if (raw === 'pong') return

    let parsed: { type: string; message?: TeamMessage }
    try {
      parsed = JSON.parse(raw)
    } catch {
      console.warn('[Test Agent] Non-JSON message:', raw)
      return
    }

    if (parsed.type !== 'team_message' || !parsed.message) return

    const m = parsed.message
    const time = new Date(m.timestamp).toLocaleTimeString()
    const fromLabel = formatFrom(m)
    const toLabel = formatTo(m)

    console.log(`\n[${time}] ${fromLabel} (${m.from.role})${toLabel}:`)
    console.log(`  ${m.visible}`)
    if (m.agentContext) console.log(`  [context: ${m.agentContext}]`)

    // Auto-respond when tagged as our agent (mirrors TeamClient.handleMessage logic)
    const myAgentTag = `${USER_ID}-agent`
    const isTagged = m.to === myAgentTag || (Array.isArray(m.to) && m.to.includes(myAgentTag))

    if (isTagged) {
      console.log('[Test Agent] Tagged — auto-responding in 2s...')
      setTimeout(() => {
        sendMessage(
          teamId,
          `${USER_NAME}'s agent here — got your message! This is an auto-response from the test script.`,
          `Auto-response from test agent for ${USER_NAME}`,
          null
        ).catch(console.error)
      }, 2000)
    }
  }

  ws.onerror = (err: Event) => console.error('[Test Agent] WebSocket error:', err)

  ws.onclose = () => {
    console.log('[Test Agent] Disconnected')
    process.exit(0)
  }
}

function printHelp(): void {
  console.log('Commands:')
  console.log('  <message>                   broadcast to team')
  console.log('  send <message>              broadcast to team (explicit)')
  console.log('  tag <userId-agent> <msg>    tag a specific agent  e.g. tag brett-agent hello')
  console.log('  notify <userId> <msg>       notify a human user   e.g. notify brett urgent!')
  console.log('  roster                      list team members')
  console.log('  help                        show this message')
  console.log('  quit                        disconnect\n')
}

main().catch((err) => {
  console.error('[Test Agent] Fatal:', err)
  process.exit(1)
})
