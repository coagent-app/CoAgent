# doc-runtime

Precompiled Tailwind CSS bundle for the HTML document sandboxed iframe renderer.

## What this is

This directory contains the CSS pipeline for CoAgent's HTML document architecture.
`doc-runtime.css` is the compiled output — a self-contained Tailwind bundle with
semantic doc/section/editable classes and shadcn-compatible CSS custom property
mappings for the document theme system.

## How to rebuild

```sh
cd apps/desktop
pnpm build:doc-runtime
```

Commit the generated `doc-runtime.css` after rebuilding.

## Important

The main Vite build does NOT import this CSS. It is loaded directly into the
sandboxed iframe at document render time (Phase 2 of the HTML document architecture).
Rebuild manually whenever `doc-runtime.source.css` or `tailwind.config.js` changes.
