#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { MemoryStore } from './memory-store.js'
import { homedir } from 'os'
import { join } from 'path'

const MEMORY_BASE = process.env.COAGENT_DATA_DIR ?? join(homedir(), '.coagent')
const store = new MemoryStore(MEMORY_BASE)

const server = new Server(
  { name: 'coagent-memory', version: '0.0.1' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search_memory',
      description: 'Semantic search across all memory files. Use this first on every trigger to load relevant context.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language search query' },
          topK: { type: 'number', description: 'Number of results (default 5)' }
        },
        required: ['query']
      }
    },
    {
      name: 'read_memory',
      description: 'Read a specific memory file by path',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path e.g. clients/alice.md' }
        },
        required: ['path']
      }
    },
    {
      name: 'write_memory',
      description: 'Write or update a memory file. Use after every interaction to record what happened.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path e.g. clients/alice.md' },
          content: { type: 'string', description: 'Markdown content to write' }
        },
        required: ['path', 'content']
      }
    },
    {
      name: 'edit_memory',
      description: 'Edit a specific section of a memory file. Pass the exact chunk content from search_memory as old_content, and the replacement as new_content. Only re-indexes the changed section — efficient for frequent updates.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path e.g. clients/alice.md' },
          old_content: { type: 'string', description: 'The exact section content to replace (from search_memory results)' },
          new_content: { type: 'string', description: 'The replacement content' }
        },
        required: ['path', 'old_content', 'new_content']
      }
    },
    {
      name: 'append_memory',
      description: 'Append content to an existing memory file without reading it first. Creates the file if it doesn\'t exist. Only indexes the new content — efficient for adding entries.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path e.g. clients/alice.md' },
          content: { type: 'string', description: 'Content to append (will be added after a blank line)' }
        },
        required: ['path', 'content']
      }
    },
    {
      name: 'list_memories',
      description: 'List memory files, optionally filtered by category',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Optional: clients, properties, market, preferences' }
        }
      }
    },
    {
      name: 'delete_memory',
      description: 'Delete a memory file. Use during memory cleanup to remove stale, resolved, or duplicate files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path e.g. old-project.md' }
        },
        required: ['path']
      }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    if (name === 'search_memory') {
      const results = await store.searchMemory(args!.query as string, args!.topK as number | undefined)
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] }
    }

    if (name === 'read_memory') {
      const content = await store.readMemory(args!.path as string)
      return { content: [{ type: 'text', text: content }] }
    }

    if (name === 'write_memory') {
      await store.writeMemory(args!.path as string, args!.content as string)
      return { content: [{ type: 'text', text: 'Memory written.' }] }
    }

    if (name === 'edit_memory') {
      const ok = await store.editSection(args!.path as string, args!.old_content as string, args!.new_content as string)
      return { content: [{ type: 'text', text: ok ? 'Section updated.' : 'Section not found — content may have changed. Use read_memory to get current state.' }] }
    }

    if (name === 'append_memory') {
      await store.appendMemory(args!.path as string, args!.content as string)
      return { content: [{ type: 'text', text: 'Content appended.' }] }
    }

    if (name === 'list_memories') {
      const files = await store.listMemories(args?.category as string | undefined)
      return { content: [{ type: 'text', text: JSON.stringify(files) }] }
    }

    if (name === 'delete_memory') {
      await store.deleteMemory(args!.path as string)
      return { content: [{ type: 'text', text: 'Memory deleted.' }] }
    }

    throw new Error(`Unknown tool: ${name}`)
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
      isError: true
    }
  }
})

async function main() {
  await store.init()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)
