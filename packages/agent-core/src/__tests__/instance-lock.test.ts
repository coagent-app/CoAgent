import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { acquireInstanceLock, InstanceLockError } from '../instance-lock.js'

describe('acquireInstanceLock', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'coagent-lock-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a lock file on a clean dir', () => {
    const handle = acquireInstanceLock(dir)
    const lockPath = join(dir, '.instance.lock')
    expect(existsSync(lockPath)).toBe(true)
    const contents = JSON.parse(readFileSync(lockPath, 'utf-8'))
    expect(contents.pid).toBe(process.pid)
    expect(typeof contents.startedAt).toBe('string')
    expect(typeof contents.bin).toBe('string')
    handle.release()
  })

  it('removes the lock on release', () => {
    const handle = acquireInstanceLock(dir)
    const lockPath = join(dir, '.instance.lock')
    expect(existsSync(lockPath)).toBe(true)
    handle.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('release is idempotent', () => {
    const handle = acquireInstanceLock(dir)
    handle.release()
    expect(() => handle.release()).not.toThrow()
  })

  it('throws InstanceLockError if a live process holds the lock', () => {
    // Plant a lock held by a pid that is guaranteed alive AND not us: pid 1
    // (init/launchd on macOS/Linux). Signaling it as a non-root user yields
    // EPERM, which isProcessAlive() correctly treats as "alive".
    const lockPath = join(dir, '.instance.lock')
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 1,
        startedAt: new Date().toISOString(),
        bin: '/fake/other-instance',
      })
    )

    expect(() => acquireInstanceLock(dir)).toThrow(InstanceLockError)

    // Original lock preserved — we didn't overwrite someone else's work.
    const still = JSON.parse(readFileSync(lockPath, 'utf-8'))
    expect(still.bin).toBe('/fake/other-instance')
  })

  it('takes over a stale lock with a dead pid', () => {
    // pid 1 is init/launchd — but a pid that is essentially guaranteed to not
    // belong to a Co-Agent instance. Use a safer sentinel: a pid we know is
    // dead. Spawn-and-kill would be cleanest, but we can pick a very high pid
    // that is extremely unlikely to be in use.
    const DEAD_PID = 999_999
    const lockPath = join(dir, '.instance.lock')
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: DEAD_PID,
        startedAt: '2020-01-01T00:00:00.000Z',
        bin: '/old/crashed-instance',
      })
    )

    const handle = acquireInstanceLock(dir)
    const contents = JSON.parse(readFileSync(lockPath, 'utf-8'))
    expect(contents.pid).toBe(process.pid)
    expect(contents.bin).not.toBe('/old/crashed-instance')
    handle.release()
  })

  it('handles a corrupt lock file by taking over', () => {
    const lockPath = join(dir, '.instance.lock')
    writeFileSync(lockPath, 'not-json-at-all{{{')

    const handle = acquireInstanceLock(dir)
    const contents = JSON.parse(readFileSync(lockPath, 'utf-8'))
    expect(contents.pid).toBe(process.pid)
    handle.release()
  })

  it('release is safe when another process has taken over', () => {
    const handle = acquireInstanceLock(dir)
    const lockPath = join(dir, '.instance.lock')
    // Simulate another instance taking over by overwriting the lock contents
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 12345,
        startedAt: new Date().toISOString(),
        bin: '/other',
      })
    )
    // Release should NOT remove the lock — it's not ours anymore
    handle.release()
    expect(existsSync(lockPath)).toBe(true)
    const contents = JSON.parse(readFileSync(lockPath, 'utf-8'))
    expect(contents.pid).toBe(12345)
  })
})
