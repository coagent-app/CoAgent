/**
 * Local iMessage tool handler.
 *
 * Runs in-process inside coagent-server (a direct child of the Tauri app),
 * which inherits Full Disk Access from the signed app bundle. We avoid
 * spawning a sidecar subprocess because macOS TCC does NOT propagate FDA to
 * grandchild processes.
 *
 * Contact name resolution uses direct SQLite access to the AddressBook
 * databases (in Sources/ subdirectories) instead of AppleScript. The
 * AppleScript approach was unreliable because:
 *   1. Iterating all contacts via AppleScript takes 15-30+ seconds (vs ~17ms
 *      via SQLite), exceeding the execSync timeout.
 *   2. osascript requires per-binary Automation/Contacts TCC approval — a
 *      sidecar binary doesn't inherit the parent app's TCC grants.
 *
 * bun:sqlite is available at runtime in the compiled Bun binary but is not
 * a Node.js / TypeScript module, so we require() it dynamically to keep tsc
 * happy while still getting the real implementation at runtime.
 */

import { execSync } from 'child_process'
import { readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import Anthropic from '@anthropic-ai/sdk'

// Lazy-load bun:sqlite — only available in the compiled Bun sidecar, not Node dev mode
let _Database: any = null
function getDatabase(): any {
  if (!_Database) _Database = require('bun:sqlite').Database
  return _Database
}

const CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db')

/** Cached phone/email → contact name map, built from AddressBook SQLite databases */
let contactCache: Map<string, string> | null = null
let contactCacheTime = 0
const CACHE_TTL = 5 * 60 * 1000 // refresh every 5 min

function normalizeDigits(s: string): string {
  return s.replace(/\D/g, '').slice(-10)
}

/**
 * Find all AddressBook-v22.abcddb files. macOS stores contacts in per-source
 * databases under ~/Library/Application Support/AddressBook/Sources/<UUID>/,
 * while the root-level DB typically only contains the local "On My Mac" account
 * (often nearly empty when iCloud is the primary source).
 */
function findAddressBookDbs(): string[] {
  const abDir = join(homedir(), 'Library', 'Application Support', 'AddressBook')
  const dbs: string[] = []

  // Check Sources subdirectories first (iCloud, Exchange, etc.)
  const sourcesDir = join(abDir, 'Sources')
  try {
    for (const entry of readdirSync(sourcesDir)) {
      const candidate = join(sourcesDir, entry, 'AddressBook-v22.abcddb')
      try {
        if (statSync(candidate).isFile()) dbs.push(candidate)
      } catch { /* skip */ }
    }
  } catch { /* Sources dir may not exist */ }

  // Also include root DB as fallback (may have local-only contacts)
  const rootDb = join(abDir, 'AddressBook-v22.abcddb')
  try {
    if (statSync(rootDb).isFile()) dbs.push(rootDb)
  } catch { /* skip */ }

  return dbs
}

function buildContactCache(): Map<string, string> {
  const map = new Map<string, string>()
  const dbPaths = findAddressBookDbs()

  for (const dbPath of dbPaths) {
    try {
      const db = new (getDatabase())(dbPath, { readonly: true })
      try {
        // Phone → name
        const phones = db.query(`
          SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, p.ZFULLNUMBER
          FROM ZABCDRECORD r
          JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
          WHERE p.ZFULLNUMBER IS NOT NULL
        `).all() as Array<{ ZFIRSTNAME: string | null; ZLASTNAME: string | null; ZORGANIZATION: string | null; ZFULLNUMBER: string }>

        for (const row of phones) {
          const name = [row.ZFIRSTNAME, row.ZLASTNAME].filter(Boolean).join(' ') || row.ZORGANIZATION
          if (name && row.ZFULLNUMBER) {
            map.set(normalizeDigits(row.ZFULLNUMBER), name)
          }
        }

        // Email → name
        const emails = db.query(`
          SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, e.ZADDRESS
          FROM ZABCDRECORD r
          JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
          WHERE e.ZADDRESS IS NOT NULL
        `).all() as Array<{ ZFIRSTNAME: string | null; ZLASTNAME: string | null; ZORGANIZATION: string | null; ZADDRESS: string }>

        for (const row of emails) {
          const name = [row.ZFIRSTNAME, row.ZLASTNAME].filter(Boolean).join(' ') || row.ZORGANIZATION
          if (name && row.ZADDRESS) {
            map.set(row.ZADDRESS.toLowerCase(), name)
          }
        }
      } finally {
        db.close()
      }
    } catch (e: any) {
      console.log(`[iMessage] Skipping ${dbPath}: ${e.message}`)
    }
  }

  return map
}

function lookupContactName(identifier: string): string | null {
  if (!contactCache || Date.now() - contactCacheTime > CACHE_TTL) {
    contactCache = buildContactCache()
    contactCacheTime = Date.now()
    console.log(`[iMessage] Contact cache built: ${contactCache.size} entries`)
  }
  // Try phone digits match
  const digits = normalizeDigits(identifier)
  if (digits.length >= 7) {
    const name = contactCache.get(digits)
    if (name) return name
  }
  // Try email match
  if (identifier.includes('@')) {
    const name = contactCache.get(identifier.toLowerCase())
    if (name) return name
  }
  return null
}

function coreDataToISO(ts: number | null): string | null {
  if (!ts) return null
  return new Date((ts / 1000000000 + 978307200) * 1000).toISOString()
}

function openDb(): any {
  return new (getDatabase())(CHAT_DB, { readonly: true })
}

export const IMESSAGE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'IMESSAGE_LIST_CONVERSATIONS',
    description: 'List recent iMessage conversations with last message preview.',
    input_schema: {
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
    input_schema: {
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
    input_schema: {
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
    input_schema: {
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
]

export async function handleImessageTool(name: string, args: Record<string, unknown>): Promise<string> {
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
          last_date: number | null
          is_from_me: number
        }>

        const conversations = rows.map((row) => {
          const id = row.handle_id || row.chat_identifier
          const contactName = row.display_name || lookupContactName(id) || id
          return {
            chat_identifier: row.chat_identifier,
            display_name: contactName,
            last_message: row.last_text,
            last_message_date: coreDataToISO(row.last_date),
            is_from_me: row.is_from_me === 1,
          }
        })

        return JSON.stringify(conversations, null, 2)
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
          date: number | null
          is_from_me: number
          sender_handle: string | null
        }>

        const messages = rows.reverse().map((row) => ({
          id: row.ROWID,
          text: row.text,
          date: coreDataToISO(row.date),
          is_from_me: row.is_from_me === 1,
          sender: row.is_from_me === 1 ? 'me' : (lookupContactName(row.sender_handle ?? '') || row.sender_handle || 'unknown'),
        }))

        return JSON.stringify(messages, null, 2)
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

        if (contact) {
          sql = `
            SELECT m.ROWID, m.text, m.date, m.is_from_me, c.chat_identifier, h.id AS sender_handle
            FROM message m
            JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            JOIN chat c ON c.ROWID = cmj.chat_id
            LEFT JOIN handle h ON h.ROWID = m.handle_id
            WHERE m.text LIKE ? AND c.chat_identifier LIKE ?
            ORDER BY m.date DESC LIMIT ?
          `
          params = [`%${query}%`, `%${contact}%`, limit]
        } else {
          sql = `
            SELECT m.ROWID, m.text, m.date, m.is_from_me, c.chat_identifier, h.id AS sender_handle
            FROM message m
            JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            JOIN chat c ON c.ROWID = cmj.chat_id
            LEFT JOIN handle h ON h.ROWID = m.handle_id
            WHERE m.text LIKE ?
            ORDER BY m.date DESC LIMIT ?
          `
          params = [`%${query}%`, limit]
        }

        const rows = db.query(sql).all(...params) as Array<{
          ROWID: number
          text: string | null
          date: number | null
          is_from_me: number
          chat_identifier: string
          sender_handle: string | null
        }>

        const results = rows.map((row) => ({
          id: row.ROWID,
          text: row.text,
          date: coreDataToISO(row.date),
          is_from_me: row.is_from_me === 1,
          chat_identifier: row.chat_identifier,
          sender: row.is_from_me === 1 ? 'me' : (lookupContactName(row.sender_handle ?? '') || row.sender_handle || 'unknown'),
        }))

        return JSON.stringify(results, null, 2)
      } finally {
        db.close()
      }
    }

    if (name === 'IMESSAGE_SEND') {
      const to = args?.to as string
      const text = args?.text as string

      // Validate recipient format to prevent AppleScript/shell injection
      if (!/^[\d+\-() ]+$|^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
        return `Invalid recipient format: "${to}". Must be a phone number or email address.`
      }

      const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const escapedTo = to.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

      const appleScript = [
        'tell application "Messages"',
        '  set targetService to 1st service whose service type = iMessage',
        `  set targetBuddy to buddy "${escapedTo}" of targetService`,
        `  send "${escaped}" to targetBuddy`,
        'end tell',
      ].join('\n')

      execSync(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`)

      return `Message sent to ${to}`
    }

    throw new Error(`Unknown iMessage tool: ${name}`)
  } catch (error: any) {
    if (error?.code === 'SQLITE_CANTOPEN' || error?.message?.includes('unable to open')) {
      return 'Cannot open chat.db. Please grant Full Disk Access to this application in System Settings > Privacy & Security > Full Disk Access.'
    }
    return `Error: ${error?.message ?? String(error)}`
  }
}
