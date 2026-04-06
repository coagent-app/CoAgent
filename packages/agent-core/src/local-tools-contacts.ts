/**
 * Local Contacts tool handler.
 *
 * Runs in-process inside coagent-server (a direct child of the Tauri app),
 * which inherits Full Disk Access from the signed app bundle. We avoid
 * spawning a sidecar subprocess because macOS TCC does NOT propagate FDA to
 * grandchild processes.
 *
 * macOS stores contacts in per-source databases under
 * ~/Library/Application Support/AddressBook/Sources/<UUID>/AddressBook-v22.abcddb
 * (iCloud, Exchange, etc.). The root-level DB typically only contains the
 * local "On My Mac" account which is nearly empty when iCloud sync is active.
 * We query all source databases and merge results.
 *
 * bun:sqlite is available at runtime in the compiled Bun binary but is not
 * a Node.js / TypeScript module, so we require() it dynamically to keep tsc
 * happy while still getting the real implementation at runtime.
 */

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

/**
 * Find all AddressBook-v22.abcddb files across all sources.
 * Prioritizes Sources/ subdirectories (iCloud, Exchange) over the root DB.
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

/** Open all discoverable AddressBook databases (readonly). Caller must close them. */
function openAllDbs(): any[] {
  return findAddressBookDbs().map(path => {
    try {
      return new (getDatabase())(path, { readonly: true })
    } catch {
      return null
    }
  }).filter(Boolean)
}

/** Core Data timestamp -> ISO string (epoch = 2001-01-01) */
function coreDataToISO(ts: number | null): string | null {
  if (!ts) return null
  return new Date((ts + 978307200) * 1000).toISOString()
}

/** Strip Apple's internal label wrapper: _$!<Home>!$_ -> Home */
function cleanLabel(label: string | null): string {
  if (!label) return 'other'
  const m = label.match(/^_\$!<(.+?)>!\$_$/)
  return m ? m[1].toLowerCase() : label.toLowerCase()
}

interface ContactRow {
  Z_PK: number
  ZFIRSTNAME: string | null
  ZLASTNAME: string | null
  ZORGANIZATION: string | null
  ZJOBTITLE: string | null
  ZDEPARTMENT: string | null
  ZNICKNAME: string | null
  ZBIRTHDAY: number | null
  ZMODIFICATIONDATE: number | null
  ZCREATIONDATE: number | null
}

interface PhoneRow { ZFULLNUMBER: string | null; ZLABEL: string | null }
interface EmailRow { ZADDRESS: string | null; ZLABEL: string | null }
interface AddressRow {
  ZSTREET: string | null
  ZCITY: string | null
  ZSTATE: string | null
  ZZIPCODE: string | null
  ZCOUNTRYNAME: string | null
  ZLABEL: string | null
}

function formatContact(row: ContactRow, phones: PhoneRow[], emails: EmailRow[], addresses?: AddressRow[]): Record<string, unknown> {
  const name = [row.ZFIRSTNAME, row.ZLASTNAME].filter(Boolean).join(' ') || row.ZORGANIZATION || 'Unknown'
  const result: Record<string, unknown> = { id: row.Z_PK, name }
  if (row.ZORGANIZATION) result.organization = row.ZORGANIZATION
  if (row.ZJOBTITLE) result.job_title = row.ZJOBTITLE
  if (row.ZDEPARTMENT) result.department = row.ZDEPARTMENT
  if (row.ZNICKNAME) result.nickname = row.ZNICKNAME
  if (row.ZBIRTHDAY) result.birthday = coreDataToISO(row.ZBIRTHDAY)
  if (phones.length > 0) {
    result.phones = phones.map(p => ({ number: p.ZFULLNUMBER, label: cleanLabel(p.ZLABEL) }))
  }
  if (emails.length > 0) {
    result.emails = emails.map(e => ({ address: e.ZADDRESS, label: cleanLabel(e.ZLABEL) }))
  }
  if (addresses && addresses.length > 0) {
    result.addresses = addresses.map(a => ({
      street: a.ZSTREET,
      city: a.ZCITY,
      state: a.ZSTATE,
      zip: a.ZZIPCODE,
      country: a.ZCOUNTRYNAME,
      label: cleanLabel(a.ZLABEL),
    }))
  }
  if (row.ZMODIFICATIONDATE) result.modified = coreDataToISO(row.ZMODIFICATIONDATE)
  return result
}

export const CONTACTS_TOOLS: Anthropic.Tool[] = [
  {
    name: 'CONTACTS_SEARCH',
    description: 'Search contacts by name, email, phone number, or organization. Returns matching contacts with their details.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — matches against name, email, phone, organization',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 20)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'CONTACTS_GET',
    description: 'Get full details for a specific contact by their ID (Z_PK). Includes all phone numbers, emails, addresses.',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'Contact ID (Z_PK from a search result)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'CONTACTS_LIST_RECENT',
    description: 'List recently modified or added contacts.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of contacts to return (default 20)',
        },
      },
      required: [],
    },
  },
]

export async function handleContactsTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    if (name === 'CONTACTS_SEARCH') {
      const query = args?.query as string
      const limit = (args?.limit as number) ?? 20
      const allDbs = openAllDbs()
      if (allDbs.length === 0) {
        return 'No AddressBook databases found. Please grant Full Disk Access to this application in System Settings > Privacy & Security > Full Disk Access.'
      }
      try {
        const like = `%${query}%`
        const allContacts: Record<string, unknown>[] = []

        for (const db of allDbs) {
          const rows = db.query(`
            SELECT DISTINCT r.Z_PK, r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION,
                   r.ZJOBTITLE, r.ZDEPARTMENT, r.ZNICKNAME, r.ZBIRTHDAY,
                   r.ZMODIFICATIONDATE, r.ZCREATIONDATE
            FROM ZABCDRECORD r
            LEFT JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
            LEFT JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
            WHERE r.ZFIRSTNAME LIKE ?
               OR r.ZLASTNAME LIKE ?
               OR r.ZORGANIZATION LIKE ?
               OR e.ZADDRESS LIKE ?
               OR p.ZFULLNUMBER LIKE ?
            ORDER BY r.ZSORTINGLASTNAME, r.ZSORTINGFIRSTNAME
            LIMIT ?
          `).all(like, like, like, like, like, limit) as ContactRow[]

          for (const row of rows) {
            const phones = db.query(
              'SELECT ZFULLNUMBER, ZLABEL FROM ZABCDPHONENUMBER WHERE ZOWNER = ?'
            ).all(row.Z_PK) as PhoneRow[]
            const emails = db.query(
              'SELECT ZADDRESS, ZLABEL FROM ZABCDEMAILADDRESS WHERE ZOWNER = ?'
            ).all(row.Z_PK) as EmailRow[]
            allContacts.push(formatContact(row, phones, emails))
          }
        }

        // Deduplicate by name and limit
        const seen = new Set<string>()
        const deduped = allContacts.filter(c => {
          const key = (c.name as string).toLowerCase()
          if (seen.has(key)) return false
          seen.add(key)
          return true
        }).slice(0, limit)

        return JSON.stringify(deduped, null, 2)
      } finally {
        for (const db of allDbs) db.close()
      }
    }

    if (name === 'CONTACTS_GET') {
      const id = args?.id as number
      const allDbs = openAllDbs()
      if (allDbs.length === 0) {
        return 'No AddressBook databases found. Please grant Full Disk Access.'
      }
      try {
        for (const db of allDbs) {
          const row = db.query(`
            SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZJOBTITLE,
                   ZDEPARTMENT, ZNICKNAME, ZBIRTHDAY, ZMODIFICATIONDATE, ZCREATIONDATE
            FROM ZABCDRECORD WHERE Z_PK = ?
          `).get(id) as ContactRow | undefined

          if (row) {
            const phones = db.query(
              'SELECT ZFULLNUMBER, ZLABEL FROM ZABCDPHONENUMBER WHERE ZOWNER = ?'
            ).all(id) as PhoneRow[]
            const emails = db.query(
              'SELECT ZADDRESS, ZLABEL FROM ZABCDEMAILADDRESS WHERE ZOWNER = ?'
            ).all(id) as EmailRow[]
            const addresses = db.query(
              'SELECT ZSTREET, ZCITY, ZSTATE, ZZIPCODE, ZCOUNTRYNAME, ZLABEL FROM ZABCDPOSTALADDRESS WHERE ZOWNER = ?'
            ).all(id) as AddressRow[]

            return JSON.stringify(formatContact(row, phones, emails, addresses), null, 2)
          }
        }

        return `Contact with ID ${id} not found.`
      } finally {
        for (const db of allDbs) db.close()
      }
    }

    if (name === 'CONTACTS_LIST_RECENT') {
      const limit = (args?.limit as number) ?? 20
      const allDbs = openAllDbs()
      if (allDbs.length === 0) {
        return 'No AddressBook databases found. Please grant Full Disk Access.'
      }
      try {
        const allContacts: Record<string, unknown>[] = []

        for (const db of allDbs) {
          const rows = db.query(`
            SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZJOBTITLE,
                   ZDEPARTMENT, ZNICKNAME, ZBIRTHDAY, ZMODIFICATIONDATE, ZCREATIONDATE
            FROM ZABCDRECORD
            WHERE ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL OR ZORGANIZATION IS NOT NULL
            ORDER BY ZMODIFICATIONDATE DESC
            LIMIT ?
          `).all(limit) as ContactRow[]

          for (const row of rows) {
            const phones = db.query(
              'SELECT ZFULLNUMBER, ZLABEL FROM ZABCDPHONENUMBER WHERE ZOWNER = ?'
            ).all(row.Z_PK) as PhoneRow[]
            const emails = db.query(
              'SELECT ZADDRESS, ZLABEL FROM ZABCDEMAILADDRESS WHERE ZOWNER = ?'
            ).all(row.Z_PK) as EmailRow[]
            allContacts.push(formatContact(row, phones, emails))
          }
        }

        // Sort by modification date descending across all sources, then limit
        allContacts.sort((a, b) => {
          const aDate = a.modified as string || ''
          const bDate = b.modified as string || ''
          return bDate.localeCompare(aDate)
        })

        return JSON.stringify(allContacts.slice(0, limit), null, 2)
      } finally {
        for (const db of allDbs) db.close()
      }
    }

    throw new Error(`Unknown contacts tool: ${name}`)
  } catch (error: any) {
    if (error?.code === 'SQLITE_CANTOPEN' || error?.message?.includes('unable to open')) {
      return 'Cannot open AddressBook database. Please grant Full Disk Access to this application in System Settings > Privacy & Security > Full Disk Access.'
    }
    return `Error: ${error?.message ?? String(error)}`
  }
}
