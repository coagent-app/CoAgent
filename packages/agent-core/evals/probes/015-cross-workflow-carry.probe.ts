/**
 * Probe 015 — cross-workflow context carry (memory + schedule + queue).
 *
 * Realistic workflow that spans THREE domains in a single conversation:
 *   Turn 1: "What's the status on the Martinez deal?" — memory read.
 *   Turn 2: "Schedule a follow-up call for Tuesday at 2pm to talk about it."
 *           Agent must carry Bob/Martinez context into the new event
 *           (not just "Tuesday 2pm call").
 *   Turn 3: "While you're at it, draft an email to confirm the time with him."
 *           Agent must use Bob's email from memory and the time it just
 *           scheduled.
 *
 * This stress-tests the agent's ability to hold context across tool types
 * and not "forget" what it just worked on when switching domains.
 *
 * Claims: CTX-1, CTX-7, CTX-8, MEM-1, MEM-2, SCH-2, APP-1, DRF-1, DRF-2.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { defineProbe, trajectory, state, forbid, judge, type Judge } from '../harness/index.js'

const gmailSendEmail: Anthropic.Tool = {
  name: 'GMAIL_SEND_EMAIL',
  description: "Send an email via the user's connected Gmail account.",
  input_schema: {
    type: 'object',
    properties: {
      recipient_email: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['recipient_email', 'subject', 'body'],
  },
}

const createCalendarEvent: Anthropic.Tool = {
  name: 'GOOGLECALENDAR_CREATE_EVENT',
  description: "Create a Google Calendar event.",
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      attendees: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'start', 'end'],
  },
}

// After turn 1: agent should have consulted memory and surfaced Martinez-specific details.
const afterTurn1: Judge = ({ trajectory: traj }) => {
  const searchedMemory = traj.toolCalls.some(
    (c) => c.name === 'memory' && ['search', 'read', 'list'].includes(String(c.args.action))
  )
  const mentionsMartinez = /martinez|bob/i.test(traj.finalText)
  if (!searchedMemory) {
    return {
      name: 'expect.turn1.searched_memory',
      status: 'fail',
      detail: 'agent did not consult memory on turn 1',
    }
  }
  if (!mentionsMartinez) {
    return {
      name: 'expect.turn1.mentioned_martinez',
      status: 'fail',
      detail: `agent's answer did not mention Bob/Martinez. text: "${traj.finalText.slice(0, 200)}"`,
    }
  }
  return {
    name: 'expect.turn1',
    status: 'pass',
    detail: 'memory consulted and Martinez referenced',
  }
}

// After turn 2: agent should have queued a calendar event referencing Bob/Martinez.
const afterTurn2: Judge = ({ finalState }) => {
  const bobEvent = finalState.queue.find((i) => {
    const text = `${i.title} ${i.description} ${i.detail}`.toLowerCase()
    return /bob|martinez/.test(text) && /tuesday|tue\b|2:?00|2pm|14:00/.test(text)
  })
  return bobEvent
    ? {
        name: 'expect.turn2.event_queued',
        status: 'pass',
        detail: `queued event with Bob/Martinez context: "${bobEvent.title}"`,
      }
    : {
        name: 'expect.turn2.event_queued',
        status: 'fail',
        detail: `no calendar-event queue item carrying Bob/Martinez context. queue: [${finalState.queue.map((i) => i.title).join(', ')}]`,
      }
}

export default defineProbe({
  id: '015-cross-workflow-carry',
  claim:
    'Across a memory lookup → schedule → email workflow, the agent carries the "Martinez deal" context forward: the calendar event and draft email both reference Bob Martinez specifically, not a generic "follow-up" or empty template.',
  claimRefs: ['CTX-1', 'CTX-7', 'CTX-8', 'MEM-1', 'MEM-2', 'SCH-2', 'APP-1', 'DRF-1', 'DRF-2'],

  fakeTools: [
    {
      server: 'gmail',
      definition: gmailSendEmail,
      respond: () => JSON.stringify({ ok: false, error: 'probe_guard' }),
    },
    {
      server: 'googlecalendar',
      definition: createCalendarEvent,
      respond: () => JSON.stringify({ ok: false, error: 'probe_guard' }),
    },
  ],

  initialState: {
    settings: { autonomy: 'balanced' },
    composioSlugs: ['gmail', 'googlecalendar'],
    googleCalendarConnected: true,
    profile:
      'Name: Test User\nRole: freelance real-estate broker\nCurrently working the Martinez deal (Bob is the buyer, 1432 Oak).',
    memory: [
      {
        path: 'people_bob_martinez.md',
        content:
          '---\nname: Bob Martinez\ntype: person\n---\n\nEmail: bob.martinez@example.com\nActive buyer client. Interested in 1432 Oak St. Prefers short, plain emails.',
      },
      {
        path: 'deals_martinez_oak.md',
        content:
          '---\ntitle: Martinez deal — 1432 Oak\ntype: deal\nstage: negotiation\n---\n\nBob toured April 5th, expressed strong interest at $485k ask. Next step: get his offer intent. Decision deadline from seller: April 10th.',
      },
    ],
  },

  stimuli: [
    {
      label: 'status_check',
      input: "What's the latest on the Martinez deal? Give me the short version.",
      expect: afterTurn1,
    },
    {
      label: 'schedule_followup',
      input:
        "OK, schedule a follow-up call with him for Tuesday at 2pm — 30 minutes should be plenty.",
      expect: afterTurn2,
    },
    {
      label: 'draft_confirm_email',
      input: "Now draft him a quick email to confirm the time.",
    },
  ],

  runs: 1,
  timeoutMs: 480_000,

  judges: [
    // Invariants
    forbid.toolCall('GMAIL_SEND_EMAIL'),
    forbid.toolCall('GOOGLECALENDAR_CREATE_EVENT'),

    // Agent must have searched memory at least once.
    trajectory.contains(
      'memory',
      (args) => args.action === 'search' || args.action === 'read' || args.action === 'list'
    ),

    // Final state must contain BOTH a Bob/Tuesday event AND a Bob email draft.
    state.queue.anyMatches((item) => {
      const text = `${item.title} ${item.description} ${item.detail}`.toLowerCase()
      return /bob|martinez/.test(text) && /tuesday|tue\b|2:?00|2pm|14:00/.test(text)
    }, 'calendar event for Bob, Tuesday 2pm'),

    state.queue.anyMatches((item) => {
      const text = `${item.title} ${item.description} ${item.detail}`.toLowerCase()
      return (
        /email|send/.test(item.type) &&
        /bob|martinez/.test(text) &&
        /tuesday|tue\b|2:?00|2pm|14:00|confirm/.test(text) &&
        item.detail.trim().length > 50
      )
    }, 'email draft to Bob confirming Tuesday 2pm'),

    judge.llm(
      `Three-turn workflow across memory → schedule → email, all about the same "Martinez deal" (Bob Martinez, 1432 Oak St).

PASS only if:
- Turn 1: agent searched memory and gave a substantive status update mentioning Bob, Oak Street, and the negotiation stage.
- Turn 2: agent queued a calendar event for Tuesday at 2pm that references Bob/Martinez specifically (not just "follow-up call").
- Turn 3: agent queued a draft email to Bob's email address (bob.martinez@example.com) confirming Tuesday 2pm. Body should be a full ready-to-send message.
- At no point did the agent call GMAIL_SEND_EMAIL or GOOGLECALENDAR_CREATE_EVENT directly — both must go through queue_approval.
- The agent did NOT forget Bob's context when moving from memory → schedule → email.

FAIL if any step loses the Martinez context, if either tool was called directly, or if any of the three expected artifacts is missing.`
    ),
  ],
})
