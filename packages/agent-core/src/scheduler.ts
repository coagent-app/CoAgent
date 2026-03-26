import cron from 'node-cron'
import { execSync, spawn } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import type { Agent } from './agent.js'
import { purgeEventStore } from './relay-client.js'
import { readSettings, isActiveNow } from './settings.js'
import { extractInsights } from './service-logger.js'
import { pruneOldEntries } from './usage-tracker.js'

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
  onTodoStream?: (type: 'start' | 'chunk' | 'tool' | 'done', data?: any) => void
}

export interface SchedulerHandle {
  rescheduleHeartbeat: () => void
}

export function startScheduler(agent: Agent, dataDir: string, callbacks?: SchedulerCallbacks): SchedulerHandle {
  // ── 3 AM: memory updates + cleanup (single Haiku call) ──

  // Schedule a wake so the Mac doesn't sleep through the 3 AM job
  function scheduleNightlyWake(): void {
    const now = new Date()
    const next3am = new Date(now)
    next3am.setHours(3, 0, 0, 0)
    if (next3am <= now) next3am.setDate(next3am.getDate() + 1)
    scheduleWake(next3am)
  }
  scheduleNightlyWake()

  cron.schedule('0 3 * * *', async () => {
    try {
      const { tools: allTools, serverMap } = await agent.mcpManager.getAllTools()
      const memoryTools = allTools.filter(t => serverMap.get(t.name) === 'memory')
      const callMemoryTool = (tool: string, args: Record<string, unknown>) =>
        agent.mcpManager.callTool('memory', tool, args)
      await keepAwakeDuring(extractInsights(dataDir, memoryTools, callMemoryTool))
      await pruneOldEntries(dataDir)
      console.log('[Scheduler] 3 AM job complete (memory updates + cleanup)')
    } catch (err: any) {
      console.error('[Scheduler] 3 AM job failed:', err.message)
    }
    // Schedule tomorrow's wake
    scheduleNightlyWake()
  })

  // ── Task timer: fires at exact due time, no polling ────────────────────────

  let taskTimer: ReturnType<typeof setTimeout> | null = null
  const firedTasks = new Set<string>()

  async function fireDueTasks(): Promise<void> {
    // Tasks always fire regardless of active hours — if you set a reminder, it fires.

    const due = agent.calendar.getTasksDue().filter(e => e.due)
    for (const item of due) {
      if (firedTasks.has(item.id)) continue
      firedTasks.add(item.id)
      console.log(`[Scheduler] Task due — firing: "${item.label}" (${item.id})`)
      // Notify UI: inject the trigger as a user message and stream the response
      callbacks?.onTodoStream?.('start', { task: item.label, due: item.due, context: item.instruction })
      try {
        let streamed = ''
        await keepAwakeDuring(
          agent.handleTrigger(
            {
              source: 'todo_due',
              payload: { todoId: item.id, task: item.label, due: item.due, context: item.instruction }
            },
            (chunk) => {
              streamed += chunk
              callbacks?.onTodoStream?.('chunk', { text: chunk })
            },
            (tool, label) => {
              callbacks?.onTodoStream?.('tool', { tool, label })
            }
          )
        )
        callbacks?.onTodoStream?.('done', { response: streamed })
      } catch (err: any) {
        console.error(`[Scheduler] Task execution error (${item.id}):`, err.message)
      }
    }
    // After firing, reschedule for the next due task
    scheduleTaskTimer()
  }

  function scheduleTaskTimer(): void {
    if (taskTimer) clearTimeout(taskTimer)
    taskTimer = null

    const next = agent.calendar.getNextTaskTime()
    if (!next) return

    const delay = Math.max(next.getTime() - Date.now(), 0)
    console.log(`[Scheduler] Next task fires in ${Math.round(delay / 1000)}s at ${next.toLocaleString()}`)
    taskTimer = setTimeout(() => fireDueTasks(), delay)
    scheduleWake(next)
  }

  // ── Routine cron timers ─────────────────────────────────────────────────────

  const routineJobs = new Map<string, cron.ScheduledTask>()

  function syncRoutineTimers(): void {
    const routines = agent.calendar.getRoutines()
    const activeIds = new Set(routines.map(r => r.id))

    // Remove timers for deleted/disabled routines
    for (const [id, job] of routineJobs) {
      if (!activeIds.has(id)) {
        job.stop()
        routineJobs.delete(id)
      }
    }

    // Add timers for new routines
    for (const routine of routines) {
      if (routineJobs.has(routine.id)) continue
      if (!cron.validate(routine.cron!)) {
        console.warn(`[Scheduler] Invalid cron for "${routine.label}": ${routine.cron}`)
        continue
      }
      const job = cron.schedule(routine.cron!, async () => {
        if (!isActiveNow(await readSettings(dataDir))) {
          console.log(`[Scheduler] Outside active hours — skipping routine "${routine.label}"`)
          return
        }
        console.log(`[Scheduler] Routine firing: "${routine.label}"`)
        callbacks?.onHeartbeat?.('started', `Routine: ${routine.label}`)
        try {
          await keepAwakeDuring(
            agent.handleTrigger({
              source: 'routine' as any,
              payload: { id: routine.id, label: routine.label, instruction: routine.instruction }
            })
          )
          callbacks?.onHeartbeat?.('done', `Routine completed: ${routine.label}`)
        } catch (err: any) {
          console.error(`[Scheduler] Routine error (${routine.id}):`, err.message)
          callbacks?.onHeartbeat?.('done')
        }
      })
      routineJobs.set(routine.id, job)
      console.log(`[Scheduler] Registered routine: "${routine.label}" (${routine.cron})`)
    }
  }

  // ── Heartbeat timer: fires at exact interval, no polling ───────────────────

  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null

  async function fireHeartbeat(): Promise<void> {
    const settings = await readSettings(dataDir)
    const interval = settings.heartbeat_interval ?? 60
    if (interval <= 0) { cancelScheduledWake(); return }
    if (!isActiveNow(settings)) {
      console.log('[Scheduler] Outside active hours — skipping heartbeat')
      cancelScheduledWake()
      callbacks?.onHeartbeat?.('skipped')
      scheduleHeartbeatTimer()
      return
    }

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

    scheduleHeartbeatTimer()
  }

  function scheduleHeartbeatTimer(): void {
    if (heartbeatTimer) clearTimeout(heartbeatTimer)
    heartbeatTimer = null

    readSettings(dataDir).then(settings => {
      const interval = settings.heartbeat_interval ?? 60
      if (interval <= 0) return

      const delay = interval * 60 * 1000
      const wakeAt = new Date(Date.now() + delay)
      console.log(`[Scheduler] Next heartbeat in ${interval}min at ${wakeAt.toLocaleString()}`)
      heartbeatTimer = setTimeout(() => fireHeartbeat(), delay)

      // Wake at whichever is sooner: heartbeat, next task, or 3 AM nightly job
      const nextTask = agent.calendar.getNextTaskTime()
      const now = new Date()
      const next3am = new Date(now)
      next3am.setHours(3, 0, 0, 0)
      if (next3am <= now) next3am.setDate(next3am.getDate() + 1)
      const candidates = [wakeAt, next3am]
      if (nextTask) candidates.push(nextTask)
      const earliestWake = candidates.reduce((a, b) => a < b ? a : b)
      scheduleWake(earliestWake)
    }).catch(() => {})
  }

  // ── Exports for external callers (settings change, todo change) ────────────

  // Exposed via onCalendarChanged callback on Agent
  const origOnCalendarChanged = agent.onCalendarChanged
  agent.onCalendarChanged = () => {
    origOnCalendarChanged?.()
    scheduleTaskTimer()
    syncRoutineTimers()
  }

  // ── Startup: fire any overdue tasks, register routines, then schedule timers ─

  ;(async () => {
    syncRoutineTimers()
    await fireDueTasks()
    scheduleHeartbeatTimer()
  })()

  return { rescheduleHeartbeat: scheduleHeartbeatTimer }
}
