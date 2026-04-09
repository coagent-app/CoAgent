/**
 * Probe 019 — parallel research via spawn_agents.
 *
 * Real freelancer workflow: client asks for a lead-qualification pack on
 * three prospective buyers. Each prospect has independent research needs
 * (company background, marketing presence, budget signals). The correct
 * execution is ONE spawn_agents call with three parallel tasks — not three
 * sequential sub-calls.
 *
 * Stress-tests SPA-1, SPA-2, CTX-7, WEB-1.
 *
 * This probe also uses seeded conversation history to establish continuity:
 * prior turns show the user and agent already agreed to build a
 * qualification report, so the stimulus is a direct "go" rather than a cold
 * open.
 */

import { defineProbe, trajectory, forbid, judge, type Judge } from '../harness/index.js'

// Verify there's at least one spawn_agents call with ≥3 parallel tasks, all
// referencing distinct prospect names.
const spawnThree: Judge = ({ trajectory: traj }) => {
  const spawnCalls = traj.toolCalls.filter((c) => c.name === 'spawn_agents')
  if (spawnCalls.length === 0) {
    return {
      name: 'trajectory.spawn_agents.three_parallel',
      status: 'fail',
      detail: 'no spawn_agents call found',
    }
  }
  // spawn_agents args shape: { agents: [{ task, ... }, ...] }
  for (const call of spawnCalls) {
    const agents = (call.args as any).agents
    if (Array.isArray(agents) && agents.length >= 3) {
      const blob = JSON.stringify(agents).toLowerCase()
      const prospects = ['acme', 'beta', 'gamma']
      const found = prospects.filter((p) => blob.includes(p))
      if (found.length >= 3) {
        return {
          name: 'trajectory.spawn_agents.three_parallel',
          status: 'pass',
          detail: `spawn_agents with ${agents.length} tasks covering ${found.join(', ')}`,
        }
      }
      return {
        name: 'trajectory.spawn_agents.three_parallel',
        status: 'fail',
        detail: `spawn_agents had ${agents.length} tasks but only covered: ${found.join(', ') || '(none)'}`,
      }
    }
  }
  return {
    name: 'trajectory.spawn_agents.three_parallel',
    status: 'fail',
    detail: `spawn_agents called but never with ≥3 tasks. calls: ${spawnCalls.length}`,
  }
}

export default defineProbe({
  id: '019-parallel-research',
  claim:
    'When asked to research multiple independent items, the agent fires a single spawn_agents call with one task per item, in parallel — not sequential sub-calls, and not a single agent doing them one at a time.',
  claimRefs: ['SPA-1', 'SPA-2', 'CTX-7', 'WEB-1'],

  fakeTools: [],

  initialState: {
    settings: { autonomy: 'balanced' },
    profile:
      'Name: Test User\nRole: freelance real-estate broker\nRegularly qualifies commercial leads before a first-touch meeting.',
    memory: [
      {
        path: 'leads_pipeline.md',
        content:
          '---\ntitle: Active leads pipeline\ntype: index\n---\n\n| Lead | Type | Stage |\n| ---- | ---- | ----- |\n| Acme Industries | Commercial | Pre-call research |\n| Beta Holdings  | Commercial | Pre-call research |\n| Gamma Partners | Commercial | Pre-call research |',
      },
    ],
    conversationHistory: [
      {
        role: 'user',
        content: 'I have three commercial leads coming in this week: Acme Industries, Beta Holdings, and Gamma Partners. Before the first calls I want a short qualification pack on each.',
      },
      {
        role: 'assistant',
        content:
          "Sounds good. For each prospect I'll gather recent news/press, company size/revenue signals, marketing-spend signals, and any red flags. Ready when you are — just say go.",
      },
    ],
  },

  userMessage:
    "Go — kick off all three research packs in parallel. I don't want them done sequentially.",

  runs: 1,
  timeoutMs: 300_000,

  judges: [
    // Required: one spawn_agents call with ≥3 parallel tasks.
    spawnThree,

    // Anti-pattern: the agent admitting it'll do them sequentially.
    forbid.mentionedInText(
      /let me (do|tackle|handle|work through) these? one at a time|one by one|i('ll| will) (do|tackle|handle|research) (them|these) sequentially|start with the first/i
    ),

    // Must not produce placeholders.
    forbid.mentionedInText(/\[placeholder\]|\{\{.*?\}\}|TBD/i),

    // Spawn_agents must actually be called (redundant with spawnThree but
    // kept as a cheap guard that surfaces in the report).
    trajectory.contains('spawn_agents'),

    judge.llm(
      `The user explicitly asked for three independent research packs — Acme Industries, Beta Holdings, Gamma Partners — in parallel, not sequentially.

PASS only if the agent fired a single spawn_agents call with at least three parallel task definitions, one per prospect, each with a clear research brief. The agent should NOT have done them one at a time, and should NOT have refused on grounds of complexity.

FAIL if spawn_agents was not called, if the agent said it would do them sequentially, if fewer than 3 tasks were spawned, or if the tasks didn't cover all three prospects.`
    ),
  ],
})
