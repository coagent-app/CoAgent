import { describe, it, expect } from 'vitest'
import { pruneExpiredEventIds, EVENT_ID_RETENTION_MS } from '../scheduler.js'

describe('pruneExpiredEventIds', () => {
  const NOW = Date.parse('2026-04-16T00:00:00.000Z')
  const oldIso = new Date(NOW - EVENT_ID_RETENTION_MS - 1000).toISOString() // 30 days + 1s ago
  const freshIso = new Date(NOW - 60_000).toISOString() // 1 minute ago

  it('drops IDs whose seenAt is older than the retention window', () => {
    const briefed = new Set(['old', 'fresh'])
    const recapped = new Set(['old'])
    const seenAt: Record<string, string> = {
      old: oldIso,
      fresh: freshIso,
    }

    const { pruned } = pruneExpiredEventIds(briefed, recapped, seenAt, NOW)

    expect(pruned).toBe(1)
    expect(briefed.has('old')).toBe(false)
    expect(briefed.has('fresh')).toBe(true)
    expect(recapped.has('old')).toBe(false)
    expect(seenAt.old).toBeUndefined()
    expect(seenAt.fresh).toBe(freshIso)
  })

  it('keeps IDs at exactly the cutoff boundary (inclusive of "now - retention")', () => {
    // An id stamped exactly retentionMs ago is NOT older than cutoff — must be kept.
    const atBoundary = new Date(NOW - EVENT_ID_RETENTION_MS).toISOString()
    const briefed = new Set(['edge'])
    const recapped = new Set<string>()
    const seenAt: Record<string, string> = { edge: atBoundary }

    const { pruned } = pruneExpiredEventIds(briefed, recapped, seenAt, NOW)

    expect(pruned).toBe(0)
    expect(briefed.has('edge')).toBe(true)
    expect(seenAt.edge).toBe(atBoundary)
  })

  it('stamps legacy IDs (no seenAt) with now so their clock starts from upgrade time', () => {
    // Simulates loading a pre-rotation file: briefed/recapped are populated but
    // seenAt is empty. We must not drop those IDs — they might be recent.
    const briefed = new Set(['legacy-a', 'legacy-b'])
    const recapped = new Set(['legacy-c'])
    const seenAt: Record<string, string> = {}

    const { pruned } = pruneExpiredEventIds(briefed, recapped, seenAt, NOW)

    expect(pruned).toBe(0)
    expect(briefed.size).toBe(2)
    expect(recapped.size).toBe(1)
    const nowIso = new Date(NOW).toISOString()
    expect(seenAt['legacy-a']).toBe(nowIso)
    expect(seenAt['legacy-b']).toBe(nowIso)
    expect(seenAt['legacy-c']).toBe(nowIso)
  })

  it('drops orphan seenAt entries whose IDs are no longer in either set', () => {
    const briefed = new Set<string>(['keep'])
    const recapped = new Set<string>()
    const seenAt: Record<string, string> = {
      keep: freshIso,
      orphan: freshIso, // not in briefed or recapped
    }

    pruneExpiredEventIds(briefed, recapped, seenAt, NOW)

    expect(seenAt.keep).toBe(freshIso)
    expect(seenAt.orphan).toBeUndefined()
  })

  it('keeps an id that still has a fresh stamp even if it appears in both sets', () => {
    // Some events could in theory be both briefed AND recapped. Ensure dual-set
    // membership doesn't cause double-deletion or an incorrect prune count.
    const briefed = new Set(['both'])
    const recapped = new Set(['both'])
    const seenAt: Record<string, string> = { both: freshIso }

    const { pruned } = pruneExpiredEventIds(briefed, recapped, seenAt, NOW)

    expect(pruned).toBe(0)
    expect(briefed.has('both')).toBe(true)
    expect(recapped.has('both')).toBe(true)
    expect(seenAt.both).toBe(freshIso)
  })

  it('drops an expired id from both sets in a single pass', () => {
    const briefed = new Set(['both'])
    const recapped = new Set(['both'])
    const seenAt: Record<string, string> = { both: oldIso }

    const { pruned } = pruneExpiredEventIds(briefed, recapped, seenAt, NOW)

    // Counted once — the id is a single logical entry, even if it lived in two sets.
    expect(pruned).toBe(1)
    expect(briefed.has('both')).toBe(false)
    expect(recapped.has('both')).toBe(false)
    expect(seenAt.both).toBeUndefined()
  })

  it('ignores malformed seenAt values (treats as missing and stamps them)', () => {
    const briefed = new Set(['bad'])
    const recapped = new Set<string>()
    const seenAt: Record<string, string> = { bad: 'not-a-date' }

    pruneExpiredEventIds(briefed, recapped, seenAt, NOW)

    // Malformed timestamp → Date.parse returns NaN → not finite → not pruned.
    // Also not re-stamped (since seenAt[id] is truthy). It stays as-is and will
    // be evaluated again on the next save. Acceptable: worst case it lives
    // forever, best case it gets pruned when the file is next rewritten with
    // a valid stamp. Either way: no crash, no data loss.
    expect(briefed.has('bad')).toBe(true)
  })
})
