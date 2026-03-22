import cron from 'node-cron'
import { spawn, type ChildProcess } from 'child_process'
import type { Agent } from './agent.js'
import { hasUnreadEvents, purgeEventStore } from './relay-client.js'
import { readSettings, isActiveNow } from './settings.js'

let caffeinateProc: ChildProcess | null = null

function updateCaffeinate(active: boolean): void {
  if (process.platform !== 'darwin') return

  if (active && !caffeinateProc) {
    caffeinateProc = spawn('caffeinate', ['-i'], { stdio: 'ignore', detached: false })
    caffeinateProc.on('exit', () => { caffeinateProc = null })
    console.log('[Scheduler] caffeinate started — preventing idle sleep')
  } else if (!active && caffeinateProc) {
    caffeinateProc.kill()
    caffeinateProc = null
    console.log('[Scheduler] caffeinate stopped — sleep allowed')
  }
}

export function startScheduler(agent: Agent, dataDir: string): void {
  // Check active hours and manage caffeinate on startup + every minute
  async function syncCaffeinate() {
    const settings = await readSettings(dataDir).catch(() => null)
    if (settings) updateCaffeinate(isActiveNow(settings))
  }
  syncCaffeinate()
  cron.schedule('* * * * *', () => { syncCaffeinate() })

  // Daily memory cleanup — 3am (runs regardless of active hours)
  cron.schedule('0 3 * * *', () => {
    agent.handleTrigger({ source: 'memory_cleanup' })
  })

  // Hourly heartbeat — top of every hour
  cron.schedule('0 * * * *', async () => {
    const settings = await readSettings(dataDir)
    if (!isActiveNow(settings)) {
      console.log('[Scheduler] Outside active hours — skipping heartbeat')
      return
    }

    await purgeEventStore(dataDir).catch((err) =>
      console.error('[Scheduler] Purge failed:', err.message)
    )

    agent.handleTrigger({ source: 'heartbeat' })
  })
}
