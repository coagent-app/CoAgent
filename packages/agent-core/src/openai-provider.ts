/**
 * OpenAI-compatible provider for non-Anthropic models (via OpenRouter, etc.)
 *
 * Translates between Anthropic's internal message format and OpenAI's chat completions format.
 * Used when the selected model is not a Claude model.
 */
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

// ── Format Translation: Anthropic → OpenAI ──

/** Convert Anthropic tools to OpenAI function tools */
export function translateTools(tools: Anthropic.Tool[]): OpenAI.ChatCompletionTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema as Record<string, unknown>,
    },
  }))
}

/** Convert Anthropic messages to OpenAI messages */
export function translateMessages(
  system: string,
  messages: Anthropic.MessageParam[]
): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
  ]

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      // Assistant messages may have text + tool_use + thinking blocks
      const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text' as const, text: String(msg.content) }]
      const textParts = content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('')
      const toolUses = content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[]
      // Preserve reasoning_content from Kimi thinking blocks for round-trip
      const thinkingBlock = content.find(b => (b as any).type === 'thinking') as any
      const reasoningContent = thinkingBlock?.thinking || undefined

      const assistantMsg: any = { role: 'assistant' }
      if (reasoningContent) assistantMsg.reasoning_content = reasoningContent

      if (toolUses.length > 0) {
        assistantMsg.content = textParts || null
        assistantMsg.tool_calls = toolUses.map(tu => ({
          id: tu.id,
          type: 'function' as const,
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input),
          },
        }))
      } else {
        assistantMsg.content = textParts
      }
      out.push(assistantMsg)
    } else if (msg.role === 'user') {
      const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text' as const, text: String(msg.content) }]

      // Check if this is a tool_result message
      const toolResults = content.filter(b => (b as any).type === 'tool_result') as Anthropic.ToolResultBlockParam[]
      const textParts = content.filter(b => (b as any).type === 'text') as Anthropic.TextBlockParam[]

      if (toolResults.length > 0) {
        // Each tool_result becomes a separate 'tool' message in OpenAI format
        for (const tr of toolResults) {
          const resultContent = typeof tr.content === 'string'
            ? tr.content
            : Array.isArray(tr.content)
              ? tr.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('')
              : ''
          out.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: resultContent,
          })
        }
        // If there's also text content alongside tool results, add as user message
        if (textParts.length > 0) {
          out.push({ role: 'user', content: textParts.map(t => t.text).join('\n') })
        }
      } else {
        // Regular user message — handle text and images
        const parts: OpenAI.ChatCompletionContentPart[] = []
        for (const block of content) {
          if ((block as any).type === 'text') {
            parts.push({ type: 'text', text: (block as any).text })
          } else if ((block as any).type === 'image') {
            const img = block as any
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${img.source.media_type};base64,${img.source.data}` },
            })
          }
        }
        if (parts.length === 1 && parts[0].type === 'text') {
          out.push({ role: 'user', content: parts[0].text })
        } else if (parts.length > 0) {
          out.push({ role: 'user', content: parts })
        }
      }
    }
  }

  // ── Safety net: deduplicate tool_call IDs for OpenAI compatibility ──
  const seenToolCallIds = new Set<string>()
  for (let i = 0; i < out.length; i++) {
    const msg = out[i] as any
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (seenToolCallIds.has(tc.id)) {
          const oldId = tc.id
          const newId = `${oldId}_dedup_${Math.random().toString(36).slice(2, 8)}`
          tc.id = newId
          // Find and rename the matching tool response message
          for (let j = i + 1; j < out.length; j++) {
            const resp = out[j] as any
            if (resp.role === 'tool' && resp.tool_call_id === oldId) {
              resp.tool_call_id = newId
              break
            }
          }
        }
        seenToolCallIds.add(tc.id)
      }
    }
  }

  // ── Validate: every tool_call has a matching tool response ──
  const allToolCallIds = new Set<string>()
  const allToolResponseIds = new Set<string>()
  for (const msg of out as any[]) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) allToolCallIds.add(tc.id)
    }
    if (msg.role === 'tool') allToolResponseIds.add(msg.tool_call_id)
  }
  const orphanedCalls = [...allToolCallIds].filter(id => !allToolResponseIds.has(id))
  if (orphanedCalls.length > 0) {
    console.error(`[translateMessages] ORPHANED tool_calls (no response): ${orphanedCalls.join(', ')}`)
    // Remove assistant messages that have orphaned tool_calls to prevent 400
    for (let i = out.length - 1; i >= 0; i--) {
      const msg = out[i] as any
      if (msg.role === 'assistant' && msg.tool_calls) {
        const hasOrphan = msg.tool_calls.some((tc: any) => orphanedCalls.includes(tc.id))
        if (hasOrphan) {
          // Strip the tool_calls, keep only text content
          if (msg.content) {
            delete msg.tool_calls
          } else {
            out.splice(i, 1)
          }
          console.log(`[translateMessages] Stripped orphaned tool_calls from assistant msg at index ${i}`)
        }
      }
    }
  }

  return out
}

// ── Format Translation: OpenAI → Anthropic ──

/** Convert OpenAI response to Anthropic-like response shape */
export function translateResponse(completion: OpenAI.ChatCompletion): {
  content: Anthropic.ContentBlock[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens'
  usage: { input_tokens: number; output_tokens: number }
} {
  const choice = completion.choices[0]
  const content: Anthropic.ContentBlock[] = []

  // Add text content
  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content } as Anthropic.TextBlock)
  }

  // Add tool calls
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      if (tc.type !== 'function') continue
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(tc.function.arguments) } catch { /* malformed args */ }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      } as Anthropic.ToolUseBlock)
    }
  }

  // Map finish_reason
  let stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn'
  if (choice.finish_reason === 'tool_calls') stop_reason = 'tool_use'
  else if (choice.finish_reason === 'length') stop_reason = 'max_tokens'

  return {
    content,
    stop_reason,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  }
}

/** Convert a streaming OpenAI response to Anthropic-like shape, calling onChunk for text deltas */
export async function streamOpenAI(
  client: OpenAI,
  params: {
    model: string
    system: string
    messages: Anthropic.MessageParam[]
    tools: Anthropic.Tool[]
    maxTokens: number
  },
  onChunk?: (text: string) => void,
  signal?: AbortSignal,
): Promise<{
  content: Anthropic.ContentBlock[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens'
  usage: { input_tokens: number; output_tokens: number; cached_tokens?: number }
}> {
  const openaiMessages = translateMessages(params.system, params.messages)
  const openaiTools = params.tools.length > 0 ? translateTools(params.tools) : undefined

  const createParams: Record<string, any> = {
    model: params.model,
    max_tokens: params.maxTokens,
    messages: openaiMessages,
    tools: openaiTools,
    stream: true,
    stream_options: { include_usage: true },
  }
  // Kimi K2.5 has thinking enabled by default — disable to save tokens
  if (params.model.startsWith('kimi')) {
    createParams.thinking = { type: 'disabled' }
  }
  const stream = await (client.chat.completions as any).create(createParams, { signal })

  // Accumulate the full response from stream deltas
  let textContent = ''
  let reasoningContent = ''
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
  let finishReason: string | null = null
  let promptTokens = 0
  let completionTokens = 0
  let cachedTokens = 0

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta as any
    if (!delta) {
      // Usage chunk (final)
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? 0
        completionTokens = chunk.usage.completion_tokens ?? 0
        // Moonshot returns cached_tokens for auto-cached prefixes
        cachedTokens = (chunk.usage as any).cached_tokens ?? (chunk.usage as any).prompt_tokens_details?.cached_tokens ?? 0
      }
      continue
    }

    // Reasoning content (Kimi thinking)
    if (delta.reasoning_content) {
      reasoningContent += delta.reasoning_content
    }

    // Text content
    if (delta.content) {
      textContent += delta.content
      onChunk?.(delta.content)
    }

    // Tool call deltas
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index
        if (!toolCalls.has(idx)) {
          toolCalls.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' })
        }
        const existing = toolCalls.get(idx)!
        if (tc.id) existing.id = tc.id
        if (tc.function?.name) existing.name = tc.function.name
        if (tc.function?.arguments) existing.arguments += tc.function.arguments
      }
    }

    if (chunk.choices?.[0]?.finish_reason) {
      finishReason = chunk.choices[0].finish_reason
    }
  }

  // Build Anthropic-compatible content blocks
  const content: Anthropic.ContentBlock[] = []
  // Preserve reasoning_content as a 'thinking' block for round-trip fidelity
  if (reasoningContent) {
    content.push({ type: 'thinking', thinking: reasoningContent } as any)
  }
  if (textContent) {
    content.push({ type: 'text', text: textContent } as Anthropic.TextBlock)
  }
  for (const [, tc] of toolCalls) {
    let input: Record<string, unknown> = {}
    try { input = JSON.parse(tc.arguments) } catch { /* malformed */ }
    // Kimi reuses tool_call IDs like "tool_name:N" across different API calls.
    // Append a random suffix to make IDs globally unique across the conversation,
    // preventing orphaned tool_call errors when the same ID appears in multiple turns.
    const uniqueId = tc.id ? `${tc.id}_${Math.random().toString(36).slice(2, 8)}` : `tc_${Math.random().toString(36).slice(2, 10)}`
    content.push({
      type: 'tool_use',
      id: uniqueId,
      name: tc.name,
      input,
    } as Anthropic.ToolUseBlock)
  }

  let stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn'
  if (finishReason === 'tool_calls') stop_reason = 'tool_use'
  else if (finishReason === 'length') stop_reason = 'max_tokens'

  return {
    content,
    stop_reason,
    usage: { input_tokens: promptTokens, output_tokens: completionTokens, cached_tokens: cachedTokens },
  }
}
