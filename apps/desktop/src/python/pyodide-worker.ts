/**
 * Pyodide Web Worker — runs Python code in a WASM-isolated sandbox.
 *
 * Communication protocol (main thread ↔ worker):
 *
 *   → main → worker                  ← worker → main
 *   ─────────────────────             ──────────────────────
 *   { type: 'init' }                  { type: 'ready' }
 *                                     { type: 'init_error', error }
 *
 *   { type: 'execute',                { type: 'stdout', requestId, line }
 *     requestId, code }               { type: 'stderr', requestId, line }
 *                                     { type: 'done', requestId,
 *                                         resultRepr?, durationMs }
 *                                     { type: 'error', requestId,
 *                                         errorType, message, traceback }
 *
 * Cancellation: main thread calls worker.terminate() and spawns a new
 * worker — Pyodide cannot be soft-interrupted reliably. The kernel
 * controller handles re-spawning into the same pool slot.
 */

// Pyodide is loaded from /pyodide/pyodide.mjs (copied by scripts/copy-pyodide.mjs).
// We use dynamic import inside the worker so the bundler doesn't try to
// resolve the URL at build time.

interface PyodideAPI {
  runPythonAsync: (code: string) => Promise<unknown>
  setStdout: (opts: { batched: (s: string) => void }) => void
  setStderr: (opts: { batched: (s: string) => void }) => void
  loadPackage?: (
    names: string[] | string,
    options?: { messageCallback?: (s: string) => void; errorCallback?: (s: string) => void },
  ) => Promise<void>
  loadPackagesFromImports?: (
    code: string,
    options?: { messageCallback?: (s: string) => void; errorCallback?: (s: string) => void },
  ) => Promise<void>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globals: any
}

let pyodide: PyodideAPI | null = null
let currentRequestId: string | null = null

type WorkerInMessage =
  | { type: 'init' }
  | { type: 'execute'; requestId: string; code: string }

type WorkerOutMessage =
  | { type: 'ready' }
  | { type: 'init_error'; error: string }
  | { type: 'stdout'; requestId: string; line: string }
  | { type: 'stderr'; requestId: string; line: string }
  | { type: 'image'; requestId: string; dataUrl: string }
  | { type: 'done'; requestId: string; resultRepr?: string; durationMs: number }
  | { type: 'error'; requestId: string; errorType: string; message: string; traceback: string }

function post(msg: WorkerOutMessage) {
  ;(self as unknown as Worker).postMessage(msg)
}

async function init() {
  try {
    // The worker is loaded from the page origin; pyodide.mjs is at /pyodide/pyodide.mjs
    // We construct the URL at runtime so Vite doesn't try to resolve the import
    // statically (files in /public/ can only be referenced as URLs, not imported).
    // Package wheels (numpy, pandas, matplotlib, ...) are bundled into the same
    // /pyodide/ directory by scripts/copy-pyodide.mjs, so the sandbox is fully
    // self-contained — no CDN dependency at runtime.
    const pyodideUrl = new URL('/pyodide/pyodide.mjs', self.location.origin).href
    const indexURL = new URL('/pyodide/', self.location.origin).href
    const mod = await import(/* @vite-ignore */ pyodideUrl)
    const loadPyodide = mod.loadPyodide as (opts: { indexURL: string }) => Promise<PyodideAPI>
    pyodide = await loadPyodide({ indexURL })

    // Set MPLBACKEND env var BEFORE matplotlib is ever imported. This avoids
    // the 'webagg' backend trying to `from js import document` (which doesn't
    // exist in a Web Worker). No need to import matplotlib here — it reads
    // this env var on first import.
    await pyodide.runPythonAsync(`
import os
os.environ['MPLBACKEND'] = 'agg'
`)

    post({ type: 'ready' })
  } catch (err) {
    post({ type: 'init_error', error: err instanceof Error ? err.message : String(err) })
  }
}

async function execute(requestId: string, code: string) {
  if (!pyodide) {
    post({
      type: 'error',
      requestId,
      errorType: 'NotInitialized',
      message: 'Pyodide is not initialized yet',
      traceback: '',
    })
    return
  }

  currentRequestId = requestId
  const startedAt = performance.now()

  // Set requestId in Python globals so plt.show() capture includes it
  pyodide.globals.set('_current_request_id', requestId)

  // Wire stdout/stderr to stream lines back to the main thread.
  // batched fires once per print() call (or chunk of output).
  pyodide.setStdout({
    batched: (line: string) => {
      if (currentRequestId === requestId) {
        post({ type: 'stdout', requestId, line })
      }
    },
  })
  pyodide.setStderr({
    batched: (line: string) => {
      if (currentRequestId === requestId) {
        post({ type: 'stderr', requestId, line })
      }
    },
  })

  try {
    // Auto-load any packages the user code imports (numpy, pandas, matplotlib, etc.)
    // Pyodide ships these as prebuilt wheels; loadPackagesFromImports scans the
    // source for import statements and fetches/registers anything missing.
    // We pass no-op message/error callbacks so Pyodide's default "Loading numpy..."
    // / "pandas already loaded from default channel" chatter doesn't leak into
    // the cell's stdout — the user just wants the analysis, not the bookkeeping.
    // Real load failures still surface via thrown exceptions (caught below) and
    // as Python's own ModuleNotFoundError when the import finally runs.
    if (pyodide.loadPackagesFromImports) {
      try {
        await pyodide.loadPackagesFromImports(code, {
          messageCallback: () => {},
          errorCallback: () => {},
        })
      } catch (loadErr) {
        const msg = loadErr instanceof Error ? loadErr.message : String(loadErr)
        post({ type: 'stderr', requestId, line: `[package load warning] ${msg}\n` })
      }
    }

    // If the user code imports matplotlib, patch plt.show() to capture
    // figures as base64 PNG and send them as image messages. This runs
    // after loadPackagesFromImports has loaded matplotlib's wheel.
    if (code.includes('matplotlib') || code.includes('plt')) {
      try {
        await pyodide.runPythonAsync(`
import sys as _sys
if 'matplotlib' in _sys.modules or 'matplotlib.pyplot' in _sys.modules:
    import matplotlib.pyplot as _plt
    if not hasattr(_plt.show, '_is_capturing'):
        import io as _io
        import base64 as _b64
        from js import postMessage
        from pyodide.ffi import to_js

        def _capturing_show(*args, **kwargs):
            for fig_num in _plt.get_fignums():
                fig = _plt.figure(fig_num)
                buf = _io.BytesIO()
                fig.savefig(buf, format='png', dpi=150, bbox_inches='tight',
                            facecolor='white', edgecolor='none')
                buf.seek(0)
                b64 = _b64.b64encode(buf.read()).decode('ascii')
                data_url = f'data:image/png;base64,{b64}'
                buf.close()
                req_id = globals().get('_current_request_id', '')
                postMessage(to_js({"type": "image", "requestId": req_id, "dataUrl": data_url}))
            _plt.close('all')

        _capturing_show._is_capturing = True
        _plt.show = _capturing_show
`)
      } catch { /* matplotlib not actually loaded yet — no-op */ }
    }

    // Delegate to Pyodide's eval_code_async — same function runPythonAsync uses
    // internally. It handles top-level `await`, last-expression capture
    // (Jupyter-style), and clean tracebacks. Rolling our own wrapper here was
    // what broke top-level await: plain ast.parse + exec() strips the
    // PyCF_ALLOW_TOP_LEVEL_AWAIT flag and rejects any `await` outside a function.
    const wrapped = `
from pyodide.code import eval_code_async as _eval_code_async
_src = ${JSON.stringify(code)}
_val = await _eval_code_async(_src, globals=globals(), return_mode='last_expr', filename='<cell>', quiet_trailing_semicolon=True)
_last_expr_repr = repr(_val) if _val is not None else None
_last_expr_repr
`
    const result = await pyodide.runPythonAsync(wrapped)
    const resultRepr = result == null ? undefined : String(result)
    const durationMs = Math.round(performance.now() - startedAt)
    post({ type: 'done', requestId, resultRepr, durationMs })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Pyodide error messages typically embed the Python traceback as the
    // tail of the .message string. Split on the last 'File "<cell>"' to
    // separate a short message from the traceback.
    let errorType = 'PythonError'
    let cleanMessage = message
    let traceback = ''
    const tbMatch = message.match(/^([\s\S]*?)\n((?:Traceback[\s\S]*|File [\s\S]*))$/)
    if (tbMatch) {
      cleanMessage = tbMatch[1].trim()
      traceback = tbMatch[2]
    }
    const typeMatch = message.match(/(\w+Error|Exception):/)
    if (typeMatch) errorType = typeMatch[1]
    post({ type: 'error', requestId, errorType, message: cleanMessage, traceback })
  } finally {
    if (currentRequestId === requestId) currentRequestId = null
  }
}

self.addEventListener('message', (e: MessageEvent<WorkerInMessage>) => {
  const msg = e.data
  if (msg.type === 'init') {
    void init()
  } else if (msg.type === 'execute') {
    void execute(msg.requestId, msg.code)
  }
})
