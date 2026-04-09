/**
 * Probe 013 — lead qualification pipeline (memory-update, no duplication).
 *
 * Stress-tests MEM-1, MEM-2, MEM-3, MEM-5, CTX-1:
 *   - Memory already contains a file for Bob Martinez (a buyer).
 *   - User says: "Bob told me today he's also thinking of selling his office
 *     building on Halsted. Add him to the leads list with that intent."
 *   - Correct behavior:
 *       1. Agent must read/search memory and FIND the existing Bob file.
 *       2. Agent must UPDATE Bob's existing file — NOT create a second
 *          `people_bob_martinez_2.md` or an unrelated leads file with
 *          partial info.
 *       3. The updated file must contain the new seller-intent + the Halsted
 *          office building detail.
 *   - Forbidden: creating a file whose name collides with the existing one
 *     but with a different path (e.g. `people/bob.md` when the original is
 *     `people_bob_martinez.md`), or writing a fresh summary that drops all
 *     the existing buyer context.
 */

import { defineProbe, trajectory, judge, type Judge } from '../harness/index.js'

// After the run, there should be exactly ONE file mentioning Bob Martinez,
// and it should contain BOTH the original buyer context (Oak Street) AND
// the new seller intent (Halsted office).
const noDuplicateBob: Judge = ({ finalState }) => {
  const bobFiles = finalState.memoryFiles.filter((f) => /bob|martinez/i.test(f))
  if (bobFiles.length === 0) {
    return {
      name: 'state.memory.single_bob_file',
      status: 'fail',
      detail: `no Bob file found after run. files: [${finalState.memoryFiles.join(', ')}]`,
    }
  }
  if (bobFiles.length > 1) {
    return {
      name: 'state.memory.single_bob_file',
      status: 'fail',
      detail: `${bobFiles.length} Bob files after run — agent duplicated instead of updating: [${bobFiles.join(', ')}]`,
    }
  }
  const content = finalState.memoryContents[bobFiles[0]] ?? ''
  const lower = content.toLowerCase()
  const keptOldContext = /oak|buyer/.test(lower)
  const hasNewIntent = /halsted|sell|seller|office/.test(lower)
  if (!keptOldContext) {
    return {
      name: 'state.memory.single_bob_file',
      status: 'fail',
      detail: `Bob file (${bobFiles[0]}) lost the original buyer context. content preview: "${content.slice(0, 200)}"`,
    }
  }
  if (!hasNewIntent) {
    return {
      name: 'state.memory.single_bob_file',
      status: 'fail',
      detail: `Bob file (${bobFiles[0]}) missing the new seller intent (Halsted / office / seller). content preview: "${content.slice(0, 200)}"`,
    }
  }
  return {
    name: 'state.memory.single_bob_file',
    status: 'pass',
    detail: `updated ${bobFiles[0]} in place with both old and new context`,
  }
}

export default defineProbe({
  id: '013-lead-qualification',
  claim:
    'When updating info about an existing contact, the agent finds and updates the existing memory file rather than creating a duplicate file or dropping existing context.',
  claimRefs: ['CTX-1', 'MEM-1', 'MEM-2', 'MEM-3', 'MEM-5'],

  fakeTools: [],

  initialState: {
    settings: { autonomy: 'balanced' },
    profile:
      'Name: Test User\nRole: freelance real-estate broker\nFocused on residential buyers but open to commercial referrals.',
    memory: [
      {
        path: 'people_bob_martinez.md',
        content:
          '---\nname: Bob Martinez\ntype: person\nrole: buyer\n---\n\nEmail: bob.martinez@example.com\nActive buyer client. Toured 1432 Oak St on April 5th. Prefers plain, short emails. Budget: $850k.',
      },
      {
        path: 'leads_pipeline.md',
        content:
          '---\ntitle: Active leads pipeline\ntype: index\n---\n\n| Lead | Type | Stage | Notes |\n| ---- | ---- | ----- | ----- |\n| Alicia Chen | Buyer | Showing scheduled | Downtown lofts |\n| Sanjay Rao | Seller | Listed last week | 2BR condo in Lincoln Park |',
      },
    ],
  },

  userMessage:
    "Quick update: Bob Martinez told me at today's showing that he's also thinking about selling his office building on Halsted — 4,200 sq ft, potential asking around $1.2M. Add him to the leads list with that intent and keep his buyer stuff too.",

  runs: 1,
  timeoutMs: 240_000,

  judges: [
    // The agent MUST have searched memory first (to find the existing Bob file).
    trajectory.contains(
      'memory',
      (args) => args.action === 'search' || args.action === 'list' || args.action === 'read'
    ),

    // The agent must have written to memory at some point.
    trajectory.contains(
      'memory',
      (args) => args.action === 'write' || args.action === 'update' || args.action === 'append'
    ),

    // Single Bob file, updated in place with both old + new context.
    noDuplicateBob,

    judge.llm(
      `The user told the agent that Bob Martinez (already an existing buyer contact) is now also a potential seller for an office building on Halsted.

PASS only if:
- The agent looked up the existing Bob file (memory read/search) BEFORE writing.
- The agent updated the SAME Bob file (people_bob_martinez.md) rather than creating a second file.
- The updated content preserves Bob's existing buyer context (Oak St, buyer-client notes) AND adds the new seller intent (Halsted office building, ~4200 sqft, asking ~$1.2M).
- The agent did NOT duplicate Bob under a new name or drop the buyer context in a full rewrite.

FAIL if there are multiple Bob files, the buyer context was lost, the seller intent was not added, or the agent asked clarifying questions without first searching memory.`
    ),
  ],
})
