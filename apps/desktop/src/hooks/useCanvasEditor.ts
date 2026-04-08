// useCanvasEditor — local op-based editing for a BlockDocument.
//
// Maintains a local copy of the doc, supports undo/redo via an inverse-op
// history, and exposes helpers for the per-block editors in CanvasPane.
// Each mutation is expressed as a DocumentUpdateOp (the same model the
// agent uses), applied optimistically and sent to the server via the
// provided `emit` callback.

import { useState, useCallback, useEffect } from 'react'
import type { BlockDocument, DocumentBlock, DocumentUpdateOp } from '@coagent/shared'
import { applyDocumentOps } from '@/lib/canvas'

// An undo entry pairs the forward op(s) with the inverse op(s) needed to
// reverse them. We store arrays to support multi-op transactions.
interface HistoryEntry {
  forward: DocumentUpdateOp[]
  inverse: DocumentUpdateOp[]
}

const MAX_HISTORY = 50

export interface UseCanvasEditorResult {
  doc: BlockDocument
  /** Apply ops locally, record undo history, and call emit for persistence. */
  emit: (ops: DocumentUpdateOp[]) => void
  /** Replace a block by id. */
  replaceBlock: (blockId: string, next: DocumentBlock) => void
  /** Delete a block by id. */
  deleteBlock: (blockId: string) => void
  /** Move block at fromIndex to toIndex. */
  moveBlock: (fromIndex: number, toIndex: number) => void
  /** Insert a copy of a block after it. */
  duplicateBlock: (blockId: string) => void
  /** Undo last operation. */
  undo: () => void
  /** Redo last undone operation. */
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}

export function useCanvasEditor(
  initialDoc: BlockDocument,
  onEmit: (docId: string, ops: DocumentUpdateOp[]) => void,
): UseCanvasEditorResult {
  const [doc, setDoc] = useState<BlockDocument>(initialDoc)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [future, setFuture] = useState<HistoryEntry[]>([])

  // When the parent pushes a fresh doc (e.g. from streaming), replace our
  // local state wholesale and discard history so we don't undo over server
  // changes we didn't author.
  useEffect(() => {
    setDoc(initialDoc)
    setHistory([])
    setFuture([])
  }, [initialDoc.id])

  // Apply ops locally + persist + record history.
  const emit = useCallback((ops: DocumentUpdateOp[]) => {
    setDoc(prev => {
      // Compute inverse ops from the current doc BEFORE applying forward ops.
      const inverse = buildInverseOps(prev, ops)
      const next = applyDocumentOps(prev, ops)
      setHistory(h => [...h.slice(-MAX_HISTORY + 1), { forward: ops, inverse }])
      setFuture([])
      onEmit(prev.id, ops)
      return next
    })
  }, [onEmit])

  const replaceBlock = useCallback((blockId: string, next: DocumentBlock) => {
    emit([{ op: 'replace', blockId, block: next }])
  }, [emit])

  const deleteBlock = useCallback((blockId: string) => {
    emit([{ op: 'delete', blockId }])
  }, [emit])

  const moveBlock = useCallback((fromIndex: number, toIndex: number) => {
    setDoc(prev => {
      const blocks = prev.blocks
      if (
        fromIndex < 0 || fromIndex >= blocks.length ||
        toIndex < 0 || toIndex >= blocks.length ||
        fromIndex === toIndex
      ) return prev

      const block = blocks[fromIndex]
      // Express as delete + insert so the inverse is symmetric.
      // After deleting at fromIndex the insertion target shifts by -1 when
      // toIndex > fromIndex (because the array is shorter by one).
      const insertIdx = toIndex > fromIndex ? toIndex : toIndex
      const forwardOps: DocumentUpdateOp[] = [
        { op: 'delete', blockId: block.id },
        { op: 'insert', index: insertIdx, block },
      ]
      const inverseOps: DocumentUpdateOp[] = [
        { op: 'delete', blockId: block.id },
        { op: 'insert', index: fromIndex, block },
      ]
      const next = applyDocumentOps(prev, forwardOps)
      setHistory(h => [...h.slice(-MAX_HISTORY + 1), { forward: forwardOps, inverse: inverseOps }])
      setFuture([])
      onEmit(prev.id, forwardOps)
      return next
    })
  }, [onEmit])

  const duplicateBlock = useCallback((blockId: string) => {
    setDoc(prev => {
      const idx = prev.blocks.findIndex(b => b.id === blockId)
      if (idx === -1) return prev
      const original = prev.blocks[idx]
      // Generate a new id for the copy so it's addressable separately.
      const newId = 'b_' + Math.random().toString(36).slice(2, 8)
      const copy: DocumentBlock = { ...original, id: newId } as DocumentBlock
      const insertIdx = idx + 1
      const forwardOps: DocumentUpdateOp[] = [{ op: 'insert', index: insertIdx, block: copy }]
      const inverseOps: DocumentUpdateOp[] = [{ op: 'delete', blockId: newId }]
      const next = applyDocumentOps(prev, forwardOps)
      setHistory(h => [...h.slice(-MAX_HISTORY + 1), { forward: forwardOps, inverse: inverseOps }])
      setFuture([])
      onEmit(prev.id, forwardOps)
      return next
    })
  }, [onEmit])

  const undo = useCallback(() => {
    setHistory(h => {
      if (h.length === 0) return h
      const entry = h[h.length - 1]
      const rest = h.slice(0, -1)
      setDoc(prev => {
        const next = applyDocumentOps(prev, entry.inverse)
        onEmit(prev.id, entry.inverse)
        return next
      })
      setFuture(f => [entry, ...f])
      return rest
    })
  }, [onEmit])

  const redo = useCallback(() => {
    setFuture(f => {
      if (f.length === 0) return f
      const entry = f[0]
      const rest = f.slice(1)
      setDoc(prev => {
        const next = applyDocumentOps(prev, entry.forward)
        onEmit(prev.id, entry.forward)
        return next
      })
      setHistory(h => [...h.slice(-MAX_HISTORY + 1), entry])
      return rest
    })
  }, [onEmit])

  return {
    doc,
    emit,
    replaceBlock,
    deleteBlock,
    moveBlock,
    duplicateBlock,
    undo,
    redo,
    canUndo: history.length > 0,
    canRedo: future.length > 0,
  }
}

// ── Inverse op computation ────────────────────────────────────────────────
//
// Build the minimal op sequence that reverses a list of forward ops.
// We snapshot the affected blocks BEFORE the forward ops are applied.
function buildInverseOps(doc: BlockDocument, ops: DocumentUpdateOp[]): DocumentUpdateOp[] {
  const inverse: DocumentUpdateOp[] = []
  // Walk ops in reverse so restoring them in order reconstructs the original.
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]
    switch (op.op) {
      case 'replace': {
        const original = findBlockById(doc.blocks, op.blockId)
        if (original) {
          inverse.push({ op: 'replace', blockId: op.blockId, block: original })
        }
        break
      }
      case 'insert': {
        // Inverse of insert is delete (the new block, identified by id).
        const blockId = op.block.id || ('b_undo_' + i)
        inverse.push({ op: 'delete', blockId })
        break
      }
      case 'delete': {
        // Inverse of delete is re-insert at the original index.
        const idx = doc.blocks.findIndex(b => b.id === op.blockId)
        const block = findBlockById(doc.blocks, op.blockId)
        if (block && idx !== -1) {
          inverse.push({ op: 'insert', index: idx, block })
        }
        break
      }
      case 'set_title': {
        inverse.push({ op: 'set_title', title: doc.title })
        break
      }
    }
  }
  return inverse
}

function findBlockById(blocks: BlockDocument['blocks'], id: string): DocumentBlock | undefined {
  for (const b of blocks) {
    if (b.id === id) return b
    if (b.type === 'section') {
      const child = b.blocks.find(c => c.id === id)
      if (child) return child as DocumentBlock
    }
  }
  return undefined
}
