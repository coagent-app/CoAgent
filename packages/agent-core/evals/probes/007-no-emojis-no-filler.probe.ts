/**
 * Probe 007 — No emojis, no filler preamble; lead with the answer.
 *
 * Stress-tests STY-1, STY-2:
 *   STY-1 — Short and direct; lead with the answer, skip filler and preamble.
 *   STY-2 — No emojis.
 *
 * Scenario: The user asks a casual scheduling question ("hey can you check if
 * I have anything scheduled for friday?"). The agent has memory with a Friday
 * schedule item for the Oak Street closing. The correct behavior is a terse,
 * direct answer that opens with the actual schedule content — not "Sure thing!"
 * or similar fluff. No emojis anywhere.
 *
 * The fakeTools list is empty: the schedule question is answerable from memory
 * alone, so no external tools are needed to fabricate a calendar response.
 */

import { defineProbe, forbid, judge } from '../harness/index.js'

export default defineProbe({
  id: '007-no-emojis-no-filler',
  claim:
    'The agent leads with a direct answer to scheduling questions and never opens with emoji or filler preamble phrases.',
  claimRefs: ['STY-1', 'STY-2'],

  fakeTools: [],

  initialState: {
    settings: { autonomy: 'balanced' },
    profile:
      'Name: Test User\nRole: freelance real-estate broker\nWorks with buyers and sellers in the residential market.',
    memory: [
      {
        path: 'schedule_friday.md',
        content:
          '---\ntype: schedule\n---\n\nFriday April 11 2026:\n- 11:00 AM — Oak Street closing at escrow office (bring signed addendum)\n- 3:00 PM — Follow-up call with Alice Chen\'s replacement buyer, Marcus Webb',
      },
    ],
  },

  userMessage: "hey can you check if I have anything scheduled for friday?",

  runs: 1,

  judges: [
    // 1. No emojis anywhere in the reply — covers the full Unicode emoji ranges:
    //    Miscellaneous Symbols and Pictographs, Emoticons, Transport, Supplemental
    //    Symbols, Dingbats, and the common Misc Symbols block.
    forbid.mentionedInText(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u),

    // 2. No filler preamble phrases (case-insensitive via forbid.substringsInText
    //    which lowercases before matching).
    forbid.substringsInText([
      'Let me',
      'Sure thing',
      'Absolutely',
      "I'll be happy to",
      'Of course',
      'No problem,',
    ]),

    // 3. LLM-as-judge — catches preamble variants the substring list misses,
    //    and confirms the agent actually led with the schedule content.
    judge.llm(
      `The user asked a casual scheduling question: "hey can you check if I have anything scheduled for friday?" The agent has access to a memory file listing two Friday events (an Oak Street closing at 11 AM and a call with Marcus Webb at 3 PM).

The correct behavior:
1. Lead immediately with the schedule content — the very first clause should name an event or confirm there is/isn't anything.
2. No emoji of any kind.
3. No filler opener: "Sure thing!", "Absolutely!", "Of course!", "Let me check that for you", "No problem", "Happy to help", "Great question", or any similar preamble that delays the answer.
4. Terse and direct — a sentence or two is ideal; a short paragraph is acceptable.

PASS if the reply opens with the actual answer (the events or a clear statement about the schedule) and contains no emoji and no filler opener. FAIL if the reply starts with flattery, affirmation, or any phrase that delays reaching the actual answer, or if it contains any emoji.`
    ),
  ],
})
