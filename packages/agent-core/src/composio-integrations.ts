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
  // Popular
  { slug: 'gmail', name: 'Gmail' },
  { slug: 'slack', name: 'Slack' },
  { slug: 'googlecalendar', name: 'Google Calendar' },
  { slug: 'googledrive', name: 'Google Drive' },
  { slug: 'notion', name: 'Notion' },
  { slug: 'github', name: 'GitHub' },
  { slug: 'hubspot', name: 'HubSpot' },
  { slug: 'stripe', name: 'Stripe' },
  { slug: 'shopify', name: 'Shopify' },
  { slug: 'linkedin', name: 'LinkedIn' },
  { slug: 'outlook', name: 'Outlook' },
  { slug: 'zoom', name: 'Zoom' },
  { slug: 'discord', name: 'Discord' },
  { slug: 'asana', name: 'Asana' },
  { slug: 'trello', name: 'Trello' },
  { slug: 'figma', name: 'Figma' },
  { slug: 'dropbox', name: 'Dropbox' },
  { slug: 'airtable', name: 'Airtable' },
  { slug: 'salesforce', name: 'Salesforce' },
  { slug: 'google_analytics', name: 'Google Analytics' },
  { slug: 'youtube', name: 'YouTube' },
  { slug: 'facebook', name: 'Facebook' },
  { slug: 'mailchimp', name: 'Mailchimp' },
  { slug: 'todoist', name: 'Todoist' },

  // Email & Communication
  { slug: 'zoho_mail', name: 'Zoho Mail' },
  { slug: 'microsoft_teams', name: 'Microsoft Teams' },
  { slug: 'intercom', name: 'Intercom' },
  { slug: 'dialpad', name: 'Dialpad' },
  { slug: 'whatsapp', name: 'WhatsApp' },

  // Calendar & Scheduling
  { slug: 'googlemeet', name: 'Google Meet' },
  { slug: 'googletasks', name: 'Google Tasks' },
  { slug: 'calendly', name: 'Calendly' },
  { slug: 'cal', name: 'Cal' },
  { slug: 'harvest', name: 'Harvest' },
  { slug: 'timely', name: 'Timely' },

  // Documents & Storage
  { slug: 'googledocs', name: 'Google Docs' },
  { slug: 'googlesheets', name: 'Google Sheets' },
  { slug: 'googleslides', name: 'Google Slides' },
  { slug: 'googlephotos', name: 'Google Photos' },
  { slug: 'excel', name: 'Excel' },
  { slug: 'one_drive', name: 'OneDrive' },
  { slug: 'share_point', name: 'SharePoint' },
  { slug: 'dropbox_sign', name: 'Dropbox Sign' },
  { slug: 'box', name: 'Box' },
  { slug: 'confluence', name: 'Confluence' },
  { slug: 'contentful', name: 'Contentful' },
  { slug: 'canva', name: 'Canva' },
  { slug: 'docusign', name: 'DocuSign' },
  { slug: 'boldsign', name: 'Boldsign' },

  // CRM & Sales
  { slug: 'attio', name: 'Attio' },
  { slug: 'capsule_crm', name: 'Capsule CRM' },
  { slug: 'follow_up_boss', name: 'Follow Up Boss' },
  { slug: 'zoho', name: 'Zoho' },
  { slug: 'zoho_bigin', name: 'Zoho Bigin' },
  { slug: 'gorgias', name: 'Gorgias' },
  { slug: 'zendesk', name: 'Zendesk' },
  { slug: 'freshbooks', name: 'FreshBooks' },

  // Project Management
  { slug: 'clickup', name: 'ClickUp' },
  { slug: 'monday', name: 'Monday' },
  { slug: 'linear', name: 'Linear' },
  { slug: 'wrike', name: 'Wrike' },
  { slug: 'basecamp', name: 'Basecamp' },
  { slug: 'miro', name: 'Miro' },
  { slug: 'mural', name: 'Mural' },
  { slug: 'productboard', name: 'Productboard' },
  { slug: 'dart', name: 'Dart' },

  // Developer Tools
  { slug: 'bitbucket', name: 'Bitbucket' },
  { slug: 'sentry', name: 'Sentry' },
  { slug: 'digital_ocean', name: 'DigitalOcean' },
  { slug: 'supabase', name: 'Supabase' },
  { slug: 'wakatime', name: 'WakaTime' },

  // Finance & Payments
  { slug: 'square', name: 'Square' },
  { slug: 'xero', name: 'Xero' },
  { slug: 'zoho_books', name: 'Zoho Books' },
  { slug: 'zoho_invoice', name: 'Zoho Invoice' },
  { slug: 'zoho_inventory', name: 'Zoho Inventory' },
  { slug: 'dynamics365', name: 'Dynamics 365' },
  { slug: 'gumroad', name: 'Gumroad' },
  { slug: 'ynab', name: 'YNAB' },

  // eCommerce
  { slug: 'servicem8', name: 'Servicem8' },

  // Social & Marketing
  { slug: 'reddit', name: 'Reddit' },
  { slug: 'googleads', name: 'Google Ads' },
  { slug: 'google_maps', name: 'Google Maps' },
  { slug: 'klaviyo', name: 'Klaviyo' },
  { slug: 'eventbrite', name: 'Eventbrite' },

  // Data & Design
  { slug: 'crowdin', name: 'Crowdin' },

  // Other
  { slug: 'dub', name: 'Dub' },
  { slug: 'fathom', name: 'Fathom' },
  { slug: 'stack_exchange', name: 'Stack Exchange' },
  { slug: 'yandex', name: 'Yandex' },
  { slug: 'zoho_desk', name: 'Zoho Desk' },
]

export async function getIntegrationStatuses(
  apiKey: string,
  userId = 'default'
): Promise<{ slug: string; name: string; connected: boolean }[]> {
  const composio = new Composio({ apiKey })
  const result = await composio.connectedAccounts.list({ user_uuid: userId } as any)
  const accounts = (result as any)?.items ?? []
  const connectedSlugs = new Set<string>(
    accounts
      .filter((a: any) => a.status === 'ACTIVE')
      .map((a: any) => (a.toolkit?.slug ?? a.toolkitSlug ?? a.appName ?? '').toLowerCase())
  )
  return INTEGRATIONS.map(({ slug, name }) => ({
    slug,
    name,
    connected: connectedSlugs.has(slug),
  }))
}

/** Fetch required fields for connecting an account (cached per slug) */
const fieldsCache = new Map<string, { name: string; displayName: string; description: string }[]>()

export async function getRequiredFields(
  apiKey: string,
  slug: string
): Promise<{ name: string; displayName: string; description: string }[]> {
  if (fieldsCache.has(slug)) return fieldsCache.get(slug)!
  try {
    const res = await fetch(`${COMPOSIO_BASE}/toolkits/${slug}`, {
      headers: { 'X-API-KEY': apiKey }
    })
    const data = await res.json() as any
    const fields = data?.auth_config_details?.[0]?.fields?.connected_account_initiation?.required ?? []
    const result = fields.map((f: any) => ({ name: f.name, displayName: f.displayName, description: f.description }))
    fieldsCache.set(slug, result)
    return result
  } catch {
    return []
  }
}

export async function generateAuthUrl(
  apiKey: string,
  slug: string,
  userId = 'default',
  params?: Record<string, string>
): Promise<string> {
  // If this integration requires extra fields, use the REST API to pass them
  const requiredFields = await getRequiredFields(apiKey, slug)
  if (requiredFields.length > 0) {
    // Check all required fields are provided
    const missing = requiredFields.filter(f => !params?.[f.name]?.trim())
    if (missing.length > 0) {
      // Return a special error with field info so frontend can prompt
      const err: any = new Error(`NEEDS_FIELDS`)
      err.fields = requiredFields
      throw err
    }

    await removeAllAccountsForSlug(apiKey, slug, userId)
    const data: Record<string, string> = {}
    for (const f of requiredFields) data[f.name] = params![f.name].trim()

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

  // No extra fields needed — use SDK auth flow
  const composio = new Composio({ apiKey })
  const [result] = await Promise.all([
    composio.toolkits.authorize(userId, slug),
    removeAllAccountsForSlug(apiKey, slug, userId).catch(() => {}),
  ])
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
