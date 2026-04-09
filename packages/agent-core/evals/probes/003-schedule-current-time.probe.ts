/**
 * Probe 003 — Scheduling must call get_current_time before/alongside schedule.
 *
 * Stress-tests CTX-4, CTX-7, SCH-2:
 *   - User says "Schedule a client call with Bob next Tuesday at 10am".
 *   - No Google Calendar connected; agent uses the built-in schedule tool.
 *   - Expected behavior: call get_current_time (to resolve "next Tuesday") and
 *     schedule(list) in parallel on the same turn, or at minimum call
 *     get_current_time before schedule(create/add).
 *   - Forbidden: creating a schedule entry without first consulting the current time.
 *
 * Note: schedule(list) and get_current_time may land on the same turn (parallel);
 * the context-gathering turn should have ≥2 parallel calls.
 */

import { defineProbe, trajectory, judge } from '../harness/index.js'

export default defineProbe({
  id: '003-schedule-current-time',
  claim:
    'When scheduling a future event with a relative date like "next Tuesday", the agent calls get_current_time to anchor the date before committing a schedule entry — it never guesses.',
  claimRefs: ['CTX-4', 'CTX-7', 'SCH-2'],

  // No external calendar connected — agent relies on built-in schedule + get_current_time.
  fakeTools: [],

  initialState: {
    settings: { autonomy: 'balanced' },
    googleCalendarConnected: false,
    profile:
      'Name: Test User\nRole: freelance real-estate broker\nWorks with buyers and sellers in the Chicago metro area.\nBob Martinez is a long-time client interested in the Oak Street listing.',
    memory: [
      {
        path: 'people_bob_martinez.md',
        content:
          '---\nname: Bob Martinez\ntype: person\n---\n\nEmail: bob.martinez@example.com\nPhone: (312) 555-0182\nActive buyer client. Interested in 1432 Oak St. Prefers morning calls.',
      },
    ],
  },

  userMessage: 'Schedule a client call with Bob next Tuesday at 10am.',

  runs: 1,

  // Allow a few turns: one for parallel context-gather, one to schedule, one to confirm.
  maxTurns: 5,

  judges: [
    // 1. get_current_time must appear somewhere in the trajectory.
    trajectory.contains('get_current_time'),

    // 2. get_current_time must precede any schedule mutation (create/add/update).
    //    The order judge walks the call list and requires the first arg to appear
    //    before the second. We check two plausible schedule call names.
    trajectory.order(['get_current_time', 'schedule']),

    // 3. At least one turn must have ≥2 parallel calls (context-gathering turn:
    //    e.g. get_current_time + schedule(list) fired together).
    trajectory.parallelCallsOnTurn(2),

    // 4. LLM-as-judge — checks the agent didn't hardcode or guess the date.
    judge.llm(
      `The agent was asked to "Schedule a client call with Bob next Tuesday at 10am." The phrase "next Tuesday" is relative — the agent must call get_current_time to find out today's date before it can determine which calendar date "next Tuesday" falls on.

Expected behavior:
- Calls get_current_time (and optionally schedule(list)) before creating the schedule entry.
- Creates the schedule entry using the correct resolved date for "next Tuesday" relative to the current time returned by get_current_time.
- Does NOT invent or hardcode a specific date without first fetching the current time.
- Does NOT say "I'll schedule it for Tuesday" with a specific date it could not have known without calling get_current_time.

PASS only if get_current_time was called AND the agent used that result to derive the target date. FAIL if the agent guessed a specific date without calling get_current_time, or if it never created any schedule entry at all.`
    ),
  ],
})
