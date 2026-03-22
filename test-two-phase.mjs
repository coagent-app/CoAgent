/**
 * Two-phase event processing test
 * Phase 1: match incoming events against real memory using Voyage embeddings
 * Phase 2: strip unmatched events to bare minimum, run Haiku triage
 */

import Anthropic from './packages/agent-core/node_modules/@anthropic-ai/sdk/index.js'
import { readFile, readdir } from 'fs/promises'
import { join } from 'path'

const VOYAGE_API_KEY = 'pa-3gv1bUpAJh5cpEzP758txb4iI4g5LnjRr4hZ7gFMM7t'
const MATCH_THRESHOLD = 0.50
const HOME = process.env.HOME
const MEMORY_DIR = join(HOME, '.coagent', 'memory')

const anthropic = new Anthropic()

// ── Helpers ───────────────────────────────────────────────────────────────────

async function embed(texts) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + VOYAGE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: texts, model: 'voyage-3-lite' })
  })
  const data = await res.json()
  return data.data.map(d => d.embedding)
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function eventToText(e) {
  return [e.trigger_name, e.from && ('from:' + e.from), e.subject, e.snippet,
          e.title, e.description, e.name, e.text, e.note].filter(Boolean).join(' | ')
}

function stripToBare(e) {
  // Phase 2: absolute minimum — trigger + sender + subject/title only, 20-30 tokens
  const sender = e.from || e.user || e.name || e.organizer || ''
  const topic  = e.subject || e.title || e.text?.slice(0, 60) || e.note?.slice(0, 60) || ''
  return [e.trigger_name, sender, topic].filter(Boolean).join(' | ')
}

// ── Load real memory files ────────────────────────────────────────────────────

async function loadMemoryFiles(dir) {
  const files = []
  async function walk(d) {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.md')) {
        const content = await readFile(full, 'utf-8')
        files.push({ path: full.replace(MEMORY_DIR + '/', ''), content })
      }
    }
  }
  await walk(dir)
  return files
}

// ── Incoming events (realistic mix) ──────────────────────────────────────────

const incomingEvents = [
  // Should match 123-main-st.md (known deal)
  { trigger_name: 'GMAIL_NEW_EMAIL', from: 'seller@coastalrealty.com', subject: 'Re: Counter offer deadline', snippet: 'Sellers need a response on the 485k counter offer by end of day.' },
  { trigger_name: 'GMAIL_NEW_EMAIL', from: 'inspector@homeinspect.com', subject: '123 Main St inspection report', snippet: 'Minor issues found. Full report attached.' },
  { trigger_name: 'GOOGLECALENDAR_NEW_EVENT', title: 'Final walkthrough: 123 Main St', organizer: 'buyer@gmail.com', description: 'Pre-closing walkthrough before March 15 deadline' },

  // Should match john-martinez.md (known client)
  { trigger_name: 'GMAIL_NEW_EMAIL', from: 'john.martinez@gmail.com', subject: 'Found a property in Boca', snippet: 'Saw a 3BR on Palmetto that looks interesting. Can you check it out?' },
  { trigger_name: 'SLACK_NEW_MESSAGE', user: 'john_m', username: 'john.martinez', text: 'Hey any updates on the Boca Raton search?' },

  // New — should fall to Phase 2
  { trigger_name: 'GMAIL_NEW_EMAIL', from: 'newlead@hotmail.com', subject: 'Interested in buying a home', snippet: 'Hi I am looking to buy a 2BR condo in Miami, budget around 400k.' },
  { trigger_name: 'HUBSPOT_NEW_CONTACT', name: 'Lisa Park', email: 'lisa.park@gmail.com', source: 'Website form' },
  { trigger_name: 'SLACK_NEW_MESSAGE', username: 'mike.chen.lender', text: 'Hey have a new client for you, pre-approved 550k, looking in Boca' },
  { trigger_name: 'GOOGLECALENDAR_NEW_EVENT', title: 'Coffee meeting: prospective seller', organizer: 'unknown@gmail.com', description: 'Wants to discuss listing their property on Oak Ave' },
]

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('Loading memory files...')
const memoryFiles = await loadMemoryFiles(MEMORY_DIR)
console.log(`Found ${memoryFiles.length} memory files: ${memoryFiles.map(f => f.path).join(', ')}\n`)

console.log(`Embedding ${memoryFiles.length} memory files + ${incomingEvents.length} events...`)
const allTexts = [
  ...memoryFiles.map(f => f.content.slice(0, 800)), // first 800 chars of each memory file
  ...incomingEvents.map(eventToText)
]
const allEmbeddings = await embed(allTexts)
const memoryEmbeddings = allEmbeddings.slice(0, memoryFiles.length)
const eventEmbeddings  = allEmbeddings.slice(memoryFiles.length)

// ── Phase 1: match events against memory ─────────────────────────────────────

console.log('\n' + '='.repeat(60))
console.log('PHASE 1 — Match events to known memory')
console.log('='.repeat(60))

const phase2Events = []

for (let i = 0; i < incomingEvents.length; i++) {
  const event = incomingEvents[i]
  const emb = eventEmbeddings[i]

  let bestMatch = null
  let bestScore = 0
  for (let j = 0; j < memoryFiles.length; j++) {
    const score = cosine(emb, memoryEmbeddings[j])
    if (score > bestScore) { bestScore = score; bestMatch = memoryFiles[j] }
  }

  const label = event.subject || event.title || event.text?.slice(0, 50) || event.name
  if (bestScore >= MATCH_THRESHOLD) {
    console.log(`\n✅ MATCHED (${bestScore.toFixed(3)}) → ${bestMatch.path}`)
    console.log(`   [${event.trigger_name}] ${label}`)
    console.log(`   Agent can act with full context from memory`)
  } else {
    console.log(`\n❓ NO MATCH (best: ${bestScore.toFixed(3)}) → Phase 2`)
    console.log(`   [${event.trigger_name}] ${label}`)
    phase2Events.push(event)
  }
}

// ── Phase 2: Haiku triage on stripped events ──────────────────────────────────

console.log('\n' + '='.repeat(60))
console.log(`PHASE 2 — Haiku triage on ${phase2Events.length} unmatched events`)
console.log('='.repeat(60))

const bareEvents = phase2Events.map(stripToBare)
console.log('\nStripped payloads sent to Haiku:')
bareEvents.forEach((b, i) => console.log(`  ${i+1}. ${b}`))

const totalChars = bareEvents.join('\n').length
console.log(`\nTotal payload to Haiku: ~${Math.round(totalChars/4)} tokens`)

const haiku = await anthropic.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 512,
  system: `You are triaging incoming events for a real estate agent.
Classify each event as one of:
- NEW_LEAD: potential new client or seller
- EXISTING_DEAL: related to an active deal the agent may not have found
- REFERRAL: from a known contact referring someone
- IGNORE: not actionable

Reply with a numbered list matching the input. Format: "N. TYPE: one line reason"
Be brief. No fluff.`,
  messages: [{
    role: 'user',
    content: `Triage these incoming events:\n${bareEvents.map((b, i) => `${i+1}. ${b}`).join('\n')}`
  }]
})

console.log('\nHaiku triage result:')
console.log(haiku.content[0].text)
console.log(`\nHaiku usage: ${haiku.usage.input_tokens} in / ${haiku.usage.output_tokens} out tokens`)

console.log('\n' + '='.repeat(60))
console.log('SUMMARY')
console.log('='.repeat(60))
console.log(`${incomingEvents.length} events → ${incomingEvents.length - phase2Events.length} matched memory (Phase 1) + ${phase2Events.length} triaged by Haiku (Phase 2)`)
