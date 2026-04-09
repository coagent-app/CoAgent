/**
 * Judge factory unit tests — no live LLM calls.
 *
 * We feed each judge a hand-crafted Trajectory + FinalState and assert it
 * emits the right pass/fail with the right detail. judge.llm() is NOT
 * covered here because it requires Kimi; it's smoke-tested by the first
 * probe run against real Kimi.
 */

import { describe, it, expect } from 'vitest'
import { trajectory, state, forbid } from '../judges.js'
import type { Trajectory, FinalState } from '../types.js'

function mkTraj(over: Partial<Trajectory> = {}): Trajectory {
  return {
    toolCalls: [],
    assistantTexts: [],
    finalText: '',
    totalTurns: 0,
    history: [],
    systemPrompt: '',
    ...over,
  }
}

function mkState(over: Partial<FinalState> = {}): FinalState {
  return {
    queue: [],
    memoryFiles: [],
    memoryContents: {},
    dataDir: '/tmp/test',
    ...over,
  }
}

describe('trajectory.contains', () => {
  it('passes when the named tool is called', async () => {
    const t = mkTraj({
      toolCalls: [{ name: 'queue_approval', args: { type: 'send_email' }, turn: 1, id: 't1', kind: 'internal' }],
    })
    const r = await trajectory.contains('queue_approval')({ trajectory: t, finalState: mkState() })
    expect(r.status).toBe('pass')
  })

  it('fails when the tool is absent', async () => {
    const t = mkTraj({
      toolCalls: [{ name: 'memory', args: {}, turn: 1, id: 't1', kind: 'internal' }],
    })
    const r = await trajectory.contains('queue_approval')({ trajectory: t, finalState: mkState() })
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('no call to queue_approval')
  })

  it('supports regex tool names', async () => {
    const t = mkTraj({
      toolCalls: [{ name: 'GMAIL_SEND_EMAIL', args: {}, turn: 1, id: 't1', kind: 'external' }],
    })
    const r = await trajectory.contains(/SEND_EMAIL/)({ trajectory: t, finalState: mkState() })
    expect(r.status).toBe('pass')
  })

  it('supports shape-match args with regex values', async () => {
    const t = mkTraj({
      toolCalls: [{ name: 'queue_approval', args: { type: 'send_email', title: 'Draft to Bob' }, turn: 1, id: 't1', kind: 'internal' }],
    })
    const pass = await trajectory.contains('queue_approval', { title: /bob/i })({ trajectory: t, finalState: mkState() })
    const fail = await trajectory.contains('queue_approval', { title: /alice/i })({ trajectory: t, finalState: mkState() })
    expect(pass.status).toBe('pass')
    expect(fail.status).toBe('fail')
  })

  it('supports predicate matchers', async () => {
    const t = mkTraj({
      toolCalls: [{ name: 'queue_approval', args: { detail: 'long email body' }, turn: 1, id: 't1', kind: 'internal' }],
    })
    const r = await trajectory.contains('queue_approval', (a) => String(a.detail).length > 5)({
      trajectory: t,
      finalState: mkState(),
    })
    expect(r.status).toBe('pass')
  })
})

describe('trajectory.order', () => {
  it('passes when order is satisfied even with extra calls between', async () => {
    const t = mkTraj({
      toolCalls: [
        { name: 'get_current_time', args: {}, turn: 1, id: '1', kind: 'internal' },
        { name: 'memory', args: {}, turn: 1, id: '2', kind: 'internal' },
        { name: 'schedule', args: {}, turn: 2, id: '3', kind: 'internal' },
      ],
    })
    const r = await trajectory.order(['get_current_time', 'schedule'])({ trajectory: t, finalState: mkState() })
    expect(r.status).toBe('pass')
  })

  it('fails when order is reversed', async () => {
    const t = mkTraj({
      toolCalls: [
        { name: 'schedule', args: {}, turn: 1, id: '1', kind: 'internal' },
        { name: 'get_current_time', args: {}, turn: 2, id: '2', kind: 'internal' },
      ],
    })
    const r = await trajectory.order(['get_current_time', 'schedule'])({ trajectory: t, finalState: mkState() })
    expect(r.status).toBe('fail')
  })
})

describe('trajectory.finalTextWordsAtMost', () => {
  it('passes at exactly the cap', async () => {
    const t = mkTraj({ finalText: 'one two three four five' })
    const r = await trajectory.finalTextWordsAtMost(5)({ trajectory: t, finalState: mkState() })
    expect(r.status).toBe('pass')
  })

  it('fails when above cap', async () => {
    const t = mkTraj({ finalText: 'one two three four five six' })
    const r = await trajectory.finalTextWordsAtMost(5)({ trajectory: t, finalState: mkState() })
    expect(r.status).toBe('fail')
  })
})

describe('trajectory.parallelCallsOnTurn', () => {
  it('passes when a single turn has enough parallel calls', async () => {
    const t = mkTraj({
      toolCalls: [
        { name: 'a', args: {}, turn: 1, id: '1', kind: 'internal' },
        { name: 'b', args: {}, turn: 1, id: '2', kind: 'internal' },
        { name: 'c', args: {}, turn: 2, id: '3', kind: 'internal' },
      ],
    })
    const r = await trajectory.parallelCallsOnTurn(2)({ trajectory: t, finalState: mkState() })
    expect(r.status).toBe('pass')
  })

  it('fails when calls are spread across turns', async () => {
    const t = mkTraj({
      toolCalls: [
        { name: 'a', args: {}, turn: 1, id: '1', kind: 'internal' },
        { name: 'b', args: {}, turn: 2, id: '2', kind: 'internal' },
      ],
    })
    const r = await trajectory.parallelCallsOnTurn(2)({ trajectory: t, finalState: mkState() })
    expect(r.status).toBe('fail')
  })
})

describe('state.queue', () => {
  it('hasLength passes on exact match', async () => {
    const s = mkState({ queue: [{ id: '1', type: 'send_email', title: 'x', description: '', detail: '' }] })
    const r = await state.queue.hasLength(1)({ trajectory: mkTraj(), finalState: s })
    expect(r.status).toBe('pass')
  })

  it('anyMatches finds by predicate', async () => {
    const s = mkState({
      queue: [
        { id: '1', type: 'send_email', title: 'Reply to Bob about lease', description: '', detail: 'Hi Bob, attached is the signed lease.' },
      ],
    })
    const r = await state.queue.anyMatches(
      (item) => item.type === 'send_email' && /bob/i.test(item.title),
      'send_email to bob'
    )({ trajectory: mkTraj(), finalState: s })
    expect(r.status).toBe('pass')
  })

  it('anyMatches fails cleanly with a helpful detail', async () => {
    const s = mkState({ queue: [{ id: '1', type: 'send_email', title: 'Different', description: '', detail: '' }] })
    const r = await state.queue.anyMatches((item) => item.title === 'Missing', 'missing title')({
      trajectory: mkTraj(),
      finalState: s,
    })
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('no queue item matched')
  })
})

describe('state.memory', () => {
  it('fileExists finds the file', async () => {
    const s = mkState({ memoryFiles: ['user_role.md'] })
    const r = await state.memory.fileExists('user_role.md')({ trajectory: mkTraj(), finalState: s })
    expect(r.status).toBe('pass')
  })

  it('fileMatches returns fail when file is missing', async () => {
    const s = mkState()
    const r = await state.memory.fileMatches('x.md', /foo/)({ trajectory: mkTraj(), finalState: s })
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('not found')
  })

  it('fileMatches returns pass when content matches', async () => {
    const s = mkState({ memoryFiles: ['x.md'], memoryContents: { 'x.md': 'hello world' } })
    const r = await state.memory.fileMatches('x.md', /hello/)({ trajectory: mkTraj(), finalState: s })
    expect(r.status).toBe('pass')
  })
})

describe('forbid', () => {
  it('forbid.toolCall passes when the tool was not called', async () => {
    const t = mkTraj({ toolCalls: [{ name: 'memory', args: {}, turn: 1, id: '1', kind: 'internal' }] })
    const r = await forbid.toolCall('GMAIL_SEND_EMAIL')({ trajectory: t, finalState: mkState() })
    expect(r.status).toBe('pass')
  })

  it('forbid.toolCall fails loudly when the tool WAS called', async () => {
    const t = mkTraj({
      toolCalls: [{ name: 'GMAIL_SEND_EMAIL', args: { to: 'bob@x.com' }, turn: 1, id: '1', kind: 'external' }],
    })
    const r = await forbid.toolCall('GMAIL_SEND_EMAIL')({ trajectory: t, finalState: mkState() })
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('forbidden tool called')
  })

  it('forbid.substringsInText finds any forbidden substring (case-insensitive)', async () => {
    const t = mkTraj({ assistantTexts: ["Let me think... I'll draft something."] })
    const r = await forbid.substringsInText(['let me think', 'LET ME'])({
      trajectory: t,
      finalState: mkState(),
    })
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('let me think')
  })

  it('forbid.mentionedInText passes when pattern is absent', async () => {
    const t = mkTraj({ assistantTexts: ['Sounds good.'] })
    const r = await forbid.mentionedInText(/placeholder|TBD/i)({ trajectory: t, finalState: mkState() })
    expect(r.status).toBe('pass')
  })
})
