/**
 * Judge factories — the assertion primitives probes use.
 *
 * Four flavors:
 *   trajectory.* — pattern-matches the recorded tool calls & text
 *   state.*      — inspects the agent's final state (queue, memory files)
 *   forbid.*     — fails if a forbidden thing happened
 *   judge.llm    — uses Kimi K2.5 as a grader against a rubric
 */

import OpenAI from 'openai'
import { getRelayConfig } from '../../src/auth.js'
import type { Judge, JudgeResult } from './types.js'
import { hasCall, countCalls } from './trajectory.js'

const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1'
const JUDGE_MODEL = 'kimi-k2.5'

// ── trajectory.* ───────────────────────────────────────────────────────────

export const trajectory = {
  /** Assert the trajectory contains a matching tool call */
  contains(toolName: string | RegExp, argsMatch?: Record<string, unknown> | ((args: any) => boolean)): Judge {
    return async ({ trajectory: t }) => {
      const matcher =
        typeof argsMatch === 'function'
          ? argsMatch
          : argsMatch
            ? (args: Record<string, unknown>) => {
                for (const [k, v] of Object.entries(argsMatch)) {
                  if (v instanceof RegExp) {
                    if (typeof args[k] !== 'string' || !v.test(args[k] as string)) return false
                  } else if (args[k] !== v) {
                    return false
                  }
                }
                return true
              }
            : undefined

      const found = hasCall(t, toolName, matcher)
      const nameStr = typeof toolName === 'string' ? toolName : toolName.source
      return {
        name: `trajectory.contains(${nameStr})`,
        status: found ? 'pass' : 'fail',
        detail: found
          ? `found call to ${nameStr}`
          : `no call to ${nameStr} in ${t.toolCalls.length} tool call(s): ${t.toolCalls.map((c) => c.name).join(', ') || '(none)'}`,
      }
    }
  },

  /** Assert a specific call order — A must appear before B before C */
  order(toolNames: string[]): Judge {
    return async ({ trajectory: t }) => {
      let idx = 0
      for (const call of t.toolCalls) {
        if (call.name === toolNames[idx]) idx++
        if (idx === toolNames.length) break
      }
      const ok = idx === toolNames.length
      return {
        name: `trajectory.order([${toolNames.join(' → ')}])`,
        status: ok ? 'pass' : 'fail',
        detail: ok
          ? 'order satisfied'
          : `expected order [${toolNames.join(' → ')}] but got [${t.toolCalls.map((c) => c.name).join(' → ') || 'none'}]`,
      }
    }
  },

  /** Assert the final text matches a regex */
  finalTextMatches(pattern: RegExp): Judge {
    return async ({ trajectory: t }) => {
      const ok = pattern.test(t.finalText)
      return {
        name: `trajectory.finalTextMatches(${pattern.source})`,
        status: ok ? 'pass' : 'fail',
        detail: ok ? 'pattern matched' : `final text did not match: "${t.finalText.slice(0, 160)}..."`,
      }
    }
  },

  /** Assert the final text length (in words) is at or below a cap */
  finalTextWordsAtMost(max: number): Judge {
    return async ({ trajectory: t }) => {
      const words = t.finalText.trim().split(/\s+/).filter(Boolean).length
      const ok = words <= max
      return {
        name: `trajectory.finalTextWordsAtMost(${max})`,
        status: ok ? 'pass' : 'fail',
        detail: `${words} words (cap: ${max})`,
      }
    }
  },

  /** Assert at least N tool calls happened on the same turn (parallelism check) */
  parallelCallsOnTurn(minCount: number): Judge {
    return async ({ trajectory: t }) => {
      const byTurn = new Map<number, number>()
      for (const c of t.toolCalls) byTurn.set(c.turn, (byTurn.get(c.turn) ?? 0) + 1)
      const best = Math.max(0, ...byTurn.values())
      const ok = best >= minCount
      return {
        name: `trajectory.parallelCallsOnTurn(${minCount})`,
        status: ok ? 'pass' : 'fail',
        detail: `best turn had ${best} parallel call(s) (min: ${minCount})`,
      }
    }
  },
}

// ── state.* ────────────────────────────────────────────────────────────────

export const state = {
  queue: {
    hasLength(n: number): Judge {
      return async ({ finalState }) => {
        const ok = finalState.queue.length === n
        return {
          name: `state.queue.hasLength(${n})`,
          status: ok ? 'pass' : 'fail',
          detail: `queue has ${finalState.queue.length} item(s), expected ${n}`,
        }
      }
    },
    hasAtLeast(n: number): Judge {
      return async ({ finalState }) => {
        const ok = finalState.queue.length >= n
        return {
          name: `state.queue.hasAtLeast(${n})`,
          status: ok ? 'pass' : 'fail',
          detail: `queue has ${finalState.queue.length} item(s), expected ≥ ${n}`,
        }
      }
    },
    /** Any queue item matches the given predicate */
    anyMatches(pred: (item: { type: string; title: string; detail: string }) => boolean, description: string): Judge {
      return async ({ finalState }) => {
        const ok = finalState.queue.some(pred)
        return {
          name: `state.queue.anyMatches(${description})`,
          status: ok ? 'pass' : 'fail',
          detail: ok
            ? 'at least one queue item matched'
            : `no queue item matched: ${JSON.stringify(finalState.queue.map((q) => ({ type: q.type, title: q.title })))}`,
        }
      }
    },
  },
  memory: {
    fileExists(path: string): Judge {
      return async ({ finalState }) => {
        const ok = finalState.memoryFiles.includes(path)
        return {
          name: `state.memory.fileExists(${path})`,
          status: ok ? 'pass' : 'fail',
          detail: ok
            ? `memory file present`
            : `no memory file at ${path}. Present: ${finalState.memoryFiles.join(', ') || '(none)'}`,
        }
      }
    },
    fileMatches(path: string, pattern: RegExp): Judge {
      return async ({ finalState }) => {
        const content = finalState.memoryContents[path]
        if (!content) {
          return {
            name: `state.memory.fileMatches(${path})`,
            status: 'fail',
            detail: `memory file ${path} not found`,
          }
        }
        const ok = pattern.test(content)
        return {
          name: `state.memory.fileMatches(${path}, ${pattern.source})`,
          status: ok ? 'pass' : 'fail',
          detail: ok ? 'pattern matched' : `content did not match: "${content.slice(0, 160)}..."`,
        }
      }
    },
  },
}

// ── forbid.* ───────────────────────────────────────────────────────────────

export const forbid = {
  /** Fail if the named tool was ever called */
  toolCall(toolName: string | RegExp): Judge {
    return async ({ trajectory: t }) => {
      const hit = t.toolCalls.find((c) =>
        typeof toolName === 'string' ? c.name === toolName : toolName.test(c.name)
      )
      const nameStr = typeof toolName === 'string' ? toolName : toolName.source
      return {
        name: `forbid.toolCall(${nameStr})`,
        status: hit ? 'fail' : 'pass',
        detail: hit ? `forbidden tool called: ${hit.name}(${JSON.stringify(hit.args).slice(0, 120)})` : 'not called',
      }
    }
  },

  /** Fail if any assistant text contains the pattern */
  mentionedInText(pattern: RegExp): Judge {
    return async ({ trajectory: t }) => {
      const match = t.assistantTexts.find((s) => pattern.test(s))
      return {
        name: `forbid.mentionedInText(${pattern.source})`,
        status: match ? 'fail' : 'pass',
        detail: match ? `forbidden text: "${match.slice(0, 160)}..."` : 'not mentioned',
      }
    }
  },

  /** Fail if any of the given substrings appear in assistant text (case-insensitive) */
  substringsInText(substrings: string[]): Judge {
    return async ({ trajectory: t }) => {
      const allText = t.assistantTexts.join('\n').toLowerCase()
      const hits = substrings.filter((s) => allText.includes(s.toLowerCase()))
      return {
        name: `forbid.substringsInText([${substrings.join(', ')}])`,
        status: hits.length === 0 ? 'pass' : 'fail',
        detail: hits.length === 0 ? 'none present' : `forbidden substrings present: ${hits.join(', ')}`,
      }
    }
  },
}

// ── judge.llm ──────────────────────────────────────────────────────────────

/**
 * Lazy judge client — Kimi K2.5 via the CoAgent relay (preferred) or direct
 * Moonshot as a fallback. Built once per process and shared across probes.
 *
 * The resolution mirrors `Agent.getOpenAIClient()` so the judge sees Kimi
 * through the same path the agent under test is using.
 */
let judgeClient: OpenAI | null = null
function getJudgeClient(): OpenAI {
  if (judgeClient) return judgeClient

  // 1. Prefer the relay if it's configured — no Moonshot key on disk.
  const relay = getRelayConfig()
  if (relay) {
    judgeClient = new OpenAI({
      baseURL: `${relay.url.replace(/\/$/, '')}/v1`,
      apiKey: relay.token,
    })
    return judgeClient
  }

  // 2. Fall back to direct Moonshot for CI / no-relay setups.
  const apiKey = process.env.MOONSHOT_API_KEY
  if (!apiKey) {
    throw new Error(
      'LLM-as-judge needs Kimi credentials. Either sign into CoAgent (so ~/.coagent/.env has RELAY_URL + RELAY_TOKEN) or set MOONSHOT_API_KEY in .env.'
    )
  }
  judgeClient = new OpenAI({ baseURL: MOONSHOT_BASE_URL, apiKey })
  return judgeClient
}

export const judge = {
  /**
   * Use Kimi K2.5 to grade the trajectory against a rubric.
   * Returns pass if the grader answers "PASS" on its first line.
   */
  llm(rubric: string): Judge {
    return async ({ trajectory: t }): Promise<JudgeResult> => {
      const client = getJudgeClient()
      const trajectorySummary = formatTrajectoryForJudge(t)
      const prompt = `You are an AI researcher evaluating whether an agent's behavior matches an expected property.

## Property to evaluate
${rubric}

## Agent trajectory (tool calls + final text)
${trajectorySummary}

## Instructions
Answer on ONE line starting with either PASS or FAIL, then on subsequent lines give a 1-3 sentence explanation.
Be strict: if any part of the property is violated, answer FAIL. Err on the side of FAIL when uncertain.`

      try {
        const completion = await (client.chat.completions as any).create({
          model: JUDGE_MODEL,
          max_tokens: 300,
          messages: [
            { role: 'system', content: 'You are a strict evaluator. Output format: first line PASS or FAIL, then reasoning.' },
            { role: 'user', content: prompt },
          ],
          thinking: { type: 'disabled' },
        })
        const text = String(completion.choices?.[0]?.message?.content ?? '').trim()
        const firstLine = text.split('\n')[0].trim().toUpperCase()
        const isPass = firstLine.startsWith('PASS')
        return {
          name: `judge.llm(${rubric.slice(0, 60)}${rubric.length > 60 ? '…' : ''})`,
          status: isPass ? 'pass' : 'fail',
          detail: text.slice(0, 400),
        }
      } catch (err: any) {
        return {
          name: `judge.llm(${rubric.slice(0, 60)}${rubric.length > 60 ? '…' : ''})`,
          status: 'fail',
          detail: `judge call threw: ${err?.message ?? String(err)}`,
        }
      }
    }
  },
}

function formatTrajectoryForJudge(t: { toolCalls: Array<{ name: string; args: any; turn: number }>; finalText: string }): string {
  const calls = t.toolCalls
    .map((c, i) => `  ${i + 1}. [turn ${c.turn}] ${c.name}(${JSON.stringify(c.args).slice(0, 200)})`)
    .join('\n')
  return `Tool calls:
${calls || '  (none)'}

Final text:
"${t.finalText}"`
}
