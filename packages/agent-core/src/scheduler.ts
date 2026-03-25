import cron from 'node-cron'
import { execSync, spawn } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import type { Agent } from './agent.js'
import { hasUnreadEvents, purgeEventStore } from './relay-client.js'
import { readSettings, isActiveNow } from './settings.js'

// ── Platform wake scheduling ────────────────────────────────────────────────
// Instead of preventing sleep 24/7, we let the machine sleep and schedule it
// to wake briefly for heartbeats.
//   macOS: `pmset schedule wake` (needs one-time admin auth for sudoers entry)
//   Windows: `schtasks` with /wake flag (no admin needed)

const TASK_NAME = 'CoAgentHeartbeat'
let lastScheduledWake: string | null = null

// ── macOS: pmset ────────────────────────────────────────────────────────────

let hasPmsetAccess = false
let pmsetSetupAttempted = false

function formatPmsetDate(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const yyyy = date.getFullYear()
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${mm}/${dd}/${yyyy} ${hh}:${min}:${ss}`
}

function checkPmsetAccess(): boolean {
  try {
    execSync('sudo -n /usr/bin/pmset -g sched', { stdio: 'ignore', timeout: 3000 })
    return true
  } catch { return false }
}

function setupPmsetAccess(): boolean {
  if (pmsetSetupAttempted) return hasPmsetAccess
  pmsetSetupAttempted = true

  if (checkPmsetAccess()) {
    hasPmsetAccess = true
    console.log('[Scheduler] pmset access already configured')
    return true
  }

  const user = process.env.USER
  if (!user) return false

  const tmpFile = `/tmp/coagent-sudoers-${process.pid}`
  try {
    writeFileSync(tmpFile, `${user} ALL=(root) NOPASSWD: /usr/bin/pmset\n`, { mode: 0o440 })
    execSync(
      `osascript -e 'do shell script "` +
        `cp ${tmpFile} /etc/sudoers.d/coagent && ` +
        `chmod 0440 /etc/sudoers.d/coagent && ` +
        `visudo -cf /etc/sudoers.d/coagent || rm -f /etc/sudoers.d/coagent` +
      `" with administrator privileges'`,
      { stdio: 'ignore', timeout: 60000 }
    )
    hasPmsetAccess = checkPmsetAccess()
    if (hasPmsetAccess) console.log('[Scheduler] pmset access installed — wake scheduling enabled')
  } catch {
    console.log('[Scheduler] User declined wake scheduling auth — machine will not wake for heartbeats')
  }
  try { unlinkSync(tmpFile) } catch {}
  return hasPmsetAccess
}

function scheduleMacWake(date: Date): void {
  if (!hasPmsetAccess && !setupPmsetAccess()) return
  cancelMacWake()
  const dateStr = formatPmsetDate(date)
  try {
    execSync(`sudo -n /usr/bin/pmset schedule wake "${dateStr}"`, { stdio: 'ignore', timeout: 5000 })
    lastScheduledWake = dateStr
    console.log(`[Scheduler] Mac will wake at ${dateStr}`)
  } catch (err: any) {
    console.error('[Scheduler] Failed to schedule wake:', err.message)
  }
}

function cancelMacWake(): void {
  if (!lastScheduledWake) return
  try {
    execSync(`sudo -n /usr/bin/pmset schedule cancel wake "${lastScheduledWake}"`, { stdio: 'ignore', timeout: 5000 })
  } catch {}
  lastScheduledWake = null
}

// ── Windows: schtasks ───────────────────────────────────────────────────────

function formatSchtasksTime(date: Date): { date: string; time: string } {
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const yyyy = date.getFullYear()
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  return { date: `${mm}/${dd}/${yyyy}`, time: `${hh}:${min}` }
}

function scheduleWindowsWake(date: Date): void {
  cancelWindowsWake()
  const fmt = formatSchtasksTime(date)
  try {
    // /wake wakes the PC from sleep to run the task — no admin needed
    // The task itself is a no-op; it just wakes the machine so the cron fires
    execSync(
      `schtasks /create /tn "${TASK_NAME}" /tr "cmd /c echo CoAgent wake" ` +
      `/sc once /sd ${fmt.date} /st ${fmt.time} /f /rl limited`,
      { stdio: 'ignore', timeout: 5000 }
    )
    // Enable the wake flag (schtasks /create doesn't have /wake, use powershell)
    execSync(
      `powershell -NoProfile -Command "$s = Get-ScheduledTask -TaskName '${TASK_NAME}'; ` +
      `$s.Settings.WakeToRun = $true; Set-ScheduledTask -InputObject $s"`,
      { stdio: 'ignore', timeout: 10000 }
    )
    console.log(`[Scheduler] PC will wake at ${fmt.date} ${fmt.time}`)
  } catch (err: any) {
    console.error('[Scheduler] Failed to schedule wake:', err.message)
  }
}

function cancelWindowsWake(): void {
  try {
    execSync(`schtasks /delete /tn "${TASK_NAME}" /f`, { stdio: 'ignore', timeout: 5000 })
  } catch {}
}

// ── Cross-platform wrappers ─────────────────────────────────────────────────

function scheduleWake(date: Date): void {
  if (process.platform === 'darwin') scheduleMacWake(date)
  else if (process.platform === 'win32') scheduleWindowsWake(date)
}

function cancelScheduledWake(): void {
  if (process.platform === 'darwin') cancelMacWake()
  else if (process.platform === 'win32') cancelWindowsWake()
}

/** Keep the machine awake briefly while a heartbeat runs, then release */
function keepAwakeDuring<T>(promise: Promise<T>): Promise<T> {
  if (process.platform === 'darwin') {
    const proc = spawn('caffeinate', ['-i', '-t', '180'], { stdio: 'ignore', detached: false })
    proc.on('error', () => {})
    return promise.finally(() => { proc.kill() })
  }
  if (process.platform === 'win32') {
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED — prevents sleep during execution
    try {
      execSync(
        'powershell -NoProfile -Command "[System.Runtime.InteropServices.Marshal]::' +
        'GetDelegateForFunctionPointer((Add-Type -MemberDefinition \'[DllImport(' +
        '\\\"kernel32.dll\\\")] public static extern uint SetThreadExecutionState(uint f);\' ' +
        '-Name W -PassThru)::SetThreadExecutionState, [Func[uint,uint]]).Invoke(0x80000001)"',
        { stdio: 'ignore', timeout: 5000 }
      )
    } catch {}
    return promise.finally(() => {
      // Clear: ES_CONTINUOUS alone resets to normal
      try {
        execSync(
          'powershell -NoProfile -Command "[System.Runtime.InteropServices.Marshal]::' +
          'GetDelegateForFunctionPointer((Add-Type -MemberDefinition \'[DllImport(' +
          '\\\"kernel32.dll\\\")] public static extern uint SetThreadExecutionState(uint f);\' ' +
          '-Name W2 -PassThru)::SetThreadExecutionState, [Func[uint,uint]]).Invoke(0x80000000)"',
          { stdio: 'ignore', timeout: 5000 }
        )
      } catch {}
    })
  }
  return promise
}

// ── Scheduler ───────────────────────────────────────────────────────────────

export interface SchedulerCallbacks {
  onHeartbeat?: (status: 'started' | 'done' | 'skipped' | 'escalated', summary?: string) => void
}

/** Call when heartbeat_interval or active hours change — reschedules the next wake immediately */
export async function onHeartbeatSettingsChanged(dataDir: string): Promise<void> {
  const settings = await readSettings(dataDir).catch(() => null)
  if (!settings) return

  const interval = settings.heartbeat_interval ?? 60
  if (interval <= 0 || !isActiveNow(settings)) {
    cancelScheduledWake()
    console.log('[Scheduler] Wake cancelled — heartbeat disabled or outside active hours')
    return
  }

  // Reschedule from now with the new interval
  scheduleWake(new Date(Date.now() + interval * 60 * 1000))
  console.log(`[Scheduler] Rescheduled — next wake in ${interval} min`)
}

export function startScheduler(agent: Agent, dataDir: string, callbacks?: SchedulerCallbacks): void {
  // Daily memory cleanup — 3am
  cron.schedule('0 3 * * *', () => {
    agent.handleTrigger({ source: 'memory_cleanup' })
  })

  // Configurable heartbeat — check every minute, fire when interval elapsed
  let lastHeartbeat = 0
  cron.schedule('* * * * *', async () => {
    const settings = await readSettings(dataDir)
    const interval = settings.heartbeat_interval ?? 60
    if (interval <= 0) {
      cancelScheduledWake()
      return
    }

    const now = Date.now()
    if (now - lastHeartbeat < interval * 60 * 1000) return

    if (!isActiveNow(settings)) {
      console.log('[Scheduler] Outside active hours — skipping heartbeat')
      cancelScheduledWake()
      callbacks?.onHeartbeat?.('skipped')
      return
    }

    lastHeartbeat = now

    await purgeEventStore(dataDir).catch((err) =>
      console.error('[Scheduler] Purge failed:', err.message)
    )

    callbacks?.onHeartbeat?.('started')
    try {
      await keepAwakeDuring(agent.handleTrigger({ source: 'heartbeat' }))
      callbacks?.onHeartbeat?.('done')
    } catch (err: any) {
      console.error('[Scheduler] Heartbeat error:', err.message)
      callbacks?.onHeartbeat?.('done')
    }

    // Schedule machine to wake for the next heartbeat
    scheduleWake(new Date(now + interval * 60 * 1000))
  })

  // On startup: schedule first wake if active
  ;(async () => {
    const settings = await readSettings(dataDir).catch(() => null)
    if (settings && isActiveNow(settings)) {
      const interval = settings.heartbeat_interval ?? 60
      if (interval > 0) {
        scheduleWake(new Date(Date.now() + interval * 60 * 1000))
      }
    }
  })()
}
