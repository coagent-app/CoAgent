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

export interface SchedulerCallbacks {
  onHeartbeat?: (status: 'started' | 'done' | 'skipped' | 'escalated', summary?: string) => void
}

export function startScheduler(agent: Agent, dataDir: string, callbacks?: SchedulerCallbacks): void {
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

  // Configurable heartbeat — check every minute, fire when interval elapsed
  let lastHeartbeat = 0
  cron.schedule('* * * * *', async () => {
    const settings = await readSettings(dataDir)
    const interval = settings.heartbeat_interval ?? 60
    if (interval <= 0) return // disabled

    const now = Date.now()
    if (now - lastHeartbeat < interval * 60 * 1000) return

    if (!isActiveNow(settings)) {
      console.log('[Scheduler] Outside active hours — skipping heartbeat')
      callbacks?.onHeartbeat?.('skipped')
      return
    }

    lastHeartbeat = now

    await purgeEventStore(dataDir).catch((err) =>
      console.error('[Scheduler] Purge failed:', err.message)
    )

    callbacks?.onHeartbeat?.('started')
    try {
      await agent.handleTrigger({ source: 'heartbeat' })
      callbacks?.onHeartbeat?.('done')
    } catch (err: any) {
      console.error('[Scheduler] Heartbeat error:', err.message)
      callbacks?.onHeartbeat?.('done')
    }
  })
}
