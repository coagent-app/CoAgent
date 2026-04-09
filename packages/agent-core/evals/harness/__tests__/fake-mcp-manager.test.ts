/**
 * FakeMCPManager unit tests — exercise the drop-in fake without booting a
 * real Agent. We just need to confirm:
 *   - getAllTools returns the probe-supplied schema with a correct serverMap
 *   - callTool records every invocation and dispatches to the right handler
 *   - unknown tool names return a tool_not_found stub (not a throw)
 *   - isConnected reports servers in the fake config as connected
 */

import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { FakeMCPManager } from '../fake-mcp-manager.js'
import type { FakeTool } from '../types.js'

function mkTool(name: string, server: string, respond?: FakeTool['respond']): FakeTool {
  const definition: Anthropic.Tool = {
    name,
    description: `fake ${name}`,
    input_schema: { type: 'object', properties: {}, required: [] },
  }
  return { server, definition, respond }
}

describe('FakeMCPManager', () => {
  it('getAllTools returns tools with a populated serverMap', async () => {
    const m = new FakeMCPManager([mkTool('GMAIL_SEND_EMAIL', 'gmail'), mkTool('SLACK_POST_MESSAGE', 'slack')])
    const { tools, serverMap } = await m.getAllTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['GMAIL_SEND_EMAIL', 'SLACK_POST_MESSAGE'])
    expect(serverMap.get('GMAIL_SEND_EMAIL')).toBe('gmail')
    expect(serverMap.get('SLACK_POST_MESSAGE')).toBe('slack')
  })

  it('isConnected reflects the configured servers', () => {
    const m = new FakeMCPManager([mkTool('GMAIL_SEND_EMAIL', 'gmail')])
    expect(m.isConnected('gmail')).toBe(true)
    expect(m.isConnected('slack')).toBe(false)
  })

  it('callTool records each invocation and dispatches to the respond handler', async () => {
    const m = new FakeMCPManager([
      mkTool('GMAIL_SEND_EMAIL', 'gmail', (args) => ({ ok: true, echoed: args })),
    ])
    const result = await m.callTool('gmail', 'GMAIL_SEND_EMAIL', { to: 'bob@example.com', subject: 'hi' })
    expect(m.recordedCalls).toHaveLength(1)
    expect(m.recordedCalls[0].toolName).toBe('GMAIL_SEND_EMAIL')
    expect(m.recordedCalls[0].args).toEqual({ to: 'bob@example.com', subject: 'hi' })
    expect(JSON.parse(result)).toEqual({ ok: true, echoed: { to: 'bob@example.com', subject: 'hi' } })
  })

  it('callTool returns a tool_not_found stub for unknown tools', async () => {
    const m = new FakeMCPManager([])
    const result = await m.callTool('gmail', 'NONEXISTENT_TOOL', {})
    const parsed = JSON.parse(result)
    expect(parsed.error).toBe('tool_not_found')
    expect(parsed.tool).toBe('NONEXISTENT_TOOL')
    // Still recorded, so judges can inspect hallucinated tool calls
    expect(m.recordedCalls).toHaveLength(1)
  })

  it('callTool catches thrown responders and returns a structured error', async () => {
    const m = new FakeMCPManager([
      mkTool('WOBBLE', 'test', () => {
        throw new Error('boom')
      }),
    ])
    const result = await m.callTool('test', 'WOBBLE', {})
    const parsed = JSON.parse(result)
    expect(parsed.error).toBe('fake_response_threw')
    expect(parsed.message).toBe('boom')
  })

  it('connect/ready/disconnect/registerLocal are no-ops that do not throw', async () => {
    const m = new FakeMCPManager([mkTool('X', 'srv')])
    await expect(m.connect([])).resolves.toBeUndefined()
    await expect(m.ready()).resolves.toBeUndefined()
    await expect(m.disconnect('srv')).resolves.toBeUndefined()
    await expect(m.disconnectAll()).resolves.toBeUndefined()
    expect(() => m.registerLocal('x', [], async () => 'ok')).not.toThrow()
  })

  it('rejects duplicate tool names at construction', () => {
    expect(
      () =>
        new FakeMCPManager([
          mkTool('DUP', 'a'),
          mkTool('DUP', 'b'),
        ])
    ).toThrow(/duplicate tool name/)
  })
})
