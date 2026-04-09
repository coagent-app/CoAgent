/**
 * run-all — discover every probe in evals/probes/, run it against real Kimi,
 * aggregate results, and write a findings report to
 * `docs/reviews/YYYY-MM-DD-prompt-eval.md` relative to the repo root.
 *
 * Usage:
 *   pnpm --filter @coagent/agent-core eval                 # all probes
 *   pnpm --filter @coagent/agent-core eval 001 003         # subset by id prefix
 *   REPORT_PATH=/tmp/out.md pnpm --filter @coagent/agent-core eval
 *
 * Requires MOONSHOT_API_KEY in env.
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { config as loadEnv } from 'dotenv'
import { runProbe } from './harness/index.js'
import { resolveKimiCredentials } from './harness/run-probe.js'
import type { Probe, ProbeResult } from './harness/index.js'

// Load .env from agent-core (two levels up from evals/).
const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: join(__dirname, '..', '.env') })
// Also try repo root .env as a fallback.
loadEnv({ path: join(__dirname, '..', '..', '..', '.env') })

const PROBES_DIR = join(__dirname, 'probes')
const CLAIMS_PATH = join(__dirname, 'claims.md')

async function main() {
  const filters = process.argv.slice(2)

  // Resolve Kimi creds (relay preferred, direct Moonshot fallback). Throws if
  // neither path is available.
  let credMode: 'relay' | 'moonshot-direct'
  try {
    credMode = resolveKimiCredentials()
  } catch (err: any) {
    console.error(`[eval] ${err?.message ?? String(err)}`)
    process.exit(2)
  }
  console.log(`[eval] Kimi credentials: ${credMode}`)

  // Discover probe files.
  const allFiles = readdirSync(PROBES_DIR).filter((f) => f.endsWith('.probe.ts') || f.endsWith('.probe.js'))
  const matched = filters.length > 0 ? allFiles.filter((f) => filters.some((pref) => f.startsWith(pref))) : allFiles
  if (matched.length === 0) {
    console.error(`[eval] no probes matched filters: ${filters.join(', ') || '(none)'}`)
    process.exit(1)
  }

  console.log(`[eval] discovered ${matched.length} probe(s): ${matched.join(', ')}`)

  const claimIds = extractClaimIds(CLAIMS_PATH)
  const reportPath =
    process.env.REPORT_PATH ??
    join(__dirname, '..', '..', '..', 'docs', 'reviews', `${today()}-prompt-eval.md`)
  mkdirSync(dirname(reportPath), { recursive: true })

  // Write the report after each probe completes so a crash mid-run doesn't
  // lose all findings. Kimi is flaky enough that we treat every completed
  // probe as "committable state" — the report file is always a snapshot of
  // what's been observed so far.
  const writeReport = (results: ProbeResult[], total: number) => {
    const covered = new Set<string>()
    for (const r of results) for (const c of r.claimRefs) covered.add(c)
    const uncovered = claimIds.filter((id) => !covered.has(id))
    const report = renderReport(results, claimIds, covered, uncovered, { completed: results.length, total })
    writeFileSync(reportPath, report, 'utf-8')
  }

  const results: ProbeResult[] = []
  // Write an initial empty report so the file exists from turn 0.
  writeReport(results, matched.length)
  console.log(`[eval] incremental report at ${reportPath}`)

  for (const file of matched) {
    const abs = join(PROBES_DIR, file)
    const mod = (await import(pathToFileURL(abs).href)) as any
    // CJS/ESM interop: tsx transpiles ESM default exports to CJS, which then
    // come back through dynamic import() as { default: { default: probe } }.
    // Handle both shapes so we don't care which mode a probe file is in.
    const probe: Probe | undefined =
      (mod?.default?.default as Probe | undefined) ?? (mod?.default as Probe | undefined) ?? (mod as Probe | undefined)
    if (!probe || !probe.id) {
      console.error(`[eval] ${file} has no default export (or export is malformed) — skipping`)
      continue
    }
    try {
      const result = await runProbe(probe)
      results.push(result)
    } catch (err: any) {
      console.error(`[eval] ${probe.id} threw: ${err?.message ?? String(err)}`)
      results.push({
        probeId: probe.id,
        claim: probe.claim,
        claimRefs: probe.claimRefs,
        runs: [],
        overall: 'fail',
      })
    }
    writeReport(results, matched.length)
    console.log(`[eval] report updated — ${results.length}/${matched.length} complete`)
  }

  console.log(`\n[eval] report written to ${reportPath}`)

  // Console summary.
  const pass = results.filter((r) => r.overall === 'pass').length
  const partial = results.filter((r) => r.overall === 'partial').length
  const fail = results.filter((r) => r.overall === 'fail').length
  console.log(`[eval] summary — pass: ${pass}, partial: ${partial}, fail: ${fail}`)

  // Exit nonzero on any fail so CI can catch regressions.
  process.exit(fail > 0 ? 1 : 0)
}

function today(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function extractClaimIds(path: string): string[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf-8')
  // Match patterns like `**CTX-1**`, `**ADV-2**` — the bold claim ID at the start of each bullet.
  const ids = new Set<string>()
  for (const m of text.matchAll(/\*\*([A-Z]{2,4}-\d+)\*\*/g)) {
    ids.add(m[1])
  }
  return Array.from(ids).sort()
}

function renderReport(
  results: ProbeResult[],
  claimIds: string[],
  covered: Set<string>,
  uncovered: string[],
  progress?: { completed: number; total: number }
): string {
  const lines: string[] = []
  lines.push(`# Prompt Eval Report — ${today()}`)
  lines.push('')
  lines.push(
    'Generated by `packages/agent-core/evals/run-all.ts` — each probe runs the real `Agent` loop against Kimi K2.5 via Moonshot direct, with a fake MCP layer that records tool calls without executing side effects.'
  )
  lines.push('')

  if (progress && progress.completed < progress.total) {
    lines.push(`> ⏳ **Run in progress** — ${progress.completed}/${progress.total} probes complete. This report is a live snapshot.`)
    lines.push('')
  }

  // Summary
  const pass = results.filter((r) => r.overall === 'pass').length
  const partial = results.filter((r) => r.overall === 'partial').length
  const fail = results.filter((r) => r.overall === 'fail').length
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Probes run: **${results.length}**`)
  lines.push(`- Pass: **${pass}**`)
  lines.push(`- Partial: **${partial}**`)
  lines.push(`- Fail: **${fail}**`)
  lines.push('')

  // Per-probe
  lines.push('## Per-probe results')
  lines.push('')
  for (const r of results) {
    const icon = r.overall === 'pass' ? '✅' : r.overall === 'partial' ? '⚠️' : '❌'
    lines.push(`### ${icon} ${r.probeId} — ${r.overall.toUpperCase()}`)
    lines.push('')
    lines.push(`**Claim:** ${r.claim}`)
    lines.push('')
    lines.push(`**Claim refs:** ${r.claimRefs.join(', ') || '(none)'}`)
    lines.push('')
    if (r.runs.length === 0) {
      lines.push('_Probe threw during setup — see console output._')
      lines.push('')
      continue
    }
    for (const run of r.runs) {
      lines.push(`**Run ${run.runIndex + 1}** — ${run.status} (${run.durationMs}ms)`)
      lines.push('')
      if (run.error) {
        lines.push(`- error: ${run.error}`)
      }

      // Multi-stimulus per-step breakdown
      if (run.stepResults && run.stepResults.length > 1) {
        lines.push('- steps:')
        for (const s of run.stepResults) {
          const midIcon = s.midAssertion
            ? s.midAssertion.status === 'pass'
              ? ' ✅'
              : ' ❌'
            : ''
          lines.push(
            `  - **step ${s.stepIndex + 1} (${s.label})**${midIcon} — ${s.toolCallCount} tool call(s)`
          )
          lines.push(`    - stimulus: "${s.stimulusSummary.replace(/\n/g, ' ')}"`)
          if (s.assistantText) {
            lines.push(`    - assistant: "${s.assistantText.replace(/\n/g, ' ')}${s.assistantText.length >= 500 ? '…' : ''}"`)
          }
          if (s.midAssertion) {
            lines.push(`    - expect \`${s.midAssertion.name}\`: ${s.midAssertion.detail}`)
          }
        }
      }

      // Tool call trace (cumulative, compressed)
      if (run.trajectory.toolCalls.length > 0) {
        lines.push('- tool calls:')
        for (const c of run.trajectory.toolCalls) {
          const argsPreview = JSON.stringify(c.args).slice(0, 160)
          lines.push(`  - [t${c.turn}] \`${c.name}\`(${argsPreview})`)
        }
      } else {
        lines.push('- tool calls: _(none)_')
      }
      // Final text
      if (run.trajectory.finalText) {
        const preview = run.trajectory.finalText.slice(0, 400).replace(/\n/g, ' ')
        lines.push(`- final text: "${preview}${run.trajectory.finalText.length > 400 ? '…' : ''}"`)
      }
      // Judge results
      lines.push('- judges:')
      for (const j of run.judgeResults) {
        const ji = j.status === 'pass' ? '✅' : '❌'
        lines.push(`  - ${ji} \`${j.name}\` — ${j.detail}`)
      }
      lines.push('')
    }
  }

  // Coverage
  lines.push('## Claim coverage')
  lines.push('')
  lines.push(`**Total claims in claims.md:** ${claimIds.length}`)
  lines.push(`**Covered by ≥1 probe:** ${covered.size}`)
  lines.push(`**Uncovered:** ${uncovered.length}`)
  lines.push('')
  if (uncovered.length > 0) {
    lines.push('### Uncovered claims')
    lines.push('')
    for (const id of uncovered) lines.push(`- ${id}`)
    lines.push('')
  }

  return lines.join('\n') + '\n'
}

main().catch((err) => {
  console.error('[eval] fatal:', err)
  process.exit(1)
})
