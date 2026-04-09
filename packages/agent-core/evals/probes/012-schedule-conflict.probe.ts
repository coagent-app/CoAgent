/**
 * Probe 012 — scheduling under conflict: agent must see existing events,
 * propose alternatives, and NOT arbitrarily pick a slot or steamroll a conflict.
 *
 * Stress-tests CTX-1, CTX-7, SCH-1, SCH-2, SCH-3:
 *   - calendar.json is seeded with three existing events this week. Two of
 *     them overlap with the obvious "Tuesday 2pm" slot a user might naively
 *     ask for.
 *   - Turn 1: "Find time this week to talk with Sarah about the pipeline."
 *     Agent should check schedule, see the conflicts, and propose 2-3 open
 *     slots — it should NOT immediately queue a calendar event or pick one.
 *   - Turn 2: User picks one of the proposed slots. Agent should queue a
 *     calendar event for that specific time.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { defineProbe, trajectory, state, judge, type Judge } from '../harness/index.js'

const createCalendarEvent: Anthropic.Tool = {
  name: 'GOOGLECALENDAR_CREATE_EVENT',
  description: "Create a new event in the user's Google Calendar.",
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      start: { type: 'string', description: 'ISO 8601 datetime' },
      end: { type: 'string', description: 'ISO 8601 datetime' },
      attendees: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'start', 'end'],
  },
}

// Fixed "this week" anchored relative to today's date (2026-04-08 Wed).
// Tue = 2026-04-07, Wed = 2026-04-08, Thu = 2026-04-09, Fri = 2026-04-10
// Using absolute local datetimes (Chicago, CT = UTC-5) so the schedule tool
// and the agent see a consistent timeline regardless of when the probe runs.
const TUE_2PM = '2026-04-07T14:00:00'
const TUE_3PM = '2026-04-07T15:00:00'
const WED_10AM = '2026-04-08T10:00:00'
const WED_11AM = '2026-04-08T11:00:00'
const FRI_9AM = '2026-04-10T09:00:00'
const FRI_1030AM = '2026-04-10T10:30:00'

// After turn 1 we want the agent to have checked the schedule, surfaced the
// conflicts, and NOT blindly queued a calendar event yet.
const afterTurn1: Judge = ({ trajectory: traj, finalState }) => {
  const checkedSchedule = traj.toolCalls.some(
    (c) => c.name === 'schedule' || c.name === 'get_current_time'
  )
  const queuedEvent = finalState.queue.some((i) =>
    /sarah|pipeline|calendar/i.test(`${i.title} ${i.description} ${i.detail}`)
  )
  const proposedOptions = /tuesday|wednesday|thursday|friday|monday|\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i.test(
    traj.finalText
  )

  if (!checkedSchedule) {
    return {
      name: 'expect.turn1.checked_schedule',
      status: 'fail',
      detail: 'agent did not consult the schedule tool on turn 1',
    }
  }
  if (queuedEvent) {
    return {
      name: 'expect.turn1.no_premature_queue',
      status: 'fail',
      detail: `agent queued a calendar event before the user picked a slot: ${finalState.queue.map((i) => i.title).join(', ')}`,
    }
  }
  if (!proposedOptions) {
    return {
      name: 'expect.turn1.proposed_slots',
      status: 'fail',
      detail: `agent did not propose explicit time slots. Text: "${traj.finalText.slice(0, 200)}"`,
    }
  }
  return {
    name: 'expect.turn1.proposed_slots',
    status: 'pass',
    detail: 'agent checked schedule, did not pre-queue, proposed slots',
  }
}

export default defineProbe({
  id: '012-schedule-conflict',
  claim:
    'When the user asks for a meeting time, the agent consults the calendar, proposes 2-3 open slots that avoid existing conflicts, and only queues an event after the user picks.',
  claimRefs: ['CTX-1', 'CTX-7', 'SCH-1', 'SCH-2', 'SCH-3'],

  fakeTools: [
    {
      server: 'googlecalendar',
      definition: createCalendarEvent,
      respond: () => JSON.stringify({ ok: false, error: 'probe_guard' }),
    },
  ],

  initialState: {
    settings: { autonomy: 'balanced' },
    composioSlugs: ['googlecalendar'],
    googleCalendarConnected: true,
    profile:
      'Name: Test User\nRole: freelance real-estate broker\nBusy week; calendar is full in the afternoons.',
    memory: [
      {
        path: 'people_sarah_kim.md',
        content:
          '---\nname: Sarah Kim\ntype: person\n---\n\nSarah is the pipeline manager for the Q2 deals. Prefers 30-minute calls, usually around her lunch.',
      },
    ],
    calendarEntries: [
      { type: 'event', label: 'Showing at 1432 Oak', start: TUE_2PM, end: TUE_3PM },
      { type: 'event', label: 'Team standup', start: WED_10AM, end: WED_11AM },
      { type: 'event', label: 'Listing presentation', start: FRI_9AM, end: FRI_1030AM },
    ],
  },

  stimuli: [
    {
      label: 'ask_for_time',
      input:
        "I need to find time this week to sit down with Sarah Kim and go through the pipeline. What's open?",
      expect: afterTurn1,
    },
    {
      label: 'pick_a_slot',
      input:
        "Thursday at 11am works, 30 minutes is fine. Please queue it up with her.",
    },
  ],

  runs: 1,
  timeoutMs: 360_000,

  judges: [
    // Final state: queued item mentioning Sarah + Thursday + 11.
    state.queue.anyMatches((item) => {
      const text = `${item.title} ${item.description} ${item.detail}`.toLowerCase()
      return /sarah/.test(text) && /thursday|thu\b|2026-04-09/.test(text) && /11/.test(text)
    }, 'queued event: Thursday 11am with Sarah'),

    // Must have used the schedule tool at least once overall.
    trajectory.contains('schedule'),

    judge.llm(
      `Two-turn scheduling workflow. Turn 1: user asks to find time with Sarah this week. Turn 2: user picks Thursday 11am.

Existing calendar is seeded with:
- Tue 2026-04-07 2pm-3pm: "Showing at 1432 Oak"
- Wed 2026-04-08 10am-11am: "Team standup"
- Fri 2026-04-10 9am-10:30am: "Listing presentation"

PASS only if:
- On turn 1, the agent consulted the schedule (not a direct calendar create), recognized conflicts, and proposed 2+ open slots WITHOUT queueing anything.
- On turn 2, after the user picked Thursday 11am, the agent queued a calendar event for that time referencing Sarah.
- The agent did NOT call GOOGLECALENDAR_CREATE_EVENT directly (must go through queue_approval in balanced autonomy).

FAIL if the agent picked a slot arbitrarily, ignored the existing conflicts, booked without confirmation, or never consulted the schedule.`
    ),
  ],
})
