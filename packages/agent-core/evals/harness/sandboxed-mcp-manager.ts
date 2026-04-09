/**
 * SandboxedMCPManager — the v2 harness replacement for FakeMCPManager.
 *
 * Instead of stubbing out the entire MCP layer, this subclass:
 *   1. Spawns REAL stdio MCP subprocesses (memory, optionally others) pointed
 *      at the probe's tmp data dir via COAGENT_DATA_DIR. Memory reads/writes/
 *      searches actually hit LanceDB + relay embeddings — same code path as
 *      production.
 *   2. Fakes ONLY the external integration tools (gmail, googlecalendar, etc.)
 *      that probes declare via `FakeTool[]`. Those never touch the network.
 *   3. Merges both surfaces in getAllTools() so buildSystemPrompt's serverMap
 *      sees memory's real tools + the probe's fake external tools.
 *
 * The goal: test the real agent loop against the real memory MCP, against a
 * sandboxed data dir, while blocking outbound integration side effects.
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

export class SandboxedMCPManager extends MCPManager {
  private fakeTools: FakeTool[]
  private fakeToolByName: Map<string, FakeTool>
  public readonly recordedCalls: RecordedCall[] = []

  constructor(fakeTools: FakeTool[]) {
    super()
    this.fakeTools = fakeTools
    this.fakeToolByName = new Map()
    for (const t of fakeTools) {
      if (this.fakeToolByName.has(t.definition.name)) {
        throw new Error(`SandboxedMCPManager: duplicate fake tool name '${t.definition.name}'`)
      }
      this.fakeToolByName.set(t.definition.name, t)
    }
  }

  /**
   * Real tools = anything exposed by a spawned stdio MCP subprocess (memory,
   * etc.) via super.getAllTools(). Fake tools = the probe's external-integration
   * stubs (gmail, googlecalendar, ...). Merge them so the agent sees one flat
   * list, with serverMap correctly pointing each name at its owning server.
   */
  async getAllTools(): Promise<{ tools: Anthropic.Tool[]; serverMap: Map<string, string> }> {
    const real = await super.getAllTools()
    const tools: Anthropic.Tool[] = [...real.tools]
    const serverMap = new Map(real.serverMap)
    for (const ft of this.fakeTools) {
      if (serverMap.has(ft.definition.name)) {
        // A real subprocess already exposes this name — refuse to clobber it,
        // that's a probe authoring bug.
        throw new Error(
          `SandboxedMCPManager: fake tool '${ft.definition.name}' collides with a real MCP tool from server '${serverMap.get(ft.definition.name)}'`
        )
      }
      tools.push(ft.definition)
      serverMap.set(ft.definition.name, ft.server)
    }
    return { tools, serverMap }
  }

  /**
   * Dispatch rule:
   *   - If the tool name is in the fake map → route to the probe's handler
   *     (record the call, never touch the network).
   *   - Otherwise → pass through to the real MCPManager, which will route to
   *     the appropriate spawned subprocess (e.g. memory).
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const fake = this.fakeToolByName.get(toolName)
    if (fake) {
      this.recordedCalls.push({
        server: serverName,
        toolName,
        args,
        timestamp: Date.now(),
      })
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
    // Real path — memory, files, whatever else the harness spawned.
    return super.callTool(serverName, toolName, args)
  }

  /**
   * A fake server is considered "connected" iff at least one of the probe's
   * fake tools claims it. Real servers use the base-class check.
   */
  isConnected(name: string): boolean {
    if (super.isConnected(name)) return true
    return this.fakeTools.some((t) => t.server === name)
  }

  /**
   * External-boundary record for the trajectory. Note that the canonical
   * source of tool_use blocks is still the agent's conversationHistory —
   * `extractTrajectory()` pulls from there, not from here. This helper is
   * kept for ad-hoc debugging / future probe-side assertions.
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
