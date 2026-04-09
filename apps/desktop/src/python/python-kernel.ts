/**
 * Python kernel controller — manages a pool of Pyodide Web Workers.
 *
 * - Pool of MAX_WORKERS workers, LRU evicted when full
 * - Each worker is owned by at most one conversation at a time
 * - Conversation kernel state (imports, in-memory variables) is lost on
 *   eviction; workspace state (files on disk) is unaffected
 * - Eager preload of one worker on app launch via primeKernelPool()
 * - Cancel = worker.terminate() + spawn fresh into the same slot
 * - Default 60s wall-clock timeout per call
 */

const MAX_WORKERS = 3
const DEFAULT_TIMEOUT_MS = 60_000
const IDLE_EVICT_MS = 30 * 60 * 1000 // 30 min

export type ExecutionEvent =
  | { type: 'stdout'; line: string }
  | { type: 'stderr'; line: string }
  | { type: 'image'; dataUrl: string }
  | { type: 'done'; resultRepr?: string; durationMs: number }
  | { type: 'error'; errorType: string; message: string; traceback: string }
  | { type: 'cancelled'; reason: 'user' | 'timeout' }

export interface ExecuteOptions {
  conversationId: string
  code: string
  timeoutMs?: number
  onEvent: (event: ExecutionEvent) => void
}

interface WorkerSlot {
  id: number
  worker: Worker
  conversationId: string | null
  ready: boolean
  readyPromise: Promise<void>
  lastUsedAt: number
  currentRequestId: string | null
  currentTimeout: ReturnType<typeof setTimeout> | null
  currentOnEvent: ((event: ExecutionEvent) => void) | null
}

let nextSlotId = 1
const pool: WorkerSlot[] = []

function createWorker(): Worker {
  // Vite supports `new URL(..., import.meta.url)` for worker bundling.
  return new Worker(new URL('./pyodide-worker.ts', import.meta.url), { type: 'module' })
}

function spawnSlot(): WorkerSlot {
  const worker = createWorker()
  const slot: WorkerSlot = {
    id: nextSlotId++,
    worker,
    conversationId: null,
    ready: false,
    readyPromise: new Promise<void>((resolve, reject) => {
      const onMessage = (e: MessageEvent) => {
        const msg = e.data
        if (msg?.type === 'ready') {
          slot.ready = true
          worker.removeEventListener('message', onMessage)
          resolve()
        } else if (msg?.type === 'init_error') {
          worker.removeEventListener('message', onMessage)
          reject(new Error(msg.error))
        }
      }
      worker.addEventListener('message', onMessage)
    }),
    lastUsedAt: Date.now(),
    currentRequestId: null,
    currentTimeout: null,
    currentOnEvent: null,
  }

  worker.addEventListener('message', (e: MessageEvent) => handleWorkerMessage(slot, e.data))
  worker.addEventListener('error', (e) => {
    console.error(`[python-kernel] worker ${slot.id} errored:`, e.message || e)
  })

  worker.postMessage({ type: 'init' })
  pool.push(slot)
  return slot
}

function handleWorkerMessage(slot: WorkerSlot, msg: unknown) {
  if (!msg || typeof msg !== 'object') return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = msg as any
  if (m.type === 'ready' || m.type === 'init_error') return // handled in spawnSlot
  if (slot.currentRequestId !== m.requestId) return
  const onEvent = slot.currentOnEvent
  if (!onEvent) return

  if (m.type === 'stdout') {
    onEvent({ type: 'stdout', line: m.line })
  } else if (m.type === 'stderr') {
    onEvent({ type: 'stderr', line: m.line })
  } else if (m.type === 'image') {
    onEvent({ type: 'image', dataUrl: m.dataUrl })
  } else if (m.type === 'done') {
    finishRequest(slot)
    onEvent({ type: 'done', resultRepr: m.resultRepr, durationMs: m.durationMs })
  } else if (m.type === 'error') {
    finishRequest(slot)
    onEvent({
      type: 'error',
      errorType: m.errorType,
      message: m.message,
      traceback: m.traceback,
    })
  }
}

function finishRequest(slot: WorkerSlot) {
  if (slot.currentTimeout) {
    clearTimeout(slot.currentTimeout)
    slot.currentTimeout = null
  }
  slot.currentRequestId = null
  slot.currentOnEvent = null
  slot.lastUsedAt = Date.now()
}

/**
 * Pick (or create) a worker for this conversation. If the conversation
 * already owns a worker, reuse it. Otherwise grab an idle slot, evict
 * the LRU if pool is full.
 */
async function getSlotForConversation(conversationId: string): Promise<WorkerSlot> {
  // 1. Already-owning slot wins
  let slot = pool.find(s => s.conversationId === conversationId && s.currentRequestId == null)
  if (slot) return waitReady(slot)

  // 2. Free slot in pool (no owner) wins
  slot = pool.find(s => s.conversationId == null && s.currentRequestId == null)
  if (slot) {
    slot.conversationId = conversationId
    return waitReady(slot)
  }

  // 3. Pool not full → spawn new
  if (pool.length < MAX_WORKERS) {
    slot = spawnSlot()
    slot.conversationId = conversationId
    return waitReady(slot)
  }

  // 4. Pool full → evict LRU idle slot
  const lru = pool
    .filter(s => s.currentRequestId == null)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
  if (!lru) {
    throw new Error('All Python workers busy and no idle slot to evict')
  }
  evictSlot(lru)
  // Replace evicted slot with a fresh worker assigned to this conversation
  const fresh = spawnSlot()
  fresh.conversationId = conversationId
  return waitReady(fresh)
}

async function waitReady(slot: WorkerSlot): Promise<WorkerSlot> {
  if (!slot.ready) await slot.readyPromise
  return slot
}

function evictSlot(slot: WorkerSlot) {
  try {
    slot.worker.terminate()
  } catch {
    /* ignore */
  }
  const idx = pool.indexOf(slot)
  if (idx >= 0) pool.splice(idx, 1)
}

/**
 * Execute Python code in the worker assigned to this conversation.
 * Streams stdout/stderr via onEvent. Resolves when the worker reports
 * done/error/cancelled.
 */
export async function executePython(opts: ExecuteOptions): Promise<void> {
  const slot = await getSlotForConversation(opts.conversationId)
  if (slot.currentRequestId) {
    throw new Error(`Worker ${slot.id} already has a pending request`)
  }
  const requestId = `${slot.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  slot.currentRequestId = requestId
  slot.currentOnEvent = opts.onEvent
  slot.lastUsedAt = Date.now()

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  slot.currentTimeout = setTimeout(() => {
    if (slot.currentRequestId !== requestId) return
    // Timeout: terminate this worker and replace it with a fresh one
    // pinned to the same conversation so the next call doesn't re-pay cold start
    const conv = slot.conversationId
    const onEvent = slot.currentOnEvent
    finishRequest(slot)
    evictSlot(slot)
    const fresh = spawnSlot()
    fresh.conversationId = conv
    onEvent?.({ type: 'cancelled', reason: 'timeout' })
  }, timeoutMs)

  slot.worker.postMessage({ type: 'execute', requestId, code: opts.code })
}

/**
 * User-initiated cancel for any in-flight request on a conversation's worker.
 * Terminates the worker and replaces it with a fresh one in the same slot.
 */
export function cancelConversation(conversationId: string) {
  const slot = pool.find(s => s.conversationId === conversationId && s.currentRequestId != null)
  if (!slot) return
  const onEvent = slot.currentOnEvent
  finishRequest(slot)
  evictSlot(slot)
  const fresh = spawnSlot()
  fresh.conversationId = conversationId
  onEvent?.({ type: 'cancelled', reason: 'user' })
}

/**
 * Eagerly spawn one worker on app launch so the first user request has
 * no cold-start latency. Safe to call multiple times — no-op if pool
 * already has a ready worker.
 */
export function primeKernelPool() {
  if (pool.length > 0) return
  spawnSlot()
}

/**
 * Idle eviction sweep — terminate workers that haven't been used in 30 min.
 * Should be called from a timer in the app shell.
 */
export function sweepIdleWorkers() {
  const now = Date.now()
  for (const slot of [...pool]) {
    if (slot.currentRequestId != null) continue
    if (now - slot.lastUsedAt > IDLE_EVICT_MS) {
      evictSlot(slot)
    }
  }
}

// Expose for browser-console testing during development
if (typeof window !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).__pythonKernel = {
    executePython,
    cancelConversation,
    primeKernelPool,
    sweepIdleWorkers,
    poolStatus: () => pool.map(s => ({
      id: s.id,
      conversationId: s.conversationId,
      ready: s.ready,
      busy: s.currentRequestId != null,
      lastUsedAt: s.lastUsedAt,
    })),
  }
}
