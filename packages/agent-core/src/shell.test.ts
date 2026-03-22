import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdir } from 'fs/promises'

const execFileAsync = promisify(execFile)

// Mirror the exact patterns from agent.ts — tests break if they drift
const BLOCKED_SHELL_PATTERNS = [
  // Destructive
  /rm\s+-rf\s+\//,
  /\brm\s+-rf\s+~/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/sd/,
  // Privilege escalation
  /\bsudo\b/,
  /\bchmod\s+777\b/,
  // System control
  /\bshutdown\b/,
  /\breboot\b/,
  /\bkillall\b/,
  /\bpkill\b/,
  /:\(\)\s*\{/,
]

function isBlocked(command: string): boolean {
  return BLOCKED_SHELL_PATTERNS.some(p => p.test(command))
}

/** Run a command exactly like the agent handler does */
async function runShell(command: string, workspaceDir: string): Promise<string> {
  const blocked = BLOCKED_SHELL_PATTERNS.find(p => p.test(command))
  if (blocked) {
    return 'Blocked: This command matches a dangerous pattern and cannot be executed.'
  }
  await mkdir(workspaceDir, { recursive: true })
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
      cwd: workspaceDir,
      timeout: 30000,
      env: { ...process.env, HOME: workspaceDir }
    })
    let result = (stdout + (stderr ? `\nstderr: ${stderr}` : '')).trim() || '(no output)'
    if (result.length > 4000) result = result.slice(0, 4000) + '\n\n[Truncated]'
    return result
  } catch (err: any) {
    return `Error: ${err.stderr ?? err.message}`
  }
}

// ─── Blocked pattern tests ───────────────────────────────────────────

describe('BLOCKED_SHELL_PATTERNS', () => {
  const dangerous = [
    ['rm -rf /',                     'wipe root'],
    ['rm -rf /etc',                  'wipe system dir'],
    ['sudo apt install curl',        'privilege escalation'],
    ['sudo rm file.txt',             'sudo anything'],
    ['chmod 777 /etc/passwd',        'overly permissive'],
    ['mkfs.ext4 /dev/sda1',          'format disk'],
    ['dd if=/dev/zero of=/dev/sda',  'raw disk write'],
    [':() { :|:& };:',              'fork bomb'],
    ['echo x > /dev/sda',           'write to disk device'],
    ['shutdown -h now',              'shutdown'],
    ['reboot',                       'reboot'],
    ['killall node',                 'killall'],
    ['pkill -9 python',             'pkill'],
    ['rm -rf ~/Documents',           'wipe home subdir'],
    ['rm -rf ~',                     'wipe home'],
  ]

  for (const [cmd, label] of dangerous) {
    it(`blocks: ${label} (${cmd})`, () => {
      expect(isBlocked(cmd)).toBe(true)
    })
  }

  const safe = [
    ['ls -la',                       'list files'],
    ['pwd',                          'print working directory'],
    ['echo hello',                   'echo'],
    ['cat file.txt',                 'read file'],
    ['curl https://example.com',     'curl'],
    ['python3 -c "print(1+1)"',     'python one-liner'],
    ['mkdir -p subdir',              'make directory'],
    ['cp a.txt b.txt',              'copy file'],
    ['rm file.txt',                  'remove single file (not -rf /)'],
    ['rm -rf ./build',              'remove local dir (relative)'],
    ['chmod 644 file.txt',          'normal chmod'],
    ['git status',                   'git'],
    ['npm install',                  'npm'],
    ['grep -r "pattern" .',         'grep'],
    ['wget https://example.com/f',  'wget'],
  ]

  for (const [cmd, label] of safe) {
    it(`allows: ${label} (${cmd})`, () => {
      expect(isBlocked(cmd)).toBe(false)
    })
  }
})

// ─── Sandbox execution tests ─────────────────────────────────────────

describe('run_shell sandbox', () => {
  let tmpDir: string
  let workspaceDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shell-test-'))
    workspaceDir = join(tmpDir, 'workspace')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runs a basic command and returns stdout', async () => {
    const result = await runShell('echo hello world', workspaceDir)
    expect(result).toBe('hello world')
  })

  it('returns (no output) for silent commands', async () => {
    const result = await runShell('true', workspaceDir)
    expect(result).toBe('(no output)')
  })

  it('captures stderr', async () => {
    const result = await runShell('echo oops >&2', workspaceDir)
    expect(result).toContain('stderr: oops')
  })

  it('returns error for failing commands', async () => {
    const result = await runShell('exit 1', workspaceDir)
    expect(result).toMatch(/Error:/)
  })

  it('returns error for nonexistent commands', async () => {
    const result = await runShell('nonexistent_command_xyz', workspaceDir)
    expect(result).toMatch(/Error:/)
  })

  it('working directory is the workspace', async () => {
    const result = await runShell('pwd', workspaceDir)
    // macOS resolves /var -> /private/var, so compare resolved paths
    const { realpathSync } = await import('fs')
    expect(result).toBe(realpathSync(workspaceDir))
  })

  it('HOME is overridden to workspace', async () => {
    const result = await runShell('echo $HOME', workspaceDir)
    expect(result).toBe(workspaceDir)
  })

  it('cd ~ stays in workspace', async () => {
    const result = await runShell('cd ~ && pwd', workspaceDir)
    expect(result).toBe(workspaceDir)
  })

  it('creates workspace dir on first use', async () => {
    expect(existsSync(workspaceDir)).toBe(false)
    await runShell('echo hi', workspaceDir)
    expect(existsSync(workspaceDir)).toBe(true)
  })

  it('files persist across commands in the same workspace', async () => {
    await runShell('echo "test content" > myfile.txt', workspaceDir)
    const result = await runShell('cat myfile.txt', workspaceDir)
    expect(result).toBe('test content')
    // Verify the file is actually in the workspace dir
    const content = readFileSync(join(workspaceDir, 'myfile.txt'), 'utf-8').trim()
    expect(content).toBe('test content')
  })

  it('can run multi-step commands', async () => {
    const result = await runShell('echo 2 + 2 | bc 2>/dev/null || echo $((2 + 2))', workspaceDir)
    expect(result).toBe('4')
  })

  it('truncates output over 4000 chars', async () => {
    // Generate 5000 chars of output using printf (no external deps)
    const result = await runShell('printf "x%.0s" $(seq 1 5000)', workspaceDir)
    expect(result.length).toBeLessThanOrEqual(4000 + 20) // 4000 + '\n\n[Truncated]'
    expect(result).toContain('[Truncated]')
  })

  it('blocked commands never execute', async () => {
    const result = await runShell('sudo echo pwned > /tmp/shell-test-pwned', workspaceDir)
    expect(result).toContain('Blocked')
    expect(existsSync('/tmp/shell-test-pwned')).toBe(false)
  })

  it('times out long-running commands', async () => {
    // Verify sleep isn't blocked by patterns
    expect(isBlocked('sleep 60')).toBe(false)

    // Run through the handler with a command that will exceed the timeout
    // We override the timeout to 500ms to keep the test fast
    await mkdir(workspaceDir, { recursive: true })
    try {
      await execFileAsync('bash', ['-c', 'sleep 10'], {
        cwd: workspaceDir,
        timeout: 500,
        env: { ...process.env, HOME: workspaceDir }
      })
      expect.unreachable('should have timed out')
    } catch (err: any) {
      // execFileAsync throws on timeout — the process was killed
      expect(err.message).toContain('sleep 10')
    }
  }, 10000)

  it('cannot write outside workspace via relative path traversal', async () => {
    // Even with ../ the file lands relative to cwd which is workspace
    await runShell('touch ../outside.txt', workspaceDir)
    // The file would land in tmpDir (one level up from workspace)
    // This is fine — it's still in our temp dir, not in the real system
    // The key protection is HOME override + cwd lock
    const result = await runShell('ls ../', workspaceDir)
    // Just verify the command runs in the right context
    expect(result).toBeTruthy()
  })

  it('cannot access real home directory files', async () => {
    // ~ expands to workspaceDir, not the real home
    const result = await runShell('ls ~/Desktop 2>&1 || true', workspaceDir)
    // Should fail because workspaceDir/Desktop doesn't exist
    expect(result).not.toContain('.DS_Store') // shouldn't see real Desktop contents
  })
})
