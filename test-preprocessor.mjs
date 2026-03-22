/**
 * Test: generic event pre-processor
 * Runs realistic webhook payloads from multiple integrations through
 * the three noise filters and shows what survives vs what gets dropped.
 */

// ── Three generic filters ─────────────────────────────────────────────────────

const TRIGGER_DENY_LIST = [
  '_READ', '_VIEWED', '_OPENED', '_SYNC', '_DELETED',
  '_MODIFIED', '_BOUNCED', '_UNSUBSCRIBED'
]

const SYSTEM_SENDER_PATTERNS = [
  'no-reply', 'noreply', 'donotreply', 'do-not-reply',
  'notifications@', 'notification@', 'automated@',
  'bot@', 'digest@', 'mailer@', 'bounce@', 'support+auto'
]

const CONTENT_FIELDS = [
  'subject', 'message', 'snippet', 'description',
  'title', 'body', 'content', 'text', 'note', 'summary'
]

function getSenderField(payload) {
  return (payload.from || payload.sender || payload.bot_id ||
          payload.source || payload.email || payload.organizer || '').toLowerCase()
}

function hasHumanContent(payload) {
  function search(obj, depth = 0) {
    if (depth > 3) return false
    for (const key of Object.keys(obj ?? {})) {
      if (CONTENT_FIELDS.includes(key.toLowerCase())) {
        const val = obj[key]
        if (typeof val === 'string' && val.trim().length > 5) return true
      }
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        if (search(obj[key], depth + 1)) return true
      }
    }
    return false
  }
  return search(payload)
}

function preprocess(event) {
  const { trigger, ...payload } = event

  // Layer 1: trigger deny-list
  if (TRIGGER_DENY_LIST.some(p => trigger.toUpperCase().includes(p))) {
    return { kept: false, reason: 'trigger deny-list', layer: 1 }
  }

  // Layer 2: system sender
  if (payload.bot_id) {
    return { kept: false, reason: 'bot_id present', layer: 2 }
  }
  const sender = getSenderField(payload)
  if (sender && SYSTEM_SENDER_PATTERNS.some(p => sender.includes(p))) {
    return { kept: false, reason: `system sender (${sender})`, layer: 2 }
  }

  // Layer 3: no human content
  if (!hasHumanContent(payload)) {
    return { kept: false, reason: 'no human content', layer: 3 }
  }

  return { kept: true }
}

// ── Realistic test events from multiple integrations ──────────────────────────

const events = [
  // GMAIL — signal
  { trigger: 'GMAIL_NEW_EMAIL', from: 'seller@coastalrealty.com', subject: 'Counter offer on 123 Main St', snippet: 'Willing to come down to $485k if you close by March 15.' },
  { trigger: 'GMAIL_NEW_EMAIL', from: 'client@gmail.com', subject: 'Question about Sunday open house', snippet: 'Are you still doing the open house? Bringing my parents.' },
  { trigger: 'GMAIL_NEW_EMAIL', from: 'lender@wellsfargo.com', subject: 'Loan approval update', snippet: 'Your client has been approved for $520,000.' },

  // GMAIL — noise
  { trigger: 'GMAIL_EMAIL_READ', from: 'seller@coastalrealty.com', messageId: 'abc123' },
  { trigger: 'GMAIL_NEW_EMAIL', from: 'no-reply@zillow.com', subject: 'Your weekly market report', snippet: 'See how your listings performed this week.' },
  { trigger: 'GMAIL_NEW_EMAIL', from: 'notifications@hubspot.com', subject: 'HubSpot digest for today', snippet: '3 contacts viewed your email.' },
  { trigger: 'GMAIL_LABEL_MODIFIED', messageId: 'xyz', labels: ['INBOX'] },

  // SLACK — signal
  { trigger: 'SLACK_NEW_MESSAGE', user: 'U123ABC', username: 'sarah.johnson', text: 'Hey can we move the showing to 3pm instead?', channel: 'D789DEF', channel_type: 'im' },
  { trigger: 'SLACK_NEW_MESSAGE', user: 'U456XYZ', username: 'john.buyer', text: 'We are very interested in the Oak Ave property. What is the asking price?', channel: 'C111GHI' },

  // SLACK — noise
  { trigger: 'SLACK_NEW_MESSAGE', bot_id: 'B000BOT', username: 'github-bot', text: 'PR #42 was merged', channel: 'C222JKL' },
  { trigger: 'SLACK_MESSAGE_VIEWED', user: 'U123ABC', channel: 'D789DEF' },

  // HUBSPOT — signal
  { trigger: 'HUBSPOT_NEW_NOTE', contact: 'Sarah Johnson', body: 'Called about 789 Elm St. Very motivated buyer, pre-approved $600k, needs to close by April.' },
  { trigger: 'HUBSPOT_DEAL_STAGE_CHANGED', dealName: '123 Main St', fromStage: 'Under Contract', toStage: 'Inspection', note: 'Inspection scheduled for Feb 25' },

  // HUBSPOT — noise
  { trigger: 'HUBSPOT_CONTACT_VIEWED', contactId: '12345', viewedBy: 'agent@brokerage.com' },
  { trigger: 'HUBSPOT_CONTACT_SYNC', contactId: '12345', updatedFields: ['lastActivity'] },

  // GOOGLE CALENDAR — signal
  { trigger: 'GOOGLECALENDAR_NEW_EVENT', title: 'Showing: 123 Main St', organizer: 'buyer@gmail.com', description: 'Buyer wants to see the property. Bringing their contractor.', start: '2026-02-25T14:00:00Z' },
  { trigger: 'GOOGLECALENDAR_EVENT_REMINDER', title: 'Contract deadline: 456 Oak Ave', description: 'Counteroffer response due by 5pm', start: '2026-02-22T17:00:00Z' },

  // GOOGLE CALENDAR — noise
  { trigger: 'GOOGLECALENDAR_SYNC', calendarId: 'primary', syncToken: 'abc' },
  { trigger: 'GOOGLECALENDAR_EVENT_VIEWED', eventId: 'xyz', viewedBy: 'agent@gmail.com' },

  // ZOOM — signal
  { trigger: 'ZOOM_MEETING_ENDED', topic: 'Call with Johnson family re: Oak Ave offer', duration: 1823, host_email: 'agent@brokerage.com', summary: 'Discussed offer terms. Buyers want closing cost assistance.' },

  // ZOOM — noise
  { trigger: 'ZOOM_RECORDING_VIEWED', meetingId: '123', viewedBy: 'participant@gmail.com' },
  { trigger: 'ZOOM_PARTICIPANT_JOINED', meetingId: '123', participantName: 'John Doe' },
]

// ── Run and report ────────────────────────────────────────────────────────────

console.log('Running pre-processor on', events.length, 'events from 5 integrations\n')

const kept = []
const dropped = []

for (const event of events) {
  const result = preprocess(event)
  const label = event.subject || event.text || event.title || event.body?.slice(0, 50) || event.note?.slice(0, 50) || event.topic || event.trigger
  if (result.kept) {
    kept.push({ event, label })
  } else {
    dropped.push({ event, label, ...result })
  }
}

console.log('✅ KEPT (' + kept.length + '):')
for (const { event, label } of kept) {
  console.log('  [' + event.trigger + '] ' + label)
}

console.log('\n🚫 DROPPED (' + dropped.length + '):')
const byLayer = { 1: [], 2: [], 3: [] }
for (const item of dropped) {
  byLayer[item.layer].push(item)
}
for (const [layer, items] of Object.entries(byLayer)) {
  if (items.length === 0) continue
  const names = { 1: 'trigger deny-list', 2: 'system sender', 3: 'no human content' }
  console.log('\n  Layer ' + layer + ' — ' + names[layer] + ':')
  for (const { event, label } of items) {
    console.log('    [' + event.trigger + '] ' + label)
  }
}

console.log('\n' + '='.repeat(50))
console.log('Result: ' + events.length + ' events → ' + kept.length + ' stored, ' + dropped.length + ' dropped (' + Math.round(dropped.length/events.length*100) + '% noise eliminated)')
