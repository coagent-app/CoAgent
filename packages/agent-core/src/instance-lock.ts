import { openSync, writeSync, closeSync, readFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * Cross-instance lock so only one Co-Agent process can own a given data dir.
 *
 * Why: `~/.coagent/` is full of JSON files rewritten on every change. If a dev
 * build (`pnpm tauri dev`) and the installed production app both run against
 * the same data dir, their writes race and can corrupt queue, chat history,
 * file index, etc. The feedback memory `feedback_kill_production_app.md`
 * documents this class of bug.
 *
 * Mechanism: atomic exclusive create of `<dataDir>/.instance.lock` containing
 * pid + start time. On startup, if the lock exists and its pid is still alive,
 * we refuse to start and print a clear message. If the pid is dead (previous
 * crash, stale lock), we take over. On clean shutdown the lock is removed.
 */

export interface InstanceLockHandle {
  release(): void
}

interface LockFileContents {
  pid: number
  startedAt: string
  bin: string
}

export class InstanceLockError extends Error {
  readonly holder: LockFileContents
  constructor(holder: LockFileContents) {
    super(
      `Another Co-Agent instance is already running:\n` +
      `  PID: ${holder.pid}\n` +
      `  Started: ${holder.startedAt}\n` +
      `  Binary: ${holder.bin}\n\n` +
      `Close the other instance before starting this one.\n` +
      `On macOS: Activity Monitor → search "Co-Agent" → force quit.`
    )
    this.name = 'InstanceLockError'
    this.holder = holder
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    // Signal 0 doesn't actually send a signal — just tests whether the target
    // exists and we have permission to signal it. Throws ESRCH if no such pid.
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    // EPERM means the process exists but we can't signal it — still alive.
    if (err?.code === 'EPERM') return true
    return false
  }
}

function readLock(lockPath: string): LockFileContents | null {
  try {
    const raw = readFileSync(lockPath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.pid !== 'number') return null
    return {
      pid: parsed.pid,
      startedAt: String(parsed.startedAt ?? ''),
      bin: String(parsed.bin ?? ''),
    }
  } catch {
    return null
  }
}

function writeLock(lockPath: string, contents: LockFileContents): void {
  // 'wx' → fail if file exists. Atomic on POSIX.
  const fd = openSync(lockPath, 'wx')
  try {
    writeSync(fd, JSON.stringify(contents, null, 2))
  } finally {
    closeSync(fd)
  }
}

/**
 * Acquire an exclusive lock on `dataDir`. Throws `InstanceLockError` if
 * another live process already holds the lock.
 *
 * The returned handle's `release()` removes the lock file. It is idempotent
 * and safe to call from both normal shutdown and signal handlers.
 */
export function acquireInstanceLock(dataDir: string): InstanceLockHandle {
  const lockPath = join(dataDir, '.instance.lock')
  const ourContents: LockFileContents = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    bin: process.execPath,
  }

  // Try atomic create first (happy path).
  try {
    writeLock(lockPath, ourContents)
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err

    // Lock exists — check if the holder is still alive.
    const existing = readLock(lockPath)
    if (existing && isProcessAlive(existing.pid) && existing.pid !== process.pid) {
      throw new InstanceLockError(existing)
    }

    // Stale lock (unreadable, dead pid, or — improbably — our own pid).
    // Remove it and try once more. Any failure here bubbles up naturally.
    try { unlinkSync(lockPath) } catch { /* already gone — fine */ }
    writeLock(lockPath, ourContents)
  }

  let released = false
  const release = (): void => {
    if (released) return
    released = true
    try {
      // Only remove the lock if it's still ours — defensive against the case
      // where another instance forcibly took over.
      const current = readLock(lockPath)
      if (current && current.pid === process.pid) {
        unlinkSync(lockPath)
      }
    } catch { /* best-effort */ }
  }

  // Catch-all: ensure the lock is released if the process exits without
  // going through the signal handlers in server.ts.
  process.once('exit', release)

  return { release }
}
