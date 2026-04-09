/**
 * Probe 002 — Vague reference: agent must search memory, not ask for clarification.
 *
 * Stress-tests CTX-1, CTX-6, CTX-8, MEM-1:
 *   - User says "What's the latest on that Oak Street thing?" — intentionally vague.
 *   - Memory contains `projects_oak_street.md` with full listing context.
 *   - Expected behavior: call memory(action: 'search') to find Oak Street details,
 *     then answer from what it found.
 *   - Forbidden: asking "which Oak Street?" or any other clarifying question that
 *     could have been answered by a tool call first.
 */

import { defineProbe, trajectory, forbid, judge } from '../harness/index.js'

export default defineProbe({
  id: '002-dont-ask-look-up',
  claim:
    'When the user asks a vague question about a known project, the agent searches memory to find context and answers directly — it does not ask the user to clarify.',
  claimRefs: ['CTX-1', 'CTX-6', 'CTX-8', 'MEM-1'],

  // No external MCP tools needed — agent only uses the built-in memory tool.
  fakeTools: [],

  initialState: {
    settings: { autonomy: 'balanced' },
    profile:
      'Name: Test User\nRole: freelance real-estate broker\nWorks with buyers and sellers in the Chicago metro area.\nBob Martinez is a long-time client interested in the Oak Street listing.',
    memory: [
      {
        path: 'people_bob_martinez.md',
        content:
          '---\nname: Bob Martinez\ntype: person\n---\n\nEmail: bob.martinez@example.com\nActive buyer client. Interested in 1432 Oak St. Prefers plain, short emails. Budget: $850k.',
      },
      {
        path: 'projects_oak_street.md',
        content:
          '---\ntitle: 1432 Oak Street Listing\ntype: project\nstatus: active\n---\n\nAddress: 1432 Oak Street, Chicago, IL 60614\nAsk price: $799,000\nBedrooms: 3 / Bathrooms: 2\nLast update: 2026-04-06 — seller accepted showing requests; Bob Martinez toured on April 5th and expressed strong interest. Awaiting buyer\'s decision by April 10th.\nNext action: follow up with Bob on April 8th to gauge offer intent.',
      },
    ],
  },

  userMessage: "What's the latest on that Oak Street thing?",

  runs: 1,

  judges: [
    // 1. The agent must have called memory with a search action to look up Oak Street.
    trajectory.contains(
      'memory',
      (args) =>
        typeof args.action === 'string' &&
        args.action === 'search' &&
        typeof args.query === 'string' &&
        /oak/i.test(args.query)
    ),

    // 2. Must NOT have asked the user to clarify which Oak Street they meant.
    forbid.mentionedInText(/which\s+oak\s+street|can you clarify|which\s+one\??|what\s+do\s+you\s+mean\??/i),

    // 3. Must NOT have asked a generic clarifying question when it could have looked it up.
    forbid.mentionedInText(/could you (be more specific|clarify|elaborate)|what are you referring to/i),

    // 4. LLM-as-judge — catches anything the structural judges miss.
    judge.llm(
      `The agent was asked "What's the latest on that Oak Street thing?" — a vague reference. Memory contains a file called projects_oak_street.md with full details about 1432 Oak Street: ask price $799k, Bob Martinez toured on April 5th, decision deadline April 10th, next follow-up April 8th.

Expected behavior:
- The agent calls the memory search tool (with a query mentioning Oak Street or similar) BEFORE replying.
- The agent answers with real details from the memory file (price, status, buyer interest, timeline).
- The agent does NOT ask "which Oak Street?" or request clarification before looking it up.

PASS only if the agent proactively searched memory and gave a substantive answer based on what it found, without asking the user for clarification first. FAIL if the agent asked a clarifying question, gave a vague non-answer, or answered without calling the memory tool.`
    ),
  ],
})
