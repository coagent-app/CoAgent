/**
 * Probe 008 — agent searches memory before answering a question about a person.
 *
 * Stress-tests CTX-1, CTX-2, CTX-9, MEM-1:
 *   - User asks "What do I know about the Martinez family?"
 *   - Memory contains two separate files: Bob Martinez (buyer) and Maria Martinez
 *     (Bob's wife, mortgage co-signer).
 *   - Expected behavior: perform a semantic memory search, surface BOTH files,
 *     synthesize a combined answer.
 *   - Forbidden: asking the user for clarification instead of looking it up.
 *   - Failure modes: returning information about only one of the two people, or
 *     hallucinating details not present in either file.
 */

import { defineProbe, trajectory, forbid, judge } from '../harness/index.js'

export default defineProbe({
  id: '008-context-gathering',
  claim:
    'When asked about a known person (or family), the agent searches memory first and synthesizes a multi-source answer — it never asks for clarification when memory can answer.',
  claimRefs: ['CTX-1', 'CTX-2', 'CTX-9', 'MEM-1'],

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
          'Phone: 555-0142',
          'Active buyer client. Interested in the Oak Street listing at 1432 Oak St.',
          'Budget: up to $650k. Prefers 3+ bedrooms, good school district.',
          'Prefers plain, short emails. Best reached after 5 pm on weekdays.',
        ].join('\n'),
      },
      {
        path: 'people_maria_martinez.md',
        content: [
          '---',
          'name: Maria Martinez',
          'type: person',
          'relationship: co-signer',
          '---',
          '',
          'Bob Martinez\'s wife. Mortgage co-signer on any purchase.',
          'Works as an RN at St. Mary\'s Hospital — has irregular hours.',
          'Prefers to be included on all formal communications.',
          'Email: maria.martinez@example.com',
        ].join('\n'),
      },
    ],
  },

  userMessage: 'What do I know about the Martinez family?',

  runs: 1,

  judges: [
    // 1. Agent must issue a memory search action — not just recite from thin air.
    trajectory.contains('memory', (args) => args['action'] === 'search'),

    // 2. LLM-as-judge — checks that BOTH Bob and Maria appear in the answer and
    //    that the agent synthesised rather than asking for clarification.
    judge.llm(
      `The agent was asked "What do I know about the Martinez family?" and had access to two memory files:
- people_bob_martinez.md: Bob Martinez, active buyer client, interested in 1432 Oak St, budget up to $650k, prefers plain short emails.
- people_maria_martinez.md: Maria Martinez, Bob's wife, mortgage co-signer, works as an RN.

Expected behavior:
- Agent must search memory (not ask for clarification first).
- Agent must cite BOTH Bob Martinez AND Maria Martinez in the answer.
- Agent must not hallucinate facts not present in either file.

PASS only if the agent's final answer mentions both Bob and Maria with at least one accurate detail from each file.
FAIL if:
  - Only one of the two is mentioned.
  - The agent asked the user for clarification instead of looking it up.
  - The agent fabricated details not present in the memory files.`
    ),

    // 3. Sanity regex — Bob must appear in the final text.
    trajectory.finalTextMatches(/bob/i),

    // 4. Sanity regex — Maria must appear in the final text.
    trajectory.finalTextMatches(/maria/i),

    // 5. Agent must not punt to the user for info memory already has.
    forbid.mentionedInText(
      /could you (tell|clarify|provide|share|give)|what (do you mean|are you looking for)|can you (clarify|specify|elaborate)|I('d| would) need (more|additional) (info|detail|context)/i
    ),
  ],
})
