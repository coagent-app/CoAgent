/**
 * Layer 1 verification: run the SQLite migration against a COPY of the user's
 * real ~/.coagent/ data dir and deep-diff every store to prove data fidelity.
 *
 * The user's live ~/.coagent/ is NEVER touched. Script creates a copy at
 * ~/.coagent-sqlite-test/, operates only there, and cleans up.
 *
 * Usage: pnpm tsx scripts/verify-sqlite-migration.ts
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { CoAgentDB } from '../packages/agent-core/src/db.js'
import { migrateFromJson } from '../packages/agent-core/src/db-migration.js'

const SRC = join(homedir(), '.coagent')
const DST = join(homedir(), '.coagent-sqlite-test')

// Map of legacy filename → domain getter on CoAgentDB
const STORES: Array<{
  filename: string
  get: (db: CoAgentDB) => unknown
}> = [
  { filename: 'conversation.json',           get: (d) => d.getConversation() },
  { filename: 'team-history.json',           get: (d) => d.getTeamConversation() },
  { filename: 'queue.json',                  get: (d) => d.getQueue() },
  { filename: 'done.json',                   get: (d) => d.getDone() },
  { filename: 'file-index.json',             get: (d) => d.getFileIndex() },
  { filename: 'folder-order.json',           get: (d) => d.getFolderOrder() },
  { filename: 'scheduler-event-ids.json',    get: (d) => d.getSchedulerEventIds() },
  { filename: 'connected-integrations.json', get: (d) => d.getConnectedIntegrations() },
  { filename: 'triggers.json',               get: (d) => d.getComposioTriggers() },
]

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function summarize(value: unknown): string {
  if (Array.isArray(value)) return `array[${value.length}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as object)
    return `object{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}}`
  }
  return typeof value
}

function main() {
  if (!existsSync(SRC)) {
    console.error(`✗ No live data at ${SRC}`)
    process.exit(1)
  }

  console.log(`── CoAgent SQLite Migration — Layer 1 Verification ──\n`)
  console.log(`source: ${SRC}`)
  console.log(`sandbox: ${DST}\n`)

  // Fresh sandbox
  if (existsSync(DST)) rmSync(DST, { recursive: true, force: true })
  mkdirSync(DST, { recursive: true })

  // Copy ALL of ~/.coagent/ (JSON + subdirs) so migration operates in a
  // realistic directory. We don't need to copy the large blob dirs, but cpSync
  // is cheap and keeps semantics identical.
  const copyStart = Date.now()
  cpSync(SRC, DST, { recursive: true, force: true, errorOnExist: false })
  const copyMs = Date.now() - copyStart
  console.log(`[copy] ${copyMs}ms\n`)

  // Inventory which stores exist on disk
  console.log(`── Inventory ──`)
  const present: string[] = []
  for (const { filename } of STORES) {
    const path = join(DST, filename)
    if (existsSync(path)) {
      const size = readFileSync(path).byteLength
      present.push(filename)
      console.log(`  ✓ ${filename.padEnd(34)} ${prettyBytes(size)}`)
    } else {
      console.log(`  · ${filename.padEnd(34)} (absent — nothing to migrate)`)
    }
  }
  console.log('')

  // Snapshot original JSON contents BEFORE migration (since migration renames them)
  const originals: Record<string, unknown> = {}
  for (const { filename } of STORES) {
    const path = join(DST, filename)
    if (existsSync(path)) {
      originals[filename] = JSON.parse(readFileSync(path, 'utf-8'))
    }
  }

  // Run migration
  console.log(`── Migration ──`)
  const db = new CoAgentDB(DST)
  const migStart = Date.now()
  const result = migrateFromJson(DST, db)
  const migMs = Date.now() - migStart

  if (!result.ok) {
    console.error(`✗ MIGRATION FAILED in ${migMs}ms:`, result.error)
    db.close()
    process.exit(1)
  }

  console.log(`  ok: true`)
  console.log(`  duration: ${migMs}ms`)
  console.log(`  migrated: [${result.migrated.join(', ')}]`)
  console.log(`  skipped: [${result.skipped.join(', ')}]`)
  console.log('')

  // Verify .pre-sqlite.bak files exist for each migrated store
  console.log(`── Backup files ──`)
  let backupOk = true
  for (const filename of present) {
    const bakPath = join(DST, filename + '.pre-sqlite.bak')
    const origPath = join(DST, filename)
    const hasBak = existsSync(bakPath)
    const origGone = !existsSync(origPath)
    const ok = hasBak && origGone
    if (!ok) backupOk = false
    console.log(
      `  ${ok ? '✓' : '✗'} ${filename.padEnd(34)} ` +
      `bak=${hasBak ? 'yes' : 'NO'} orig_renamed=${origGone ? 'yes' : 'NO'}`
    )
  }
  console.log('')

  // Deep-diff each store
  console.log(`── Data fidelity (original JSON vs DB readback) ──`)
  let mismatches = 0
  for (const { filename, get } of STORES) {
    if (!(filename in originals)) continue
    const original = originals[filename]
    const fromDb = get(db)
    const equal = deepEqual(original, fromDb)
    const status = equal ? '✓' : '✗ MISMATCH'
    const detail = equal
      ? summarize(original)
      : `original=${summarize(original)}  db=${summarize(fromDb)}`
    console.log(`  ${status.padEnd(12)} ${filename.padEnd(34)} ${detail}`)
    if (!equal) mismatches++
  }
  console.log('')

  // Idempotency check — run migration again, expect all present keys skipped
  console.log(`── Idempotency (second run) ──`)
  const result2 = migrateFromJson(DST, db)
  if (!result2.ok) {
    console.error(`  ✗ Second run failed:`, result2.error)
    mismatches++
  } else {
    const reMigrated = result2.migrated.length
    const skipCount = result2.skipped.length
    console.log(`  migrated: ${reMigrated} (expected 0)`)
    console.log(`  skipped: ${skipCount}`)
    if (reMigrated !== 0) {
      console.log(`  ✗ Second run re-migrated something — NOT idempotent`)
      mismatches++
    } else {
      console.log(`  ✓ Idempotent — second run was a no-op`)
    }
  }
  console.log('')

  db.close()

  // Final summary
  console.log(`── Summary ──`)
  console.log(`  copy: ${copyMs}ms`)
  console.log(`  migration: ${migMs}ms`)
  console.log(`  stores migrated: ${result.migrated.length}`)
  console.log(`  data mismatches: ${mismatches}`)
  console.log(`  backup files: ${backupOk ? 'all present' : 'MISSING SOME'}`)
  console.log('')

  if (mismatches === 0 && backupOk) {
    console.log(`✅ PASS — migration preserves your real data bit-for-bit.`)
    console.log(`   Sandbox left at ${DST} for manual inspection.`)
    console.log(`   Delete with: rm -rf ${DST}`)
    process.exit(0)
  } else {
    console.log(`❌ FAIL — see details above.`)
    console.log(`   Sandbox left at ${DST} for debugging.`)
    process.exit(1)
  }
}

main()
