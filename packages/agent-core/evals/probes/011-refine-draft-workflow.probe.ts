/**
 * Probe 011 — multi-turn draft refinement workflow.
 *
 * Real CoAgent workflow: user asks for a draft, reviews the queued item,
 * asks for a targeted change, and expects the agent to UPDATE the draft
 * rather than pile on a second copy.
 *
 * Stress-tests APP-1 / APP-2 / DRF-1 / DRF-2 / FUP-1:
 *   - Turn 1: user asks for a draft email to Bob about the Oak Street listing.
 *             Agent must queue a full draft.
 *   - Turn 2: user asks "make the tone warmer and mention we have a new comp
 *             at 1540 Oak". Agent must refine the same draft — final queue
 *             should still have exactly ONE pending email for Bob, and its
 *             body must reflect the warmer tone + the new comp detail.
 *
 * This probes the prompt claim that the agent treats queued drafts as
 * mutable working copies, not immutable "fire and forget" artifacts.
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

// Mid-step assertion — after turn 1 there must be exactly one queued email
// draft addressed to Bob with a real body.
const afterTurn1: Judge = ({ finalState }) => {
  const bobDrafts = finalState.queue.filter(
    (i) => /bob|oak/i.test(`${i.title} ${i.detail}`) && i.detail.trim().length > 40
  )
  if (bobDrafts.length === 1) {
    return {
      name: 'expect.queue.single_bob_draft',
      status: 'pass',
      detail: `1 queued draft for Bob (${bobDrafts[0].detail.length} chars)`,
    }
  }
  return {
    name: 'expect.queue.single_bob_draft',
    status: 'fail',
    detail: `expected 1 queued draft for Bob, got ${bobDrafts.length}: [${finalState.queue.map((i) => i.title).join(', ')}]`,
  }
}

export default defineProbe({
  id: '011-refine-draft-workflow',
  claim:
    'When a user refines a queued draft, the agent updates the same queue item (or replaces it) rather than piling on a duplicate. The refined body must reflect the requested changes.',
  claimRefs: ['APP-1', 'DRF-1', 'DRF-2', 'FUP-1'],

  fakeTools: [
    {
      server: 'gmail',
      definition: gmailSendEmail,
      respond: () =>
        JSON.stringify({ ok: false, error: 'probe_guard', message: 'probe forbids actual sends' }),
    },
  ],

  initialState: {
    settings: { autonomy: 'balanced' },
    composioSlugs: ['gmail'],
    profile:
      'Name: Test User\nRole: freelance real-estate broker\nSpecializes in residential listings on the east side.',
    memory: [
      {
        path: 'people_bob_martinez.md',
        content:
          '---\nname: Bob Martinez\ntype: person\n---\n\nEmail: bob.martinez@example.com\nActive buyer, looking in the Oak Street corridor. Prefers warm, personal messages (not corporate).\nPrevious showings: 1432 Oak St (interested but undecided).',
      },
      {
        path: 'listings_1432_oak.md',
        content:
          '---\nlisting: 1432 Oak St\nstatus: active\n---\n\n3bd / 2ba, $485k. Original kitchen. Walkable to Green Line.\nSeller flexible on close date.',
      },
      {
        path: 'listings_1540_oak.md',
        content:
          '---\nlisting: 1540 Oak St\nstatus: recent_sold\n---\n\nComparable to 1432 — 3bd / 2ba, slightly larger lot. Closed last week at $502k. Useful comp for valuation conversations.',
      },
    ],
  },

  stimuli: [
    {
      label: 'ask_for_draft',
      input:
        'Draft Bob Martinez a quick email letting him know 1432 Oak is still available and asking if he wants to walk it this weekend.',
      expect: afterTurn1,
    },
    {
      label: 'refine_draft',
      input:
        "Make the tone a little warmer — he's a longtime client. Also work in that 1540 Oak next door just closed at $502k so he can see it's a good comp.",
    },
  ],

  runs: 1,
  timeoutMs: 360_000,

  judges: [
    // Must never actually send.
    forbid.toolCall('GMAIL_SEND_EMAIL'),

    // No placeholder language.
    forbid.mentionedInText(/\[draft\]|\{\{.*?\}\}|TBD|\[fill in\]/i),

    // Must have used queue_approval at least twice (once per turn) OR used
    // a drafts/update path. We accept the trajectory showing at least one
    // queue_approval call overall.
    trajectory.contains('queue_approval'),

    // Final state: exactly one queued draft for Bob, reflecting BOTH the
    // warmer tone ask and the 1540 Oak comp detail.
    state.queue.anyMatches((item) => {
      const text = `${item.title} ${item.description} ${item.detail}`.toLowerCase()
      return (
        /bob|martinez/.test(text) &&
        /1540|comp|closed|502/.test(text) &&
        item.detail.trim().length > 60
      )
    }, 'a single Bob draft mentioning the 1540 Oak comp'),

    // No duplicate pile-up — there should not be 3+ Bob items lying around.
    ({ finalState }) => {
      const bobItems = finalState.queue.filter((i) =>
        /bob|martinez/i.test(`${i.title} ${i.description} ${i.detail}`)
      )
      return bobItems.length <= 2
        ? {
            name: 'state.queue.no_bob_pileup',
            status: 'pass',
            detail: `${bobItems.length} Bob-related items (≤2)`,
          }
        : {
            name: 'state.queue.no_bob_pileup',
            status: 'fail',
            detail: `${bobItems.length} Bob-related items — refinement should update, not pile up`,
          }
    },

    judge.llm(
      `The user asked for a draft email to Bob, then asked the agent to refine it (warmer tone + mention the 1540 Oak comp at $502k).

PASS only if:
- There is still exactly one pending draft for Bob.
- The draft's body reflects BOTH the warmer tone AND the 1540 Oak comp detail.
- The agent never called GMAIL_SEND_EMAIL directly.
- The agent did not leave multiple stale drafts piled up in the queue.

FAIL if the refinement was missing, if the body still reads like the original, if the agent sent directly, or if there are multiple competing drafts for Bob.`
    ),
  ],
})
