/**
 * End-to-end test: event store implementation
 * Tests pre-processor logic, Voyage embedding, search, markDone, purge, hasUnread
 */

import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY
const TEST_DIR = join(tmpdir(), 'coagent-test-' + Date.now())

// Import compiled dist
import {
  searchEventStore,
  markEventsDone,
  hasUnreadEvents,
  purgeEventStore,
} from './packages/agent-core/dist/relay-client.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0, failed = 0

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`)
    passed++
  } else {
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`)
    failed++
  }
}

async function embed(texts) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + VOYAGE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: texts, model: 'voyage-3-lite' })
  })
  const data = await res.json()
  return data.data.map(d => d.embedding)
}

async function seedStore(events) {
  const texts = events.map(e =>
    [e.trigger_name, e.from && ('from:' + e.from), e.subject, e.snippet, e.title, e.text, e.name]
      .filter(Boolean).join(' | ')
  )
  const embeddings = await embed(texts)
  const entries = events.map((e, i) => ({
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    trigger: e.trigger_name,
    event: e,
    embedding: embeddings[i],
    retrieved: false,
    done: false,
  }))
  await mkdir(TEST_DIR, { recursive: true })
  await writeFile(join(TEST_DIR, 'event-store.json'), JSON.stringify(entries, null, 2))
  return entries
}

// ── Pre-processor test (inline — same logic as relay-client.ts) ────────────

const TRIGGER_DENY_PATTERNS = ['_READ', '_VIEWED', '_OPENED', '_SYNC', '_DELETED', '_MODIFIED', '_BOUNCED', '_UNSUBSCRIBED']
const SYSTEM_SENDER_PATTERNS = ['no-reply', 'noreply', 'donotreply', 'do-not-reply', 'notifications@', 'notification@', 'automated@', 'bot@', 'digest@', 'mailer@', 'bounce@', 'support+auto']
const CONTENT_FIELDS = ['subject', 'message', 'snippet', 'description', 'title', 'body', 'content', 'text', 'note', 'summary']

function getSender(p) {
  return ((p.from ?? p.sender ?? p.email ?? p.organizer ?? '')).toLowerCase()
}
function hasHumanContent(obj, depth = 0) {
  if (depth > 3 || typeof obj !== 'object' || obj === null) return false
  for (const [key, val] of Object.entries(obj)) {
    if (CONTENT_FIELDS.includes(key.toLowerCase()) && typeof val === 'string' && val.trim().length > 5) return true
    if (typeof val === 'object' && hasHumanContent(val, depth + 1)) return true
  }
  return false
}
function shouldKeep(trigger, payload) {
  if (TRIGGER_DENY_PATTERNS.some(p => trigger.toUpperCase().includes(p))) return false
  if (payload.bot_id) return false
  const sender = getSender(payload)
  if (sender && SYSTEM_SENDER_PATTERNS.some(p => sender.includes(p))) return false
  if (!hasHumanContent(payload)) return false
  return true
}

// ── Run tests ─────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60))
console.log('TEST 1 — Pre-processor (3 layers)')
console.log('='.repeat(60))

// Should KEEP
assert('Real email from seller',         shouldKeep('GMAIL_NEW_EMAIL',         { from: 'seller@coastalrealty.com', subject: 'Counter offer on 123 Main St', snippet: 'Willing to drop to $485k.' }))
assert('Slack DM from client',           shouldKeep('SLACK_NEW_MESSAGE',       { user: 'U123', username: 'john.buyer', text: 'Any updates on Oak Ave?' }))
assert('HubSpot deal note',              shouldKeep('HUBSPOT_NEW_NOTE',        { contact: 'Sarah Johnson', body: 'Very motivated buyer, pre-approved $600k.' }))
assert('Calendar showing invite',        shouldKeep('GOOGLECALENDAR_NEW_EVENT',{ title: 'Showing: 123 Main St', organizer: 'buyer@gmail.com', description: 'Buyer wants to see it.' }))
assert('Zoom meeting ended with summary',shouldKeep('ZOOM_MEETING_ENDED',      { topic: 'Call with Johnsons', summary: 'Discussed offer terms.' }))

// Should DROP — layer 1: trigger deny-list
assert('Drop: GMAIL_EMAIL_READ',         !shouldKeep('GMAIL_EMAIL_READ',         { from: 'a@b.com', messageId: 'x' }))
assert('Drop: SLACK_MESSAGE_VIEWED',     !shouldKeep('SLACK_MESSAGE_VIEWED',     { user: 'U123', channel: 'C1' }))
assert('Drop: GOOGLECALENDAR_SYNC',      !shouldKeep('GOOGLECALENDAR_SYNC',      { calendarId: 'primary', syncToken: 'abc' }))
assert('Drop: HUBSPOT_CONTACT_SYNC',     !shouldKeep('HUBSPOT_CONTACT_SYNC',     { contactId: '12345' }))
assert('Drop: GMAIL_LABEL_MODIFIED',     !shouldKeep('GMAIL_LABEL_MODIFIED',     { messageId: 'xyz', labels: ['INBOX'] }))

// Should DROP — layer 2: system sender
assert('Drop: no-reply@zillow.com',      !shouldKeep('GMAIL_NEW_EMAIL',     { from: 'no-reply@zillow.com', subject: 'Weekly report', snippet: 'See listings.' }))
assert('Drop: notifications@hubspot.com',!shouldKeep('GMAIL_NEW_EMAIL',     { from: 'notifications@hubspot.com', subject: 'Digest', snippet: '3 contacts viewed.' }))
assert('Drop: Slack bot_id',             !shouldKeep('SLACK_NEW_MESSAGE',   { bot_id: 'B000BOT', username: 'github-bot', text: 'PR merged' }))

// Should DROP — layer 3: no human content
assert('Drop: contact view (no content)',!shouldKeep('HUBSPOT_CONTACT_VIEWED', { contactId: '12345', viewedBy: 'agent@brokerage.com' }))
assert('Drop: zoom participant joined',  !shouldKeep('ZOOM_PARTICIPANT_JOINED', { meetingId: '123', participantName: 'John' }))

console.log('\n' + '='.repeat(60))
console.log('TEST 2 — Event store: seed → search → markDone → purge')
console.log('='.repeat(60))

if (!VOYAGE_API_KEY) {
  console.log('❌ VOYAGE_API_KEY not set — skipping store tests')
} else {
  const testEvents = [
    // Known deal
    { trigger_name: 'GMAIL_NEW_EMAIL', from: 'seller@coastalrealty.com', subject: 'Re: Counter offer deadline', snippet: 'Sellers need a response on the 485k counter offer by end of day.' },
    { trigger_name: 'GMAIL_NEW_EMAIL', from: 'inspector@homeinspect.com', subject: '123 Main St inspection report', snippet: 'Minor issues found. Full report attached.' },
    // Known client
    { trigger_name: 'GMAIL_NEW_EMAIL', from: 'john.martinez@gmail.com', subject: 'Found a property in Boca', snippet: 'Saw a 3BR on Palmetto that looks interesting.' },
    // New / unknown
    { trigger_name: 'GMAIL_NEW_EMAIL', from: 'newlead@hotmail.com', subject: 'Interested in buying', snippet: 'Looking for a 2BR condo in Miami, budget 400k.' },
    { trigger_name: 'HUBSPOT_NEW_CONTACT', name: 'Lisa Park', email: 'lisa.park@gmail.com', source: 'Website form' },
  ]

  console.log(`\nSeeding store with ${testEvents.length} events (Voyage embedding)...`)
  const seeded = await seedStore(testEvents)
  console.log(`Seeded ${seeded.length} entries to ${TEST_DIR}`)

  // Test hasUnreadEvents
  const hasUnread = await hasUnreadEvents(TEST_DIR)
  assert('hasUnreadEvents → true after seeding', hasUnread)

  // Test search — deal-specific
  console.log('\nSearch: "123 Main St counter offer"')
  const dealResults = await searchEventStore(TEST_DIR, '123 Main St counter offer', 3)
  console.log(`  Got ${dealResults.length} results:`)
  dealResults.forEach(r => console.log(`    [${r.score.toFixed(3)}] ${r.event.subject || r.event.name || r.trigger}`))
  assert('Deal search returns results', dealResults.length > 0)
  assert('Top deal result is counter offer (score > 0.4)', dealResults[0].score > 0.4)

  // Test search — client-specific
  console.log('\nSearch: "john martinez boca raton property"')
  const clientResults = await searchEventStore(TEST_DIR, 'john martinez boca raton property', 3)
  console.log(`  Got ${clientResults.length} results:`)
  clientResults.forEach(r => console.log(`    [${r.score.toFixed(3)}] ${r.event.subject || r.event.name || r.trigger}`))
  assert('Client search returns results', clientResults.length > 0)

  // Test search — broad sweep
  console.log('\nSearch: "new leads unread messages"')
  const broadResults = await searchEventStore(TEST_DIR, 'new leads unread messages', 5)
  console.log(`  Got ${broadResults.length} results`)
  assert('Broad sweep returns results', broadResults.length > 0)

  // Test markEventsDone
  const idsToMark = dealResults.map(r => r.id)
  await markEventsDone(TEST_DIR, idsToMark)
  console.log(`\nMarked ${idsToMark.length} deal events as done`)

  // Search again — marked events should not appear
  const afterMark = await searchEventStore(TEST_DIR, '123 Main St counter offer', 5)
  const noDoneInResults = afterMark.every(r => !idsToMark.includes(r.id))
  assert('Done events excluded from search', noDoneInResults, `got IDs: ${afterMark.map(r=>r.id).join(',')}`)

  // hasUnreadEvents should still be true (other events remain)
  const stillHasUnread = await hasUnreadEvents(TEST_DIR)
  assert('hasUnreadEvents → true while undone events remain', stillHasUnread)

  // Test purge — removes done events, keeps undone
  await purgeEventStore(TEST_DIR)
  const afterPurge = await searchEventStore(TEST_DIR, '123 Main St', 5)
  const noPurgedInResults = afterPurge.every(r => !idsToMark.includes(r.id))
  assert('Purged done events gone from store', noPurgedInResults)

  // Test expiry: seed one old event
  console.log('\nSeeding 1 expired event (25h ago)...')
  const { readFile: rf, writeFile: wf } = await import('fs/promises')
  const storePath = join(TEST_DIR, 'event-store.json')
  const current = JSON.parse(await rf(storePath, 'utf-8'))
  current.push({
    id: crypto.randomUUID(),
    receivedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
    trigger: 'GMAIL_NEW_EMAIL',
    event: { trigger_name: 'GMAIL_NEW_EMAIL', subject: 'Old email' },
    embedding: Array(512).fill(0),
    retrieved: false,
    done: false,
  })
  await wf(storePath, JSON.stringify(current, null, 2))
  await purgeEventStore(TEST_DIR)
  const afterExpiry = JSON.parse(await rf(storePath, 'utf-8'))
  const oldGone = !afterExpiry.some(e => e.event?.subject === 'Old email')
  assert('Expired events purged (25h old)', oldGone)

  // Cleanup
  await rm(TEST_DIR, { recursive: true }).catch(() => {})
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60))
console.log(`RESULT: ${passed + failed} tests — ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
