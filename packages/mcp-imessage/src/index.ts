#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Database } from 'bun:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'

const CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db')

function coreDataToISO(ts: number | null): string | null {
  if (!ts) return null
  return new Date((ts / 1000000000 + 978307200) * 1000).toISOString()
}

/**
 * Parse the NSAttributedString typedstream blob stored in message.attributedBody
 * and return the plain text. Starting with macOS Ventura, Messages leaves the
 * `text` column NULL for locally-sent/newer messages and puts the text here
 * instead.
 *
 * Format: NeXTSTEP/Apple `typedstream` (legacy NSArchiver, NOT NSKeyedArchiver).
 * The first `0x01 0x2b` byte pair after the header is the type-tag for "1 type
 * follows, the tag is `+` (UTF-8 C-string)" and immediately precedes the message
 * body. The next 1, 3, or 5 bytes are a length prefix:
 *   - 0x00..0x80      → length is the byte itself
 *   - 0x81 LL LL      → length is u16 LE
 *   - 0x82 LL LL LL LL → length is u32 LE
 * followed by `length` UTF-8 bytes.
 *
 * Modeled after ReagentX/imessage-exporter's streamtyped.rs legacy parser.
 */
function parseAttributedBody(blob: Uint8Array | Buffer | null | undefined): string | null {
  if (!blob || blob.length === 0) return null
  const buf: Uint8Array = blob instanceof Uint8Array ? blob : new Uint8Array(blob as any)

  // 1. Find the FIRST 0x01 0x2b marker. Class names like "NSString" use a
  //    different shape (0x84 [len] name 0x00) and never appear here.
  let i = -1
  for (let k = 0; k < buf.length - 1; k++) {
    if (buf[k] === 0x01 && buf[k + 1] === 0x2b) { i = k; break }
  }
  if (i < 0) return null

  // 2. Decode the length prefix that immediately follows the type tag.
  const p = i + 2
  if (p >= buf.length) return null
  const tag = buf[p]
  let len: number
  let start: number
  if (tag <= 0x80) {
    len = tag
    start = p + 1
  } else if (tag === 0x81 && p + 2 < buf.length) {
    len = buf[p + 1] | (buf[p + 2] << 8)
    start = p + 3
  } else if (tag === 0x82 && p + 4 < buf.length) {
    len = buf[p + 1] | (buf[p + 2] << 8) | (buf[p + 3] << 16) | (buf[p + 4] << 24)
    start = p + 5
  } else {
    return null
  }
  if (len <= 0 || start + len > buf.length) return null

  // 3. Non-fatal UTF-8 decode so a corrupted byte yields U+FFFD instead of
  //    throwing — Apple has been known to ship invalid sequences in old rows.
  const text = new TextDecoder('utf-8').decode(buf.subarray(start, start + len))
  if (!text) return null

  // 4. Defensive backstop: a real message body never equals a known class name.
  if (/^(NS|__kIM)/.test(text)) return null

  return text
}

function openDb(): Database {
  return new Database(CHAT_DB, { readonly: true })
}

process.stdout.on('error', (err: any) => {
  if (err?.code === 'EPIPE') process.exit(0)
})
process.on('uncaughtException', (err: any) => {
  if (err?.code === 'EPIPE' || err?.message?.includes('EPIPE')) process.exit(0)
  console.error('[iMessage] Uncaught:', err)
  process.exit(1)
})

const server = new Server(
  { name: 'coagent-imessage', version: '0.0.1' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'IMESSAGE_LIST_CONVERSATIONS',
      description: 'List recent iMessage conversations with last message preview.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of conversations to return (default 20)',
          },
        },
        required: [],
      },
    },
    {
      name: 'IMESSAGE_GET_CONVERSATION',
      description: 'Get recent messages from a specific conversation by phone number or email address.',
      inputSchema: {
        type: 'object',
        properties: {
          identifier: {
            type: 'string',
            description: 'Phone number or email of the contact',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of messages to return (default 50)',
          },
        },
        required: ['identifier'],
      },
    },
    {
      name: 'IMESSAGE_SEARCH',
      description: 'Search messages by keyword, optionally filtered by contact.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keyword to search for in message text',
          },
          contact: {
            type: 'string',
            description: 'Optional phone number or email to filter results to a specific contact',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default 30)',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'IMESSAGE_SEND',
      description: 'Send an iMessage to a phone number or email address via AppleScript.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Recipient phone number or email address',
          },
          text: {
            type: 'string',
            description: 'Message text to send',
          },
        },
        required: ['to', 'text'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    if (name === 'IMESSAGE_LIST_CONVERSATIONS') {
      const limit = (args?.limit as number) ?? 20
      const db = openDb()

      try {
        const rows = db.query(`
          SELECT
            c.ROWID          AS chat_id,
            c.chat_identifier,
            c.display_name,
            h.id             AS handle_id,
            m.text           AS last_text,
            m.attributedBody AS last_attributed_body,
            m.date           AS last_date,
            m.is_from_me
          FROM chat c
          LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
          LEFT JOIN message m ON m.ROWID = cmj.message_id
          LEFT JOIN handle h ON h.ROWID = m.handle_id
          WHERE m.date = (
            SELECT MAX(m2.date)
            FROM chat_message_join cmj2
            JOIN message m2 ON m2.ROWID = cmj2.message_id
            WHERE cmj2.chat_id = c.ROWID
          )
          ORDER BY m.date DESC
          LIMIT ?
        `).all(limit) as Array<{
          chat_id: number
          chat_identifier: string
          display_name: string | null
          handle_id: string | null
          last_text: string | null
          last_attributed_body: Uint8Array | null
          last_date: number | null
          is_from_me: number
        }>

        const conversations = rows.map((row) => ({
          chat_identifier: row.chat_identifier,
          display_name: row.display_name || row.handle_id || row.chat_identifier,
          last_message: row.last_text ?? parseAttributedBody(row.last_attributed_body),
          last_message_date: coreDataToISO(row.last_date),
          is_from_me: row.is_from_me === 1,
        }))

        return {
          content: [{ type: 'text', text: JSON.stringify(conversations, null, 2) }],
        }
      } finally {
        db.close()
      }
    }

    if (name === 'IMESSAGE_GET_CONVERSATION') {
      const identifier = args?.identifier as string
      const limit = (args?.limit as number) ?? 50
      const db = openDb()

      try {
        const rows = db.query(`
          SELECT
            m.ROWID,
            m.text,
            m.attributedBody,
            m.date,
            m.is_from_me,
            h.id AS sender_handle
          FROM message m
          JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
          JOIN chat c ON c.ROWID = cmj.chat_id
          LEFT JOIN handle h ON h.ROWID = m.handle_id
          WHERE c.chat_identifier LIKE ?
          ORDER BY m.date DESC
          LIMIT ?
        `).all(`%${identifier}%`, limit) as Array<{
          ROWID: number
          text: string | null
          attributedBody: Uint8Array | null
          date: number | null
          is_from_me: number
          sender_handle: string | null
        }>

        const messages = rows.reverse().map((row) => ({
          id: row.ROWID,
          text: row.text ?? parseAttributedBody(row.attributedBody),
          date: coreDataToISO(row.date),
          is_from_me: row.is_from_me === 1,
          sender: row.is_from_me === 1 ? 'me' : (row.sender_handle ?? 'unknown'),
        }))

        return {
          content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }],
        }
      } finally {
        db.close()
      }
    }

    if (name === 'IMESSAGE_SEARCH') {
      const query = args?.query as string
      const contact = args?.contact as string | undefined
      const limit = (args?.limit as number) ?? 30
      const db = openDb()

      try {
        let sql: string
        let params: (string | number)[]

        // Pre-filter by LIKE against both m.text and m.attributedBody. SQLite's
        // LIKE operator works byte-wise on BLOBs, so an ASCII query matches the
        // UTF-8 bytes embedded in the typedstream. We still re-check in JS after
        // parsing to ensure accuracy and apply the final limit.
        const prefetch = limit * 4
        if (contact) {
          sql = `
            SELECT m.ROWID, m.text, m.attributedBody, m.date, m.is_from_me, c.chat_identifier, h.id AS sender_handle
            FROM message m
            JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            JOIN chat c ON c.ROWID = cmj.chat_id
            LEFT JOIN handle h ON h.ROWID = m.handle_id
            WHERE (m.text LIKE ? OR m.attributedBody LIKE ?) AND c.chat_identifier LIKE ?
            ORDER BY m.date DESC LIMIT ?
          `
          params = [`%${query}%`, `%${query}%`, `%${contact}%`, prefetch]
        } else {
          sql = `
            SELECT m.ROWID, m.text, m.attributedBody, m.date, m.is_from_me, c.chat_identifier, h.id AS sender_handle
            FROM message m
            JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            JOIN chat c ON c.ROWID = cmj.chat_id
            LEFT JOIN handle h ON h.ROWID = m.handle_id
            WHERE m.text LIKE ? OR m.attributedBody LIKE ?
            ORDER BY m.date DESC LIMIT ?
          `
          params = [`%${query}%`, `%${query}%`, prefetch]
        }

        const rows = db.query(sql).all(...params) as Array<{
          ROWID: number
          text: string | null
          attributedBody: Uint8Array | null
          date: number | null
          is_from_me: number
          chat_identifier: string
          sender_handle: string | null
        }>

        const needle = query.toLowerCase()
        const results: Array<{
          id: number
          text: string | null
          date: string | null
          is_from_me: boolean
          chat_identifier: string
          sender: string
        }> = []
        for (const row of rows) {
          const text = row.text ?? parseAttributedBody(row.attributedBody)
          if (!text || !text.toLowerCase().includes(needle)) continue
          results.push({
            id: row.ROWID,
            text,
            date: coreDataToISO(row.date),
            is_from_me: row.is_from_me === 1,
            chat_identifier: row.chat_identifier,
            sender: row.is_from_me === 1 ? 'me' : (row.sender_handle ?? 'unknown'),
          })
          if (results.length >= limit) break
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        }
      } finally {
        db.close()
      }
    }

    if (name === 'IMESSAGE_SEND') {
      const to = args?.to as string
      const text = args?.text as string

      // Validate recipient format to prevent AppleScript/shell injection
      if (!/^[\d+\-() ]+$|^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
        return { content: [{ type: 'text', text: `Invalid recipient format: "${to}". Must be a phone number or email address.` }] }
      }

      const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

      const appleScript = [
        'tell application "Messages"',
        '  set targetService to 1st service whose service type = iMessage',
        `  set targetBuddy to buddy "${to}" of targetService`,
        `  send "${escaped}" to targetBuddy`,
        'end tell',
      ].join('\n')

      execSync(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`)

      return {
        content: [{ type: 'text', text: `Message sent to ${to}` }],
      }
    }

    throw new Error(`Unknown tool: ${name}`)
  } catch (error: any) {
    if (error?.code === 'SQLITE_CANTOPEN' || error?.message?.includes('unable to open')) {
      return {
        content: [{
          type: 'text',
          text: 'Cannot open chat.db. Please grant Full Disk Access to this application in System Settings > Privacy & Security > Full Disk Access.',
        }],
        isError: true,
      }
    }

    return {
      content: [{ type: 'text', text: `Error: ${error?.message ?? String(error)}` }],
      isError: true,
    }
  }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)
