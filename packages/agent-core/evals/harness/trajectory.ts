/**
 * Trajectory extraction — read the real Agent's conversationHistory after
 * chat() returns and reconstruct a probe-friendly record of what the model did.
 *
 * This is "free" because the Agent already stores every tool_use + tool_result
 * block in history. We don't need to monkey-patch the loop or add callbacks.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { Agent } from '../../src/agent.js'
import type { Trajectory, ToolCall } from './types.js'

/**
 * Pull a Trajectory out of a completed Agent run.
 * `startIdx` is the length of conversationHistory BEFORE the probe's user message
 * was added — so we only capture what the agent did during this run, not any
 * seed history we may have populated.
 */
export function extractTrajectory(agent: Agent, startIdx: number): Trajectory {
  // The Agent's history is private, so reach into it via the public getter/cast.
  // Agent exposes `getChatHistory()` but that strips tool_use blocks — we need the raw one.
  // `(agent as any).conversationHistory` is the authoritative source.
  const history = ((agent as any).conversationHistory as Anthropic.MessageParam[]) ?? []
  const slice = history.slice(startIdx)

  const toolCalls: ToolCall[] = []
  const assistantTexts: string[] = []
  let turn = 0
  let lastAssistantText = ''

  for (const msg of slice) {
    if (msg.role === 'assistant') {
      turn++
      const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content) }]
      for (const block of content as any[]) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          assistantTexts.push(block.text)
          lastAssistantText = block.text
        } else if (block.type === 'tool_use') {
          const input = (block.input ?? {}) as Record<string, unknown>
          // Detect the call_external_tool proxy pattern — the real external
          // tool name is in `tool_name` and the args live under `parameters`.
          if (block.name === 'call_external_tool') {
            const extName = typeof input.tool_name === 'string' ? input.tool_name : 'unknown'
            const extArgs = (input.parameters ?? {}) as Record<string, unknown>
            toolCalls.push({
              name: extName,
              args: extArgs,
              turn,
              id: String(block.id),
              kind: 'external',
              externalToolName: extName,
            })
          } else {
            toolCalls.push({
              name: String(block.name),
              args: input,
              turn,
              id: String(block.id),
              kind: 'internal',
            })
          }
        }
      }
    }
  }

  // Pull the cached system prompt from the agent — this is the exact string
  // buildSystemPrompt() produced for this run. If the agent cache was bypassed
  // for some reason, this will be null; the probe runner handles that case.
  const systemPrompt = ((agent as any).cachedSystemPrompt as string | null) ?? ''

  return {
    toolCalls,
    assistantTexts,
    finalText: lastAssistantText,
    totalTurns: turn,
    history: slice,
    systemPrompt,
  }
}

/** Walk a trajectory and count tool calls by name — handy for judges */
export function countCalls(trajectory: Trajectory, toolName: string): number {
  return trajectory.toolCalls.filter((c) => c.name === toolName).length
}

/** Does the trajectory contain a call to `toolName` matching the given args? */
export function hasCall(
  trajectory: Trajectory,
  toolName: string | RegExp,
  argsMatcher?: (args: Record<string, unknown>) => boolean
): boolean {
  return trajectory.toolCalls.some((c) => {
    const nameMatch = typeof toolName === 'string' ? c.name === toolName : toolName.test(c.name)
    if (!nameMatch) return false
    if (!argsMatcher) return true
    try {
      return argsMatcher(c.args)
    } catch {
      return false
    }
  })
}
