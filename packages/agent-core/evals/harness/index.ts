/**
 * Barrel exports + defineProbe() helper.
 *
 * Probes import from here rather than reaching into individual files, so we
 * can refactor the harness later without breaking every probe in the suite.
 */

export * from './types.js'
export { runProbe, resolveKimiCredentials } from './run-probe.js'
export { FakeMCPManager } from './fake-mcp-manager.js'
export { extractTrajectory, hasCall, countCalls } from './trajectory.js'
export { trajectory, state, forbid, judge } from './judges.js'

import type { Probe } from './types.js'

/**
 * Tiny helper that gives probes defaulted fields without forcing every file
 * to repeat `runs: 1, judges: []`. Nothing magical — just a typed pass-through.
 */
export function defineProbe(
  p: Omit<Probe, 'runs' | 'judges'> & Partial<Pick<Probe, 'runs' | 'judges'>>
): Probe {
  return {
    runs: 1,
    judges: [],
    ...p,
  }
}
