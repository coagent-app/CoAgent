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

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import Anthropic from '@anthropic-ai/sdk'

const execFileAsync = promisify(execFile)

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

interface ContactMatch {
  name: string
  /** All phone numbers and emails associated with this contact */
  identifiers: string[]
}

/**
 * Reverse lookup: find contacts whose display name fuzzy-matches the given
 * string. Queries the AddressBook SQLite databases directly (same sources as
 * buildContactCache). Returns one entry per unique display name, each with all
 * their phone numbers and emails.
 */
function lookupIdentifiersByName(contactName: string): ContactMatch[] {
  const dbPaths = findAddressBookDbs()
  const needle = contactName.toLowerCase()

  // name → identifiers — deduplicate across sources
  const byName = new Map<string, Set<string>>()

  for (const dbPath of dbPaths) {
    try {
      const db = new (getDatabase())(dbPath, { readonly: true })
      try {
        const rows = db.query(`
          SELECT r.Z_PK, r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION
          FROM ZABCDRECORD r
          WHERE LOWER(COALESCE(r.ZFIRSTNAME, '') || ' ' || COALESCE(r.ZLASTNAME, '')) LIKE ?
             OR LOWER(COALESCE(r.ZFIRSTNAME, ''))    LIKE ?
             OR LOWER(COALESCE(r.ZLASTNAME, ''))     LIKE ?
             OR LOWER(COALESCE(r.ZORGANIZATION, '')) LIKE ?
        `).all(`%${needle}%`, `%${needle}%`, `%${needle}%`, `%${needle}%`) as Array<{
          Z_PK: number
          ZFIRSTNAME: string | null
          ZLASTNAME: string | null
          ZORGANIZATION: string | null
        }>

        for (const row of rows) {
          const name = [row.ZFIRSTNAME, row.ZLASTNAME].filter(Boolean).join(' ') || row.ZORGANIZATION
          if (!name) continue

          const key = name.toLowerCase()
          if (!byName.has(key)) byName.set(key, new Set())
          const ids = byName.get(key)!

          const phones = db.query(
            'SELECT ZFULLNUMBER FROM ZABCDPHONENUMBER WHERE ZOWNER = ? AND ZFULLNUMBER IS NOT NULL'
          ).all(row.Z_PK) as Array<{ ZFULLNUMBER: string }>
          for (const p of phones) ids.add(p.ZFULLNUMBER)

          const emails = db.query(
            'SELECT ZADDRESS FROM ZABCDEMAILADDRESS WHERE ZOWNER = ? AND ZADDRESS IS NOT NULL'
          ).all(row.Z_PK) as Array<{ ZADDRESS: string }>
          for (const e of emails) ids.add(e.ZADDRESS.toLowerCase())
        }
      } finally {
        db.close()
      }
    } catch (e: any) {
      console.log(`[iMessage] Skipping ${dbPath} for name lookup: ${e.message}`)
    }
  }

  return Array.from(byName.entries()).map(([name, ids]) => ({
    name,
    identifiers: Array.from(ids),
  }))
}

function coreDataToISO(ts: number | null): string | null {
  if (!ts) return null
  return new Date((ts / 1000000000 + 978307200) * 1000).toISOString()
}

/** Reverse of coreDataToISO — converts an ISO date string to a CoreData nanosecond timestamp. */
function isoToCoreData(iso: string): number {
  return (Date.parse(iso) / 1000 - 978307200) * 1000000000
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
 * Modeled after ReagentX/imessage-exporter's streamtyped.rs legacy parser, which
 * is shipped in production with a comprehensive test suite (ASCII, Unicode,
 * 2359-byte long messages, attachments, URLs, mathematical script).
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

function openDb(): any {
  return new (getDatabase())(CHAT_DB, { readonly: true })
}

/**
 * Denylist provider. server.ts injects a getter that returns the current
 * `imessage_denylist` from settings. The filter is applied in SQL so excluded
 * messages never enter process memory.
 */
let _getDenylist: () => string[] = () => []
export function setDenylistProvider(fn: () => string[]) { _getDenylist = fn }

function normalizeId(id: string): string {
  const trimmed = id.trim()
  if (trimmed.includes('@')) return trimmed.toLowerCase()
  const digits = normalizeDigits(trimmed)
  return digits.length >= 7 ? digits : trimmed
}

/** Returns the denylist in normalized form (lowercase email or last-10-digit phone). */
function currentDenyNormalized(): Set<string> {
  const out = new Set<string>()
  for (const id of _getDenylist()) {
    const n = normalizeId(id)
    if (n) out.add(n)
  }
  return out
}

function isDenied(identifier: string | null | undefined, deny: Set<string>): boolean {
  if (!identifier || deny.size === 0) return false
  return deny.has(normalizeId(identifier))
}

/**
 * Full contacts list for the denylist picker UI. Sources:
 *   1. Every contact from the AddressBook SQLite DBs (all phone/email identifiers
 *      grouped by person — one row per contact, not per number).
 *   2. Plus any 1:1 iMessage sender whose identifier is not yet saved in Contacts
 *      (unknown numbers you've still texted with). These appear as single-id rows
 *      so users can deny spam/unsaved numbers too.
 *
 * Sorted by most-recent iMessage activity (contacts with no iMessage history
 * appear after those who have messaged you, alphabetically).
 */
export interface DenyPickerContact {
  name: string
  identifiers: string[]
  last_message_date: string | null
  is_denied: boolean  // true if ANY of the contact's identifiers is in the denylist
}
export function listContactsForDenyPicker(): DenyPickerContact[] {
  // --- 1. Collect all contacts from AddressBook, grouped by person ---
  const dbPaths = findAddressBookDbs()
  const contactsByName = new Map<string, Set<string>>()  // display name → identifiers

  for (const dbPath of dbPaths) {
    try {
      const db = new (getDatabase())(dbPath, { readonly: true })
      try {
        const rows = db.query(`
          SELECT r.Z_PK, r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION
          FROM ZABCDRECORD r
        `).all() as Array<{
          Z_PK: number
          ZFIRSTNAME: string | null
          ZLASTNAME: string | null
          ZORGANIZATION: string | null
        }>

        for (const row of rows) {
          const name = [row.ZFIRSTNAME, row.ZLASTNAME].filter(Boolean).join(' ') || row.ZORGANIZATION
          if (!name) continue
          if (!contactsByName.has(name)) contactsByName.set(name, new Set())
          const ids = contactsByName.get(name)!

          const phones = db.query(
            'SELECT ZFULLNUMBER FROM ZABCDPHONENUMBER WHERE ZOWNER = ? AND ZFULLNUMBER IS NOT NULL'
          ).all(row.Z_PK) as Array<{ ZFULLNUMBER: string }>
          for (const p of phones) ids.add(p.ZFULLNUMBER)

          const emails = db.query(
            'SELECT ZADDRESS FROM ZABCDEMAILADDRESS WHERE ZOWNER = ? AND ZADDRESS IS NOT NULL'
          ).all(row.Z_PK) as Array<{ ZADDRESS: string }>
          for (const e of emails) ids.add(e.ZADDRESS.toLowerCase())
        }
      } finally {
        db.close()
      }
    } catch (e: any) {
      console.log(`[iMessage] Skipping ${dbPath} for picker: ${e.message}`)
    }
  }

  // --- 2. Build an identifier → last-message-date map from chat.db ---
  const idToLastDate = new Map<string, number>()  // raw chat_identifier → coredata ts
  try {
    const db = openDb()
    try {
      const rows = db.query(`
        SELECT c.chat_identifier, MAX(m.date) AS last_date
        FROM chat c
        LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
        LEFT JOIN message m ON m.ROWID = cmj.message_id
        WHERE c.chat_identifier NOT LIKE 'chat%'
        GROUP BY c.chat_identifier
      `).all() as Array<{ chat_identifier: string; last_date: number | null }>
      for (const r of rows) {
        if (r.chat_identifier && r.last_date) {
          idToLastDate.set(r.chat_identifier, r.last_date)
        }
      }
    } finally {
      db.close()
    }
  } catch (e: any) {
    console.log(`[iMessage] Picker: could not read chat.db for last-message dates: ${e.message}`)
  }

  // Helper: max coredata date across a contact's identifiers (normalized matching).
  const lastDateForIdentifiers = (identifiers: string[]): number | null => {
    let best: number | null = null
    for (const id of identifiers) {
      // Try exact match first, then normalized digits.
      const direct = idToLastDate.get(id)
      if (direct && (best === null || direct > best)) best = direct
      const normId = normalizeId(id)
      for (const [chatId, date] of idToLastDate) {
        if (normalizeId(chatId) === normId) {
          if (best === null || date > best) best = date
        }
      }
    }
    return best
  }

  // --- 3. Build the contact list ---
  const deny = currentDenyNormalized()
  const contacts: DenyPickerContact[] = []
  const normalizedIdsSeen = new Set<string>()

  for (const [name, idSet] of contactsByName) {
    const identifiers = Array.from(idSet)
    for (const id of identifiers) normalizedIdsSeen.add(normalizeId(id))
    contacts.push({
      name,
      identifiers,
      last_message_date: coreDataToISO(lastDateForIdentifiers(identifiers)),
      is_denied: identifiers.some(id => isDenied(id, deny)),
    })
  }

  // --- 4. Add unknown 1:1 senders not already covered by a contact ---
  for (const [chatId] of idToLastDate) {
    if (normalizedIdsSeen.has(normalizeId(chatId))) continue
    contacts.push({
      name: chatId,
      identifiers: [chatId],
      last_message_date: coreDataToISO(idToLastDate.get(chatId) ?? null),
      is_denied: isDenied(chatId, deny),
    })
  }

  // --- 5. Sort: contacts with recent iMessage activity first (newest → oldest),
  //        then the rest alphabetically by name. ---
  contacts.sort((a, b) => {
    if (a.last_message_date && b.last_message_date) {
      return b.last_message_date.localeCompare(a.last_message_date)
    }
    if (a.last_message_date) return -1
    if (b.last_message_date) return 1
    return a.name.localeCompare(b.name)
  })

  return contacts
}

export const IMESSAGE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'IMESSAGE_LIST_CONVERSATIONS',
    description: 'List recent iMessage conversations with last message preview, sender, and unread count. Set unread_only=true to see only unread conversations.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of conversations to return (default 20)',
        },
        unread_only: {
          type: 'boolean',
          description: 'When true, only return conversations where the last message is unread (received, not yet read)',
        },
      },
      required: [],
    },
  },
  {
    name: 'IMESSAGE_GET_CONVERSATION',
    description: "Get message history from a specific contact by phone number or email. Returns messages in chronological order. Use 'since'/'before' with ISO dates to filter by date range (e.g. since='2026-04-01').",
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
        since: {
          type: 'string',
          description: 'Return only messages on or after this ISO date string (e.g. "2024-01-01T00:00:00Z")',
        },
        before: {
          type: 'string',
          description: 'Return only messages before this ISO date string (e.g. "2024-12-31T23:59:59Z")',
        },
      },
      required: ['identifier'],
    },
  },
  {
    name: 'IMESSAGE_SEARCH',
    description: 'Search all iMessage conversations by keyword. Optionally filter by contact and/or date range. Returns matching messages with sender names and timestamps.',
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
        since: {
          type: 'string',
          description: 'Return only messages on or after this ISO date string (e.g. "2024-01-01T00:00:00Z")',
        },
        before: {
          type: 'string',
          description: 'Return only messages before this ISO date string (e.g. "2024-12-31T23:59:59Z")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'IMESSAGE_SEND',
    description: "Send an iMessage. Provide either 'to' (phone/email) or 'contact_name' (will auto-resolve from Contacts). Message is sent via the Messages app.",
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient phone number or email address. Required if contact_name is not provided.',
        },
        contact_name: {
          type: 'string',
          description: "Recipient's name as it appears in Contacts. The tool will look up their phone number or email automatically. Use this instead of 'to' when you know the person's name but not their number.",
        },
        text: {
          type: 'string',
          description: 'Message text to send',
        },
      },
      required: ['text'],
    },
  },
]

export async function handleImessageTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    if (name === 'IMESSAGE_LIST_CONVERSATIONS') {
      const limit = (args?.limit as number) ?? 20
      const unreadOnly = (args?.unread_only as boolean) ?? false
      const deny = currentDenyNormalized()
      // Over-fetch when a denylist is active so the final count still approaches `limit`.
      const fetchLimit = deny.size > 0 ? limit * 3 : limit
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
            m.is_from_me,
            m.is_read,
            (
              SELECT COUNT(*)
              FROM chat_message_join cmj3
              JOIN message m3 ON m3.ROWID = cmj3.message_id
              WHERE cmj3.chat_id = c.ROWID
                AND m3.is_from_me = 0
                AND m3.is_read = 0
            ) AS unread_count
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
          ${unreadOnly ? 'AND m.is_from_me = 0 AND m.is_read = 0' : ''}
          ORDER BY m.date DESC
          LIMIT ?
        `).all(fetchLimit) as Array<{
          chat_id: number
          chat_identifier: string
          display_name: string | null
          handle_id: string | null
          last_text: string | null
          last_attributed_body: Uint8Array | null
          last_date: number | null
          is_from_me: number
          is_read: number
          unread_count: number
        }>

        const conversations = rows
          // Hide 1:1 chats where the other party is denied. Group chats have a
          // chat_identifier starting with "chat" (GUID) that never matches the
          // denylist, so they're always kept — denied senders inside a group
          // are filtered at message level in IMESSAGE_GET_CONVERSATION.
          .filter(row => !isDenied(row.chat_identifier, deny))
          .slice(0, limit)
          .map((row) => {
            const id = row.handle_id || row.chat_identifier
            const contactName = row.display_name || lookupContactName(id) || id
            return {
              chat_identifier: row.chat_identifier,
              display_name: contactName,
              last_message: row.last_text ?? parseAttributedBody(row.last_attributed_body),
              last_message_sender: row.is_from_me === 1 ? 'me' : contactName,
              last_message_date: coreDataToISO(row.last_date),
              unread_count: row.unread_count,
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
      const since = args?.since as string | undefined
      const before = args?.before as string | undefined
      const deny = currentDenyNormalized()
      if (isDenied(identifier, deny)) {
        return JSON.stringify({ error: 'This contact is on the iMessage denylist and cannot be read.' })
      }
      const db = openDb()
      try {
        const dateConditions: string[] = []
        const dateParams: number[] = []
        if (since) {
          dateConditions.push('m.date >= ?')
          dateParams.push(isoToCoreData(since))
        }
        if (before) {
          dateConditions.push('m.date < ?')
          dateParams.push(isoToCoreData(before))
        }
        const dateWhere = dateConditions.length > 0 ? ' AND ' + dateConditions.join(' AND ') : ''

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
          WHERE c.chat_identifier LIKE ?${dateWhere}
          ORDER BY m.date DESC
          LIMIT ?
        `).all(`%${identifier}%`, ...dateParams, limit) as Array<{
          ROWID: number
          text: string | null
          attributedBody: Uint8Array | null
          date: number | null
          is_from_me: number
          sender_handle: string | null
        }>

        const messages = rows
          // Filter messages from denied senders (e.g. a denied participant in a group chat).
          // Your own messages (is_from_me=1) always pass through.
          .filter(row => row.is_from_me === 1 || !isDenied(row.sender_handle, deny))
          .reverse()
          .map((row) => ({
            id: row.ROWID,
            text: row.text ?? parseAttributedBody(row.attributedBody),
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
      const deny = currentDenyNormalized()
      if (contact && isDenied(contact, deny)) {
        return JSON.stringify({ error: 'This contact is on the iMessage denylist and cannot be searched.' })
      }
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
          // Drop matches in denied 1:1 threads and messages sent by denied senders in group chats.
          if (isDenied(row.chat_identifier, deny)) continue
          if (row.is_from_me !== 1 && isDenied(row.sender_handle, deny)) continue
          results.push({
            id: row.ROWID,
            text,
            date: coreDataToISO(row.date),
            is_from_me: row.is_from_me === 1,
            chat_identifier: row.chat_identifier,
            sender: row.is_from_me === 1 ? 'me' : (lookupContactName(row.sender_handle ?? '') || row.sender_handle || 'unknown'),
          })
          if (results.length >= limit) break
        }

        return JSON.stringify(results, null, 2)
      } finally {
        db.close()
      }
    }

    if (name === 'IMESSAGE_SEND') {
      const contactName = args?.contact_name as string | undefined
      let to = args?.to as string | undefined
      const text = args?.text as string

      // Resolve contact_name → phone/email if to is not provided directly
      if (!to && contactName) {
        const matches = lookupIdentifiersByName(contactName)

        if (matches.length === 0) {
          return `No contact found matching "${contactName}". Please check the name or provide the phone number/email directly using the 'to' parameter.`
        }

        if (matches.length > 1) {
          const names = matches.map(m => `"${m.name}"`).join(', ')
          return `Multiple contacts match "${contactName}": ${names}. Please be more specific or provide the phone number/email directly using the 'to' parameter.`
        }

        const match = matches[0]
        if (match.identifiers.length === 0) {
          return `Contact "${match.name}" was found but has no phone number or email address on record.`
        }

        // Prefer a phone number over email for iMessage; fall back to first identifier
        const phone = match.identifiers.find(id => !id.includes('@'))
        to = phone ?? match.identifiers[0]
        console.log(`[iMessage] Resolved "${contactName}" → ${to}`)
      }

      if (!to) {
        return "Missing recipient. Provide either 'to' (phone number or email) or 'contact_name'."
      }

      // Validate recipient format to prevent AppleScript injection
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

      await execFileAsync('osascript', ['-e', appleScript])

      const recipient = contactName ? `${contactName} (${to})` : to
      return `Message sent to ${recipient}`
    }

    throw new Error(`Unknown iMessage tool: ${name}`)
  } catch (error: any) {
    if (error?.code === 'SQLITE_CANTOPEN' || error?.message?.includes('unable to open')) {
      return 'Cannot open chat.db. Please grant Full Disk Access to this application in System Settings > Privacy & Security > Full Disk Access.'
    }
    return `Error: ${error?.message ?? String(error)}`
  }
}
