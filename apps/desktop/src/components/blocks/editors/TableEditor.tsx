import { useState } from 'react'
import type { TableBlock, TableRow } from '@coagent/shared'
import { Plus, X } from 'lucide-react'

export function TableEditor({ block, onCommit }: {
  block: TableBlock
  onCommit: (next: TableBlock) => void
}) {
  const [headers, setHeaders] = useState<string[]>(block.headers)
  const [rows, setRows] = useState<TableRow[]>(block.rows)
  const [caption, setCaption] = useState(block.caption ?? '')

  const commit = (
    nextHeaders: string[] = headers,
    nextRows: TableRow[] = rows,
    nextCaption: string = caption,
  ) => {
    onCommit({
      ...block,
      headers: nextHeaders,
      rows: nextRows,
      caption: nextCaption || undefined,
    })
  }

  const updateHeader = (i: number, v: string) => {
    const next = headers.map((h, idx) => idx === i ? v : h)
    setHeaders(next)
    // commit on blur, not onChange — handled by onBlur={() => commit()}
  }

  const updateCell = (r: number, c: number, v: string) => {
    const next = rows.map((row, ri) =>
      ri === r
        ? { ...row, cells: row.cells.map((cell, ci) => ci === c ? v : cell) }
        : row
    )
    setRows(next)
  }

  const addRow = () => {
    const next = [...rows, { cells: headers.map(() => '') }]
    setRows(next)
    commit(headers, next, caption)
  }

  const removeRow = (r: number) => {
    const next = rows.filter((_, i) => i !== r)
    setRows(next)
    commit(headers, next, caption)
  }

  const addCol = () => {
    const nextHeaders = [...headers, 'Column']
    const nextRows = rows.map(row => ({ ...row, cells: [...row.cells, ''] }))
    setHeaders(nextHeaders)
    setRows(nextRows)
    commit(nextHeaders, nextRows, caption)
  }

  const removeCol = (c: number) => {
    const nextHeaders = headers.filter((_, i) => i !== c)
    const nextRows = rows.map(row => ({
      ...row,
      cells: row.cells.filter((_, i) => i !== c),
    }))
    setHeaders(nextHeaders)
    setRows(nextRows)
    commit(nextHeaders, nextRows, caption)
  }

  return (
    <div className="space-y-2 overflow-x-auto">
      {/* Caption at top (optional) */}
      <input
        value={caption}
        onChange={e => setCaption(e.target.value)}
        onBlur={() => commit()}
        placeholder="Caption (optional)"
        className="w-full text-[11px] italic text-neutral-500 dark:text-neutral-400 bg-transparent outline-none border-0 focus:ring-0 placeholder:text-neutral-300 dark:placeholder:text-neutral-600"
      />

      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th
                key={i}
                className="relative group border border-neutral-200 dark:border-neutral-700 px-2 py-1.5 text-left font-semibold text-white"
                style={{ background: 'var(--canvas-primary)' }}
              >
                <input
                  value={h}
                  onChange={e => updateHeader(i, e.target.value)}
                  onBlur={() => commit()}
                  className="w-full font-semibold bg-transparent outline-none border-0 focus:ring-0 text-white placeholder:text-white/50"
                  placeholder="Header"
                />
                {headers.length > 1 && (
                  <button
                    onClick={() => removeCol(i)}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity z-10"
                    aria-label="Remove column"
                    title="Remove column"
                  >
                    <X size={9} />
                  </button>
                )}
              </th>
            ))}
            {/* Add column button */}
            <th className="w-8 border-0 bg-transparent px-1">
              <button
                onClick={addCol}
                className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors"
                title="Add column"
                aria-label="Add column"
              >
                <Plus size={13} />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="group border-b border-neutral-200 dark:border-neutral-700">
              {row.cells.map((cell, c) => (
                <td
                  key={c}
                  className="border border-neutral-200 dark:border-neutral-700 px-2 py-1.5 text-neutral-700 dark:text-neutral-200 align-top"
                >
                  <input
                    value={cell}
                    onChange={e => updateCell(r, c, e.target.value)}
                    onBlur={() => commit()}
                    className="w-full bg-transparent outline-none border-0 focus:ring-0 text-neutral-700 dark:text-neutral-200"
                    placeholder="—"
                  />
                </td>
              ))}
              {/* Remove row button */}
              <td className="w-8 border-0 px-1 align-middle">
                <button
                  onClick={() => removeRow(r)}
                  className="opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-500 transition-opacity"
                  aria-label="Remove row"
                  title="Remove row"
                >
                  <X size={12} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Add row button */}
      <button
        onClick={addRow}
        className="flex items-center gap-1 text-[11px] text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors"
      >
        <Plus size={12} /> Add row
      </button>
    </div>
  )
}
