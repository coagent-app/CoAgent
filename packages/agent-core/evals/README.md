# CoAgent Prompt Eval Harness

AI-researcher-style probe kit for the real Agent loop. Each probe runs the
actual `Agent` instance — real `buildSystemPrompt()`, real tool schemas, real
`ApprovalQueue`, real memory files in a temp dir — with only two things
swapped:

1. **MCP layer → `FakeMCPManager`.** No real MCP subprocesses, no real sends.
   Every external tool call lands in an in-process recorder that returns a
   probe-supplied stub response.
2. **LLM endpoint → Kimi K2.5.** Routed through the CoAgent relay by default
   (so no Moonshot key lives on disk) or direct Moonshot if you set
   `MOONSHOT_API_KEY`.

The harness then extracts a **trajectory** (every tool call + assistant text
the agent produced) and runs a pipeline of **judges** against it. Judges come
in four flavors:

- **trajectory** — "did the agent call this tool?" / "in this order?" / "≤ N
  words final text?"
- **state** — "is there an item of this shape in the approval queue?" / "does
  this memory file exist?"
- **forbid** — "did it call this forbidden tool?" / "is this forbidden
  substring in the reply?"
- **judge.llm** — Kimi itself grades the trajectory against a rubric

## Layout

```
evals/
├── README.md                    — this file
├── claims.md                    — canonical list of testable system-prompt claims
├── run-all.ts                   — discovery + runner + report writer
├── harness/
│   ├── index.ts                 — barrel + defineProbe() helper
│   ├── types.ts                 — Probe / Judge / Trajectory types
│   ├── run-probe.ts             — core runner (real Agent + FakeMCP swap)
│   ├── fake-mcp-manager.ts      — drop-in MCPManager replacement
│   ├── trajectory.ts            — trajectory extractor
│   ├── judges.ts                — trajectory / state / forbid / judge.llm factories
│   └── __tests__/               — vitest self-tests for the harness
└── probes/
    ├── 001-approval-email.probe.ts
    ├── 002-dont-ask-look-up.probe.ts
    ├── 003-schedule-current-time.probe.ts
    ├── ...
```

## Running

```bash
# All probes, writes a report to docs/reviews/YYYY-MM-DD-prompt-eval.md
pnpm --filter @coagent/agent-core eval

# Subset by id prefix
pnpm --filter @coagent/agent-core eval 001 003

# Just the harness self-tests (no live LLM)
pnpm --filter @coagent/agent-core eval:test
```

### Credentials

The runner resolves Kimi credentials in this order:

1. **Relay** — `RELAY_URL` + `RELAY_TOKEN` already in `process.env` or in
   `~/.coagent/.env` (what the desktop app uses after you sign in). Kimi
   traffic goes `harness → relay → Moonshot`. **No API keys touch disk.**
2. **Direct Moonshot** — only if `MOONSHOT_API_KEY` is set in
   `packages/agent-core/.env` or your shell. For CI or headless setups that
   don't use the relay.
3. **Throw** — the runner refuses to run.

`ANTHROPIC_API_KEY` is always cleared from env inside `runProbe()` so that a
probe cannot accidentally bill the Anthropic path if someone flips
`powerModel` to a Claude model.

## Writing a probe

```ts
// evals/probes/042-my-probe.probe.ts
import { defineProbe, trajectory, state, forbid, judge } from '../harness/index.js'

export default defineProbe({
  id: '042-my-probe',
  claim: 'Plain-English description of the behavior being tested.',
  claimRefs: ['CTX-1', 'MEM-5'], // IDs from evals/claims.md

  // Fake external tools the agent will "see" in the system prompt.
  // Leave empty if the probe only exercises internal tools.
  fakeTools: [
    {
      server: 'gmail',
      definition: {
        name: 'GMAIL_SEND_EMAIL',
        description: 'Send an email via the user\'s Gmail.',
        input_schema: {
          type: 'object',
          properties: {
            recipient_email: { type: 'string' },
            subject: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['recipient_email', 'subject', 'body'],
        },
      },
      respond: () => JSON.stringify({ ok: false, error: 'probe_guard' }),
    },
  ],

  // Fixture state written to the temp dir before agent.chat() runs.
  initialState: {
    settings: { autonomy: 'balanced' },
    composioSlugs: ['gmail'],
    profile: 'Name: Test User\nRole: ...',
    memory: [
      { path: 'people_bob.md', content: '...' },
    ],
  },

  userMessage: 'The message that drives the run.',
  runs: 1, // Number of times to re-run for non-determinism
  judges: [
    trajectory.contains('queue_approval'),
    state.queue.hasAtLeast(1),
    forbid.toolCall('GMAIL_SEND_EMAIL'),
    judge.llm('Rubric: PASS if ... FAIL if ...'),
  ],
})
```

### Judge reference

```ts
// Trajectory assertions
trajectory.contains(name: string | RegExp, argsMatch?)
trajectory.order(['a', 'b', 'c'])
trajectory.finalTextMatches(/regex/)
trajectory.finalTextWordsAtMost(30)
trajectory.parallelCallsOnTurn(2)

// Final-state assertions
state.queue.hasLength(n)
state.queue.hasAtLeast(n)
state.queue.anyMatches(predicate, description)
state.memory.fileExists('path.md')
state.memory.fileMatches('path.md', /regex/)

// Forbidden actions
forbid.toolCall(name: string | RegExp)
forbid.mentionedInText(/regex/)
forbid.substringsInText(['let me', 'sure thing'])

// LLM-as-judge (uses Kimi itself)
judge.llm('You are grading whether ... PASS if ..., FAIL if ...')
```

You can also inline a custom judge as an async function matching the `Judge`
signature:

```ts
import type { Judge } from '../harness/index.js'

const customJudge: Judge = async ({ trajectory, finalState }) => ({
  name: 'custom.my-check',
  status: finalState.memoryContents['x.md']?.includes('foo') ? 'pass' : 'fail',
  detail: '...',
})
```

## Reports

After a run, `run-all.ts` writes a markdown report to
`docs/reviews/YYYY-MM-DD-prompt-eval.md` with:

- Per-probe pass/partial/fail status
- Full tool-call trace and final text for every run
- Every judge verdict with its explanation
- A claim coverage summary showing which IDs from `claims.md` are tested

Exit code is nonzero if any probe failed, so CI can gate on it.

## When to add a probe

- You wrote a new section in the system prompt. Add a claim ID to `claims.md`
  and at least one probe that exercises it.
- You found a production issue where the agent didn't follow a prompt rule.
  Add a probe that reproduces it.
- You changed the autonomy / approval logic. Add probes for every mode.

## Current scope (v1)

The initial probe suite covers the highest-impact behavioral claims:
approvals, context gathering, scheduling, drafts, memory hygiene, voice mode,
style, sub-agents, and prompt injection. See `claims.md` for the full map and
`run-all.ts` output for the "uncovered claims" list — anything listed there
is a gap in the eval suite.
