// packages/agent-core/src/sub-agent.ts
// General-purpose sub-agent runner — read-only tool access, no external side effects

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { MCPManager } from './mcp-manager.js'
import { recordUsage } from './usage-tracker.js'
import { streamOpenAI } from './openai-provider.js'

const KIMI_MODEL = 'kimi-k2.5'
const MAX_TOOL_LOOPS = 10

// Tools sub-agents are NOT allowed to use — anything with external side effects
const BLOCKED_TOOLS = new Set([
  'queue_approval',
  'notify_user',
  'call_external_tool',
  'send_team_message',
  'update_settings',
  'add_done_item',
  'create_custom_integration',
  'research',       // no recursion
  'spawn_agents',   // no recursion
])

// Memory actions sub-agents CAN use (read + write to memory, but not delete)
const ALLOWED_MEMORY_ACTIONS = new Set(['search', 'read', 'write', 'append', 'edit', 'list'])

// Schedule actions — read only
const ALLOWED_SCHEDULE_ACTIONS = new Set(['list'])

// Files actions — read only
const ALLOWED_FILES_ACTIONS = new Set(['list', 'read', 'search'])

const SUB_AGENT_SYSTEM = `You are a focused sub-agent working on a specific task. Complete the task thoroughly and return your results.

You have access to tools for searching the web (exa), reading/writing memory, reading files, creating documents, and checking the time. You CANNOT send emails, queue approvals, notify the user, or perform external actions — you are read-only for external systems.

Be thorough but concise in your output. Return actionable results the main agent can use.`

export interface SubAgentTask {
  label: string
  instruction: string
}

export interface SubAgentProgress {
  label: string
  status: 'running' | 'done' | 'error'
  detail?: string
}

export async function runSubAgents(
  tasks: SubAgentTask[],
  client: OpenAI | Anthropic,
  internalTools: Anthropic.Tool[],
  mcpManager: MCPManager,
  toolExecutor: (name: string, input: Record<string, unknown>) => Promise<string>,
  dataDir?: string,
  onProgress?: (progress: SubAgentProgress[]) => void,
): Promise<string> {
  const capped = tasks.slice(0, 5)
  console.log(`[SubAgent] Spawning ${capped.length} sub-agents:`, capped.map(t => t.label))

  const progressState: SubAgentProgress[] = capped.map(t => ({
    label: t.label, status: 'running' as const
  }))
  onProgress?.(progressState)

  // Filter tools to read-only set
  const safeTools = internalTools.filter(t => !BLOCKED_TOOLS.has(t.name))

  const results = await Promise.all(
    capped.map((task, i) => runSingle(task, client, safeTools, mcpManager, toolExecutor, dataDir, (p) => {
      progressState[i] = p
      onProgress?.(progressState)
    }))
  )

  const combined = results
    .map((r, i) => `### ${capped[i].label}\n${r}`)
    .join('\n\n---\n\n')

  console.log(`[SubAgent] All ${capped.length} done — ${combined.length} chars total`)
  return combined
}

async function runSingle(
  task: SubAgentTask,
  client: OpenAI | Anthropic,
  tools: Anthropic.Tool[],
  mcpManager: MCPManager,
  toolExecutor: (name: string, input: Record<string, unknown>) => Promise<string>,
  dataDir?: string,
  onProgress?: (p: SubAgentProgress) => void,
): Promise<string> {
  const isOpenAI = client instanceof OpenAI
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: task.instruction }
  ]

  // Also include exa tools (from MCP)
  const { tools: allMcpTools } = await mcpManager.getAllTools()
  const exaTools = allMcpTools.filter(t => t.name === 'exa')
  const allTools = [...tools, ...exaTools]

  console.log(`[SubAgent:${task.label}] Starting with ${allTools.length} tools via ${isOpenAI ? 'Kimi' : 'Claude'}`)

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    try {
      let res: {
        content: Anthropic.ContentBlock[]
        stop_reason: string | null
        usage: { input_tokens: number; output_tokens: number }
      }

      if (isOpenAI) {
        res = await streamOpenAI(client, {
          model: KIMI_MODEL,
          system: SUB_AGENT_SYSTEM,
          messages,
          tools: allTools,
          maxTokens: 4096,
        })
      } else {
        res = await (client as Anthropic).messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          system: SUB_AGENT_SYSTEM,
          tools: allTools as any,
          messages: messages as any,
        } as any)
      }

      if (dataDir && res.usage) {
        recordUsage(dataDir, {
          timestamp: new Date().toISOString(),
          model: isOpenAI ? KIMI_MODEL : 'claude-haiku-4-5-20251001',
          inputTokens: res.usage.input_tokens || 0,
          outputTokens: res.usage.output_tokens || 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          category: 'chat',
        }).catch(() => {})
      }

      // Done — return text
      if (res.stop_reason === 'end_turn') {
        const text = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map(b => b.text).join('\n')
        onProgress?.({ label: task.label, status: 'done', detail: `${text.length} chars` })
        console.log(`[SubAgent:${task.label}] Done: ${text.length} chars`)
        return text
      }

      // Tool calls
      if (res.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: res.content })

        const toolBlocks = res.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
        )

        // Guard: reject any blocked tools that slipped through
        const resultBlocks: Anthropic.ToolResultBlockParam[] = []
        for (const block of toolBlocks) {
          if (BLOCKED_TOOLS.has(block.name)) {
            resultBlocks.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error: sub-agents cannot use ${block.name}. This tool has external side effects.`,
              is_error: true,
            })
            continue
          }

          // Enforce read-only for schedule/files
          const inp = block.input as Record<string, unknown>
          if (block.name === 'schedule' && !ALLOWED_SCHEDULE_ACTIONS.has(inp.action as string)) {
            resultBlocks.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error: sub-agents can only list schedule entries, not modify them.`,
              is_error: true,
            })
            continue
          }
          if (block.name === 'files' && !ALLOWED_FILES_ACTIONS.has(inp.action as string)) {
            resultBlocks.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error: sub-agents can only read/list/search files, not modify them.`,
              is_error: true,
            })
            continue
          }

          try {
            const toolResult = await toolExecutor(block.name, block.input as Record<string, unknown>)
            resultBlocks.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: toolResult,
            })
          } catch (err: any) {
            resultBlocks.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error: ${err.message}`,
              is_error: true,
            })
          }
        }

        messages.push({ role: 'user', content: resultBlocks })
        onProgress?.({ label: task.label, status: 'running', detail: `loop ${loop + 1}` })
        continue
      }

      break
    } catch (err: any) {
      console.error(`[SubAgent:${task.label}] Error:`, err.message)
      onProgress?.({ label: task.label, status: 'error', detail: err.message })
      return `Error: ${err.message}`
    }
  }

  onProgress?.({ label: task.label, status: 'done', detail: 'max loops' })
  return `Sub-agent "${task.label}" did not complete within ${MAX_TOOL_LOOPS} tool loops.`
}
