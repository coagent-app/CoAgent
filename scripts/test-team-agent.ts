/**
 * AI-powered team agent for testing.
 *
 * Runs as "Alex" — a real AI agent that responds to team messages
 * using the relay's LLM proxy. Maintains conversation history and
 * responds contextually.
 *
 * Usage:
 *   RELAY_URL=https://your-relay.example.com \
 *   RELAY_TOKEN=<token> \
 *   USER_ID=<userId> \
 *   USER_NAME=Alex \
 *   npx tsx scripts/test-team-agent.ts
 */

import type { TeamMessage } from '../packages/shared/src/index.js'

const RELAY_URL = (process.env.RELAY_URL || '').replace(/\/$/, '')
const RELAY_TOKEN = process.env.RELAY_TOKEN
if (!RELAY_URL || !RELAY_TOKEN) { console.error('Set RELAY_URL and RELAY_TOKEN env vars'); process.exit(1) }
const USER_ID = process.env.USER_ID || 'agent2'
const USER_NAME = process.env.USER_NAME || 'Alex'
const USER_ROLE = process.env.USER_ROLE || 'Agent'

const SYSTEM_PROMPT = `You are ${USER_NAME}'s AI agent on a team collaboration platform called CoAgent. You represent ${USER_NAME} and act on their behalf.

## Your identity
- You are ${USER_NAME}'s personal AI assistant
- You respond as "${USER_NAME}'s Agent" in team conversations
- You are helpful, professional, and concise

## Guidelines
- Keep responses brief and conversational (1-3 sentences usually)
- Be friendly but professional
- You can help with questions, planning, brainstorming, and coordination
- Never share personal details about ${USER_NAME} (address, phone, financial info, etc.)
- If asked to do something you can't (like access files or run code), be upfront about it
- When someone says hi or greets you, respond naturally
- Match the tone of the conversation — casual if they're casual, professional if they're formal

## Context
- You're on a team called "CoAgent Team"
- Messages tagged to you mean someone wants your help specifically
- You can see recent conversation history for context`

// Conversation history for context
const conversationHistory: { role: 'user' | 'assistant'; content: string }[] = []
const MAX_HISTORY = 20

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
  console.log(`[Send${toLabel}] "${visible.slice(0, 80)}${visible.length > 80 ? '...' : ''}" — ${res.status}`)
}

async function generateResponse(fromName: string, message: string): Promise<string> {
  // Add the incoming message to history
  conversationHistory.push({ role: 'user', content: `${fromName}: ${message}` })
  if (conversationHistory.length > MAX_HISTORY) {
    conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY)
  }

  try {
    const res = await fetch(`${RELAY_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RELAY_TOKEN}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: conversationHistory,
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error(`[AI] LLM call failed: ${res.status} ${err}`)
      return "Sorry, I'm having trouble processing that right now. Can you try again?"
    }

    const data = await res.json() as { content: { type: string; text: string }[] }
    const reply = data.content?.[0]?.text || "I didn't get a response. Can you try again?"

    // Add our response to history
    conversationHistory.push({ role: 'assistant', content: reply })
    if (conversationHistory.length > MAX_HISTORY) {
      conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY)
    }

    return reply
  } catch (err) {
    console.error('[AI] Error:', err)
    return "Sorry, I ran into an error. Let me try again in a moment."
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n[${USER_NAME}'s Agent] Starting...`)
  console.log(`[${USER_NAME}'s Agent] Relay: ${RELAY_URL}`)
  console.log(`[${USER_NAME}'s Agent] User ID: ${USER_ID}\n`)

  // Fetch team roster
  const rosterRes = await fetch(`${RELAY_URL}/team/roster`, {
    headers: { 'Authorization': `Bearer ${RELAY_TOKEN}` }
  })
  if (!rosterRes.ok) {
    console.error(`[${USER_NAME}'s Agent] Roster fetch failed: ${rosterRes.status} ${await rosterRes.text()}`)
    process.exit(1)
  }

  const roster = await rosterRes.json() as { team?: { teamId?: string; name?: string }; members?: { name: string; role: string; userId: string }[] }
  if (!roster.team?.teamId) {
    console.error(`[${USER_NAME}'s Agent] Not in a team. Join a team first.`)
    process.exit(1)
  }

  const teamId = roster.team.teamId
  const memberList = roster.members?.map(m => `${m.name} (${m.role})`).join(', ') ?? 'none'
  console.log(`[${USER_NAME}'s Agent] Team: ${roster.team.name}`)
  console.log(`[${USER_NAME}'s Agent] Members: ${memberList}\n`)

  // Connect WebSocket
  const wsBase = RELAY_URL.replace(/^https?:\/\//, (p) => p === 'https://' ? 'wss://' : 'ws://')
  const wsUrl = `${wsBase}/team/ws?token=${RELAY_TOKEN}&userId=${USER_ID}`
  const ws = new WebSocket(wsUrl)

  // Ping to keep alive
  let pingInterval: ReturnType<typeof setInterval>

  ws.onopen = () => {
    console.log(`[${USER_NAME}'s Agent] Connected and listening for messages\n`)
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping')
    }, 30000)
  }

  ws.onmessage = async (event: MessageEvent) => {
    const raw = typeof event.data === 'string' ? event.data : event.data.toString()
    if (raw === 'pong') return

    let parsed: { type: string; message?: TeamMessage }
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }

    if (parsed.type !== 'team_message' || !parsed.message) return

    const m = parsed.message
    const time = new Date(m.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const fromLabel = m.from.isAgent ? `${m.from.name}'s Agent` : m.from.name

    // Don't respond to our own messages or other agents (prevent loops)
    if (String(m.from.userId) === String(USER_ID)) return
    if (m.from.isAgent) return

    console.log(`[${time}] ${fromLabel}: ${m.visible}`)

    // Check if we're tagged
    const myAgentTag = `${USER_ID}-agent`
    const isTagged = m.to === myAgentTag || (Array.isArray(m.to) && m.to.includes(myAgentTag))

    if (isTagged) {
      console.log(`[${USER_NAME}'s Agent] Thinking...`)

      const reply = await generateResponse(m.from.name, m.visible)
      console.log(`[${USER_NAME}'s Agent] → ${reply.slice(0, 100)}${reply.length > 100 ? '...' : ''}`)

      // Reply to the human user directly (not their agent, to avoid triggering auto-responses)
      const replyTo = m.from.isAgent ? m.from.userId : String(m.from.userId)
      await sendMessage(teamId, reply, '', replyTo)
    }
  }

  ws.onerror = (err: Event) => console.error(`[${USER_NAME}'s Agent] WebSocket error:`, err)

  ws.onclose = () => {
    if (pingInterval) clearInterval(pingInterval)
    console.log(`[${USER_NAME}'s Agent] Disconnected — reconnecting in 3s...`)
    setTimeout(() => main(), 3000)
  }
}

main().catch((err) => {
  console.error(`[${USER_NAME}'s Agent] Fatal:`, err)
  process.exit(1)
})
