import { Composio } from '@composio/core'

// High-signal trigger slugs to subscribe per app (verified against Composio v3 API listTypes)
// docusign, dropbox, calendly, linkedin, highlevel, zoom, follow_up_boss = action-only, no triggers available
const TRIGGER_MAP: Record<string, string[]> = {
  gmail:          ['GMAIL_NEW_GMAIL_MESSAGE'],
  googlecalendar: ['GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER', 'GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER'],
  hubspot:        ['HUBSPOT_CONTACT_CREATED_TRIGGER', 'HUBSPOT_DEAL_STAGE_UPDATED_TRIGGER'],
  slack:          ['SLACKBOT_RECEIVE_MESSAGE', 'SLACKBOT_RECEIVE_THREAD_REPLY', 'SLACKBOT_RECEIVE_DIRECT_MESSAGE'],
  outlook:        ['OUTLOOK_MESSAGE_TRIGGER'],
  googledrive:    ['GOOGLEDRIVE_FILE_CREATED_TRIGGER', 'GOOGLEDRIVE_FILE_SHARED_PERMISSIONS_ADDED'],
  notion:         ['NOTION_PAGE_ADDED_TRIGGER', 'NOTION_COMMENTS_ADDED_TRIGGER'],
}

const COMPOSIO_BASE = 'https://backend.composio.dev/api/v3'

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
  { slug: 'follow_up_boss', name: 'Follow Up Boss', category: 'CRM & Sales', description: 'Real estate CRM and lead routing', capabilities: 'Add and update leads, log notes, assign follow-up tasks, search contacts' },
  { slug: 'zoho', name: 'Zoho', category: 'CRM & Sales', description: 'Zoho CRM for sales teams', capabilities: 'Create leads and contacts, update deals, log activities, search records' },
  { slug: 'zoho_bigin', name: 'Zoho Bigin', category: 'CRM & Sales', description: 'Lightweight CRM for small teams', capabilities: 'Manage pipelines, create contacts, log notes, update deal stages' },
  { slug: 'dynamics365', name: 'Dynamics 365', category: 'CRM & Sales', description: 'Microsoft enterprise CRM', capabilities: 'Create and update contacts, manage opportunities, log activities, search accounts' },
  { slug: 'gorgias', name: 'Gorgias', category: 'CRM & Sales', description: 'Ecommerce customer support platform', capabilities: 'Reply to tickets, search conversations, add internal notes, update ticket status' },
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

  // Project Management
  { slug: 'asana', name: 'Asana', category: 'Project Management', description: 'Task and project tracking tool', capabilities: 'Create tasks and projects, update status, assign work, add comments, search tasks' },
  { slug: 'trello', name: 'Trello', category: 'Project Management', description: 'Kanban board for teams', capabilities: 'Create cards and lists, move cards between columns, add comments, manage board members' },
  { slug: 'clickup', name: 'ClickUp', category: 'Project Management', description: 'All-in-one project management tool', capabilities: 'Create tasks, update status, assign work, add comments, search across spaces' },
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
  { slug: 'dart', name: 'Dart', category: 'Project Management', description: 'AI-powered project management', capabilities: 'Create tasks, update status, assign work, manage sprints, search across projects' },

  // Time Tracking
  { slug: 'clockify', name: 'Clockify', category: 'Time Tracking', description: 'Free time tracking for teams', capabilities: 'Start and stop timers, log time entries, create projects, generate time reports' },
  { slug: 'toggl', name: 'Toggl', category: 'Time Tracking', description: 'Simple time tracking tool', capabilities: 'Start and stop timers, log time entries, manage projects, pull time reports' },
  { slug: 'harvest', name: 'Harvest', category: 'Time Tracking', description: 'Time tracking with invoicing', capabilities: 'Log time entries, manage projects and clients, create invoices, pull time reports' },
  { slug: 'timely', name: 'Timely', category: 'Time Tracking', description: 'Automatic time tracking app', capabilities: 'Log and edit time entries, manage projects, pull time reports, check team capacity' },

  // Finance & Payments
  { slug: 'stripe', name: 'Stripe', category: 'Finance & Payments', description: 'Online payment processing platform', capabilities: 'Look up customers and charges, create payment links, manage subscriptions, retrieve invoices' },
  { slug: 'square', name: 'Square', category: 'Finance & Payments', description: 'Payments and point-of-sale platform', capabilities: 'Look up customers and payments, create invoices, manage catalog items' },
  { slug: 'quickbooks', name: 'QuickBooks', category: 'Finance & Payments', description: 'Small business accounting software', capabilities: 'Create invoices and expenses, manage customers, pull financial reports, record payments' },
  { slug: 'xero', name: 'Xero', category: 'Finance & Payments', description: 'Cloud accounting for small businesses', capabilities: 'Create invoices and bills, manage contacts, record payments, pull financial reports' },
  { slug: 'freshbooks', name: 'FreshBooks', category: 'Finance & Payments', description: 'Invoicing and accounting for freelancers', capabilities: 'Create and send invoices, log expenses, manage clients, track payments' },
  { slug: 'freeagent', name: 'FreeAgent', category: 'Finance & Payments', description: 'Accounting software for freelancers', capabilities: 'Create invoices and expenses, manage contacts, record bank transactions' },
  { slug: 'zoho_books', name: 'Zoho Books', category: 'Finance & Payments', description: 'Zoho accounting platform', capabilities: 'Create invoices and bills, manage contacts, record payments, pull reports' },
  { slug: 'zoho_invoice', name: 'Zoho Invoice', category: 'Finance & Payments', description: 'Free invoicing tool by Zoho', capabilities: 'Create and send invoices, manage clients, record payments, apply discounts' },
  { slug: 'zoho_inventory', name: 'Zoho Inventory', category: 'Finance & Payments', description: 'Inventory and order management', capabilities: 'Manage products and stock, create orders, track shipments, update inventory levels' },
  { slug: 'gumroad', name: 'Gumroad', category: 'Finance & Payments', description: 'Digital product sales platform', capabilities: 'List products, retrieve sales data, manage customers, check revenue stats' },
  { slug: 'lemon_squeezy', name: 'Lemon Squeezy', category: 'Finance & Payments', description: 'Payments and subscriptions for SaaS', capabilities: 'List products and orders, manage subscriptions, retrieve customer data' },
  { slug: 'ynab', name: 'YNAB', category: 'Finance & Payments', description: 'Personal budgeting app', capabilities: 'Read budget categories, add transactions, check account balances, review spending reports' },

  // Documents & E-Sign
  { slug: 'googledocs', name: 'Google Docs', category: 'Documents & E-Sign', description: 'Cloud word processor by Google', capabilities: 'Create and update documents, append content, read document text, share with collaborators' },
  { slug: 'googlesheets', name: 'Google Sheets', category: 'Documents & E-Sign', description: 'Cloud spreadsheets by Google', capabilities: 'Read and write cell data, create sheets, update rows, apply formulas' },
  { slug: 'googleslides', name: 'Google Slides', category: 'Documents & E-Sign', description: 'Cloud presentation tool by Google', capabilities: 'Create presentations, read slide content, add and update slides' },
  { slug: 'excel', name: 'Excel', category: 'Documents & E-Sign', description: 'Microsoft spreadsheet application', capabilities: 'Read and write cell data, create workbooks, update named ranges, run formulas' },
  { slug: 'pandadoc', name: 'PandaDoc', category: 'Documents & E-Sign', description: 'Document creation and e-signing', capabilities: 'Create documents from templates, send for signature, check signing status, manage recipients' },
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
  { slug: 'typeform', name: 'Typeform', category: 'Forms & Surveys', description: 'Conversational form builder', capabilities: 'List forms, retrieve responses, check completion stats, manage form settings' },
  { slug: 'jotform', name: 'JotForm', category: 'Forms & Surveys', description: 'Online form builder platform', capabilities: 'List forms, retrieve submissions, check response counts, manage form questions' },

  // Marketing & Social
  { slug: 'mailchimp', name: 'Mailchimp', category: 'Marketing & Social', description: 'Email marketing platform', capabilities: 'Create campaigns, manage subscriber lists, add or update contacts, check campaign stats' },
  { slug: 'mailerlite', name: 'MailerLite', category: 'Marketing & Social', description: 'Email marketing for small businesses', capabilities: 'Create campaigns, manage subscribers, add contacts to groups, check open rates' },
  { slug: 'klaviyo', name: 'Klaviyo', category: 'Marketing & Social', description: 'E-commerce email and SMS marketing', capabilities: 'Create campaigns, manage lists, add and update profiles, check flow analytics' },
  { slug: 'linkedin', name: 'LinkedIn', category: 'Marketing & Social', description: 'Professional networking platform', capabilities: 'Create posts, search profiles and companies, send connection requests, retrieve feed' },
  { slug: 'facebook', name: 'Facebook', category: 'Marketing & Social', description: 'Social network by Meta', capabilities: 'Create posts, read page content, manage comments, check page insights' },
  { slug: 'instagram', name: 'Instagram', category: 'Marketing & Social', description: 'Photo and video social platform', capabilities: 'Read account media, check insights, retrieve profile info, manage comments' },
  { slug: 'tiktok', name: 'TikTok', category: 'Marketing & Social', description: 'Short-form video platform', capabilities: 'Search videos, retrieve account info, check video analytics, manage comments' },
  { slug: 'youtube', name: 'YouTube', category: 'Marketing & Social', description: 'Video hosting by Google', capabilities: 'Search videos, retrieve channel info, check video stats, manage playlists' },
  { slug: 'reddit', name: 'Reddit', category: 'Marketing & Social', description: 'Community forum and link aggregator', capabilities: 'Search posts and subreddits, read comments, submit posts, check post stats' },
  { slug: 'metaads', name: 'Meta Ads', category: 'Marketing & Social', description: 'Facebook and Instagram ad platform', capabilities: 'Create and manage campaigns, check ad performance, adjust budgets, retrieve audience data' },
  { slug: 'googleads', name: 'Google Ads', category: 'Marketing & Social', description: 'Google search and display advertising', capabilities: 'Manage campaigns and ad groups, check performance metrics, adjust bids, retrieve reports' },
  { slug: 'semrush', name: 'SEMrush', category: 'Marketing & Social', description: 'SEO and competitive intelligence tool', capabilities: 'Search keyword data, check domain rankings, retrieve backlink reports, analyze competitors' },
  { slug: 'google_analytics', name: 'Google Analytics', category: 'Marketing & Social', description: 'Web traffic analytics by Google', capabilities: 'Retrieve traffic reports, check goal completions, compare date ranges, pull audience data' },
  { slug: 'eventbrite', name: 'Eventbrite', category: 'Marketing & Social', description: 'Event ticketing and management platform', capabilities: 'Create events, manage attendees, check ticket sales, publish and update events' },

  // eCommerce
  { slug: 'shopify', name: 'Shopify', category: 'eCommerce', description: 'E-commerce store platform', capabilities: 'List and update orders, manage products, check inventory, retrieve customer data' },
  { slug: 'servicem8', name: 'Servicem8', category: 'eCommerce', description: 'Field service management platform', capabilities: 'Create and update jobs, manage clients, schedule work, retrieve job details' },

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
  const res = await fetch(`${COMPOSIO_BASE}/connected_accounts?limit=100&user_uuid=${encodeURIComponent(userId)}`, {
    headers: { 'X-API-KEY': apiKey }
  })
  const data = await res.json() as { items?: any[] }
  const accounts = data.items ?? []
  const connectedSlugs = new Set<string>(
    accounts
      .filter((a: any) => a.status === 'ACTIVE')
      .map((a: any) => (a.toolkit?.slug ?? a.toolkitSlug ?? a.appName ?? '').toLowerCase())
  )
  return INTEGRATIONS.map(({ slug, name, category, description, capabilities }) => ({
    slug,
    name,
    connected: connectedSlugs.has(slug),
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
    const res = await fetch(`${COMPOSIO_BASE}/toolkits/${slug}`, {
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
    const res = await fetch(`${COMPOSIO_BASE}/auth_configs?toolkit_slug=${slug}`, {
      headers: { 'X-API-KEY': apiKey }
    })
    const data = await res.json() as any
    // Use any existing auth config for this slug (developer may have set it up on Composio dashboard)
    const existing = (data?.items ?? [])[0]
    if (existing) {
      console.log(`[Composio] Found existing auth config for ${slug}: ${existing.name} (${existing.id})`)
    }
    return existing?.id ?? null
  } catch {
    return null
  }
}

/** Create an auth config for unmanaged OAuth apps (client_id/secret) */
async function ensureAuthConfig(
  apiKey: string,
  slug: string,
  params: Record<string, string>
): Promise<string> {
  const auth = await getToolkitAuth(apiKey, slug)
  const authConfigName = `${slug}_coagent`

  // Build the config payload
  const configData: Record<string, string> = {}
  for (const f of auth.setupFields) {
    configData[f.name] = params[f.name]?.trim() || f.default || ''
  }
  // Always include redirect URI for OAuth
  if (!configData.oauth_redirect_uri) {
    configData.oauth_redirect_uri = 'https://backend.composio.dev/api/v1/auth-apps/add'
  }

  // Check if any auth config already exists for this slug
  const listRes = await fetch(`${COMPOSIO_BASE}/auth_configs?toolkit_slug=${slug}`, {
    headers: { 'X-API-KEY': apiKey }
  })
  const listData = await listRes.json() as any
  const existing = (listData?.items ?? [])[0]
  if (existing) {
    console.log(`[Composio] Reusing auth config ${existing.name} (${existing.id})`)
    return existing.id
  }

  // Create new auth config
  const res = await fetch(`${COMPOSIO_BASE}/auth_configs`, {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: authConfigName,
      toolkit_slug: slug,
      type: auth.mode || 'OAUTH2',
      credentials: configData
    })
  })
  const body = await res.json() as any
  if (!res.ok) throw new Error(body?.error?.message ?? `Failed to create auth config for ${slug}`)
  console.log(`[Composio] Created auth config ${authConfigName} (${body.id})`)
  return body.id
}

export async function generateAuthUrl(
  apiKey: string,
  slug: string,
  userId = 'default',
  params?: Record<string, string>
): Promise<string> {
  const auth = await getToolkitAuth(apiKey, slug)

  // API key integrations — need connection fields from the user (skip fields with defaults)
  if (auth.connectionFields.length > 0) {
    const userRequired = auth.connectionFields.filter(f => !f.default)
    const missing = userRequired.filter(f => !params?.[f.name]?.trim())
    if (missing.length > 0) {
      const err: any = new Error('NEEDS_FIELDS')
      err.fields = userRequired
      throw err
    }
    await removeAllAccountsForSlug(apiKey, slug, userId)
    const data: Record<string, string> = {}
    for (const f of auth.connectionFields) data[f.name] = params?.[f.name]?.trim() || f.default || ''

    const res = await fetch(`${COMPOSIO_BASE}/connected_accounts`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolkit_slug: slug, user_uuid: userId, data })
    })
    const body = await res.json() as any
    if (!res.ok) throw new Error(body?.error?.message ?? `Failed to connect ${slug}`)
    const url = body?.redirectUrl ?? body?.redirect_url
    if (!url) throw new Error(`No auth URL returned for ${slug}`)
    return url
  }

  // Unmanaged OAuth — use pre-configured auth config (set up by developer on Composio).
  // Only ask user for credentials if no auth config exists yet.
  if (!auth.managed && auth.setupFields.length > 0) {
    const existingConfigId = await findExistingAuthConfig(apiKey, slug)
    if (!existingConfigId) {
      // No pre-configured auth — ask user for client_id/secret
      const missing = auth.setupFields.filter(f => !params?.[f.name]?.trim())
      if (missing.length > 0) {
        const err: any = new Error('NEEDS_FIELDS')
        err.fields = auth.setupFields
        throw err
      }
    }
    const authConfigId = existingConfigId || await ensureAuthConfig(apiKey, slug, params || {})
    await removeAllAccountsForSlug(apiKey, slug, userId)

    const res = await fetch(`${COMPOSIO_BASE}/connected_accounts`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toolkit_slug: slug,
        user_uuid: userId,
        auth_config: { id: authConfigId },
        connection: {}
      })
    })
    const body = await res.json() as any
    if (!res.ok) throw new Error(body?.error?.message ?? `Failed to connect ${slug}`)
    const url = body?.redirect_url ?? body?.redirectUrl
    if (!url) throw new Error(`No auth URL returned for ${slug}`)
    console.log(`[Composio] ${slug} connected using auth config ${authConfigId}${existingConfigId ? ' (pre-configured)' : ' (new)'}`)
    return url
  }

  // Managed OAuth — use SDK auth flow directly
  await removeAllAccountsForSlug(apiKey, slug, userId).catch(() => {})
  const composio = new Composio({ apiKey })
  const result = await composio.toolkits.authorize(userId, slug)
  const url = (result as any)?.redirectUrl
  if (!url) throw new Error(`No auth URL returned for ${slug}`)
  return url
}

// Delete ALL accounts matching a slug for a specific user (any status) — prevents duplicate buildup
async function removeAllAccountsForSlug(
  apiKey: string,
  slug: string,
  userId = 'default'
): Promise<number> {
  const res = await fetch(`${COMPOSIO_BASE}/connected_accounts?limit=100&user_uuid=${encodeURIComponent(userId)}`, {
    headers: { 'X-API-KEY': apiKey }
  })
  const data = await res.json() as { items?: any[] }
  const all = data.items ?? []
  const matching = all.filter((a: any) =>
    (a.toolkit?.slug ?? a.toolkitSlug ?? a.appName ?? '').toLowerCase() === slug.toLowerCase()
  )
  for (const a of matching) {
    await fetch(`${COMPOSIO_BASE}/connected_accounts/${a.id}`, {
      method: 'DELETE',
      headers: { 'X-API-KEY': apiKey }
    })
  }
  if (matching.length > 0) {
    console.log(`[Composio] Removed ${matching.length} existing account(s) for ${slug} (user: ${userId})`)
  }
  return matching.length
}

export async function disconnectIntegration(
  apiKey: string,
  slug: string,
  userId = 'default'
): Promise<void> {
  await removeAllAccountsForSlug(apiKey, slug, userId)
}

export async function getConnectedSlugs(
  apiKey: string,
  userId = 'default'
): Promise<string[]> {
  const statuses = await getIntegrationStatuses(apiKey, userId)
  return statuses.filter(s => s.connected).map(s => s.slug)
}

// Purge EXPIRED connected accounts for a specific user on startup to prevent buildup
export async function purgeExpiredAccounts(apiKey: string, userId = 'default'): Promise<void> {
  const res = await fetch(`${COMPOSIO_BASE}/connected_accounts?limit=100&user_uuid=${encodeURIComponent(userId)}`, {
    headers: { 'X-API-KEY': apiKey }
  })
  const data = await res.json() as { items?: any[] }
  const all = data.items ?? []
  const expired = all.filter((a: any) => a.status === 'EXPIRED')
  if (expired.length === 0) return
  for (const a of expired) {
    await fetch(`${COMPOSIO_BASE}/connected_accounts/${a.id}`, {
      method: 'DELETE',
      headers: { 'X-API-KEY': apiKey }
    })
  }
  console.log(`[Composio] Purged ${expired.length} expired account(s) for user: ${userId}`)
}

// Get v3 connected account ID (short format: ca_xxx) for a specific app slug and user
async function getV3ConnectedAccountId(apiKey: string, appSlug: string, userId = 'default'): Promise<string | null> {
  const res = await fetch(`${COMPOSIO_BASE}/connected_accounts?limit=50&user_uuid=${encodeURIComponent(userId)}`, {
    headers: { 'X-API-KEY': apiKey }
  })
  const data = await res.json() as { items?: any[] }
  const accounts = data.items ?? []
  const match = accounts.find((a: any) =>
    (a.toolkit?.slug ?? a.appName ?? '').toLowerCase() === appSlug.toLowerCase() &&
    a.status === 'ACTIVE'
  )
  return match?.id ?? null
}

// Subscribe all high-signal triggers for a newly connected app.
// Safe to call multiple times — upsert is idempotent.
export async function subscribeTriggersForSlug(apiKey: string, appSlug: string): Promise<void> {
  const triggerSlugs = TRIGGER_MAP[appSlug]
  if (!triggerSlugs || triggerSlugs.length === 0) {
    console.log(`[Composio] No triggers configured for ${appSlug}`)
    return
  }

  const connectedAccountId = await getV3ConnectedAccountId(apiKey, appSlug)
  if (!connectedAccountId) {
    console.warn(`[Composio] No active connected account found for ${appSlug}`)
    return
  }

  for (const triggerSlug of triggerSlugs) {
    try {
      const res = await fetch(`${COMPOSIO_BASE}/trigger_instances/${triggerSlug}/upsert`, {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connected_account_id: connectedAccountId,
          trigger_config: { userId: 'me', interval: 1 }
        })
      })
      const body = await res.json() as any
      if (res.ok) {
        console.log(`[Composio] Subscribed trigger ${triggerSlug} (${body.trigger_id})`)
      } else {
        console.warn(`[Composio] Failed to subscribe ${triggerSlug}: ${body?.error?.message ?? res.status}`)
      }
    } catch (err: any) {
      console.error(`[Composio] Error subscribing ${triggerSlug}:`, err.message)
    }
  }
}
