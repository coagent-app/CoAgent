/**
 * Dump the exact system prompt buildSystemPrompt() generates for the user's
 * real ~/.coagent/ state. Use this to diff against a harness-generated prompt
 * to verify the harness is feeding Kimi the same system prompt production does.
 *
 * Usage:
 *   pnpm tsx evals/dump-prod-prompt.ts
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { buildSystemPrompt } from '../src/agent.js'
import { readSettings } from '../src/settings.js'

async function main() {
  const dataDir = join(homedir(), '.coagent')
  if (!existsSync(dataDir)) {
    console.error(`No ${dataDir} found`)
    process.exit(1)
  }

  const settings = await readSettings(dataDir)

  // Mirror what runLoop does: derive connected services from connected-integrations.json
  let connectedServices: string[] = []
  let composioSlugs: string[] = []
  let googleCalendarConnected = false
  try {
    const raw = readFileSync(join(dataDir, 'connected-integrations.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      composioSlugs = parsed.map((p: any) => p.slug ?? p).filter(Boolean)
      googleCalendarConnected = composioSlugs.some((s) => s.toLowerCase().includes('googlecalendar'))
      connectedServices = [...composioSlugs]
    }
  } catch {
    // ignore
  }

  const agentProfilePath = join(dataDir, 'memory', 'profile.md')

  const prompt = buildSystemPrompt(
    connectedServices,
    agentProfilePath,
    settings,
    dataDir,
    undefined, // teamRoster
    undefined, // teamName
    googleCalendarConnected,
    composioSlugs
  )

  console.log(prompt)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
