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
  { slug: 'spotify', name: 'Spotify' },
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
  { slug: 'telegram', name: 'Telegram' },
  { slug: 'sendgrid', name: 'SendGrid' },
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
  { slug: 'jira', name: 'Jira' },
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
  { slug: 'quickbooks', name: 'QuickBooks' },
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
  { slug: 'instagram', name: 'Instagram' },
  { slug: 'tiktok', name: 'TikTok' },
  { slug: 'reddit', name: 'Reddit' },
  { slug: 'metaads', name: 'Meta Ads' },
  { slug: 'googleads', name: 'Google Ads' },
  { slug: 'semrush', name: 'SEMrush' },
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
  return INTEGRATIONS.map(({ slug, name }) => ({
    slug,
    name,
    connected: connectedSlugs.has(slug),
  }))
}

/** Fetch toolkit auth info (cached) */
interface ToolkitAuth {
  managed: boolean
  mode: string
  /** Fields the user must fill to connect (API key integrations) */
  connectionFields: { name: string; displayName: string; description: string }[]
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
      .map((f: any) => ({ name: f.name, displayName: f.displayName, description: f.description }))

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
  // For API key integrations: connection fields (e.g. generic_api_key)
  if (auth.connectionFields.length > 0) return auth.connectionFields
  // For unmanaged OAuth: setup fields (client_id, client_secret)
  if (!auth.managed && auth.setupFields.length > 0) return auth.setupFields
  return []
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

  // Check if auth config already exists
  const listRes = await fetch(`${COMPOSIO_BASE}/auth_configs?toolkit_slug=${slug}`, {
    headers: { 'X-API-KEY': apiKey }
  })
  const listData = await listRes.json() as any
  const existing = (listData?.items ?? []).find((c: any) => c.name === authConfigName)
  if (existing) {
    console.log(`[Composio] Reusing auth config ${authConfigName} (${existing.id})`)
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

  // Collect all required fields the user needs to provide
  const allRequired = await getRequiredFields(apiKey, slug)
  if (allRequired.length > 0) {
    const missing = allRequired.filter(f => !params?.[f.name]?.trim())
    if (missing.length > 0) {
      const err: any = new Error('NEEDS_FIELDS')
      err.fields = allRequired
      throw err
    }
  }

  // API key integrations — connect directly with the provided data
  if (auth.connectionFields.length > 0) {
    await removeAllAccountsForSlug(apiKey, slug, userId)
    const data: Record<string, string> = {}
    for (const f of auth.connectionFields) data[f.name] = params![f.name].trim()

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

  // Unmanaged OAuth — create auth config first, then connect using it
  if (!auth.managed && auth.setupFields.length > 0) {
    const authConfigId = await ensureAuthConfig(apiKey, slug, params!)
    await removeAllAccountsForSlug(apiKey, slug, userId)

    const res = await fetch(`${COMPOSIO_BASE}/connected_accounts`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toolkit_slug: slug,
        user_uuid: userId,
        auth_config_id: authConfigId
      })
    })
    const body = await res.json() as any
    if (!res.ok) throw new Error(body?.error?.message ?? `Failed to connect ${slug}`)
    const url = body?.redirectUrl ?? body?.redirect_url
    if (!url) throw new Error(`No auth URL returned for ${slug}`)
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
