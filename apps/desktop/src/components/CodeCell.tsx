import React, { useState, useEffect } from 'react'
import { ChevronRight, Square, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CodeCell as CodeCellType } from '@/hooks/useAgent'

interface CodeCellProps {
  cell: CodeCellType
  onCancel?: (id: string) => void
}

/**
 * Perplexity-style Python code cell. Code is collapsed by default; clicking
 * the chevron expands it. While running, stdout streams below the header.
 * On done, the cell auto-collapses unless the user expanded it.
 */
export function CodeCell({ cell, onCancel }: CodeCellProps) {
  const [expanded, setExpanded] = useState(true)
  const [userToggled, setUserToggled] = useState(false)

  // Auto-collapse code panel on done (but keep stdout/result visible).
  useEffect(() => {
    if (cell.status === 'done' && !userToggled) {
      setExpanded(false)
    }
  }, [cell.status, userToggled])

  function toggle() {
    setUserToggled(true)
    setExpanded(e => !e)
  }

  const lineCount = cell.code.split('\n').length
  const isRunning = cell.status === 'running'
  const isError = cell.status === 'error'
  const isCancelled = cell.status === 'cancelled'

  return (
    <div className="w-full max-w-[680px] border border-neutral-200 dark:border-neutral-700 rounded-xl overflow-hidden bg-white dark:bg-neutral-900">
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
        onClick={toggle}
      >
        <ChevronRight
          size={14}
          className={cn(
            'text-neutral-400 dark:text-neutral-500 transition-transform flex-shrink-0',
            expanded && 'rotate-90'
          )}
        />
        <span className="text-[12px] font-medium text-neutral-700 dark:text-neutral-300">Python</span>
        <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
        </span>
        {isRunning && (
          <>
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              <span className="w-1 h-1 bg-blue-400 rounded-full animate-pulse" />
              <span className="shimmer-text">Running</span>
            </span>
            {onCancel && (
              <button
                onClick={(e) => { e.stopPropagation(); onCancel(cell.id) }}
                className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
                title="Stop"
              >
                <Square size={11} className="text-neutral-500 dark:text-neutral-400" />
              </button>
            )}
          </>
        )}
        {cell.status === 'done' && (
          <span className="ml-auto text-[11px] text-neutral-400 dark:text-neutral-500">
            {cell.durationMs != null ? `${cell.durationMs}ms` : 'Done'}
          </span>
        )}
        {isError && (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-red-500 dark:text-red-400">
            <AlertCircle size={11} />
            Error
          </span>
        )}
        {isCancelled && (
          <span className="ml-auto text-[11px] text-neutral-400 dark:text-neutral-500">Cancelled</span>
        )}
      </div>

      {/* Code (collapsible) */}
      {expanded && (
        <pre className="px-3 py-2.5 bg-neutral-50 dark:bg-neutral-950 border-t border-neutral-100 dark:border-neutral-800 text-[12px] leading-relaxed text-neutral-800 dark:text-neutral-200 overflow-x-auto font-mono">
          <code>{cell.code}</code>
        </pre>
      )}

      {/* stdout (always visible while running and after done) */}
      {cell.stdout && (
        <pre className="px-3 py-2 border-t border-neutral-100 dark:border-neutral-800 text-[12px] leading-relaxed text-neutral-700 dark:text-neutral-300 overflow-x-auto font-mono whitespace-pre-wrap">
          {cell.stdout.trimEnd()}
        </pre>
      )}

      {/* result (last expression value) */}
      {cell.resultRepr && (
        <div className="px-3 py-2 border-t border-neutral-100 dark:border-neutral-800 text-[12px] font-mono text-neutral-900 dark:text-neutral-100">
          <span className="text-neutral-400 dark:text-neutral-500 mr-2">→</span>
          {cell.resultRepr}
        </div>
      )}

      {/* error block (always expanded) */}
      {isError && (
        <div className="px-3 py-2.5 border-t border-neutral-100 dark:border-neutral-800 bg-red-50 dark:bg-red-950/30">
          <div className="text-[12px] font-medium text-red-700 dark:text-red-400">
            {cell.errorType}: {cell.errorMessage}
          </div>
          {cell.traceback && (
            <pre className="mt-1.5 text-[11px] text-red-600/80 dark:text-red-400/80 font-mono whitespace-pre-wrap overflow-x-auto">
              {cell.traceback}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
