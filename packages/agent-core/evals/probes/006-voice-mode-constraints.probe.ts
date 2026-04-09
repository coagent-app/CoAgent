/**
 * Probe 006 — Voice-mode reply constraints.
 *
 * Stress-tests VOI-1, VOI-2, VOI-3, VOI-4:
 *   VOI-1 — When the user's message ends with `[voice]`, reply in ≤30 words.
 *   VOI-2 — Voice replies: natural spoken English, no markdown, no lists, no
 *            bullets, no code, no symbols that read as characters.
 *   VOI-3 — Don't include "[voice]" in the reply.
 *   VOI-4 — If the full answer won't fit, give the shortest useful version and
 *            add "I'll put the details on screen."
 *
 * Scenario: The user asks what's on their schedule today and appends `[voice]`.
 * The memory contains a couple of schedule items so the agent has real content
 * to summarize. The reply must be a short spoken sentence — no markdown, no
 * bullets, no literal "[voice]", and under 30 words.
 *
 * Note: No fake tools are needed. The agent sees the schedule items surfaced
 * through memory and is expected to produce a spoken-English summary from that
 * context without needing to call external tools.
 */

import { defineProbe, trajectory, forbid, judge } from '../harness/index.js'

export default defineProbe({
  id: '006-voice-mode-constraints',
  claim:
    'When a user message ends with [voice], the agent replies in ≤30 words of natural spoken English with no markdown, no bullets, no code, and without echoing the [voice] token.',
  claimRefs: ['VOI-1', 'VOI-2', 'VOI-3', 'VOI-4'],

  fakeTools: [],

  initialState: {
    settings: { autonomy: 'balanced' },
    profile:
      'Name: Test User\nRole: freelance real-estate broker\nWorks with buyers and sellers in the residential market.',
    memory: [
      {
        path: 'schedule_today.md',
        content:
          '---\ntype: schedule\n---\n\nToday\'s agenda (Wednesday, April 8 2026):\n- 10:00 AM — Call with Bob Martinez to discuss Oak Street offer\n- 2:00 PM — Property walkthrough at 88 Maple Ave with new buyers',
      },
    ],
  },

  userMessage: "What's on my schedule today? [voice]",

  runs: 1,

  judges: [
    // 1. Hard word-count cap — must be ≤30 words.
    trajectory.finalTextWordsAtMost(30),

    // 2. No markdown syntax, no list markers, no code fences, no headings,
    //    and no echo of the [voice] trigger token.
    forbid.mentionedInText(/\*\*|__|\n\s*[-*+]\s|\n\s*\d+\.\s|`|#|\[voice\]/),

    // 3. Belt-and-suspenders: explicit substring check for [voice] echo.
    forbid.substringsInText(['[voice]']),

    // 4. LLM-as-judge — evaluates natural spoken quality and VOI-4 compliance.
    judge.llm(
      `The user sent a message ending in "[voice]", which signals that the reply will be read aloud. The agent's reply must satisfy ALL of the following:

1. 30 words or fewer (hard cap — count every word).
2. Natural spoken English — the kind of thing you would say out loud, not write.
3. No markdown whatsoever: no bold (**), no italics (*), no bullet points (-, *, +, numbered lists), no code fences, no headers (#).
4. No symbols that would sound strange when read aloud (e.g., *, #, **, __).
5. Must NOT contain the literal string "[voice]".
6. If the full schedule can't fit in 30 words, the agent should give the most important item and add a phrase like "I'll put the details on screen."

PASS only if all six criteria are met. FAIL if any criterion is violated — especially markdown syntax, exceeding 30 words, or echoing [voice].`
    ),
  ],
})
