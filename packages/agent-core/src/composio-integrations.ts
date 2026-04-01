import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

// ── Local connection tracking ──────────────────────────────────────
// Composio v3 scopes connected accounts by user_id. Each CoAgent instance
// passes its own user_id (COMPOSIO_ENTITY_ID or RELAY_USER_ID) to isolate
// connections. Local tracking provides a fast cache and offline fallback.

const getDataDir = () => process.env.COAGENT_DATA_DIR || join(homedir(), '.coagent')

// ── Connected accounts cache ───────────────────────────────────────
let _accountsCache: { data: any[]; ts: number } | null = null
const ACCOUNTS_CACHE_TTL = 15 * 60 * 1000 // 15 min

async function fetchConnectedAccounts(apiKey: string, userId: string, forceRefresh = false): Promise<any[]> {
  if (!forceRefresh && _accountsCache && Date.now() - _accountsCache.ts < ACCOUNTS_CACHE_TTL) {
    return _accountsCache.data
  }
  const url = `${getComposioBase()}/connected_accounts?limit=100&user_ids=${encodeURIComponent(userId)}`
  const res = await fetch(url, { headers: { 'X-API-KEY': apiKey } })
  const data = await res.json() as { items?: any[] }
  const items = data.items ?? []
  _accountsCache = { data: items, ts: Date.now() }
  return items
}

export function invalidateAccountsCache(): void {
  _accountsCache = null
}

// ── Webhook subscription cache ─────────────────────────────────────
let _webhookSubId: string | null = null

async function loadLocalConnections(): Promise<Set<string>> {
  try {
    const raw = await readFile(join(getDataDir(), 'connected-integrations.json'), 'utf-8')
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

async function saveLocalConnections(slugs: Set<string>): Promise<void> {
  const dir = getDataDir()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'connected-integrations.json'), JSON.stringify(Array.from(slugs), null, 2), 'utf-8')
}

export async function markLocalConnected(slug: string): Promise<void> {
  const conns = await loadLocalConnections()
  conns.add(slug.toLowerCase())
  await saveLocalConnections(conns)
  invalidateAccountsCache()
}

export async function markLocalDisconnected(slug: string): Promise<void> {
  const conns = await loadLocalConnections()
  conns.delete(slug.toLowerCase())
  await saveLocalConnections(conns)
}

// Seed local file from Composio on first run (backwards compat for existing instances).
// Only seeds if settings.json already exists (i.e. user was using CoAgent before local tracking).
// Fresh data dirs (new vertical instances) start with an empty file.
export async function seedLocalConnectionsIfNeeded(apiKey: string, userId = 'default'): Promise<void> {
  const dir = getDataDir()
  const filePath = join(dir, 'connected-integrations.json')
  try {
    await readFile(filePath, 'utf-8')
    return // file exists, don't overwrite
  } catch {
    // File doesn't exist
  }
  // Check if this is an existing instance (has settings) vs a fresh one
  try {
    await readFile(join(dir, 'settings.json'), 'utf-8')
  } catch {
    // Fresh instance — create empty file and return
    await saveLocalConnections(new Set())
    return
  }
  // Existing instance upgrading — seed from Composio
  try {
    const items = await fetchConnectedAccounts(apiKey, userId)
    const activeSlugs = new Set<string>(
      items
        .filter((a: any) => a.status === 'ACTIVE')
        .map((a: any) => (a.toolkit?.slug ?? a.toolkitSlug ?? a.appName ?? '').toLowerCase())
        .filter(Boolean)
    )
    await saveLocalConnections(activeSlugs)
    console.log(`[Composio] Seeded local connections: ${Array.from(activeSlugs).join(', ')}`)
  } catch (err: any) {
    console.warn(`[Composio] Failed to seed local connections: ${err.message}`)
  }
}

// High-signal trigger slugs to subscribe per app (verified against Composio v3 API listTypes)
// docusign, dropbox, calendly, linkedin, highlevel, zoom, follow_up_boss = action-only, no triggers available
const TRIGGER_MAP: Record<string, { slug: string; label: string }[]> = {
  // Email & Communication
  gmail:          [{ slug: 'GMAIL_NEW_GMAIL_MESSAGE', label: 'New email received' }],
  outlook:        [
    { slug: 'OUTLOOK_MESSAGE_TRIGGER', label: 'New email received' },
    { slug: 'OUTLOOK_EVENT_TRIGGER', label: 'New calendar event' },
  ],
  slack:          [{ slug: 'SLACKBOT_RECEIVE_MESSAGE', label: 'New message' }],
  discord:        [{ slug: 'DISCORD_NEW_MESSAGE_TRIGGER', label: 'New message' }],

  // Calendar & Scheduling
  googlecalendar: [
    { slug: 'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER', label: 'New event created' },
    { slug: 'GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER', label: 'Event starting soon' },
  ],

  // CRM & Sales
  hubspot:        [
    { slug: 'HUBSPOT_CONTACT_CREATED_TRIGGER', label: 'New contact created' },
    { slug: 'HUBSPOT_DEAL_STAGE_UPDATED_TRIGGER', label: 'Deal stage changed' },
  ],
  salesforce:     [
    { slug: 'SALESFORCE_NEW_LEAD_TRIGGER', label: 'New lead' },
    { slug: 'SALESFORCE_NEW_OR_UPDATED_OPPORTUNITY_TRIGGER', label: 'Opportunity updated' },
  ],
  pipedrive:      [
    { slug: 'PIPEDRIVE_NEW_DEAL_TRIGGER', label: 'New deal' },
    { slug: 'PIPEDRIVE_NEW_NOTE_TRIGGER', label: 'New note added' },
  ],
  zendesk:        [{ slug: 'ZENDESK_NEW_ZENDESK_TICKET_TRIGGER', label: 'New ticket' }],

  // Project Management
  notion:         [
    { slug: 'NOTION_PAGE_ADDED_TO_DATABASE', label: 'New database entry' },
    { slug: 'NOTION_COMMENTS_ADDED_TRIGGER', label: 'New comment' },
  ],
  jira:           [
    { slug: 'JIRA_NEW_ISSUE_TRIGGER', label: 'New issue' },
    { slug: 'JIRA_UPDATED_ISSUE_TRIGGER', label: 'Issue updated' },
  ],
  linear:         [
    { slug: 'LINEAR_ISSUE_CREATED_TRIGGER', label: 'Issue created' },
    { slug: 'LINEAR_COMMENT_EVENT_TRIGGER', label: 'New comment' },
  ],
  trello:         [{ slug: 'TRELLO_NEW_CARD_TRIGGER', label: 'New card' }],
  asana:          [{ slug: 'ASANA_TASK_TRIGGER', label: 'Task update' }],
  todoist:        [{ slug: 'TODOIST_NEW_TASK_CREATED', label: 'New task created' }],

  // Finance & Payments
  stripe:         [
    { slug: 'STRIPE_CHECKOUT_SESSION_COMPLETED_TRIGGER', label: 'Checkout completed' },
    { slug: 'STRIPE_INVOICE_PAYMENT_SUCCEEDED_TRIGGER', label: 'Invoice paid' },
    { slug: 'STRIPE_PAYMENT_FAILED_TRIGGER', label: 'Payment failed' },
  ],

  // Storage
  googledrive:    [
    { slug: 'GOOGLEDRIVE_FILE_CREATED_TRIGGER', label: 'New file created' },
    { slug: 'GOOGLEDRIVE_FILE_SHARED_PERMISSIONS_ADDED', label: 'File shared with you' },
  ],

  // Developer Tools
  github:         [
    { slug: 'GITHUB_PULL_REQUEST_EVENT', label: 'Pull request activity' },
    { slug: 'GITHUB_ISSUES_EVENT', label: 'Issue activity' },
  ],
}

// Tracks which trigger slugs are currently subscribed (populated at boot + on toggle)
const subscribedTriggers = new Set<string>()

export function getAvailableTriggersForSlug(appSlug: string): { slug: string; label: string }[] {
  return TRIGGER_MAP[appSlug] ?? []
}

export function getSubscribedTriggers(): Set<string> {
  return subscribedTriggers
}

export function setTriggerEnabled(slug: string, enabled: boolean): void {
  if (enabled) subscribedTriggers.add(slug)
  else subscribedTriggers.delete(slug)
}

// When RELAY_URL is set, all Composio calls route through the relay (key stays server-side).
// apiKey param becomes the relay token in that case.
// Read at call time so dotenv / loadApiKeysToEnv has a chance to load first
const getComposioBase = () => process.env.RELAY_URL
  ? `${process.env.RELAY_URL.replace(/\/$/, '')}/v1/composio`
  : 'https://backend.composio.dev/api/v3'

/** Resolve the actual Composio numeric user ID from the relay.
 *  The MCP URL goes direct to Composio (not through relay), so it needs the real ID. */
let _resolvedComposioUserId: string | null = null
export async function resolveComposioUserId(apiKey: string, localUserId: string): Promise<string> {
  if (_resolvedComposioUserId) return _resolvedComposioUserId
  if (!process.env.RELAY_URL) return localUserId  // no relay = direct Composio, use as-is
  try {
    const res = await fetch(`${getComposioBase()}/connected_accounts?limit=1`, {
      headers: { 'X-API-KEY': apiKey }
    })
    const data = await res.json() as { items?: { user_id?: string | number }[] }
    const uid = data.items?.[0]?.user_id
    if (uid != null) {
      _resolvedComposioUserId = String(uid)
      console.log(`[Composio] Resolved MCP user_id: ${_resolvedComposioUserId} (local: ${localUserId})`)
      return _resolvedComposioUserId
    }
  } catch (err: any) {
    console.warn(`[Composio] Failed to resolve user ID: ${err.message}`)
  }
  return localUserId
}

export const INTEGRATIONS = [
  // Email & Communication
  { slug: 'gmail', name: 'Gmail', category: 'Email & Communication', description: 'Professional email by Google', capabilities: 'Send and reply to emails, search inbox, manage drafts, handle attachments, read labels' },
  { slug: 'outlook', name: 'Outlook', category: 'Email & Communication', description: 'Microsoft email and calendar client', capabilities: 'Send and reply to emails, read inbox, search messages, manage folders, handle attachments' },
  { slug: 'zoho_mail', name: 'Zoho Mail', category: 'Email & Communication', description: 'Business email by Zoho', capabilities: 'Send and read emails, search inbox, manage folders, handle attachments' },
  { slug: 'slack', name: 'Slack', category: 'Email & Communication', description: 'Team messaging and channels', capabilities: 'Send messages to channels or DMs, read conversations, search messages, post replies in threads' },
  { slug: 'microsoft_teams', name: 'Microsoft Teams', category: 'Email & Communication', description: 'Microsoft team chat and calls', capabilities: 'Send messages to channels, read conversations, post replies, search message history' },
  { slug: 'discord', name: 'Discord', category: 'Email & Communication', description: 'Community chat with servers and channels', capabilities: 'Send messages to channels, read channel history, post to threads, manage server content' },
  { slug: 'telegram', name: 'Telegram', category: 'Email & Communication', description: 'Encrypted messaging app', capabilities: 'Send messages to chats or channels, read conversations, forward messages' },
  { slug: 'whatsapp', name: 'WhatsApp', category: 'Email & Communication', description: 'Mobile-first messaging app', capabilities: 'Send messages to contacts, read conversations, send media and documents' },
  { slug: 'intercom', name: 'Intercom', category: 'Email & Communication', description: 'Customer messaging platform', capabilities: 'Reply to customer conversations, search contacts, create notes, manage conversation status' },
  { slug: 'dialpad', name: 'Dialpad', category: 'Email & Communication', description: 'Cloud phone and contact center', capabilities: 'Send SMS messages, read call logs, search contacts, manage voicemails' },
  { slug: 'sendgrid', name: 'SendGrid', category: 'Email & Communication', description: 'Transactional email delivery service', capabilities: 'Send transactional emails, manage templates, check delivery stats, manage contact lists' },
  { slug: 'zoom', name: 'Zoom', category: 'Email & Communication', description: 'Video conferencing platform', capabilities: 'Create meetings, list upcoming meetings, get meeting details, manage recordings' },
  { slug: 'googlemeet', name: 'Google Meet', category: 'Email & Communication', description: 'Video calling via Google', capabilities: 'Create meeting links, schedule calls, manage participants' },

  // CRM & Sales
  { slug: 'hubspot', name: 'HubSpot', category: 'CRM & Sales', description: 'All-in-one CRM and marketing platform', capabilities: 'Create and update contacts, log deals, add notes, search records, manage pipelines' },
  { slug: 'salesforce', name: 'Salesforce', category: 'CRM & Sales', description: 'Enterprise CRM platform', capabilities: 'Create and update contacts, manage opportunities, log activities, search records, update fields' },
  { slug: 'pipedrive', name: 'Pipedrive', category: 'CRM & Sales', description: 'Sales pipeline CRM', capabilities: 'Create deals and contacts, move pipeline stages, log activities, search records' },
  { slug: 'active_campaign', name: 'ActiveCampaign', category: 'CRM & Sales', description: 'Email marketing and CRM', capabilities: 'Add and update contacts, trigger automations, manage tags, search subscriber lists' },
  { slug: 'apollo', name: 'Apollo', category: 'CRM & Sales', description: 'Sales intelligence and outreach platform', capabilities: 'Search contacts and companies, enrich leads, add to sequences, export prospect data' },
  { slug: 'close', name: 'Close', category: 'CRM & Sales', description: 'CRM built for sales teams', capabilities: 'Create leads and contacts, log calls and emails, update pipeline status, search records' },
  { slug: 'attio', name: 'Attio', category: 'CRM & Sales', description: 'Flexible data-driven CRM', capabilities: 'Create and update records, manage lists, add notes, search contacts and companies' },
  { slug: 'capsule_crm', name: 'Capsule CRM', category: 'CRM & Sales', description: 'Simple small-business CRM', capabilities: 'Create contacts and opportunities, log notes and tasks, search records, update stages' },
  { slug: 'folk', name: 'Folk', category: 'CRM & Sales', description: 'Lightweight CRM for relationship management', capabilities: 'Create and update contacts, manage pipelines, add notes, search records' },
  { slug: 'follow_up_boss', name: 'Follow Up Boss', category: 'CRM & Sales', description: 'Real estate CRM and lead routing', capabilities: 'Add and update leads, log notes, assign follow-up tasks, search contacts' },
  { slug: 'zoho', name: 'Zoho', category: 'CRM & Sales', description: 'Zoho CRM for sales teams', capabilities: 'Create leads and contacts, update deals, log activities, search records' },
  { slug: 'zoho_bigin', name: 'Zoho Bigin', category: 'CRM & Sales', description: 'Lightweight CRM for small teams', capabilities: 'Manage pipelines, create contacts, log notes, update deal stages' },
  { slug: 'dynamics365', name: 'Dynamics 365', category: 'CRM & Sales', description: 'Microsoft enterprise CRM', capabilities: 'Create and update contacts, manage opportunities, log activities, search accounts' },
  { slug: 'freshdesk', name: 'Freshdesk', category: 'CRM & Sales', description: 'Customer support ticketing system', capabilities: 'Create and reply to tickets, search conversations, add notes, update status' },
  { slug: 'gorgias', name: 'Gorgias', category: 'CRM & Sales', description: 'Ecommerce customer support platform', capabilities: 'Reply to tickets, search conversations, add internal notes, update ticket status' },
  { slug: 'help_scout', name: 'Help Scout', category: 'CRM & Sales', description: 'Customer support via shared inbox', capabilities: 'Reply to conversations, search contacts, add notes, manage mailbox' },
  { slug: 'salesflare', name: 'Salesflare', category: 'CRM & Sales', description: 'Automated CRM for small B2B teams', capabilities: 'Create contacts and opportunities, log emails, track pipeline, manage tasks' },
  { slug: 'zendesk', name: 'Zendesk', category: 'CRM & Sales', description: 'Customer support ticket system', capabilities: 'Create and reply to tickets, search conversations, add notes, update ticket status' },
  { slug: 'zoho_desk', name: 'Zoho Desk', category: 'CRM & Sales', description: 'Zoho help desk software', capabilities: 'Create and reply to tickets, search issues, add comments, update ticket status' },

  // Sales Outreach
  { slug: 'instantly', name: 'Instantly', category: 'Sales Outreach', description: 'Cold email outreach platform', capabilities: 'Create campaigns, add leads to sequences, check reply stats, manage sending accounts' },
  { slug: 'lemlist', name: 'Lemlist', category: 'Sales Outreach', description: 'Personalized cold outreach tool', capabilities: 'Add leads to campaigns, create follow-up steps, check campaign stats, manage sequences' },
  { slug: 'gong', name: 'Gong', category: 'Sales Outreach', description: 'Revenue intelligence and call recording', capabilities: 'Search call recordings, get call transcripts, review deal insights, track engagement' },
  { slug: 'phantombuster', name: 'PhantomBuster', category: 'Sales Outreach', description: 'Web scraping and automation tool', capabilities: 'Launch agents, retrieve scraped data, schedule automations, manage agent configurations' },
  { slug: 'hunter', name: 'Hunter', category: 'Sales Outreach', description: 'Email finder and verification tool', capabilities: 'Find email addresses by domain, verify email addresses, search by name and company' },

  // Calendar & Scheduling
  { slug: 'googlecalendar', name: 'Google Calendar', category: 'Calendar & Scheduling', description: 'Google calendar and event scheduling', capabilities: 'Create and update events, check availability, list upcoming events, manage attendees, set reminders' },
  { slug: 'googletasks', name: 'Google Tasks', category: 'Calendar & Scheduling', description: 'Simple task lists by Google', capabilities: 'Create and complete tasks, list task lists, update due dates, manage task details' },
  { slug: 'calendly', name: 'Calendly', category: 'Calendar & Scheduling', description: 'Meeting scheduling link tool', capabilities: 'List event types, check scheduled meetings, get booking details, retrieve availability' },
  { slug: 'cal', name: 'Cal.com', category: 'Calendar & Scheduling', description: 'Open-source scheduling platform', capabilities: 'Create bookings, list event types, check availability, manage scheduling links' },
  { slug: 'motion', name: 'Motion', category: 'Calendar & Scheduling', description: 'AI-powered calendar and task planner', capabilities: 'Create tasks, manage calendar, check schedule, automate task prioritization' },
  { slug: 'ticktick', name: 'TickTick', category: 'Calendar & Scheduling', description: 'Task manager with calendar integration', capabilities: 'Create tasks, set reminders, manage projects, check calendar events' },

  // Project Management
  { slug: 'asana', name: 'Asana', category: 'Project Management', description: 'Task and project tracking tool', capabilities: 'Create tasks and projects, update status, assign work, add comments, search tasks' },
  { slug: 'trello', name: 'Trello', category: 'Project Management', description: 'Kanban board for teams', capabilities: 'Create cards and lists, move cards between columns, add comments, manage board members' },
  { slug: 'clickup', name: 'ClickUp', category: 'Project Management', description: 'All-in-one project management tool', capabilities: 'Create tasks, update status, assign work, add comments, search across spaces' },
  { slug: 'coda', name: 'Coda', category: 'Project Management', description: 'Doc-powered project workspace', capabilities: 'Create and update docs, manage tables, add rows, search content' },
  { slug: 'monday', name: 'Monday', category: 'Project Management', description: 'Visual work management platform', capabilities: 'Create items and boards, update columns, add updates, search across boards' },
  { slug: 'notion', name: 'Notion', category: 'Project Management', description: 'Docs and database workspace', capabilities: 'Create and update pages, add database entries, search content, append blocks to documents' },
  { slug: 'jira', name: 'Jira', category: 'Project Management', description: 'Issue tracker for software teams', capabilities: 'Create and update issues, move through workflows, add comments, search with JQL, log time' },
  { slug: 'linear', name: 'Linear', category: 'Project Management', description: 'Issue tracker for fast-moving teams', capabilities: 'Create and update issues, change priority and status, add comments, search issues' },
  { slug: 'wrike', name: 'Wrike', category: 'Project Management', description: 'Collaborative project management', capabilities: 'Create tasks and folders, update status, assign work, add comments, search projects' },
  { slug: 'basecamp', name: 'Basecamp', category: 'Project Management', description: 'Team project hub with messaging', capabilities: 'Create to-dos and messages, add comments, check schedules, manage project content' },
  { slug: 'todoist', name: 'Todoist', category: 'Project Management', description: 'Personal and team task manager', capabilities: 'Create tasks, set due dates and priorities, complete tasks, organize into projects' },
  { slug: 'miro', name: 'Miro', category: 'Project Management', description: 'Online visual whiteboard', capabilities: 'Create boards and sticky notes, add shapes and text, search board content' },
  { slug: 'mural', name: 'Mural', category: 'Project Management', description: 'Digital whiteboard for collaboration', capabilities: 'Create murals and sticky notes, add content, manage workspace members' },
  { slug: 'productboard', name: 'Productboard', category: 'Project Management', description: 'Product roadmap and feedback tool', capabilities: 'Create features and insights, update roadmap items, link feedback to features' },
  { slug: 'shortcut', name: 'Shortcut', category: 'Project Management', description: 'Project management for software teams', capabilities: 'Create stories, manage epics, update iterations, search across projects' },
  { slug: 'dart', name: 'Dart', category: 'Project Management', description: 'AI-powered project management', capabilities: 'Create tasks, update status, assign work, manage sprints, search across projects' },

  // Time Tracking
  { slug: 'clockify', name: 'Clockify', category: 'Time Tracking', description: 'Free time tracking for teams', capabilities: 'Start and stop timers, log time entries, create projects, generate time reports' },
  { slug: 'everhour', name: 'Everhour', category: 'Time Tracking', description: 'Time tracking inside project management tools', capabilities: 'Log time entries, manage projects, create timers, generate reports' },
  { slug: 'harvest', name: 'Harvest', category: 'Time Tracking', description: 'Time tracking with invoicing', capabilities: 'Log time entries, manage projects and clients, create invoices, pull time reports' },
  { slug: 'timely', name: 'Timely', category: 'Time Tracking', description: 'Automatic time tracking app', capabilities: 'Log and edit time entries, manage projects, pull time reports, check team capacity' },
  { slug: 'toggl', name: 'Toggl', category: 'Time Tracking', description: 'Simple time tracking tool', capabilities: 'Start and stop timers, log time entries, manage projects, pull time reports' },

  // Finance & Payments
  { slug: 'bonsai', name: 'Bonsai', category: 'Finance & Payments', description: 'All-in-one freelance business suite', capabilities: 'Create proposals and invoices, manage contracts, track time, handle payments' },
  { slug: 'brex', name: 'Brex', category: 'Finance & Payments', description: 'Business credit cards and expense management', capabilities: 'Track expenses, manage cards, review transactions, set spending limits' },
  { slug: 'stripe', name: 'Stripe', category: 'Finance & Payments', description: 'Online payment processing platform', capabilities: 'Look up customers and charges, create payment links, manage subscriptions, retrieve invoices' },
  { slug: 'square', name: 'Square', category: 'Finance & Payments', description: 'Payments and point-of-sale platform', capabilities: 'Look up customers and payments, create invoices, manage catalog items' },
  { slug: 'quickbooks', name: 'QuickBooks', category: 'Finance & Payments', description: 'Small business accounting software', capabilities: 'Create invoices and expenses, manage customers, pull financial reports, record payments' },
  { slug: 'xero', name: 'Xero', category: 'Finance & Payments', description: 'Cloud accounting for small businesses', capabilities: 'Create invoices and bills, manage contacts, record payments, pull financial reports' },
  { slug: 'freshbooks', name: 'FreshBooks', category: 'Finance & Payments', description: 'Invoicing and accounting for freelancers', capabilities: 'Create and send invoices, log expenses, manage clients, track payments' },
  { slug: 'freeagent', name: 'FreeAgent', category: 'Finance & Payments', description: 'Accounting software for freelancers', capabilities: 'Create invoices and expenses, manage contacts, record bank transactions' },
  { slug: 'gumroad', name: 'Gumroad', category: 'Finance & Payments', description: 'Digital product sales platform', capabilities: 'List products, retrieve sales data, manage customers, check revenue stats' },
  { slug: 'ko_fi', name: 'Ko-fi', category: 'Finance & Payments', description: 'Creator donations and memberships', capabilities: 'List supporters, check donations, manage memberships, retrieve payment data' },
  { slug: 'lemon_squeezy', name: 'Lemon Squeezy', category: 'Finance & Payments', description: 'Payments and subscriptions for SaaS', capabilities: 'List products and orders, manage subscriptions, retrieve customer data' },
  { slug: 'wave_accounting', name: 'Wave', category: 'Finance & Payments', description: 'Free invoicing and accounting for freelancers', capabilities: 'Create and send invoices, track expenses, manage customers, record payments' },
  { slug: 'zoho_books', name: 'Zoho Books', category: 'Finance & Payments', description: 'Zoho accounting platform', capabilities: 'Create invoices and bills, manage contacts, record payments, pull reports' },
  { slug: 'zoho_invoice', name: 'Zoho Invoice', category: 'Finance & Payments', description: 'Free invoicing tool by Zoho', capabilities: 'Create and send invoices, manage clients, record payments, apply discounts' },
  { slug: 'zoho_inventory', name: 'Zoho Inventory', category: 'Finance & Payments', description: 'Inventory and order management', capabilities: 'Manage products and stock, create orders, track shipments, update inventory levels' },
  { slug: 'ynab', name: 'YNAB', category: 'Finance & Payments', description: 'Personal budgeting app', capabilities: 'Read budget categories, add transactions, check account balances, review spending reports' },

  // Documents & E-Sign
  { slug: 'better_proposals', name: 'Better Proposals', category: 'Documents & E-Sign', description: 'Proposal and contract creation tool', capabilities: 'Create proposals from templates, send for review, track opens and signatures, manage content' },
  { slug: 'googledocs', name: 'Google Docs', category: 'Documents & E-Sign', description: 'Cloud word processor by Google', capabilities: 'Create and update documents, append content, read document text, share with collaborators' },
  { slug: 'googlesheets', name: 'Google Sheets', category: 'Documents & E-Sign', description: 'Cloud spreadsheets by Google', capabilities: 'Read and write cell data, create sheets, update rows, apply formulas' },
  { slug: 'googleslides', name: 'Google Slides', category: 'Documents & E-Sign', description: 'Cloud presentation tool by Google', capabilities: 'Create presentations, read slide content, add and update slides' },
  { slug: 'excel', name: 'Excel', category: 'Documents & E-Sign', description: 'Microsoft spreadsheet application', capabilities: 'Read and write cell data, create workbooks, update named ranges, run formulas' },
  { slug: 'pandadoc', name: 'PandaDoc', category: 'Documents & E-Sign', description: 'Document creation and e-signing', capabilities: 'Create documents from templates, send for signature, check signing status, manage recipients' },
  { slug: 'signwell', name: 'SignWell', category: 'Documents & E-Sign', description: 'Simple e-signature and document signing', capabilities: 'Send signature requests, track document status, manage templates, retrieve signed files' },
  { slug: 'docusign', name: 'DocuSign', category: 'Documents & E-Sign', description: 'Industry-standard e-signature platform', capabilities: 'Send envelopes for signature, check signing status, retrieve signed documents' },
  { slug: 'dropbox_sign', name: 'Dropbox Sign', category: 'Documents & E-Sign', description: 'E-signature tool by Dropbox', capabilities: 'Send signature requests, check signing status, retrieve signed documents, use templates' },
  { slug: 'boldsign', name: 'Boldsign', category: 'Documents & E-Sign', description: 'E-signature API platform', capabilities: 'Create signature requests, track document status, manage templates, retrieve signed files' },
  { slug: 'canva', name: 'Canva', category: 'Documents & E-Sign', description: 'Visual design and presentation tool', capabilities: 'List designs, create from templates, search design library, manage brand assets' },
  { slug: 'confluence', name: 'Confluence', category: 'Documents & E-Sign', description: 'Team wiki and documentation platform', capabilities: 'Create and update pages, add comments, search content, manage spaces' },
  { slug: 'contentful', name: 'Contentful', category: 'Documents & E-Sign', description: 'Headless content management system', capabilities: 'Create and update entries, manage content types, publish content, search records' },

  // Storage
  { slug: 'googledrive', name: 'Google Drive', category: 'Storage', description: 'Cloud file storage by Google', capabilities: 'Upload and download files, create folders, search files, share with collaborators, manage permissions' },
  { slug: 'googlephotos', name: 'Google Photos', category: 'Storage', description: 'Photo storage and organization by Google', capabilities: 'List albums, search photos, retrieve media items, create albums' },
  { slug: 'dropbox', name: 'Dropbox', category: 'Storage', description: 'Cloud file storage and sync', capabilities: 'Upload and download files, create folders, search files, share links, manage permissions' },
  { slug: 'one_drive', name: 'OneDrive', category: 'Storage', description: 'Microsoft cloud file storage', capabilities: 'Upload and download files, create folders, search files, share items, manage access' },
  { slug: 'share_point', name: 'SharePoint', category: 'Storage', description: 'Microsoft team file sharing platform', capabilities: 'Read and write documents, manage libraries, create folders, search site content' },
  { slug: 'box', name: 'Box', category: 'Storage', description: 'Enterprise cloud content management', capabilities: 'Upload and download files, create folders, share files, manage collaborators' },

  // Forms & Surveys
  { slug: 'jotform', name: 'JotForm', category: 'Forms & Surveys', description: 'Online form builder platform', capabilities: 'List forms, retrieve submissions, check response counts, manage form questions' },
  { slug: 'survey_monkey', name: 'SurveyMonkey', category: 'Forms & Surveys', description: 'Online survey and feedback platform', capabilities: 'Create surveys, retrieve responses, check completion rates, manage questions' },
  { slug: 'tally', name: 'Tally', category: 'Forms & Surveys', description: 'Free form builder with no limits', capabilities: 'List forms, retrieve submissions, check response data, manage form settings' },
  { slug: 'typeform', name: 'Typeform', category: 'Forms & Surveys', description: 'Conversational form builder', capabilities: 'List forms, retrieve responses, check completion stats, manage form settings' },

  // Marketing & Social
  { slug: 'brevo', name: 'Brevo', category: 'Marketing & Social', description: 'Email marketing and CRM platform', capabilities: 'Create campaigns, manage contact lists, send transactional emails, check analytics' },
  { slug: 'mailchimp', name: 'Mailchimp', category: 'Marketing & Social', description: 'Email marketing platform', capabilities: 'Create campaigns, manage subscriber lists, add or update contacts, check campaign stats' },
  { slug: 'mailerlite', name: 'MailerLite', category: 'Marketing & Social', description: 'Email marketing for small businesses', capabilities: 'Create campaigns, manage subscribers, add contacts to groups, check open rates' },
  { slug: 'klaviyo', name: 'Klaviyo', category: 'Marketing & Social', description: 'E-commerce email and SMS marketing', capabilities: 'Create campaigns, manage lists, add and update profiles, check flow analytics' },
  { slug: 'linkedin', name: 'LinkedIn', category: 'Marketing & Social', description: 'Professional networking platform', capabilities: 'Create posts, search profiles and companies, send connection requests, retrieve feed' },
  { slug: 'facebook', name: 'Facebook', category: 'Marketing & Social', description: 'Social network by Meta', capabilities: 'Create posts, read page content, manage comments, check page insights' },
  { slug: 'instagram', name: 'Instagram', category: 'Marketing & Social', description: 'Photo and video social platform', capabilities: 'Read account media, check insights, retrieve profile info, manage comments' },
  { slug: 'tiktok', name: 'TikTok', category: 'Marketing & Social', description: 'Short-form video platform', capabilities: 'Search videos, retrieve account info, check video analytics, manage comments' },
  { slug: 'twitter', name: 'Twitter/X', category: 'Marketing & Social', description: 'Microblogging and social media platform', capabilities: 'Create posts, search tweets, manage followers, check engagement stats' },
  { slug: 'typefully', name: 'Typefully', category: 'Marketing & Social', description: 'Twitter/X thread and post scheduler', capabilities: 'Create and schedule posts, manage drafts, check analytics, publish threads' },
  { slug: 'youtube', name: 'YouTube', category: 'Marketing & Social', description: 'Video hosting by Google', capabilities: 'Search videos, retrieve channel info, check video stats, manage playlists' },
  { slug: 'reddit', name: 'Reddit', category: 'Marketing & Social', description: 'Community forum and link aggregator', capabilities: 'Search posts and subreddits, read comments, submit posts, check post stats' },
  { slug: 'metaads', name: 'Meta Ads', category: 'Marketing & Social', description: 'Facebook and Instagram ad platform', capabilities: 'Create and manage campaigns, check ad performance, adjust budgets, retrieve audience data' },
  { slug: 'googleads', name: 'Google Ads', category: 'Marketing & Social', description: 'Google search and display advertising', capabilities: 'Manage campaigns and ad groups, check performance metrics, adjust bids, retrieve reports' },
  { slug: 'semrush', name: 'SEMrush', category: 'Marketing & Social', description: 'SEO and competitive intelligence tool', capabilities: 'Search keyword data, check domain rankings, retrieve backlink reports, analyze competitors' },
  { slug: 'google_analytics', name: 'Google Analytics', category: 'Marketing & Social', description: 'Web traffic analytics by Google', capabilities: 'Retrieve traffic reports, check goal completions, compare date ranges, pull audience data' },
  { slug: 'eventbrite', name: 'Eventbrite', category: 'Marketing & Social', description: 'Event ticketing and management platform', capabilities: 'Create events, manage attendees, check ticket sales, publish and update events' },

  // eCommerce
  { slug: 'servicem8', name: 'Servicem8', category: 'eCommerce', description: 'Field service management platform', capabilities: 'Create and update jobs, manage clients, schedule work, retrieve job details' },
  { slug: 'shopify', name: 'Shopify', category: 'eCommerce', description: 'E-commerce store platform', capabilities: 'List and update orders, manage products, check inventory, retrieve customer data' },
  { slug: 'webflow', name: 'Webflow', category: 'eCommerce', description: 'Visual website builder with CMS', capabilities: 'Manage CMS items, update site content, publish changes, manage collections' },
  { slug: 'wix', name: 'Wix', category: 'eCommerce', description: 'Website builder and ecommerce platform', capabilities: 'Manage products, check orders, update inventory, manage site content' },

  // Developer Tools
  { slug: 'github', name: 'GitHub', category: 'Developer Tools', description: 'Code hosting and collaboration platform', capabilities: 'Create issues and PRs, read repositories, manage branches, post comments, check CI status' },
  { slug: 'bitbucket', name: 'Bitbucket', category: 'Developer Tools', description: 'Git hosting by Atlassian', capabilities: 'Create issues and PRs, read repositories, manage branches, post comments on code' },
  { slug: 'sentry', name: 'Sentry', category: 'Developer Tools', description: 'Error tracking and monitoring', capabilities: 'List and resolve issues, retrieve error details, check release health, manage alerts' },
  { slug: 'digital_ocean', name: 'DigitalOcean', category: 'Developer Tools', description: 'Cloud infrastructure provider', capabilities: 'List droplets and databases, manage resources, check billing, retrieve monitoring data' },
  { slug: 'supabase', name: 'Supabase', category: 'Developer Tools', description: 'Open-source backend platform', capabilities: 'Query and update database tables, manage auth users, invoke edge functions' },
  { slug: 'wakatime', name: 'WakaTime', category: 'Developer Tools', description: 'Automatic code time tracking', capabilities: 'Retrieve coding stats, check time by project or language, pull leaderboard data' },

  // Other
  { slug: 'airtable', name: 'Airtable', category: 'Other', description: 'Spreadsheet-database hybrid tool', capabilities: 'Create and update records, search tables, manage fields, retrieve linked records' },
  { slug: 'figma', name: 'Figma', category: 'Other', description: 'Collaborative UI design tool', capabilities: 'List files and projects, retrieve design nodes, read comments, check version history' },
  { slug: 'google_maps', name: 'Google Maps', category: 'Other', description: 'Maps, directions, and places', capabilities: 'Search places, get directions, retrieve place details, check business hours' },
  { slug: 'spotify', name: 'Spotify', category: 'Other', description: 'Music streaming platform', capabilities: 'Search tracks and artists, manage playlists, control playback, retrieve listening history' },
  { slug: 'crowdin', name: 'Crowdin', category: 'Other', description: 'Localization and translation platform', capabilities: 'Manage translation projects, upload source files, retrieve translated strings, check progress' },
  { slug: 'dub', name: 'Dub', category: 'Other', description: 'Short link and analytics platform', capabilities: 'Create short links, retrieve click analytics, manage domains, update link settings' },
  { slug: 'fathom', name: 'Fathom', category: 'Other', description: 'Privacy-first website analytics', capabilities: 'Retrieve page view stats, check traffic sources, pull aggregated reports' },
  { slug: 'stack_exchange', name: 'Stack Exchange', category: 'Other', description: 'Q&A network for technical topics', capabilities: 'Search questions and answers, retrieve user reputation, check tag activity' },
  { slug: 'yandex', name: 'Yandex', category: 'Other', description: 'Russian search and services platform', capabilities: 'Search the web, manage email, retrieve maps data, access cloud storage' },
]

export async function getIntegrationStatuses(
  apiKey: string,
  userId = 'default'
): Promise<{ slug: string; name: string; connected: boolean }[]> {
  // Use local tracking as source of truth for which slugs are connected.
  // Then verify against Composio that they're still ACTIVE.
  const localConns = await loadLocalConnections()

  const items = await fetchConnectedAccounts(apiKey, userId)
  const activeSlugsInComposio = new Set<string>(
    items
      .filter((a: any) => a.status === 'ACTIVE')
      .map((a: any) => (a.toolkit?.slug ?? a.toolkitSlug ?? a.appName ?? '').toLowerCase())
  )

  return INTEGRATIONS.map(({ slug, name, category, description, capabilities }) => ({
    slug,
    name,
    connected: localConns.has(slug) && activeSlugsInComposio.has(slug),
    category,
    description,
    capabilities,
  }))
}

/** Fetch toolkit auth info (cached) */
interface ToolkitAuth {
  managed: boolean
  mode: string
  /** Fields the user must fill to connect (API key integrations) */
  connectionFields: { name: string; displayName: string; description: string; default?: string }[]
  /** Fields needed to create an auth config (unmanaged OAuth — client_id, client_secret, etc.) */
  setupFields: { name: string; displayName: string; description: string; default?: string }[]
}

const authCache = new Map<string, ToolkitAuth>()

async function getToolkitAuth(apiKey: string, slug: string): Promise<ToolkitAuth> {
  if (authCache.has(slug)) return authCache.get(slug)!
  try {
    const res = await fetch(`${getComposioBase()}/toolkits/${slug}`, {
      headers: { 'X-API-KEY': apiKey }
    })
    const data = await res.json() as any
    const managed = (data?.composio_managed_auth_schemes ?? []).length > 0
    const authConfig = data?.auth_config_details?.[0]
    const mode = authConfig?.mode ?? ''

    const connectionFields = (authConfig?.fields?.connected_account_initiation?.required ?? [])
      .map((f: any) => ({ name: f.name, displayName: f.displayName, description: f.description, default: f.default }))

    const setupFields = (authConfig?.fields?.auth_config_creation?.required ?? [])
      .map((f: any) => ({ name: f.name, displayName: f.displayName, description: f.description, default: f.default }))

    const result: ToolkitAuth = { managed, mode, connectionFields, setupFields }
    authCache.set(slug, result)
    return result
  } catch {
    return { managed: false, mode: '', connectionFields: [], setupFields: [] }
  }
}

/** Public: get all fields the user needs to provide (connection + setup fields combined) */
export async function getRequiredFields(
  apiKey: string,
  slug: string
): Promise<{ name: string; displayName: string; description: string }[]> {
  const auth = await getToolkitAuth(apiKey, slug)
  // For API key integrations: only ask for fields without usable defaults
  const userFields = auth.connectionFields.filter(f => !f.default)
  if (userFields.length > 0) return userFields
  // For unmanaged OAuth: only ask for setup fields if no auth config exists yet
  if (!auth.managed && auth.setupFields.length > 0) {
    const existingId = await findExistingAuthConfig(apiKey, slug)
    if (!existingId) return auth.setupFields
  }
  return []
}

/** Find existing auth config on Composio for this slug, return its ID or null */
async function findExistingAuthConfig(apiKey: string, slug: string): Promise<string | null> {
  try {
    const res = await fetch(`${getComposioBase()}/auth_configs?toolkit_slug=${slug}`, {
      headers: { 'X-API-KEY': apiKey }
    })
    const data = await res.json() as any
    const existing = (data?.items ?? [])[0]
    if (existing) {
      console.log(`[Composio] Found existing auth config for ${slug}: ${existing.name ?? existing.id} (${existing.id})`)
    }
    return existing?.id ?? null
  } catch {
    return null
  }
}

/**
 * Universal auth config resolver — guarantees an auth_config_id for ANY integration.
 * Composio v3 requires auth_config_id on all /connected_accounts/link requests.
 *
 * Strategy:
 *  1. Check for existing auth config → reuse it
 *  2. Try Composio-managed auth (OAuth integrations like Gmail, Slack, Notion)
 *  3. Fall back to custom auth with the toolkit's auth scheme (API_KEY integrations like Hunter)
 *  4. If user provided setup fields (client_id/secret), create with those credentials
 */
async function ensureAuthConfigId(
  apiKey: string,
  slug: string,
  params?: Record<string, string>
): Promise<string> {
  // 1. Reuse existing auth config
  const existing = await findExistingAuthConfig(apiKey, slug)
  if (existing) return existing

  const auth = await getToolkitAuth(apiKey, slug)

  // 2. Try Composio-managed auth first (works for OAuth integrations with managed credentials)
  if (auth.managed) {
    try {
      const res = await fetch(`${getComposioBase()}/auth_configs`, {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolkit: { slug },
          auth_config: { type: 'use_composio_managed_auth', credentials: {} }
        })
      })
      const body = await res.json() as any
      if (res.ok && body?.auth_config?.id) {
        console.log(`[Composio] Created managed auth config for ${slug}: ${body.auth_config.id}`)
        return body.auth_config.id
      }
      console.warn(`[Composio] Managed auth config failed for ${slug}: ${JSON.stringify(body?.error ?? body).slice(0, 200)}`)
    } catch (err: any) {
      console.warn(`[Composio] Managed auth config request failed for ${slug}:`, err.message)
    }
  }

  // 3. Custom auth — use the toolkit's auth scheme (API_KEY, OAUTH2, etc.)
  const authScheme = auth.mode || 'API_KEY'

  // Build credentials from user-provided setup fields (if any)
  const credentials: Record<string, string> = {}
  if (params && auth.setupFields.length > 0) {
    for (const f of auth.setupFields) {
      credentials[f.name] = params[f.name]?.trim() || f.default || ''
    }
  }
  // Include redirect URI for OAuth schemes
  if (authScheme.includes('OAUTH') && !credentials.oauth_redirect_uri) {
    credentials.oauth_redirect_uri = 'https://backend.composio.dev/api/v1/auth-apps/add'
  }

  const res = await fetch(`${getComposioBase()}/auth_configs`, {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      toolkit: { slug },
      auth_config: {
        type: 'use_custom_auth',
        authScheme,
        credentials,
      }
    })
  })
  const body = await res.json() as any
  if (!res.ok) {
    console.error(`[Composio] Failed to create auth config for ${slug}:`, JSON.stringify(body))
    throw new Error(body?.error?.message ?? `Failed to create auth config for ${slug}`)
  }
  const configId = body?.auth_config?.id ?? body?.id
  console.log(`[Composio] Created custom auth config for ${slug} (${authScheme}): ${configId}`)
  return configId
}

export async function generateAuthUrl(
  apiKey: string,
  slug: string,
  userId = 'default',
  params?: Record<string, string>
): Promise<string> {
  const auth = await getToolkitAuth(apiKey, slug)

  // Check if user needs to provide fields (API keys, subdomains, etc.)
  if (auth.connectionFields.length > 0) {
    const userRequired = auth.connectionFields.filter(f => !f.default)
    const missing = userRequired.filter(f => !params?.[f.name]?.trim())
    if (missing.length > 0) {
      const err: any = new Error('NEEDS_FIELDS')
      err.fields = userRequired
      throw err
    }
  }

  // Check if user needs to provide setup fields (client_id/secret for unmanaged OAuth)
  if (!auth.managed && auth.setupFields.length > 0) {
    const existingConfig = await findExistingAuthConfig(apiKey, slug)
    if (!existingConfig) {
      const missing = auth.setupFields.filter(f => !params?.[f.name]?.trim())
      if (missing.length > 0) {
        const err: any = new Error('NEEDS_FIELDS')
        err.fields = auth.setupFields
        throw err
      }
    }
  }

  // Universal: ensure auth config exists (creates one if needed)
  const authConfigId = await ensureAuthConfigId(apiKey, slug, params)

  // Clean up old connections for this slug
  await removeAllAccountsForSlug(apiKey, slug, userId).catch(() => {})

  // Build the link request — always includes auth_config_id
  const linkBody: Record<string, any> = {
    user_id: userId,
    toolkit_slug: slug,
    auth_config_id: authConfigId,
  }

  // Include connection data if user provided fields (API keys, subdomains, etc.)
  if (auth.connectionFields.length > 0) {
    const connectionData: Record<string, string> = {}
    for (const f of auth.connectionFields) connectionData[f.name] = params?.[f.name]?.trim() || f.default || ''
    linkBody.connection = connectionData
  }

  console.log(`[Composio] ${slug} link request:`, JSON.stringify(linkBody))
  const res = await fetch(`${getComposioBase()}/connected_accounts/link`, {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(linkBody)
  })
  const body = await res.json() as any
  if (!res.ok) {
    console.error(`[Composio] ${slug} link failed (${res.status}):`, JSON.stringify(body))
    throw new Error(body?.error?.message ?? `Failed to connect ${slug}`)
  }
  const url = body?.redirect_url ?? body?.redirectUrl
  console.log(`[Composio] ${slug} link success (auth_config: ${authConfigId}): ${url ? url.slice(0, 80) : 'NO URL (direct connect)'}`)

  // API key integrations may not return a URL (they connect directly)
  if (!url && auth.connectionFields.length > 0) {
    // Direct connection — no OAuth redirect needed
    invalidateAccountsCache()
    await markLocalConnected(slug)
    return 'CONNECTED_DIRECTLY'
  }
  if (!url) throw new Error(`No auth URL returned for ${slug}`)
  return url
}

// Delete accounts matching a slug for this user (any status) — prevents duplicate buildup.
async function removeAllAccountsForSlug(
  apiKey: string,
  slug: string,
  userId = 'default'
): Promise<number> {
  const items = await fetchConnectedAccounts(apiKey, userId, true) // force refresh — mutating
  const matching = items.filter((a: any) =>
    (a.toolkit?.slug ?? a.toolkitSlug ?? a.appName ?? '').toLowerCase() === slug.toLowerCase()
  )
  for (const a of matching) {
    await fetch(`${getComposioBase()}/connected_accounts/${a.id}`, {
      method: 'DELETE',
      headers: { 'X-API-KEY': apiKey }
    })
  }
  if (matching.length > 0) {
    console.log(`[Composio] Removed ${matching.length} existing account(s) for ${slug}`)
  }
  return matching.length
}

export async function disconnectIntegration(
  apiKey: string,
  slug: string,
  userId = 'default'
): Promise<void> {
  await removeAllAccountsForSlug(apiKey, slug, userId)
  await markLocalDisconnected(slug)
  invalidateAccountsCache()
}

export async function getConnectedSlugs(
  apiKey: string,
  userId = 'default'
): Promise<string[]> {
  const localConns = await loadLocalConnections()
  if (localConns.size === 0) return []
  // Only return slugs that are also ACTIVE in Composio
  const statuses = await getIntegrationStatuses(apiKey, userId)
  return statuses.filter(s => s.connected).map(s => s.slug)
}

// Purge EXPIRED connected accounts on startup to prevent buildup
export async function purgeExpiredAccounts(apiKey: string, userId = 'default'): Promise<void> {
  const items = await fetchConnectedAccounts(apiKey, userId)
  const expired = items.filter((a: any) => a.status === 'EXPIRED')
  if (expired.length === 0) return
  for (const a of expired) {
    await fetch(`${getComposioBase()}/connected_accounts/${a.id}`, {
      method: 'DELETE',
      headers: { 'X-API-KEY': apiKey }
    })
  }
  console.log(`[Composio] Purged ${expired.length} expired account(s)`)
}

// Get v3 connected account ID (short format: ca_xxx) for a specific app slug
async function getV3ConnectedAccountId(apiKey: string, appSlug: string, userId = 'default'): Promise<string | null> {
  const items = await fetchConnectedAccounts(apiKey, userId)
  const match = items.find((a: any) =>
    (a.toolkit?.slug ?? a.appName ?? '').toLowerCase() === appSlug.toLowerCase() &&
    a.status === 'ACTIVE'
  )
  return match?.id ?? null
}

// ── Composio Webhook Subscription ──────────────────────────────────
// Composio v3 delivers trigger events via webhook subscriptions.
// Each agent instance registers its own subscription pointing to
// its relay webhook endpoint. Composio routes events directly.

/**
 * Ensure Composio webhook delivery works for this user:
 * 1. Register composio entity → relay userId mapping so the relay can route webhooks
 * 2. Ensure a webhook subscription exists pointing to the relay's /webhook endpoint
 *    (shared across all users — the relay routes by metadata.user_id)
 */
export async function ensureWebhookSubscription(apiKey: string): Promise<void> {
  const relayUrl = process.env.RELAY_URL?.replace(/\/$/, '')
  const relayToken = process.env.RELAY_TOKEN
  const composioEntity = process.env.COMPOSIO_ENTITY_ID || process.env.RELAY_USER_ID || 'default'
  if (!relayUrl || !relayToken) return

  // Step 1: Register composio entity → relay user mapping
  try {
    await fetch(`${relayUrl}/v1/webhook-route`, {
      method: 'POST',
      headers: { 'X-API-KEY': relayToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ composioUserId: composioEntity })
    })
    console.log(`[Composio] Registered webhook route: entity ${composioEntity}`)
  } catch (err: any) {
    console.warn(`[Composio] Failed to register webhook route: ${err.message}`)
  }

  // Step 2: Ensure a webhook subscription exists pointing to /webhook (shared endpoint)
  const webhookUrl = `${relayUrl}/webhook`
  const base = getComposioBase()

  // Skip re-fetching if we already confirmed a valid subscription this session
  if (_webhookSubId) {
    console.log(`[Composio] Webhook subscription already confirmed: ${_webhookSubId}`)
    return
  }

  try {
    const listRes = await fetch(`${base}/webhook_subscriptions`, {
      headers: { 'X-API-KEY': apiKey }
    })
    if (listRes.ok) {
      const listData = await listRes.json() as { items?: any[] }
      const existing = (listData.items ?? [])[0]
      if (existing) {
        if (existing.webhook_url === webhookUrl) {
          console.log(`[Composio] Webhook subscription OK: ${existing.id} → ${webhookUrl}`)
          _webhookSubId = existing.id
          return
        }
        // URL is wrong — delete stale subscription so we can recreate with correct URL
        console.log(`[Composio] Replacing subscription ${existing.id}: ${existing.webhook_url} → ${webhookUrl}`)
        await fetch(`${base}/webhook_subscriptions/${existing.id}`, {
          method: 'DELETE',
          headers: { 'X-API-KEY': apiKey }
        })
      }
    }

    // Create subscription with V3 format
    const res = await fetch(`${base}/webhook_subscriptions`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhook_url: webhookUrl,
        enabled_events: ['composio.trigger.message', 'composio.connected_account.expired'],
        version: 'V3'
      })
    })
    const body = await res.json() as any
    if (res.ok) {
      console.log(`[Composio] Webhook subscription created: ${body.id} → ${webhookUrl}`)
      _webhookSubId = body.id
      // Store webhook secret for future signature verification
      if (body.secret) {
        const dir = getDataDir()
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'composio-webhook-secret.txt'), body.secret, 'utf-8')
        console.log(`[Composio] Webhook signing secret stored`)
      }
    } else {
      console.warn(`[Composio] Failed to create webhook subscription: ${body?.error?.message ?? res.status}`)
    }
  } catch (err: any) {
    console.warn(`[Composio] Webhook subscription setup failed: ${err.message}`)
  }
}

// Subscribe all high-signal triggers for a newly connected app.
// Safe to call multiple times — upsert is idempotent.
export async function subscribeTriggersForSlug(apiKey: string, appSlug: string, userId = 'default'): Promise<void> {
  const triggers = TRIGGER_MAP[appSlug]
  if (!triggers || triggers.length === 0) {
    console.log(`[Composio] No triggers configured for ${appSlug}`)
    return
  }

  const connectedAccountId = await getV3ConnectedAccountId(apiKey, appSlug, userId)
  if (!connectedAccountId) {
    console.warn(`[Composio] No active connected account found for ${appSlug}`)
    return
  }

  for (const { slug: triggerSlug } of triggers) {
    try {
      const res = await fetch(`${getComposioBase()}/trigger_instances/${triggerSlug}/upsert`, {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connected_account_id: connectedAccountId,
          trigger_config: { userId: 'me', interval: 1 }
        })
      })
      const body = await res.json() as any
      if (res.ok) {
        subscribedTriggers.add(triggerSlug)
        console.log(`[Composio] Subscribed trigger ${triggerSlug} (${body.trigger_id})`)
      } else {
        console.warn(`[Composio] Failed to subscribe ${triggerSlug}: ${body?.error?.message ?? res.status}`)
      }
    } catch (err: any) {
      console.error(`[Composio] Error subscribing ${triggerSlug}:`, err.message)
    }
  }
}

// Subscribe a single trigger by slug (used for individual toggle-on from UI)
export async function subscribeSingleTrigger(apiKey: string, triggerSlug: string, appSlug: string, userId = 'default'): Promise<boolean> {
  const connectedAccountId = await getV3ConnectedAccountId(apiKey, appSlug, userId)
  if (!connectedAccountId) return false

  try {
    const res = await fetch(`${getComposioBase()}/trigger_instances/${triggerSlug}/upsert`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connected_account_id: connectedAccountId,
        trigger_config: { userId: 'me', interval: 1 }
      })
    })
    const body = await res.json() as any
    if (res.ok) {
      subscribedTriggers.add(triggerSlug)
      console.log(`[Composio] Subscribed trigger ${triggerSlug} (${body.trigger_id})`)
      return true
    }
    console.warn(`[Composio] Failed to subscribe ${triggerSlug}: ${body?.error?.message ?? res.status}`)
    return false
  } catch (err: any) {
    console.error(`[Composio] Error subscribing ${triggerSlug}:`, err.message)
    return false
  }
}
