import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryStore, chunkContent } from './memory-store'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// chunkContent unit tests
// ---------------------------------------------------------------------------

describe('chunkContent', () => {
  it('returns the whole text as one chunk when there are no headings and it is short', () => {
    const text = 'Hello world. This is a short note.'
    const chunks = chunkContent(text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(text)
  })

  it('skips blank or too-short chunks', () => {
    const text = '   \n\n  \n\nThis is long enough to keep around.'
    const chunks = chunkContent(text)
    expect(chunks).toHaveLength(1)
  })

  it('splits on level-2 headings and includes the heading in the chunk', () => {
    const text = [
      '# Title',
      '',
      '## Section A',
      'Content of A.',
      '',
      '## Section B',
      'Content of B.'
    ].join('\n')

    const chunks = chunkContent(text)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    const sectionA = chunks.find(c => c.includes('Section A'))
    const sectionB = chunks.find(c => c.includes('Section B'))
    expect(sectionA).toBeDefined()
    expect(sectionB).toBeDefined()
    expect(sectionA).toContain('Content of A.')
  })

  it('further splits long sections on paragraph breaks', () => {
    const longParagraph1 = 'A'.repeat(400)
    const longParagraph2 = 'B'.repeat(400)
    const text = `## Long Section\n\n${longParagraph1}\n\n${longParagraph2}`

    const chunks = chunkContent(text)
    // The section is > 800 chars so it should be split on \n\n
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// MemoryStore integration tests
// ---------------------------------------------------------------------------

describe('MemoryStore', () => {
  let store: MemoryStore
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'coagent-test-'))
    store = new MemoryStore(tmpDir)
    await store.init()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true })
  })

  it('writes and reads a memory file', async () => {
    await store.writeMemory('clients/test-client.md', '# Test Client\n\nNotes here.')
    const content = await store.readMemory('clients/test-client.md')
    expect(content).toContain('Test Client')
    expect(content).toContain('Notes here.')
  })

  it('lists memory files by category', async () => {
    await store.writeMemory('clients/alice.md', '# Alice')
    await store.writeMemory('clients/bob.md', '# Bob')
    const files = await store.listMemories('clients')
    expect(files).toHaveLength(2)
    expect(files).toContain('clients/alice.md')
  })

  it('searches memory semantically and returns chunkIndex', async () => {
    await store.writeMemory('clients/alice.md', '# Alice Johnson\nBuying a 3-bed house in downtown area. Budget $500K.')
    await store.writeMemory('properties/maple.md', '# 142 Maple St\nListed at $420K. 3 bedrooms. Downtown.')
    const results = await store.searchMemory('downtown house buyer')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].content).toMatch(/downtown|house|buyer/i)
    // Every result must now carry a chunkIndex
    for (const r of results) {
      expect(typeof r.chunkIndex).toBe('number')
    }
  })

  it('stores multiple chunks per file and returns the most relevant one', async () => {
    const content = [
      '# Agent Profile',
      '',
      '## Background',
      'Alice has been a real-estate agent for 10 years and specialises in downtown condos.',
      '',
      '## Preferences',
      'Prefers early morning meetings. Uses Slack for communication.'
    ].join('\n')

    await store.writeMemory('agent.md', content)
    const results = await store.searchMemory('communication preferences', 3)
    expect(results.length).toBeGreaterThan(0)
    // The chunk about preferences should surface near the top
    const prefsChunk = results.find(r => r.content.includes('Preferences') || r.content.includes('Slack'))
    expect(prefsChunk).toBeDefined()
  })

  it('re-indexes a file when written again (replaces old chunks)', async () => {
    await store.writeMemory('notes.md', '## Old Content\nThis is the old text that will be replaced.')
    await store.writeMemory('notes.md', '## New Content\nThis is the updated text with fresh information.')

    const results = await store.searchMemory('updated text fresh information', 5)
    // The old chunks should be gone — no result should contain "old text"
    const staleResult = results.find(r => r.content.includes('old text'))
    expect(staleResult).toBeUndefined()
  })
})
