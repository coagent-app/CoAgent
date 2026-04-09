/**
 * Probe 004 — Queued email must contain a complete, send-ready draft, not a placeholder.
 *
 * Stress-tests DRF-1, APP-3:
 *   - User in `balanced` autonomy says "Queue an email to Bob letting him know
 *     the proposal is ready for review."
 *   - No email body is provided — the agent must compose the full text itself.
 *   - Memory has Bob's file with his email address.
 *   - Expected behavior: call queue_approval with a fully written email body
 *     (greeting, substantive message, sign-off). No placeholders like "TBD",
 *     "[body]", "{{...}}", or similar.
 *   - Forbidden: queuing a stub, leaving body unfilled, or asking the user
 *     to supply the body content.
 */

import { defineProbe, trajectory, state, forbid, judge } from '../harness/index.js'

export default defineProbe({
  id: '004-no-placeholder-draft',
  claim:
    'When asked to queue an email in balanced autonomy, the agent writes the complete email body itself — it never queues a placeholder, stub, or asks the user to fill in the content.',
  claimRefs: ['DRF-1', 'APP-3'],

  // No external email tool — the probe only tests the queue_approval path.
  fakeTools: [],

  initialState: {
    settings: { autonomy: 'balanced' },
    profile:
      'Name: Test User\nRole: freelance real-estate broker\nWorks with buyers and sellers in the Chicago metro area.\nBob Martinez is a long-time client who has been waiting on a purchase proposal.',
    memory: [
      {
        path: 'people_bob_martinez.md',
        content:
          '---\nname: Bob Martinez\ntype: person\n---\n\nEmail: bob.martinez@example.com\nPhone: (312) 555-0182\nActive buyer client. Interested in 1432 Oak St at $799k. Prefers plain, short emails. Last contact: April 6th — was waiting on purchase proposal from Test User.',
      },
      {
        path: 'projects_oak_street.md',
        content:
          '---\ntitle: 1432 Oak Street — Purchase Proposal\ntype: project\nstatus: draft_ready\n---\n\nAddress: 1432 Oak Street, Chicago, IL 60614\nProposal prepared for Bob Martinez at $799,000. Ready for client review as of April 8th.',
      },
    ],
  },

  userMessage: 'Queue an email to Bob letting him know the proposal is ready for review.',

  runs: 1,

  judges: [
    // 1. queue_approval must have been called.
    trajectory.contains('queue_approval'),

    // 2. The queued item must be a substantive email draft:
    //    - detail longer than 80 chars (rules out one-liner stubs)
    //    - contains Bob's name (it's addressed to him)
    //    - contains a greeting-like word (Hi, Hello, Dear, Hey)
    //    - does NOT contain placeholder markers
    state.queue.anyMatches(
      (item) => {
        const body = `${item.title} ${item.detail}`.toLowerCase()
        const hasLength = item.detail.trim().length > 80
        const hasBob = /bob/i.test(body)
        const hasGreeting = /\b(hi|hello|dear|hey)\b/i.test(item.detail)
        const hasPlaceholder = /\[body\]|\{\{|tbd|\[fill in\]|placeholder|\[draft\]/i.test(item.detail)
        return hasLength && hasBob && hasGreeting && !hasPlaceholder
      },
      'email to Bob: >80 chars, greeting, no placeholders'
    ),

    // 3. No placeholder language must appear anywhere in assistant text.
    forbid.mentionedInText(/\[body\]|\{\{.*?\}\}|TBD|\[fill in\]|placeholder|\[draft\]/i),

    // 4. The agent must not have asked the user to write the body for it.
    forbid.mentionedInText(/what would you like (me to )?say|what should (the )?email say|can you (provide|give me) the (body|content|text)/i),

    // 5. LLM-as-judge — verifies the draft is genuinely send-ready.
    judge.llm(
      `The agent was asked to "Queue an email to Bob letting him know the proposal is ready for review." Memory contains Bob Martinez's email (bob.martinez@example.com) and a project file showing the 1432 Oak Street purchase proposal is ready.

Expected behavior:
- The agent calls queue_approval with a complete email draft: a proper greeting ("Hi Bob," or similar), a substantive body explaining the proposal is ready for his review, and a closing/sign-off.
- The queued detail field contains the full email body, not a placeholder like "Draft: notify Bob about proposal", "TBD", "[body]", or "{{content}}".
- The agent does NOT ask the user what to say in the email — it composes it from context.

PASS only if the queued item contains a complete, send-ready email body addressed to Bob about the proposal being ready. FAIL if the body is a stub, placeholder, missing, or if the agent asked the user to provide the content.`
    ),
  ],
})
