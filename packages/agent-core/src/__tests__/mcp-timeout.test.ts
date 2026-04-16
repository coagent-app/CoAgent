import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  ToolTimeoutError,
  timeoutForTool,
  withTimeout,
} from '../mcp-manager.js'

describe('withTimeout', () => {
  it('resolves when the promise settles before the timer', async () => {
    const result = await withTimeout(
      Promise.resolve('ok'),
      1000,
      () => new Error('should not fire')
    )
    expect(result).toBe('ok')
  })

  it('rejects with the factory error when the timer fires first', async () => {
    const slow = new Promise(resolve => setTimeout(() => resolve('late'), 200))
    await expect(
      withTimeout(slow, 20, () => new ToolTimeoutError('srv', 'tool', 20))
    ).rejects.toBeInstanceOf(ToolTimeoutError)
  })

  it('propagates underlying rejection when it beats the timer', async () => {
    const failing = Promise.reject(new Error('boom'))
    await expect(
      withTimeout(failing, 1000, () => new Error('should not fire'))
    ).rejects.toThrow('boom')
  })

  it('clears the timer after the promise resolves (no lingering handles)', async () => {
    // If the timer weren't cleared, vitest would hold the event loop open;
    // this test also asserts we don't spuriously reject after resolution.
    const p = Promise.resolve(42)
    const result = await withTimeout(p, 10_000, () => new Error('never'))
    expect(result).toBe(42)
    // Give any stray timer ample window to mis-fire
    await new Promise(r => setTimeout(r, 20))
  })
})

describe('timeoutForTool', () => {
  it('returns the default for unknown tools', () => {
    expect(timeoutForTool('some_random_tool')).toBe(DEFAULT_TOOL_TIMEOUT_MS)
  })

  it('returns per-tool override for known slow tools', () => {
    expect(timeoutForTool('web_search_exa')).toBeGreaterThan(DEFAULT_TOOL_TIMEOUT_MS)
    expect(timeoutForTool('deep_research')).toBeGreaterThan(DEFAULT_TOOL_TIMEOUT_MS)
    expect(timeoutForTool('spawn_agents')).toBeGreaterThan(DEFAULT_TOOL_TIMEOUT_MS)
  })
})

describe('ToolTimeoutError', () => {
  it('carries server, tool, and duration', () => {
    const err = new ToolTimeoutError('gmail', 'send_message', 45_000)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ToolTimeoutError')
    expect(err.serverName).toBe('gmail')
    expect(err.toolName).toBe('send_message')
    expect(err.timeoutMs).toBe(45_000)
    expect(err.message).toContain('45000ms')
  })
})
