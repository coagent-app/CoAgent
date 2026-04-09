#!/usr/bin/env node
/**
 * Copy Pyodide runtime files from node_modules into apps/desktop/public/pyodide/
 * so Vite serves them at /pyodide/* and the worker can load them at runtime.
 *
 * Also downloads the package wheels we promise in the run_python tool description
 * (numpy, pandas, matplotlib, ...) plus their transitive dependencies, so the
 * Python sandbox is fully self-contained and works offline. Wheels live in the
 * same /pyodide/ directory and are served as static assets.
 *
 * Wheels are gitignored (see .gitignore -> apps/desktop/public/pyodide/), so
 * the first install/build downloads ~50MB from jsDelivr and subsequent runs
 * are no-ops.
 *
 * Runs automatically as part of dev/build via package.json hooks.
 */
import { copyFileSync, mkdirSync, readdirSync, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const desktopRoot = resolve(__dirname, '..')
const require = createRequire(import.meta.url)

// Resolve pyodide's installed location via node module resolution
let pyodideRoot
try {
  const pkgPath = require.resolve('pyodide/package.json')
  pyodideRoot = dirname(pkgPath)
} catch (err) {
  console.error('[copy-pyodide] Could not resolve pyodide package:', err.message)
  process.exit(1)
}

const destDir = join(desktopRoot, 'public', 'pyodide')
mkdirSync(destDir, { recursive: true })

// Files we need at runtime: the JS loaders, wasm, lockfile, and stdlib
const REQUIRED_FILES = [
  'pyodide.mjs',
  'pyodide.asm.js',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
]

let copied = 0
let skipped = 0
for (const name of REQUIRED_FILES) {
  const src = join(pyodideRoot, name)
  if (!existsSync(src)) {
    console.warn(`[copy-pyodide] Missing in pyodide package: ${name}`)
    continue
  }
  const dest = join(destDir, name)
  // Skip if size matches (cheap mtime/size check, no hashing)
  if (existsSync(dest) && statSync(dest).size === statSync(src).size) {
    skipped++
    continue
  }
  copyFileSync(src, dest)
  copied++
}

console.log(`[copy-pyodide] runtime: copied ${copied}, skipped ${skipped}`)

// ────────────────────────────────────────────────────────────────────────────
// Bundle Python package wheels (numpy, pandas, matplotlib, …) so the in-app
// Pyodide sandbox works fully offline. We resolve the wanted packages against
// pyodide-lock.json (which lists every wheel + its dependency graph + sha256),
// walk transitive dependencies, then download anything missing from jsDelivr.
// ────────────────────────────────────────────────────────────────────────────

// Packages we promise in the run_python tool description. Keep this in sync
// with packages/agent-core/src/agent.ts (run_python tool description).
//
// micropip is included as a safety net — if the agent ever tries to install
// an unbundled package at runtime, the import will at least surface a clean
// error from micropip instead of a cryptic "module not found" loop.
const WANTED_PACKAGES = [
  'micropip',
  'numpy',
  'pandas',
  'matplotlib',
  'beautifulsoup4',
  'lxml',
  'requests',
  'python-calamine',
  'python-dateutil',
  'pillow',
]

// jsDelivr serves wheels at v<runtime-version>/full/<wheel-filename>. The
// runtime version comes from the npm package, NOT from pyodide-lock.json's
// internal info.version field (which can be a dev tag).
let pyodideRuntimeVersion
try {
  pyodideRuntimeVersion = require(join(pyodideRoot, 'package.json')).version
} catch (err) {
  console.error('[copy-pyodide] Could not read pyodide package version:', err.message)
  process.exit(1)
}
const CDN_BASE = `https://cdn.jsdelivr.net/pyodide/v${pyodideRuntimeVersion}/full/`

// Parse the lock file we just copied — it's the source of truth for which
// wheel filename corresponds to which package and what depends on what.
let lockFile
try {
  lockFile = JSON.parse(readFileSync(join(destDir, 'pyodide-lock.json'), 'utf8'))
} catch (err) {
  console.error('[copy-pyodide] Could not parse pyodide-lock.json:', err.message)
  process.exit(1)
}

// Walk the dependency graph: starting from WANTED_PACKAGES, collect every
// package transitively required. This guarantees e.g. pandas pulls in numpy,
// pytz, python-dateutil even if they aren't in WANTED_PACKAGES directly.
function resolveDeps(wanted) {
  const seen = new Set()
  const queue = [...wanted]
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    const pkg = lockFile.packages?.[name]
    if (!pkg) {
      console.warn(`[copy-pyodide] Package not found in lock file: ${name}`)
      continue
    }
    seen.add(name)
    for (const dep of pkg.depends ?? []) queue.push(dep)
  }
  return seen
}

const allPackages = resolveDeps(WANTED_PACKAGES)

// Download a single wheel, verifying its sha256 against the lock file. We use
// Node's built-in fetch (Node 18+). Skip if the file already exists with a
// matching size (cheap check; full hash verify on first download only).
async function fetchWheel(pkgName) {
  const pkg = lockFile.packages[pkgName]
  const fileName = pkg.file_name
  const dest = join(destDir, fileName)
  if (existsSync(dest)) {
    return { status: 'skipped', fileName }
  }
  const url = CDN_BASE + fileName
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (pkg.sha256) {
    const actual = createHash('sha256').update(buf).digest('hex')
    if (actual !== pkg.sha256) {
      throw new Error(
        `Checksum mismatch for ${fileName}: expected ${pkg.sha256}, got ${actual}`
      )
    }
  }
  writeFileSync(dest, buf)
  return { status: 'downloaded', fileName, bytes: buf.length }
}

// Run downloads with bounded concurrency. jsDelivr is fine with parallel
// requests but we don't want to spawn 30+ at once.
async function downloadAll(packages, concurrency = 6) {
  const queue = [...packages]
  let downloaded = 0
  let skippedPkg = 0
  let totalBytes = 0
  const errors = []
  async function worker() {
    while (queue.length > 0) {
      const name = queue.shift()
      try {
        const r = await fetchWheel(name)
        if (r.status === 'downloaded') {
          downloaded++
          totalBytes += r.bytes
          process.stdout.write(`[copy-pyodide] ↓ ${r.fileName} (${(r.bytes / 1024 / 1024).toFixed(1)}MB)\n`)
        } else {
          skippedPkg++
        }
      } catch (err) {
        errors.push({ name, error: err.message })
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return { downloaded, skippedPkg, totalBytes, errors }
}

console.log(`[copy-pyodide] resolving ${WANTED_PACKAGES.length} requested packages → ${allPackages.size} total (with deps)`)
const result = await downloadAll(Array.from(allPackages))
if (result.errors.length > 0) {
  console.warn(`[copy-pyodide] ${result.errors.length} package(s) failed to download:`)
  for (const e of result.errors) console.warn(`  - ${e.name}: ${e.error}`)
  console.warn('[copy-pyodide] Python sandbox may not work offline for these packages.')
}
const mb = (result.totalBytes / 1024 / 1024).toFixed(1)
console.log(`[copy-pyodide] packages: downloaded ${result.downloaded} (${mb}MB), skipped ${result.skippedPkg}`)
