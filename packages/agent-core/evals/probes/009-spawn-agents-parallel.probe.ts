/**
 * Probe 009 — agent uses spawn_agents for genuinely parallel research tasks.
 *
 * Stress-tests SPA-1, SPA-2, CTX-7:
 *   - User explicitly requests three independent research tasks in parallel for
 *     an upcoming client meeting with Bob Martinez.
 *   - Agent has spawn_agents available as an internal built-in tool.
 *   - Expected behavior: call spawn_agents with three distinct sub-tasks in a
 *     single invocation rather than tackling them one by one.
 *   - Failure modes: doing the research sequentially, punting with "I'll look
 *     into each of these", or spawning only 1-2 sub-tasks.
 *
 * Note: spawn_agents is an internal built-in, so no fakeTools are needed — the
 * real implementation intercepts it and the trajectory records the call.
 */

import { defineProbe, trajectory, forbid, judge } from '../harness/index.js'

export default defineProbe({
  id: '009-spawn-agents-parallel',
  claim:
    'When the user requests multiple independent research tasks, the agent delegates them in parallel via spawn_agents rather than working through them sequentially.',
  claimRefs: ['SPA-1', 'SPA-2', 'CTX-7'],

  fakeTools: [],

  initialState: {
    settings: { autonomy: 'balanced' },
    profile:
      'Name: Test User\nRole: freelance real-estate broker\nWorks with buyers and sellers in the local market.',
    memory: [
      {
        path: 'people_bob_martinez.md',
        content: [
          '---',
          'name: Bob Martinez',
          'type: person',
          'relationship: buyer-client',
          '---',
          '',
          'Email: bob.martinez@example.com',
          'Active buyer client. Interested in the Oak Street listing at 1432 Oak St.',
          'Budget: up to $650k. Prefers 3+ bedrooms, good school district.',
          'Meeting scheduled for this week to review market data.',
        ].join('\n'),
      },
    ],
  },

  userMessage: [
    'Research three things for me in parallel — I need all of this for a meeting with Bob in an hour:',
    '1) Current mortgage rates (30-year fixed)',
    '2) Comparable home sales on Oak Street in the last 90 days',
    "3) School ratings for the neighborhood around 1432 Oak St",
  ].join('\n'),

  runs: 1,

  judges: [
    // 1. spawn_agents must be called — this is the primary behavioral signal.
    trajectory.contains('spawn_agents'),

    // 2. LLM-as-judge — verifies that three distinct research tasks are actually
    //    delegated and that the agent doesn't do them sequentially.
    judge.llm(
      `The agent was asked to research three independent topics in parallel for a real-estate client meeting:
1. Current mortgage rates (30-year fixed)
2. Comparable home sales on Oak Street in the last 90 days
3. School ratings for the neighborhood around 1432 Oak St

Expected behavior:
- Call spawn_agents with three distinct sub-tasks covering all three topics.
- It is acceptable if the agent ALSO calls get_current_time or schedule(list) to
  orient itself before spawning (those are complementary context-gathering steps).
- The three sub-tasks must be independent and described clearly enough that a
  sub-agent could execute each one without additional input.

PASS if spawn_agents is called with three distinguishable research tasks that map
to the three topics above (order does not matter, wording may vary).
FAIL if:
  - spawn_agents is not called at all.
  - Fewer than 3 tasks are delegated.
  - The tasks are vague placeholders (e.g. "research everything the user asked").
  - The agent replies it will "tackle these one at a time" or similar.`
    ),

    // 3. Agent must not signal sequential fallback behavior in its text.
    forbid.mentionedInText(
      /let me (do|tackle|handle|work through) these one at a time|i('ll| will) (do|tackle|handle|research) (them|these) sequentially|start with the first|one by one/i
    ),
  ],
})
