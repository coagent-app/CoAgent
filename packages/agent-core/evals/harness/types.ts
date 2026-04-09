/**
 * Shared types for the prompt-evaluation harness.
 *
 * The harness runs real `Agent` instances against Kimi K2.5 with a fake MCP layer
 * so we can probe behavior without side effects. Probes are written as small
 * scenario files that declare initial state, a stimulus, and judges.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { AgentSettings } from '../../src/settings.js'
import type { ApprovalItem, CalendarEntry } from '@coagent/shared'

// ── Fake tools ─────────────────────────────────────────────────────────────

/**
 * A fake external tool the probe wants the agent to "see".
 * The FakeMCPManager exposes these via getAllTools() exactly like a real MCP,
 * and routes callTool() through the probe-supplied handler. No side effects.
 */
export interface FakeTool {
  /** Server name the tool belongs to — populates serverMap in MCPManager.getAllTools */
  server: string
  /** Anthropic.Tool shape — this is what the model actually sees */
  definition: Anthropic.Tool
  /**
   * Optional response handler. If omitted, FakeMCPManager returns a generic
   * JSON stub `{ok: true, tool: <name>, note: 'fake response'}`.
   * Return a string (what real MCPs return) or an object (will be JSON-stringified).
   */
  respond?: (args: Record<string, unknown>) => string | object | Promise<string | object>
}

// ── Initial state ──────────────────────────────────────────────────────────

/**
 * Realistic inputs for `buildSystemPrompt()` and the Agent loop.
 * Everything here maps to real fields on the real Agent — we do NOT override
 * the prompt builder itself.
 */
export interface InitialState {
  /** Partial settings — merged with DEFAULT_SETTINGS before writing to temp dir */
  settings?: Partial<AgentSettings>
  /**
   * Memory files to write to `<dataDir>/memory/*.md`.
   * `listMemoryFiles()` inside buildSystemPrompt will pick these up, so they
   * affect the system prompt the model actually sees.
   */
  memory?: Array<{ path: string; content: string }>
  /** Contents of `<dataDir>/memory/profile.md`, surfaced to the agent */
  profile?: string
  /**
   * Flags that feed directly into buildSystemPrompt() arguments so the prompt
   * reflects a realistic connection state.
   */
  googleCalendarConnected?: boolean
  composioSlugs?: string[]
  /**
   * Seeded prior conversation. Copied into `agent.conversationHistory` BEFORE
   * the first stimulus fires, so the probe can start mid-thread (e.g. "user
   * and agent already agreed on a lead's name two turns ago"). Must be valid
   * Anthropic.MessageParam shape — the harness does NOT sanitize.
   */
  conversationHistory?: Anthropic.MessageParam[]
  /**
   * Pre-populated approval queue. Each entry becomes a real pending
   * ApprovalItem via `agent.queue.add()`. Useful for probing how the agent
   * behaves when there's already work waiting (e.g. "don't duplicate the
   * draft that's already queued").
   */
  pendingApprovals?: Array<Omit<ApprovalItem, 'id' | 'status' | 'createdAt'>>
  /**
   * Seeded calendar entries (events, routines, follow-ups, tasks). Written to
   * `<dataDir>/calendar.json` before the Agent boots so `CalendarStore.load()`
   * picks them up. The schedule tool reads from this same file.
   *
   * For events, provide `start`/`end`. For tasks/followups, provide `due`.
   * For routines, provide `cron`. `id` and `createdAt` are filled in for you.
   */
  calendarEntries?: Array<Omit<CalendarEntry, 'id' | 'createdAt'> & { id?: string; createdAt?: string }>
}

// ── Stimuli (v2) ───────────────────────────────────────────────────────────

/**
 * A single step in a multi-turn probe. The harness drives the agent one
 * stimulus at a time, lets it fully respond, then optionally runs an
 * intermediate assertion before advancing to the next stimulus.
 */
export interface Stimulus {
  /**
   * What drives the agent on this step:
   *   - { type: 'user', text: '...' }         — normal user chat message
   *   - { type: 'trigger', source, payload? } — heartbeat / schedule / memory trigger
   * For back-compat, a bare string is shorthand for { type: 'user', text }.
   */
  input: string | { type: 'user'; text: string } | { type: 'trigger'; source: string; payload?: Record<string, unknown> }
  /**
   * Optional mid-run assertion. Runs AFTER the agent finishes responding to
   * this stimulus and BEFORE the next one fires. Use for "after turn 1, there
   * should be exactly one draft in the queue" style checks. The assertion
   * sees the cumulative trajectory and current state up to this point.
   */
  expect?: Judge
  /**
   * Optional human-readable label shown in the report for this step.
   */
  label?: string
}

// ── Trajectory ─────────────────────────────────────────────────────────────

/** A single tool call the agent made during a run */
export interface ToolCall {
  /** The tool name as seen by the model (internal tool OR external via call_external_tool) */
  name: string
  /** Full input args the model sent */
  args: Record<string, unknown>
  /** Which turn (1-indexed) the call happened on */
  turn: number
  /** The tool_use_id from the model's content block */
  id: string
  /** Whether this was a built-in internal tool or an external MCP tool */
  kind: 'internal' | 'external'
  /** For external tools: the target server the call was routed to */
  externalServer?: string
  /** For external tools: the upstream tool name */
  externalToolName?: string
}

/** The full record of what happened during one probe run */
export interface Trajectory {
  /** All tool_use blocks the model produced, in order */
  toolCalls: ToolCall[]
  /** All text the model emitted (assistant messages with text blocks), in order */
  assistantTexts: string[]
  /** The final assistant reply (last text block) */
  finalText: string
  /** Total turns the loop ran */
  totalTurns: number
  /** Raw conversation history from the agent — full Anthropic.MessageParam[] */
  history: Anthropic.MessageParam[]
  /** The system prompt the model actually saw — pulled from the agent via reflection */
  systemPrompt: string
}

// ── Judges ─────────────────────────────────────────────────────────────────

export interface JudgeResult {
  name: string
  status: 'pass' | 'fail'
  detail: string
}

export type Judge = (ctx: {
  trajectory: Trajectory
  finalState: FinalState
}) => JudgeResult | Promise<JudgeResult>

/** Snapshot of agent state after the run completes — drives state-based judges */
export interface FinalState {
  /** Contents of the ApprovalQueue */
  queue: Array<{ id: string; type: string; title: string; description: string; detail: string }>
  /** Memory files present in the temp dir after the run */
  memoryFiles: string[]
  /** Raw memory file contents keyed by filename */
  memoryContents: Record<string, string>
  /** The temp dataDir — for anything fancy a judge wants to read */
  dataDir: string
}

// ── Probe definition ───────────────────────────────────────────────────────

export interface Probe {
  /** Stable ID like "001-approval-email" — used in reports and filenames */
  id: string
  /** One-line description of the behavior being probed */
  claim: string
  /** Which system-prompt claims this probe stress-tests (from claims.md) */
  claimRefs: string[]

  /** Fake tool surface the probe wants the agent to have */
  fakeTools: FakeTool[]

  /**
   * Fixture state for the temp dir. Can be a static object (same state for
   * every run) or a function `(runIndex) => InitialState` for per-run
   * variation — useful for matrix probes that sweep settings like autonomy
   * mode across the same stimulus.
   */
  initialState: InitialState | ((runIndex: number) => InitialState)

  /**
   * Single-turn convenience: the user message that kicks off the run.
   * Mutually exclusive with `stimuli`. Probes must set exactly one of
   * userMessage OR stimuli.
   */
  userMessage?: string

  /**
   * Multi-turn drive script (v2). Each entry is fed sequentially; the agent
   * fully responds to each stimulus before the next one fires. Use for
   * complex workflows (draft → refine → approve) or trigger-driven runs.
   */
  stimuli?: Stimulus[]

  /** Max number of runs — we re-run each probe to observe non-determinism */
  runs: number

  /** Hard ceiling on agent loop turns to prevent runaways */
  maxTurns?: number

  /**
   * Per-probe hard timeout in ms for the whole run (across all stimuli).
   * Defaults to 120s for single-turn, 300s for multi-turn probes.
   */
  timeoutMs?: number

  /** Judges to run after each run (post-final-stimulus) */
  judges: Judge[]
}

// ── Run results ────────────────────────────────────────────────────────────

export interface ProbeRunResult {
  runIndex: number
  trajectory: Trajectory
  finalState: FinalState
  judgeResults: JudgeResult[]
  /**
   * Per-step results for multi-stimulus probes. Each entry captures the
   * stimulus label, how many tool calls fired on that step, and any
   * mid-step `expect` judge verdict. Empty for single-turn probes.
   */
  stepResults: Array<{
    stepIndex: number
    label: string
    stimulusSummary: string
    toolCallCount: number
    assistantText: string
    midAssertion?: JudgeResult
  }>
  /** Overall run status: pass iff every judge passed */
  status: 'pass' | 'fail'
  /** Milliseconds for the run */
  durationMs: number
  /** Error during run, if any (didn't reach judges) */
  error?: string
}

export interface ProbeResult {
  probeId: string
  claim: string
  claimRefs: string[]
  runs: ProbeRunResult[]
  /** 'pass' = all runs pass, 'partial' = some pass, 'fail' = none pass */
  overall: 'pass' | 'partial' | 'fail'
}
