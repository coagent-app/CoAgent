/**
 * Trajectory extractor unit tests.
 *
 * We build a fake Agent-like object with a conversationHistory that mimics
 * what the real Agent produces — sequences of assistant messages with
 * text/tool_use blocks and user messages with tool_result blocks — then
 * confirm extractTrajectory pulls out the right shape.
 */

import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { extractTrajectory, hasCall, countCalls } from '../trajectory.js'

function mkAgent(history: Anthropic.MessageParam[], systemPrompt = 'system') {
  return {
    conversationHistory: history,
    cachedSystemPrompt: systemPrompt,
  } as any
}

describe('extractTrajectory', () => {
  it('pulls tool_use blocks and text from an assistant turn', () => {
    const history: Anthropic.MessageParam[] = [
      { role: 'user', content: 'send an email to Bob' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll queue that for you." } as any,
          { type: 'tool_use', id: 'tu_1', name: 'queue_approval', input: { type: 'send_email', title: 'To Bob' } } as any,
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'queued' } as any],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Queued — approve to send.' } as any] },
    ]

    const t = extractTrajectory(mkAgent(history), 0)
    expect(t.toolCalls).toHaveLength(1)
    expect(t.toolCalls[0].name).toBe('queue_approval')
    expect(t.toolCalls[0].kind).toBe('internal')
    expect(t.toolCalls[0].args).toEqual({ type: 'send_email', title: 'To Bob' })
    expect(t.toolCalls[0].turn).toBe(1)
    expect(t.assistantTexts).toEqual(["I'll queue that for you.", 'Queued — approve to send.'])
    expect(t.finalText).toBe('Queued — approve to send.')
    expect(t.totalTurns).toBe(2)
  })

  it('unwraps call_external_tool proxy into the real external tool name', () => {
    const history: Anthropic.MessageParam[] = [
      { role: 'user', content: 'what tools do I have?' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'call_external_tool',
            input: { tool_name: 'GMAIL_SEND_EMAIL', parameters: { to: 'bob@x.com', subject: 'hi' } },
          } as any,
        ],
      },
    ]

    const t = extractTrajectory(mkAgent(history), 0)
    expect(t.toolCalls).toHaveLength(1)
    expect(t.toolCalls[0].name).toBe('GMAIL_SEND_EMAIL')
    expect(t.toolCalls[0].kind).toBe('external')
    expect(t.toolCalls[0].args).toEqual({ to: 'bob@x.com', subject: 'hi' })
    expect(t.toolCalls[0].externalToolName).toBe('GMAIL_SEND_EMAIL')
  })

  it('respects startIdx so prior seed history is ignored', () => {
    const history: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'prior seeded text' } as any] },
      { role: 'user', content: 'new question' },
      { role: 'assistant', content: [{ type: 'text', text: 'new answer' } as any] },
    ]
    const t = extractTrajectory(mkAgent(history), 1)
    expect(t.assistantTexts).toEqual(['new answer'])
    expect(t.finalText).toBe('new answer')
    expect(t.totalTurns).toBe(1)
  })
})

describe('hasCall / countCalls', () => {
  const traj = {
    toolCalls: [
      { name: 'memory', args: { action: 'search', query: 'bob' }, turn: 1, id: '1', kind: 'internal' as const },
      { name: 'memory', args: { action: 'read', file: 'user_role.md' }, turn: 1, id: '2', kind: 'internal' as const },
      { name: 'schedule', args: { action: 'list' }, turn: 2, id: '3', kind: 'internal' as const },
    ],
    assistantTexts: [],
    finalText: '',
    totalTurns: 2,
    history: [],
    systemPrompt: '',
  }

  it('countCalls counts by exact name', () => {
    expect(countCalls(traj, 'memory')).toBe(2)
    expect(countCalls(traj, 'schedule')).toBe(1)
    expect(countCalls(traj, 'nope')).toBe(0)
  })

  it('hasCall with regex name matches', () => {
    expect(hasCall(traj, /mem|sched/)).toBe(true)
  })

  it('hasCall with argsMatcher filters by args', () => {
    expect(hasCall(traj, 'memory', (a) => a.action === 'search')).toBe(true)
    expect(hasCall(traj, 'memory', (a) => a.action === 'write')).toBe(false)
  })
})
