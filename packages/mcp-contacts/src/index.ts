#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import Database from 'better-sqlite3'
import { homedir } from 'os'
import { join } from 'path'

const ADDRESS_BOOK_DB = join(
  homedir(),
  'Library',
  'Application Support',
  'AddressBook',
  'AddressBook-v22.abcddb'
)

/** Core Data timestamp → ISO string (epoch = 2001-01-01) */
function coreDataToISO(ts: number | null): string | null {
  if (!ts) return null
  return new Date((ts + 978307200) * 1000).toISOString()
}

/** Strip Apple's internal label wrapper: _$!<Home>!$_ → Home */
function cleanLabel(label: string | null): string {
  if (!label) return 'other'
  const m = label.match(/^_\$!<(.+?)>!\$_$/)
  return m ? m[1].toLowerCase() : label.toLowerCase()
}

function openDb(): Database.Database {
  return new Database(ADDRESS_BOOK_DB, { readonly: true, fileMustExist: true })
}

process.stdout.on('error', (err: any) => {
  if (err?.code === 'EPIPE') process.exit(0)
})
process.on('uncaughtException', (err: any) => {
  if (err?.code === 'EPIPE' || err?.message?.includes('EPIPE')) process.exit(0)
  console.error('[Contacts] Uncaught:', err)
  process.exit(1)
})

const server = new Server(
  { name: 'coagent-contacts', version: '0.0.1' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'CONTACTS_SEARCH',
      description: 'Search contacts by name, email, phone number, or organization. Returns matching contacts with their details.',
      inputSchema: {
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
      inputSchema: {
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
      inputSchema: {
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
  ],
}))

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

function formatContact(row: ContactRow, phones: PhoneRow[], emails: EmailRow[], addresses?: AddressRow[]) {
  const name = [row.ZFIRSTNAME, row.ZLASTNAME].filter(Boolean).join(' ') || row.ZORGANIZATION || 'Unknown'
  const result: any = {
    id: row.Z_PK,
    name,
  }
  if (row.ZORGANIZATION) result.organization = row.ZORGANIZATION
  if (row.ZJOBTITLE) result.job_title = row.ZJOBTITLE
  if (row.ZDEPARTMENT) result.department = row.ZDEPARTMENT
  if (row.ZNICKNAME) result.nickname = row.ZNICKNAME
  if (row.ZBIRTHDAY) result.birthday = coreDataToISO(row.ZBIRTHDAY)
  if (phones.length > 0) {
    result.phones = phones.map(p => ({
      number: p.ZFULLNUMBER,
      label: cleanLabel(p.ZLABEL),
    }))
  }
  if (emails.length > 0) {
    result.emails = emails.map(e => ({
      address: e.ZADDRESS,
      label: cleanLabel(e.ZLABEL),
    }))
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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    if (name === 'CONTACTS_SEARCH') {
      const query = args?.query as string
      const limit = (args?.limit as number) ?? 20
      const db = openDb()

      try {
        const like = `%${query}%`
        const rows = db.prepare(`
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

        const contacts = rows.map(row => {
          const phones = db.prepare(
            'SELECT ZFULLNUMBER, ZLABEL FROM ZABCDPHONENUMBER WHERE ZOWNER = ?'
          ).all(row.Z_PK) as PhoneRow[]
          const emails = db.prepare(
            'SELECT ZADDRESS, ZLABEL FROM ZABCDEMAILADDRESS WHERE ZOWNER = ?'
          ).all(row.Z_PK) as EmailRow[]
          return formatContact(row, phones, emails)
        })

        return {
          content: [{ type: 'text', text: JSON.stringify(contacts, null, 2) }],
        }
      } finally {
        db.close()
      }
    }

    if (name === 'CONTACTS_GET') {
      const id = args?.id as number
      const db = openDb()

      try {
        const row = db.prepare(`
          SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZJOBTITLE,
                 ZDEPARTMENT, ZNICKNAME, ZBIRTHDAY, ZMODIFICATIONDATE, ZCREATIONDATE
          FROM ZABCDRECORD WHERE Z_PK = ?
        `).get(id) as ContactRow | undefined

        if (!row) {
          return {
            content: [{ type: 'text', text: `Contact with ID ${id} not found.` }],
            isError: true,
          }
        }

        const phones = db.prepare(
          'SELECT ZFULLNUMBER, ZLABEL FROM ZABCDPHONENUMBER WHERE ZOWNER = ?'
        ).all(id) as PhoneRow[]
        const emails = db.prepare(
          'SELECT ZADDRESS, ZLABEL FROM ZABCDEMAILADDRESS WHERE ZOWNER = ?'
        ).all(id) as EmailRow[]
        const addresses = db.prepare(
          'SELECT ZSTREET, ZCITY, ZSTATE, ZZIPCODE, ZCOUNTRYNAME, ZLABEL FROM ZABCDPOSTALADDRESS WHERE ZOWNER = ?'
        ).all(id) as AddressRow[]

        return {
          content: [{ type: 'text', text: JSON.stringify(formatContact(row, phones, emails, addresses), null, 2) }],
        }
      } finally {
        db.close()
      }
    }

    if (name === 'CONTACTS_LIST_RECENT') {
      const limit = (args?.limit as number) ?? 20
      const db = openDb()

      try {
        const rows = db.prepare(`
          SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZJOBTITLE,
                 ZDEPARTMENT, ZNICKNAME, ZBIRTHDAY, ZMODIFICATIONDATE, ZCREATIONDATE
          FROM ZABCDRECORD
          WHERE ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL OR ZORGANIZATION IS NOT NULL
          ORDER BY ZMODIFICATIONDATE DESC
          LIMIT ?
        `).all(limit) as ContactRow[]

        const contacts = rows.map(row => {
          const phones = db.prepare(
            'SELECT ZFULLNUMBER, ZLABEL FROM ZABCDPHONENUMBER WHERE ZOWNER = ?'
          ).all(row.Z_PK) as PhoneRow[]
          const emails = db.prepare(
            'SELECT ZADDRESS, ZLABEL FROM ZABCDEMAILADDRESS WHERE ZOWNER = ?'
          ).all(row.Z_PK) as EmailRow[]
          return formatContact(row, phones, emails)
        })

        return {
          content: [{ type: 'text', text: JSON.stringify(contacts, null, 2) }],
        }
      } finally {
        db.close()
      }
    }

    throw new Error(`Unknown tool: ${name}`)
  } catch (error: any) {
    if (error?.code === 'SQLITE_CANTOPEN') {
      return {
        content: [{
          type: 'text',
          text: 'Cannot open AddressBook database. Please grant Full Disk Access to this application in System Settings > Privacy & Security > Full Disk Access.',
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
