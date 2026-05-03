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

  // ── Sanitize tool_call_ids to match safe alphanumeric+dash form ──
  // Kimi reuses raw IDs like "memory:1" across requests. The colon survives in
  // some upstream paths and OpenAI's API accepts them but then the relay/Kimi
  // sometimes echoes a fresh "memory:N" while a sanitized "memory-N" is in
  // history, breaking call/response pairing. Normalize both sides here.
  const sanitizeId = (id: string): string =>
    id.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'tc'
  const idRemap = new Map<string, string>()
  for (const msg of out as any[]) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.id && /[^a-zA-Z0-9-]/.test(tc.id)) {
          const clean = idRemap.get(tc.id) ?? sanitizeId(tc.id)
          idRemap.set(tc.id, clean)
          tc.id = clean
        }
      }
    }
    if (msg.role === 'tool' && msg.tool_call_id) {
      if (idRemap.has(msg.tool_call_id)) {
        msg.tool_call_id = idRemap.get(msg.tool_call_id)!
      } else if (/[^a-zA-Z0-9-]/.test(msg.tool_call_id)) {
        msg.tool_call_id = sanitizeId(msg.tool_call_id)
      }
    }
  }

  // ── Deduplicate tool_call IDs ──
  const seenToolCallIds = new Set<string>()
  for (let i = 0; i < out.length; i++) {
    const msg = out[i] as any
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (seenToolCallIds.has(tc.id)) {
          const oldId = tc.id
          const newId = `${oldId}-dd-${Math.random().toString(36).slice(2, 8)}`
          tc.id = newId
          // Find and rename the matching tool response message (first one after this assistant)
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

  // ── Strict bidirectional orphan handling ──
  // Iterate until stable: removing one orphan can expose others.
  // Handles BOTH directions:
  //   1. assistant tool_call with no following tool response → strip just that call
  //   2. role:'tool' message with no preceding assistant tool_call → drop the message
  // Surgical: only the offending call is removed; sibling tool_calls + content stay.
  for (let pass = 0; pass < 10; pass++) {
    const callIds = new Set<string>()
    const respIds = new Set<string>()
    for (const msg of out as any[]) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) callIds.add(tc.id)
      }
      if (msg.role === 'tool') respIds.add(msg.tool_call_id)
    }
    const orphanCalls = new Set([...callIds].filter(id => !respIds.has(id)))
    const orphanResps = new Set([...respIds].filter(id => !callIds.has(id)))

    if (orphanCalls.size === 0 && orphanResps.size === 0) break

    if (orphanCalls.size > 0) {
      console.error(`[translateMessages] orphan tool_calls (no response): ${[...orphanCalls].join(', ')}`)
    }
    if (orphanResps.size > 0) {
      console.error(`[translateMessages] orphan tool responses (no call): ${[...orphanResps].join(', ')}`)
    }

    for (let i = out.length - 1; i >= 0; i--) {
      const msg = out[i] as any
      // Strip orphan responses
      if (msg.role === 'tool' && orphanResps.has(msg.tool_call_id)) {
        out.splice(i, 1)
        continue
      }
      // Surgically strip only orphan tool_calls from assistant messages
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        const kept = msg.tool_calls.filter((tc: any) => !orphanCalls.has(tc.id))
        if (kept.length === 0) {
          if (msg.content) {
            delete msg.tool_calls
          } else {
            out.splice(i, 1)
          }
        } else if (kept.length !== msg.tool_calls.length) {
          msg.tool_calls = kept
        }
      }
    }
  }

  // ── Final assertion: structure must be valid for OpenAI API ──
  const finalCallIds = new Set<string>()
  const finalRespIds = new Set<string>()
  for (const msg of out as any[]) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) finalCallIds.add(tc.id)
    }
    if (msg.role === 'tool') finalRespIds.add(msg.tool_call_id)
  }
  const stillOrphanCalls = [...finalCallIds].filter(id => !finalRespIds.has(id))
  const stillOrphanResps = [...finalRespIds].filter(id => !finalCallIds.has(id))
  if (stillOrphanCalls.length > 0 || stillOrphanResps.length > 0) {
    console.error(`[translateMessages] FATAL: orphans survived sanitize`, { stillOrphanCalls, stillOrphanResps })
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

/**
 * Fired whenever a tool call's arguments grow by a chunk during streaming.
 * `argsSoFar` is the full accumulated (and possibly still-partial) JSON string.
 * `toolCallId` is the provider-issued id, which the agent layer may remap.
 */
export type ToolArgsDeltaHandler = (args: {
  toolName: string
  toolCallId: string
  argsSoFar: string
}) => void

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
  onToolArgsDelta?: ToolArgsDeltaHandler,
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
  console.log(`[OpenAI] Request: model=${createParams.model}, max_tokens=${createParams.max_tokens}, thinking=${JSON.stringify(createParams.thinking ?? 'none')}`)
  const stream = await (client.chat.completions as any).create(createParams, { signal })

  // Accumulate the full response from stream deltas
  let textContent = ''
  let reasoningContent = ''
  const toolCalls = new Map<number, { id: string; name: string; arguments: string; uniqueId?: string }>()
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
      if (reasoningContent.length === delta.reasoning_content.length) {
        console.log(`[OpenAI] ⚠️ Kimi IS sending reasoning tokens despite thinking=disabled`)
      }
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
        // Stabilize the uniqueId as soon as we have an id/name — reused for
        // both streaming callbacks and the final tool_use block so IDs match.
        if (!existing.uniqueId && (existing.id || existing.name)) {
          const sanitized = (existing.id || '').replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || `idx-${idx}`
          existing.uniqueId = `${sanitized}-${Math.random().toString(36).slice(2, 10)}`
        }
        if (tc.function?.arguments) {
          existing.arguments += tc.function.arguments
          if (onToolArgsDelta && existing.name) {
            try {
              onToolArgsDelta({
                toolName: existing.name,
                toolCallId: existing.uniqueId || `idx_${idx}`,
                argsSoFar: existing.arguments,
              })
            } catch (err) {
              console.error('[streamOpenAI] onToolArgsDelta error:', err)
            }
          }
        }
      }
    }

    if (chunk.choices?.[0]?.finish_reason) {
      finishReason = chunk.choices[0].finish_reason
    }
  }

  console.log(`[OpenAI] Response done: text=${textContent.length} chars, reasoning=${reasoningContent.length} chars, prompt=${promptTokens}, completion=${completionTokens}, cached=${cachedTokens}, finish=${finishReason}`)
  if (reasoningContent.length > 0) {
    console.log(`[OpenAI] ⚠️ Reasoning tokens received (${reasoningContent.length} chars) — thinking disable flag may not be working`)
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
  for (const [idx, tc] of toolCalls) {
    let input: Record<string, unknown> = {}
    try { input = JSON.parse(tc.arguments) } catch { /* malformed */ }
    // Use the uniqueId stabilized during streaming so streaming callbacks
    // and the final tool_use block share the same id. Kimi reuses raw
    // tool_call IDs like "tool_name:N" across calls, so the random suffix
    // keeps them globally unique and prevents orphaned tool_call errors.
    // IDs must match ^[a-zA-Z0-9-]+ for Anthropic API compatibility.
    const uniqueId = tc.uniqueId || (() => {
      const sanitized = (tc.id || '').replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || `idx-${idx}`
      return `${sanitized}-${Math.random().toString(36).slice(2, 10)}`
    })()
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
