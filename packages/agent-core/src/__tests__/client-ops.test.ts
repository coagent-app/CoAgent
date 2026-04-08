import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createBlockDocument, updateBlockDocument, readBlockDocument } from '../block-document-store.js'
import type { DocumentBlock } from '@coagent/shared'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'coagent-client-ops-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeTextBlock(id: string, text: string): DocumentBlock {
  return { id, type: 'text', content: text } as any
}

describe('updateBlockDocument', () => {
  it('handles replace op', async () => {
    const doc = await createBlockDocument(tmpDir, {
      title: 'Test',
      blocks: [makeTextBlock('b1', 'Hello')],
    })
    const updated = await updateBlockDocument(tmpDir, doc.id, [
      { op: 'replace', blockId: 'b1', block: makeTextBlock('b1', 'World') },
    ])
    expect(updated).not.toBeNull()
    expect(updated!.blocks[0]).toMatchObject({ id: 'b1', content: 'World' })
  })

  it('handles insert op', async () => {
    const doc = await createBlockDocument(tmpDir, {
      title: 'Test',
      blocks: [makeTextBlock('b1', 'First')],
    })
    const newBlock = makeTextBlock('b2', 'Second')
    const updated = await updateBlockDocument(tmpDir, doc.id, [
      { op: 'insert', index: 1, block: newBlock },
    ])
    expect(updated).not.toBeNull()
    expect(updated!.blocks).toHaveLength(2)
    expect(updated!.blocks[1]).toMatchObject({ content: 'Second' })
  })

  it('handles delete op', async () => {
    const doc = await createBlockDocument(tmpDir, {
      title: 'Test',
      blocks: [makeTextBlock('b1', 'Keep'), makeTextBlock('b2', 'Remove')],
    })
    const updated = await updateBlockDocument(tmpDir, doc.id, [
      { op: 'delete', blockId: 'b2' },
    ])
    expect(updated).not.toBeNull()
    expect(updated!.blocks).toHaveLength(1)
    expect(updated!.blocks[0].id).toBe('b1')
  })

  it('handles set_title op', async () => {
    const doc = await createBlockDocument(tmpDir, {
      title: 'Old Title',
      blocks: [],
    })
    const updated = await updateBlockDocument(tmpDir, doc.id, [
      { op: 'set_title', title: 'New Title' },
    ])
    expect(updated).not.toBeNull()
    expect(updated!.title).toBe('New Title')
  })

  it('persists changes so readBlockDocument sees them', async () => {
    const doc = await createBlockDocument(tmpDir, {
      title: 'Persist Test',
      blocks: [makeTextBlock('b1', 'original')],
    })
    await updateBlockDocument(tmpDir, doc.id, [
      { op: 'replace', blockId: 'b1', block: makeTextBlock('b1', 'persisted') },
    ])
    const reloaded = await readBlockDocument(tmpDir, doc.id)
    expect(reloaded).not.toBeNull()
    expect(reloaded!.blocks[0]).toMatchObject({ content: 'persisted' })
  })

  it('returns null for unknown docId', async () => {
    const result = await updateBlockDocument(tmpDir, 'nonexistent', [
      { op: 'set_title', title: 'X' },
    ])
    expect(result).toBeNull()
  })
})
