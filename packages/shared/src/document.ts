// Canvas model — react-runner based document architecture.
// See docs/plans/2026-04-08-react-runner-artifacts-design.md for the full design.
//
// A Canvas is a persisted TSX component that the agent has authored.
// The desktop app compiles and renders it via react-runner inside a sandboxed
// iframe, with brand kit values and chart/icon libraries injected via scope.

export interface Canvas {
  id: string
  title: string
  kind?: string              // free-form label ("proposal", "flyer", "report") — agent picks
  code: string               // SOURCE OF TRUTH. TSX exporting a default function component.
  createdAt: string
  updatedAt: string
  versions?: Array<{ savedAt: string; code: string }>  // last N snapshots for undo
}
