import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// Mock the Anthropic SDK so ingestFile's generateSummary call doesn't need
// real credentials. Must be hoisted before any imports that transitively load
// @anthropic-ai/sdk.
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: '{"summary":"Test PDF.","group":"Documents"}' }],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          }
        })
      }
    }
  }
})

// Also mock the openai-provider path used for embeddings so no real API call
// happens for embedding generation.
vi.mock('../auth.js', () => ({
  getRelayConfig: () => null,
  getOpenAIProxy: () => null,
  loadApiKeysToEnv: () => {},
}))

import { ingestFile, overwriteFile, listFiles } from '../file-store.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'coagent-dedupe-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('overwriteFile', () => {
  it('replaces bytes under the same file id', async () => {
    const original = Buffer.from('PDF v1')
    const entry = await ingestFile(tmpDir, 'report.pdf', original, 'application/pdf')

    const updated = Buffer.from('PDF v2')
    const result = await overwriteFile(tmpDir, entry.id, updated, 'report.pdf')

    expect(result).not.toBeNull()
    expect(result!.id).toBe(entry.id)

    const onDisk = await readFile(entry.path)
    expect(onDisk.toString()).toBe('PDF v2')
  })

  it('updates sizeBytes in the index', async () => {
    const original = Buffer.from('small')
    const entry = await ingestFile(tmpDir, 'doc.pdf', original, 'application/pdf')

    const larger = Buffer.from('much larger content here')
    await overwriteFile(tmpDir, entry.id, larger, 'doc.pdf')

    const files = await listFiles(tmpDir)
    const updated = files.find(f => f.id === entry.id)
    expect(updated).toBeDefined()
    expect(updated!.sizeBytes).toBe(larger.length)
  })

  it('returns null for unknown fileId', async () => {
    const result = await overwriteFile(tmpDir, 'nonexistent-id', Buffer.from('x'), 'test.pdf')
    expect(result).toBeNull()
  })

  it('preserves the file id after overwrite', async () => {
    const entry = await ingestFile(tmpDir, 'keep-id.pdf', Buffer.from('v1'), 'application/pdf')
    const result = await overwriteFile(tmpDir, entry.id, Buffer.from('v2'), 'keep-id.pdf')
    expect(result!.id).toBe(entry.id)

    const files = await listFiles(tmpDir)
    const matches = files.filter(f => f.id === entry.id)
    expect(matches).toHaveLength(1)
  })
})
