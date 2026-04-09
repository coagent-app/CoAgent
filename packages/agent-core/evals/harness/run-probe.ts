/**
 * runProbe — execute a single probe against the real Agent loop.
 *
 * Guarantees:
 *   - Real `buildSystemPrompt()` runs on every chat call. No override.
 *   - Real `getInternalTools()` provides the real tool schemas the model sees.
 *   - Real `ApprovalQueue`, real file-store reads, real memory file listing.
 *   - ONLY the MCP tool execution layer is replaced. MCP → FakeMCPManager
 *     (in-process, no side effects). The LLM call is real Kimi K2.5, either
 *     routed through the user's CoAgent relay (preferred — no keys on disk)
 *     or direct Moonshot if `MOONSHOT_API_KEY` is set.
 *
 * Credential resolution order:
 *   1. If RELAY_URL + RELAY_TOKEN are already in process.env, use them.
 *   2. Else load ~/.coagent/.env via loadApiKeysToEnv() and try again.
 *   3. Else fall back to MOONSHOT_API_KEY (direct Moonshot).
 *   4. If none of the above, throw.
 *
 * The harness NEVER writes credentials to disk.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { Agent } from '../../src/agent.js'
import { writeSettings } from '../../src/settings.js'
import { loadApiKeysToEnv, getRelayConfig } from '../../src/auth.js'
import { resetToolEmbeddingsState } from '../../src/tool-embeddings.js'
import { SandboxedMCPManager } from './sandboxed-mcp-manager.js'
import { extractTrajectory } from './trajectory.js'
import type { Probe, ProbeResult, ProbeRunResult, FinalState, JudgeResult, Stimulus, InitialState } from './types.js'
import type { MCPServerConfig } from '../../src/mcp-manager.js'

/**
 * Resolve the memory MCP subprocess command for the harness. We use the same
 * require.resolve path the server uses in dev mode so any code changes in
 * packages/mcp-memory are picked up by the next eval run.
 */
function resolveHarnessMemoryConfig(): MCPServerConfig {
  const mcpMemoryPath = require.resolve('@coagent/mcp-memory')
  return { name: 'memory', command: 'node', args: [mcpMemoryPath] }
}

/**
 * Ensure Kimi creds are reachable. Call this once at runner startup; it's
 * idempotent and cheap. Returns the mode we ended up in for logging.
 */
export function resolveKimiCredentials(): 'relay' | 'moonshot-direct' {
  // 1. Already configured?
  if (getRelayConfig()) return 'relay'
  if (process.env.MOONSHOT_API_KEY) return 'moonshot-direct'

  // 2. Try loading from ~/.coagent/.env (where the desktop app stores relay creds).
  try {
    loadApiKeysToEnv(join(homedir(), '.coagent'))
  } catch {
    // loadApiKeysToEnv already swallows ENOENT; anything else we ignore here.
  }

  if (getRelayConfig()) return 'relay'
  if (process.env.MOONSHOT_API_KEY) return 'moonshot-direct'

  throw new Error(
    'No Kimi credentials found. Either (a) sign into CoAgent so ~/.coagent/.env has RELAY_URL + RELAY_TOKEN, or (b) set MOONSHOT_API_KEY in packages/agent-core/.env.'
  )
}

/**
 * Run a probe N times (as specified in probe.runs) and aggregate results.
 * Each run gets its own temp dir so state assertions are clean.
 */
export async function runProbe(probe: Probe): Promise<ProbeResult> {
  // Resolve credentials (relay preferred, direct Moonshot as fallback).
  // Throws if neither is configured.
  resolveKimiCredentials()

  // We clear ANTHROPIC_API_KEY so that if anyone ever flips a probe's
  // powerModel to a Claude model, we fail loud instead of silently burning
  // the user's Anthropic credit. Eval suite is Kimi-only by policy.
  delete process.env.ANTHROPIC_API_KEY

  const runs: ProbeRunResult[] = []
  for (let i = 0; i < probe.runs; i++) {
    console.log(`[eval] ${probe.id} — run ${i + 1}/${probe.runs}`)
    const run = await runOnce(probe, i)
    runs.push(run)
  }

  const passCount = runs.filter((r) => r.status === 'pass').length
  const overall: ProbeResult['overall'] =
    passCount === probe.runs ? 'pass' : passCount === 0 ? 'fail' : 'partial'

  return {
    probeId: probe.id,
    claim: probe.claim,
    claimRefs: probe.claimRefs,
    runs,
    overall,
  }
}

/**
 * Normalize a Probe's stimulus field into a list of Stimulus objects. Single-
 * turn probes (`userMessage`) are lifted into a one-element stimuli array.
 */
function normalizeStimuli(probe: Probe): Stimulus[] {
  if (probe.stimuli && probe.stimuli.length > 0) {
    if (probe.userMessage) {
      throw new Error(`${probe.id}: probe must set either userMessage OR stimuli, not both`)
    }
    return probe.stimuli
  }
  if (!probe.userMessage) {
    throw new Error(`${probe.id}: probe must set either userMessage or stimuli`)
  }
  return [{ input: probe.userMessage, label: 'user' }]
}

function stimulusLabel(step: Stimulus, index: number): string {
  if (step.label) return step.label
  if (typeof step.input === 'string') return `user#${index + 1}`
  if (step.input.type === 'user') return `user#${index + 1}`
  return `trigger:${step.input.source}#${index + 1}`
}

function stimulusSummary(step: Stimulus): string {
  const text = typeof step.input === 'string'
    ? step.input
    : step.input.type === 'user'
      ? step.input.text
      : `[trigger: ${step.input.source}${step.input.payload ? ' ' + JSON.stringify(step.input.payload).slice(0, 120) : ''}]`
  return text.slice(0, 200)
}

function resolveInitialState(probe: Probe, runIndex: number): InitialState {
  if (typeof probe.initialState === 'function') return probe.initialState(runIndex)
  return probe.initialState
}

async function runOnce(probe: Probe, runIndex: number): Promise<ProbeRunResult> {
  const t0 = Date.now()
  const tmpDir = mkdtempSync(join(tmpdir(), `coagent-eval-${probe.id}-`))
  const stimuli = normalizeStimuli(probe)
  const timeoutMs = probe.timeoutMs ?? (stimuli.length > 1 ? 300_000 : 120_000)
  const stepResults: ProbeRunResult['stepResults'] = []
  const initialState = resolveInitialState(probe, runIndex)

  // Save and restore COAGENT_DATA_DIR so the harness doesn't leak the sandbox
  // dir into the surrounding process environment between runs.
  const prevCoagentDataDir = process.env.COAGENT_DATA_DIR
  let sandboxedMcp: SandboxedMCPManager | null = null

  try {
    // ── 0. Reset the module-global LanceDB handle BEFORE constructing the Agent.
    //       Otherwise a stale `table` from the previous probe's (now-deleted)
    //       tmp dir will blow up embedTools() during the first chat turn.
    resetToolEmbeddingsState()

    // ── 1. Prepare the temp data dir to match probe.initialState ────────────
    await setupTempDir(tmpDir, initialState)

    // ── 1b. Point the memory MCP subprocess at the sandbox dir. The spawned
    //        `node @coagent/mcp-memory` process inherits this env var and
    //        reads/writes all of its files (LanceDB, memory/*.md) under tmpDir.
    //        Same mechanism production uses (see mcp-memory/src/index.ts:23).
    process.env.COAGENT_DATA_DIR = tmpDir

    // ── 2. Construct the real Agent with empty MCP configs so the default
    //       MCPManager's connect([]) is a no-op. We'll swap in the
    //       SandboxedMCPManager and start real subprocesses on THAT one, so
    //       the agent's mcpReady / toolCache / serverMap all point at the
    //       sandboxed manager from the first chat() onward.
    const agent = new Agent([], tmpDir)

    // ── 3. Swap in the SandboxedMCPManager BEFORE calling chat(). ──────────
    //       agent.mcpManager is public, so this is a legal assignment.
    sandboxedMcp = new SandboxedMCPManager(probe.fakeTools)
    ;(agent as any).mcpManager = sandboxedMcp

    // ── 3b. Spawn the REAL memory MCP against the sandbox dir. connect() is
    //        awaited so the subprocess is up and its tools are discoverable
    //        before the first chat() turn. If relay creds are missing,
    //        embeddings will fail but read/write still work — surfaced as
    //        errors in trajectory, not harness crashes.
    await sandboxedMcp.connect([resolveHarnessMemoryConfig()])

    // Invalidate the cached system prompt so runLoop rebuilds it on first chat.
    // Otherwise a stale cache from the previous internal construction could leak.
    ;(agent as any).cachedSystemPrompt = null
    ;(agent as any).cachedPromptKey = null

    // ── 4. Reflect connection flags so buildSystemPrompt sees a realistic state.
    agent.googleCalendarConnected = initialState.googleCalendarConnected ?? false
    agent.composioConnectedSlugs = initialState.composioSlugs ?? []

    // ── 5. Seed prior conversation history (v2). We mutate the private field
    //       directly because there's no public setter — probes use this to
    //       start mid-thread with realistic context.
    if (initialState.conversationHistory && initialState.conversationHistory.length > 0) {
      ;(agent as any).conversationHistory.push(...initialState.conversationHistory)
    }

    // ── 6. Seed pending approval queue items (v2).
    for (const item of initialState.pendingApprovals ?? []) {
      agent.queue.add(item)
    }

    // ── 7. Record the starting length of conversationHistory so we only
    //       capture what this run produces (not the seeded prior turns).
    const startIdx = ((agent as any).conversationHistory as unknown[])?.length ?? 0

    // Overall deadline across all stimuli.
    const deadline = Date.now() + timeoutMs

    // ── 8. Drive the real agent through each stimulus in sequence. ─────────
    for (let stepIdx = 0; stepIdx < stimuli.length; stepIdx++) {
      const step = stimuli[stepIdx]
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        // Out of budget before this step even starts.
        const traj = extractTrajectory(agent, startIdx)
        const finalState = buildFinalState(agent, tmpDir)
        return {
          runIndex,
          trajectory: traj,
          finalState,
          judgeResults: [],
          stepResults,
          status: 'fail',
          durationMs: Date.now() - t0,
          error: `probe exceeded ${timeoutMs}ms budget before stimulus ${stepIdx + 1}/${stimuli.length}`,
        }
      }

      // Snapshot pre-step tool-call count so we can attribute calls per step.
      const preStepToolCalls = extractTrajectory(agent, startIdx).toolCalls.length
      const preStepTextCount = extractTrajectory(agent, startIdx).assistantTexts.length

      // Dispatch this step based on its input type.
      const inputNorm = typeof step.input === 'string' ? { type: 'user' as const, text: step.input } : step.input
      const stepPromise =
        inputNorm.type === 'user'
          ? agent.chat(inputNorm.text)
          : agent.handleTrigger({ source: inputNorm.source as any, payload: inputNorm.payload })

      const outcome = await Promise.race([
        stepPromise.then(() => ({ kind: 'ok' as const })),
        new Promise<{ kind: 'timeout' }>((resolve) =>
          setTimeout(() => {
            agent.stop()
            resolve({ kind: 'timeout' })
          }, remaining)
        ),
      ])

      if (outcome.kind === 'timeout') {
        await stepPromise.catch(() => {})
        const traj = extractTrajectory(agent, startIdx)
        const finalState = buildFinalState(agent, tmpDir)
        return {
          runIndex,
          trajectory: traj,
          finalState,
          judgeResults: [],
          stepResults,
          status: 'fail',
          durationMs: Date.now() - t0,
          error: `probe exceeded ${timeoutMs}ms timeout during stimulus ${stepIdx + 1}/${stimuli.length} (${stimulusLabel(step, stepIdx)}) after ${traj.totalTurns} turn(s), ${traj.toolCalls.length} tool call(s)`,
        }
      }

      // Compute per-step trajectory deltas.
      const cumulativeTraj = extractTrajectory(agent, startIdx)
      const toolCallCount = cumulativeTraj.toolCalls.length - preStepToolCalls
      const newAssistantTexts = cumulativeTraj.assistantTexts.slice(preStepTextCount)
      const assistantText = newAssistantTexts.join('\n').slice(0, 500)

      // Run the mid-step `expect` judge if present.
      let midAssertion: JudgeResult | undefined
      if (step.expect) {
        try {
          const snapshotState = buildFinalState(agent, tmpDir)
          midAssertion = await step.expect({ trajectory: cumulativeTraj, finalState: snapshotState })
        } catch (err: any) {
          midAssertion = {
            name: 'mid_expect_threw',
            status: 'fail',
            detail: `expect judge threw: ${err?.message ?? String(err)}`,
          }
        }
      }

      stepResults.push({
        stepIndex: stepIdx,
        label: stimulusLabel(step, stepIdx),
        stimulusSummary: stimulusSummary(step),
        toolCallCount,
        assistantText,
        midAssertion,
      })
    }

    // ── 9. Extract final trajectory + state. ───────────────────────────────
    const traj = extractTrajectory(agent, startIdx)
    const finalState = buildFinalState(agent, tmpDir)

    // Optional: dump the exact system prompt the Agent sent to Kimi on its
    // first chat turn. Enable with DEBUG_PROMPT=1 to compare against prod.
    if (process.env.DEBUG_PROMPT) {
      const sp = (agent as any).cachedSystemPrompt as string | null
      if (sp) {
        const out = join(
          process.env.DEBUG_PROMPT_DIR || tmpdir(),
          `coagent-system-prompt-${probe.id}-run${runIndex + 1}.txt`
        )
        writeFileSync(out, sp, 'utf-8')
        console.log(`[eval] ${probe.id}: system prompt written to ${out}`)
      }
    }

    // ── 10. Run post-run judges. ───────────────────────────────────────────
    const judgeResults: JudgeResult[] = []
    for (const j of probe.judges) {
      try {
        judgeResults.push(await j({ trajectory: traj, finalState }))
      } catch (err: any) {
        judgeResults.push({
          name: 'judge_threw',
          status: 'fail',
          detail: `judge threw: ${err?.message ?? String(err)}`,
        })
      }
    }

    // Run = pass iff every post-judge AND every mid-step expect passed.
    const allJudgesPassed = judgeResults.every((j) => j.status === 'pass')
    const allMidAssertsPassed = stepResults.every((s) => !s.midAssertion || s.midAssertion.status === 'pass')
    const status: 'pass' | 'fail' = allJudgesPassed && allMidAssertsPassed ? 'pass' : 'fail'

    return {
      runIndex,
      trajectory: traj,
      finalState,
      judgeResults,
      stepResults,
      status,
      durationMs: Date.now() - t0,
    }
  } catch (err: any) {
    return {
      runIndex,
      trajectory: {
        toolCalls: [],
        assistantTexts: [],
        finalText: '',
        totalTurns: 0,
        history: [],
        systemPrompt: '',
      },
      finalState: emptyFinalState(tmpDir),
      judgeResults: [],
      stepResults,
      status: 'fail',
      durationMs: Date.now() - t0,
      error: `runOnce threw: ${err?.message ?? String(err)}`,
    }
  } finally {
    // Tear down the memory MCP subprocess first — otherwise it keeps
    // reading/writing the tmp dir we're about to delete, which can race on
    // index persistence and print noise.
    if (sandboxedMcp) {
      try {
        await sandboxedMcp.disconnectAll()
      } catch {
        // ignore — best effort cleanup
      }
    }

    // Restore the parent process env var so subsequent probes (or tests) don't
    // inherit this run's sandbox path.
    if (prevCoagentDataDir === undefined) {
      delete process.env.COAGENT_DATA_DIR
    } else {
      process.env.COAGENT_DATA_DIR = prevCoagentDataDir
    }

    // Clean up the temp dir. If you need to debug a run, comment this out.
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

// ── Temp dir setup ─────────────────────────────────────────────────────────

async function setupTempDir(tmpDir: string, initialState: InitialState): Promise<void> {
  // Create memory dir and profile.md (if provided)
  const memoryDir = join(tmpDir, 'memory')
  mkdirSync(memoryDir, { recursive: true })

  if (initialState.profile) {
    writeFileSync(join(memoryDir, 'profile.md'), initialState.profile, 'utf-8')
  }

  for (const m of initialState.memory ?? []) {
    const abs = join(memoryDir, m.path)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, m.content, 'utf-8')
  }

  // Seed calendar.json so CalendarStore.load() picks up the fixture entries
  // when the Agent constructs its schedule subsystem.
  if (initialState.calendarEntries && initialState.calendarEntries.length > 0) {
    const now = new Date().toISOString()
    const entries = initialState.calendarEntries.map((e, i) => ({
      id: e.id ?? `probe-cal-${i}`,
      createdAt: e.createdAt ?? now,
      ...e,
    }))
    writeFileSync(join(tmpDir, 'calendar.json'), JSON.stringify(entries, null, 2), 'utf-8')
  }

  // Write settings with probe overrides. powerModel defaults to 'kimi-k2.5'
  // (matches production default) but can be overridden by:
  //   1. The probe's initialState.settings (per-probe override)
  //   2. The EVAL_MODEL env var (suite-wide override — useful when Moonshot
  //      is having capacity issues)
  const defaultModel = process.env.EVAL_MODEL || 'kimi-k2.5'
  await writeSettings(tmpDir, {
    name: 'Test User',
    email: 'test@example.com',
    timezone: 'America/Chicago',
    role: 'freelancer',
    onboarded: true, // skip onboarding flow
    autonomy: 'balanced',
    powerModel: defaultModel,
    ...initialState.settings,
  })
}

// ── Final state snapshot ───────────────────────────────────────────────────

function buildFinalState(agent: Agent, tmpDir: string): FinalState {
  const queue = agent.queue.getPending().map((item) => ({
    id: item.id,
    type: item.type,
    title: item.title,
    description: item.description,
    detail: item.detail,
  }))

  const memoryDir = join(tmpDir, 'memory')
  const memoryFiles: string[] = []
  const memoryContents: Record<string, string> = {}
  if (existsSync(memoryDir)) {
    for (const f of walkMemoryDir(memoryDir, '')) {
      memoryFiles.push(f)
      try {
        memoryContents[f] = readFileSync(join(memoryDir, f), 'utf-8')
      } catch {
        // ignore
      }
    }
  }

  return { queue, memoryFiles, memoryContents, dataDir: tmpDir }
}

function walkMemoryDir(absRoot: string, relPath: string): string[] {
  const out: string[] = []
  const abs = join(absRoot, relPath)
  let entries: string[] = []
  try {
    entries = readdirSync(abs)
  } catch {
    return []
  }
  for (const entry of entries) {
    const rel = relPath ? join(relPath, entry) : entry
    const fullPath = join(absRoot, rel)
    try {
      const stat = require('fs').statSync(fullPath)
      if (stat.isDirectory()) {
        out.push(...walkMemoryDir(absRoot, rel))
      } else if (entry.endsWith('.md')) {
        out.push(rel)
      }
    } catch {
      // ignore
    }
  }
  return out
}

function emptyFinalState(tmpDir: string): FinalState {
  return { queue: [], memoryFiles: [], memoryContents: {}, dataDir: tmpDir }
}
