import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listFiles, deleteFileEntry, getStorageStats, ingestFile, listFolders, createFolder, moveFile } from '../file-store.js'

// Mock Vercel AI SDK so ingestFile tests don't need real API credentials
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateText: vi.fn().mockResolvedValue({
      text: '{"summary":"Test summary.","group":"Files"}'
    })
  }
})

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'coagent-files-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('listFiles', () => {
  it('returns empty array when no index exists', async () => {
    const files = await listFiles(tmpDir)
    expect(files).toEqual([])
  })
})

describe('getStorageStats', () => {
  it('returns zeros when no files exist', async () => {
    const stats = await getStorageStats(tmpDir)
    expect(stats.totalFiles).toBe(0)
    expect(stats.totalBytes).toBe(0)
    expect(stats.largestFiles).toEqual([])
  })
})

describe('deleteFileEntry', () => {
  it('does nothing when id does not exist', async () => {
    await expect(deleteFileEntry(tmpDir, 'nonexistent-id')).resolves.not.toThrow()
  })
})

// ── listFolders ───────────────────────────────────────────────────────────────

describe('listFolders', () => {
  it('returns empty array when files dir does not exist', async () => {
    const result = await listFolders(tmpDir)
    expect(result).toEqual([])
  })

  it('returns subfolder names sorted', async () => {
    await mkdir(join(tmpDir, 'files', 'Contracts'), { recursive: true })
    await mkdir(join(tmpDir, 'files', 'Reports'), { recursive: true })
    const result = await listFolders(tmpDir)
    expect(result).toEqual(['Contracts', 'Reports'])
  })

  it('ignores files in the files dir (only returns dirs)', async () => {
    await mkdir(join(tmpDir, 'files'), { recursive: true })
    await writeFile(join(tmpDir, 'files', 'stray.txt'), 'hi')
    const result = await listFolders(tmpDir)
    expect(result).toEqual([])
  })
})

// ── createFolder ──────────────────────────────────────────────────────────────

describe('createFolder', () => {
  it('creates a subdirectory under files/', async () => {
    await createFolder(tmpDir, 'Clients')
    const exists = existsSync(join(tmpDir, 'files', 'Clients'))
    expect(exists).toBe(true)
  })

  it('strips path traversal from folder name', async () => {
    await createFolder(tmpDir, '../../evil')
    expect(existsSync(join(tmpDir, 'files', 'evil'))).toBe(true)
  })

  it('is idempotent — does not throw if folder exists', async () => {
    await createFolder(tmpDir, 'Docs')
    await expect(createFolder(tmpDir, 'Docs')).resolves.toBeUndefined()
  })
})

// ── moveFile ──────────────────────────────────────────────────────────────────

describe('moveFile', () => {
  it('moves file on disk and updates group + path in index', async () => {
    const entry = await ingestFile(tmpDir, 'report.txt', Buffer.from('hello world'), 'text/plain')
    await createFolder(tmpDir, 'Reports')
    await moveFile(tmpDir, entry.id, 'Reports')
    expect(existsSync(join(tmpDir, 'files', 'Reports', 'report.txt'))).toBe(true)
    expect(existsSync(join(tmpDir, 'files', 'report.txt'))).toBe(false)
    const files = await listFiles(tmpDir)
    const updated = files.find(f => f.id === entry.id)!
    expect(updated.group).toBe('Reports')
    expect(updated.path).toBe(join(tmpDir, 'files', 'Reports', 'report.txt'))
  })

  it('moves file back to root when targetGroup is empty string', async () => {
    const entry = await ingestFile(tmpDir, 'doc.txt', Buffer.from('test'), 'text/plain')
    await createFolder(tmpDir, 'Temp')
    await moveFile(tmpDir, entry.id, 'Temp')
    await moveFile(tmpDir, entry.id, '')
    expect(existsSync(join(tmpDir, 'files', 'doc.txt'))).toBe(true)
    const files = await listFiles(tmpDir)
    const updated = files.find(f => f.id === entry.id)!
    expect(updated.group).toBe('')
  })

  it('throws if file id not found', async () => {
    await expect(moveFile(tmpDir, 'nonexistent-id', 'Folder')).rejects.toThrow('not found')
  })
})
