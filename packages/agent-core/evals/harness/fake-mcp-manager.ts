/**
 * FakeMCPManager — drop-in replacement for MCPManager used by the probe harness.
 *
 * The real Agent class holds `mcpManager: MCPManager` as a public field, so we
 * swap the instance AFTER constructing the Agent (with empty stdio configs) and
 * BEFORE calling chat(). The Agent still runs its real buildSystemPrompt() →
 * real runLoop() → real tool dispatch — the only thing that changes is what
 * happens when an external tool is actually invoked.
 *
 * This class:
 *  - Exposes probe-defined fake tools via getAllTools() so buildSystemPrompt's
 *    `connectedServices` reflects them realistically.
 *  - Routes callTool() through the probe's respond handlers; records every call.
 *  - Resolves ready() immediately (no real MCP subprocesses to wait for).
 */

import type Anthropic from '@anthropic-ai/sdk'
import { MCPManager } from '../../src/mcp-manager.js'
import type { FakeTool, ToolCall } from './types.js'

export interface RecordedCall {
  server: string
  toolName: string
  args: Record<string, unknown>
  timestamp: number
}

export class FakeMCPManager extends MCPManager {
  private fakeTools: FakeTool[]
  private toolByName: Map<string, FakeTool>
  public readonly recordedCalls: RecordedCall[] = []

  constructor(fakeTools: FakeTool[]) {
    super()
    this.fakeTools = fakeTools
    this.toolByName = new Map()
    for (const t of fakeTools) {
      if (this.toolByName.has(t.definition.name)) {
        throw new Error(`FakeMCPManager: duplicate tool name '${t.definition.name}'`)
      }
      this.toolByName.set(t.definition.name, t)
    }
  }

  /** No-op: no real MCP subprocesses to spawn */
  async connect(_configs: unknown[]): Promise<void> {
    // intentionally empty
  }

  /** No-op: nothing to wait for */
  async ready(): Promise<void> {
    // intentionally empty
  }

  /** No-op: registry is irrelevant for probes */
  registerPending(_name: string, p: Promise<unknown>): void {
    // Swallow rejections so the caller never sees an unhandled rejection
    void p.catch(() => {})
  }

  /** Probes treat all configured fake servers as connected */
  isConnected(name: string): boolean {
    return this.fakeTools.some((t) => t.server === name)
  }

  /** Return the same shape the real MCPManager returns */
  async getAllTools(): Promise<{ tools: Anthropic.Tool[]; serverMap: Map<string, string> }> {
    const tools: Anthropic.Tool[] = this.fakeTools.map((t) => t.definition)
    const serverMap = new Map<string, string>()
    for (const t of this.fakeTools) {
      serverMap.set(t.definition.name, t.server)
    }
    return { tools, serverMap }
  }

  /** Record the call and return the probe's fake response (or a generic stub) */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    this.recordedCalls.push({
      server: serverName,
      toolName,
      args,
      timestamp: Date.now(),
    })

    const fake = this.toolByName.get(toolName)
    if (!fake) {
      // Unknown tool — return an error string like a real MCP would for a bad name.
      // This lets us detect tool-hallucination probes: the agent tried to call a
      // tool that doesn't exist, and the fake layer politely said no.
      return JSON.stringify({
        error: `tool_not_found`,
        tool: toolName,
        server: serverName,
        note: 'FakeMCPManager: tool is not registered for this probe',
      })
    }

    if (!fake.respond) {
      return JSON.stringify({ ok: true, tool: toolName, note: 'fake response' })
    }

    try {
      const result = await fake.respond(args)
      return typeof result === 'string' ? result : JSON.stringify(result)
    } catch (err: any) {
      return JSON.stringify({
        error: 'fake_response_threw',
        tool: toolName,
        message: err?.message ?? String(err),
      })
    }
  }

  /** Local-handler registration is a no-op: probes use fakeTools instead */
  registerLocal(
    _name: string,
    _tools: Anthropic.Tool[],
    _handler: (toolName: string, args: Record<string, unknown>) => Promise<string>
  ): void {
    // intentionally empty
  }

  /** Disconnect / disconnectAll are no-ops */
  async disconnect(_name: string): Promise<void> {
    // intentionally empty
  }

  async disconnectAll(): Promise<void> {
    // intentionally empty
  }

  /**
   * Convert the recorded MCP calls into ToolCall entries for the trajectory.
   * Note: this only captures calls that went through MCP (i.e. call_external_tool
   * or direct mcpManager.callTool). Internal tool calls like queue_approval are
   * extracted separately from the agent's conversationHistory.
   */
  toToolCalls(turnByCall: number[] = []): ToolCall[] {
    return this.recordedCalls.map((c, i) => ({
      name: c.toolName,
      args: c.args,
      turn: turnByCall[i] ?? 0,
      id: `rec_${i}`,
      kind: 'external' as const,
      externalServer: c.server,
      externalToolName: c.toolName,
    }))
  }
}
