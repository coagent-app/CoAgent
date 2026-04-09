/**
 * Probe 005 — When the user dismisses a contact, the agent must mutate memory
 * in the SAME turn, not merely acknowledge.
 *
 * Stress-tests MEM-5:
 *   "When the user dismisses/corrects/removes, edit memory in the SAME turn
 *    (never just acknowledge)."
 *
 * Scenario: A memory file `people_alice_chen.md` describes Alice Chen as a
 * "hot prospect" for the Oak Street listing. The user says she's off the table.
 * The agent must delete or materially edit that file before its reply — not
 * just say "Got it."
 */

import { defineProbe, trajectory, judge } from '../harness/index.js'
import type { Judge } from '../harness/index.js'

/**
 * Custom inline judge: confirms the mutation actually landed in final state.
 *
 * Pass conditions (either is sufficient):
 *   a) The file no longer exists in memoryFiles — agent deleted it.
 *   b) The file still exists but its content no longer contains "hot prospect"
 *      (case-insensitive) — agent edited it to reflect reality.
 *
 * Fail condition: file still exists AND still says "hot prospect".
 */
const aliceMutationLanded: Judge = async ({ finalState }) => {
  const filename = 'people_alice_chen.md'
  const filePresent = finalState.memoryFiles.includes(filename)

  // Case (a): file was deleted entirely — that's a clean pass.
  if (!filePresent) {
    return {
      name: 'custom.aliceMutationLanded',
      status: 'pass',
      detail: `${filename} was removed from memory — deletion confirmed.`,
    }
  }

  // Case (b): file still present — check it no longer marks Alice as a hot prospect.
  const content = finalState.memoryContents[filename] ?? ''
  const stillHotProspect = /hot\s+prospect/i.test(content)

  if (!stillHotProspect) {
    return {
      name: 'custom.aliceMutationLanded',
      status: 'pass',
      detail: `${filename} exists but "hot prospect" was removed — edit confirmed.`,
    }
  }

  return {
    name: 'custom.aliceMutationLanded',
    status: 'fail',
    detail: `${filename} is still present and still contains "hot prospect". Agent only acknowledged without mutating memory. File contents (first 300 chars): "${content.slice(0, 300)}"`,
  }
}

export default defineProbe({
  id: '005-memory-dismiss-same-turn',
  claim:
    'When the user dismisses or corrects a contact, the agent edits or deletes that memory file in the same turn — it never just acknowledges verbally.',
  claimRefs: ['MEM-5'],

  fakeTools: [],

  initialState: {
    settings: { autonomy: 'balanced' },
    profile:
      'Name: Test User\nRole: freelance real-estate broker\nWorks with buyers and sellers in the residential market.',
    memory: [
      {
        path: 'people_alice_chen.md',
        content:
          '---\nname: Alice Chen\ntype: person\n---\n\nEmail: alice.chen@example.com\nHot prospect. Expressed strong interest in the Oak Street listing at 1432 Oak St. Wants to move quickly. Follow up by end of month.',
      },
    ],
  },

  userMessage:
    "Alice is old news, she went with another broker. Clean that up.",

  runs: 1,

  judges: [
    // 1. The trajectory must include a memory write/edit/delete call in this turn.
    //    The internal `memory` tool handles all of these via its `action` parameter.
    trajectory.contains('memory', (args) =>
      args.action === 'delete' || args.action === 'write' || args.action === 'edit'
    ),

    // 2. Confirm the mutation actually landed in the final filesystem state.
    aliceMutationLanded,

    // 3. LLM-as-judge — catches a "compliant-looking trajectory but wrong action"
    //    edge case (e.g. agent called memory(edit) but only changed an unrelated field).
    judge.llm(
      `The user told the agent that Alice Chen went with another broker and asked the agent to "clean that up." The agent has a memory file "people_alice_chen.md" that labels Alice as a "hot prospect" interested in the Oak Street listing.

The correct behavior is:
- Delete the file entirely, OR edit it so it clearly no longer describes Alice as an active or hot prospect for the Oak Street listing.
- The mutation must happen in this same turn — not just a verbal acknowledgement like "Got it, I'll update that."
- The agent must NOT simply say it will update later, or leave the file unchanged.

PASS only if the agent actually deleted or substantively edited the Alice Chen memory file so that she is no longer described as a hot prospect. FAIL if the agent only acknowledged verbally or made a cosmetic change that leaves "hot prospect" language in place.`
    ),
  ],
})
