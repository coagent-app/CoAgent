import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ApprovalQueue } from './queue'

describe('ApprovalQueue', () => {
  let queue: ApprovalQueue
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'queue-test-'))
    queue = new ApprovalQueue(tmpDir)
  })

  it('adds items and retrieves them', () => {
    queue.add({ type: 'task', title: 'Test Task', description: 'desc', detail: '', notes: '', action: 'send', metadata: {} })
    expect(queue.getPending()).toHaveLength(1)
    expect(queue.getPending()[0].status).toBe('pending')
  })

  it('approves an item', () => {
    queue.add({ type: 'document', title: 'Document', description: '', detail: '', notes: '', action: 'share', metadata: {} })
    const id = queue.getPending()[0].id
    queue.approve(id)
    expect(queue.getPending()).toHaveLength(0)
  })

  it('rejects an item', () => {
    queue.add({ type: 'task', title: 'Task', description: '', detail: '', notes: '', action: 'send', metadata: {} })
    const id = queue.getPending()[0].id
    queue.reject(id)
    expect(queue.getPending()).toHaveLength(0)
  })
})
