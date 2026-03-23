// Starts backend server + vite for Tauri dev mode. Handles port conflicts automatically.

const { spawn, execSync } = require('child_process')
const { join } = require('path')
const net = require('net')

const SERVER_PORT = 7830
const VITE_PORT = 1420
const ROOT = join(__dirname, '..')
const children = []

function killPort(port) {
  try {
    const pids = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf-8' }).trim()
    if (pids) {
      for (const pid of pids.split('\n')) {
        try { process.kill(parseInt(pid), 'SIGTERM') } catch {}
      }
      return true
    }
  } catch {}
  return false
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => { s.close(); resolve(true) })
    s.listen(port, '127.0.0.1')
  })
}

async function waitForPort(port, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (!(await isPortFree(port))) return true
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

function cleanup() {
  for (const child of children) {
    try { child.kill('SIGTERM') } catch {}
  }
}

process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(0) })
process.on('SIGTERM', () => { cleanup(); process.exit(0) })

async function main() {
  // Free up ports if stale processes are holding them
  if (!(await isPortFree(VITE_PORT))) {
    console.log('[dev] Port', VITE_PORT, 'in use — killing stale process')
    killPort(VITE_PORT)
    await new Promise(r => setTimeout(r, 500))
  }

  // Start backend server if not running
  if (await isPortFree(SERVER_PORT)) {
    console.log('[dev] Starting backend server...')
    const server = spawn('node', [join(ROOT, 'packages/agent-core/dist/server.js')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    })
    children.push(server)
    server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`))
    server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
    server.on('exit', (code) => {
      if (code && code !== 0) console.error(`[dev] Server exited with code ${code}`)
    })

    const ready = await waitForPort(SERVER_PORT)
    if (!ready) {
      console.error('[dev] Server failed to start within 15s')
      cleanup()
      process.exit(1)
    }
    console.log('[dev] Backend server ready')
  } else {
    console.log('[dev] Backend server already running')
  }

  // Start vite
  const vite = spawn('npx', ['vite'], {
    stdio: 'inherit',
    cwd: join(ROOT, 'apps/desktop'),
    env: { ...process.env }
  })
  children.push(vite)
  vite.on('exit', (code) => { cleanup(); process.exit(code ?? 0) })
}

main().catch((err) => {
  console.error('[dev] Fatal:', err)
  process.exit(1)
})
