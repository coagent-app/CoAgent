/**
 * Probe 017 — don't duplicate work that's already in the approval queue.
 *
 * The approval queue starts with a pending email draft to Bob Martinez.
 * The user then asks for "that email to Bob" to be updated / refined.
 *
 * Stress-tests APP-3, APP-4, DRF-2, FUP-1:
 *   - The agent should recognize the pending item and either update it
 *     in place or reference it — NOT create a second, parallel draft.
 *   - It should also not blindly call queue_approval again with a
 *     near-duplicate body.
 *
 * Also uses `initialState.pendingApprovals` to verify the harness actually
 * seeds the real ApprovalQueue correctly (regression test on the harness
 * itself).
 */

import type Anthropic from '@anthropic-ai/sdk'
import { defineProbe, state, forbid, judge, type Judge } from '../harness/index.js'

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

// At the end: there should be no more than 2 Bob-related queue items
// (the original + possibly a replacement). Ideally exactly 1.
const noExplosion: Judge = ({ finalState }) => {
  const bobItems = finalState.queue.filter((i) =>
    /bob|martinez|oak/i.test(`${i.title} ${i.description} ${i.detail}`)
  )
  if (bobItems.length === 0) {
    return {
      name: 'state.queue.bob_update_no_explosion',
      status: 'fail',
      detail: 'no Bob items in queue — agent may have deleted the seeded one without re-queueing',
    }
  }
  if (bobItems.length > 2) {
    return {
      name: 'state.queue.bob_update_no_explosion',
      status: 'fail',
      detail: `${bobItems.length} Bob items in queue — refinement should update, not pile up. titles: [${bobItems.map((i) => i.title).join(', ')}]`,
    }
  }
  // If there's exactly 1, verify it reflects the refinement (flexible language).
  // If there are 2, that's also acceptable (old + new) — just check at least
  // one reflects the refinement.
  const refined = bobItems.find((i) =>
    /weekend|walk|this|next/.test(`${i.title} ${i.description} ${i.detail}`.toLowerCase())
  )
  if (!refined) {
    return {
      name: 'state.queue.bob_update_no_explosion',
      status: 'fail',
      detail: `no Bob item reflects the weekend-walk refinement. items: [${bobItems.map((i) => i.detail.slice(0, 80)).join(' || ')}]`,
    }
  }
  return {
    name: 'state.queue.bob_update_no_explosion',
    status: 'pass',
    detail: `${bobItems.length} Bob item(s), refinement present`,
  }
}

export default defineProbe({
  id: '017-concurrent-queue-state',
  claim:
    'When the approval queue already has a pending draft, the agent updates/replaces it on refinement — it does not blindly add a second competing draft, and it does not clear the original silently.',
  claimRefs: ['APP-3', 'APP-4', 'DRF-2', 'FUP-1'],

  fakeTools: [
    {
      server: 'gmail',
      definition: gmailSendEmail,
      respond: () => JSON.stringify({ ok: false, error: 'probe_guard' }),
    },
  ],

  initialState: {
    settings: { autonomy: 'balanced' },
    composioSlugs: ['gmail'],
    profile:
      'Name: Test User\nRole: freelance real-estate broker\nCurrently working the Oak Street listing with Bob Martinez.',
    memory: [
      {
        path: 'people_bob_martinez.md',
        content:
          '---\nname: Bob Martinez\ntype: person\n---\n\nEmail: bob.martinez@example.com\nActive buyer client. Interested in 1432 Oak St. Prefers short, plain emails.',
      },
    ],
    pendingApprovals: [
      {
        type: 'message',
        title: 'Email to Bob Martinez re: Oak Street status',
        description: 'Draft follow-up on 1432 Oak St listing.',
        detail:
          "Hi Bob,\n\nJust a quick note — 1432 Oak St is still available. Let me know if you'd like any additional info.\n\nBest,\nTest",
        notes: '',
        action: 'send_email',
        metadata: { recipient: 'bob.martinez@example.com', subject: '1432 Oak St still available' },
      },
    ],
  },

  userMessage:
    "There's already a draft in the queue for Bob about Oak Street — can you update it to also ask if he wants to walk the place this weekend? Keep it short.",

  runs: 1,
  timeoutMs: 180_000,

  judges: [
    // Never send directly.
    forbid.toolCall('GMAIL_SEND_EMAIL'),

    // No placeholder text in the updated draft.
    forbid.mentionedInText(/\[draft\]|\{\{.*?\}\}|TBD|\[fill in\]/i),

    // Queue must contain exactly 1 Bob item OR (grace) 2 — old + new — and
    // the refinement (weekend walk) must be present.
    noExplosion,

    // Sanity: at least one queue item still references "Oak" (we didn't lose context).
    state.queue.anyMatches(
      (item) => /oak/i.test(`${item.title} ${item.description} ${item.detail}`),
      'Oak Street context retained'
    ),

    judge.llm(
      `The approval queue was pre-seeded with a pending draft email to Bob Martinez about 1432 Oak St. The user then asked the agent to update that draft to also ask about walking the place this weekend.

PASS only if:
- The agent recognized the existing draft and updated/replaced it — it should NOT add a second parallel draft.
- The final queue has at most 2 Bob-related items, and at least one reflects the new "walk this weekend" ask.
- The agent did NOT call GMAIL_SEND_EMAIL directly.
- The agent did NOT clear the original draft silently without queuing a replacement.

FAIL if the queue has 3+ Bob items, if the walk-this-weekend refinement is missing, or if the original was silently lost.`
    ),
  ],
})
