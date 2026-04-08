#!/usr/bin/env node
// Build script for doc-runtime.css — the precompiled Tailwind bundle that
// gets injected into the sandboxed iframe at document render time.
//
// Usage: node src/doc-runtime/build.js
// Or via package.json: pnpm build:doc-runtime
//
// The output file (doc-runtime.css) is committed to the repo so the main
// Vite build does NOT need to run this — it's a manual rebuild whenever
// the source CSS or tailwind config changes.

const { execSync } = require('child_process')
const { join } = require('path')

const __dir = __dirname
const root = join(__dir, '..', '..') // apps/desktop

const input = join(__dir, 'doc-runtime.source.css')
const output = join(__dir, 'doc-runtime.css')
const config = join(__dir, 'tailwind.config.js')

console.log('Building doc-runtime.css...')

execSync(
  `npx tailwindcss --config "${config}" --input "${input}" --output "${output}" --minify`,
  { cwd: root, stdio: 'inherit' },
)

console.log('Done. Output:', output)
