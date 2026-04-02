import React, { useEffect, useState } from 'react'
import { X, ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Integration } from '@coagent/shared'
import QRCode from 'qrcode'

interface PendingFields {
  slug: string
  fields: { name: string; displayName: string; description: string; helpUrl?: string; helpText?: string }[]
}

interface RelayCredentials {
  relayUrl: string
  token: string
  userId: string
}

interface IntegrationsModalProps {
  open: boolean
  onClose: () => void
  integrations: Integration[]
  onConnect: (slug: string, params?: Record<string, string>) => void
  onDisconnect: (slug: string) => void
  onDelete?: (slug: string) => void
  pendingFields: PendingFields | null
  onClearPendingFields: () => void
  whatsappQr?: string | null
  relayCredentials?: RelayCredentials | null
  onToggleTrigger?: (triggerSlug: string, appSlug: string, enabled: boolean) => void
  onChat?: (message: string) => void
}

export function IntegrationsModal({ open, onClose, integrations, onConnect, onDisconnect, onDelete, pendingFields, onClearPendingFields, whatsappQr, relayCredentials, onToggleTrigger, onChat }: IntegrationsModalProps) {
  const [search, setSearch] = useState('')
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [detailSlug, setDetailSlug] = useState<string | null>(null)
  const [mobileQrDataUrl, setMobileQrDataUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!relayCredentials?.relayUrl || !relayCredentials.token) {
      setMobileQrDataUrl(null)
      return
    }
    const payload = JSON.stringify({
      relayUrl: relayCredentials.relayUrl,
      token: relayCredentials.token,
      userId: relayCredentials.userId,
    })
    QRCode.toDataURL(payload, { width: 192, margin: 2 })
      .then(url => setMobileQrDataUrl(url))
      .catch(() => setMobileQrDataUrl(null))
  }, [relayCredentials])

  // Auto-fetch relay credentials when the mobile detail view is opened
  useEffect(() => {
    if (detailSlug === 'coagent:mobile') {
      onConnect('coagent:mobile')
    }
  }, [detailSlug])

  // Reset field values when pending fields change
  useEffect(() => {
    if (pendingFields) {
      const initial: Record<string, string> = {}
      for (const f of pendingFields.fields) initial[f.name] = ''
      setFieldValues(initial)
    }
  }, [pendingFields?.slug])

  // When a pending-fields prompt arrives for the current detail view, stay in detail view
  // (fields are shown inline in the detail panel). If we're in the grid and fields arrive,
  // navigate to the detail view for that integration.
  useEffect(() => {
    if (pendingFields && detailSlug !== pendingFields.slug) {
      setDetailSlug(pendingFields.slug)
    }
  }, [pendingFields?.slug])

  function handleConnect(slug: string) {
    onConnect(slug)
  }

  function handleFieldSubmit() {
    if (!pendingFields) return
    const allFilled = pendingFields.fields.every(f => fieldValues[f.name]?.trim())
    if (!allFilled) return
    onConnect(pendingFields.slug, fieldValues)
  }

  function handleCancelFields() {
    onClearPendingFields()
    setFieldValues({})
  }

  function handleBackToGrid() {
    setDetailSlug(null)
    if (pendingFields) handleCancelFields()
  }

  useEffect(() => {
    if (!open) { setSearch(''); setDetailSlug(null); return }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (detailSlug) { handleBackToGrid() }
        else if (pendingFields) { handleCancelFields() }
        else { onClose() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, pendingFields, detailSlug])

  if (!open) return null

  const connectedIntegrations = integrations.filter(i => i.connected)

  const filtered = integrations.filter(i => {
    const q = search.toLowerCase()
    return (
      i.name.toLowerCase().includes(q) ||
      (i.description?.toLowerCase().includes(q) ?? false) ||
      (i.capabilities?.toLowerCase().includes(q) ?? false)
    )
  })

  // Group by category, preserving the order categories appear in the data
  const grouped = new Map<string, Integration[]>()
  for (const i of filtered) {
    const cat = i.category || 'Other'
    if (!grouped.has(cat)) grouped.set(cat, [])
    grouped.get(cat)!.push(i)
  }
  for (const items of grouped.values()) {
    items.sort((a, b) => a.name.localeCompare(b.name))
  }

  const sortedCategories = [...grouped.keys()].sort((a, b) => {
    if (a === 'CoAgent') return -1
    if (b === 'CoAgent') return 1
    if (a === 'Custom') return -1
    if (b === 'Custom') return 1
    return a.localeCompare(b)
  })

  const detailIntegration = detailSlug ? integrations.find(i => i.slug === detailSlug) ?? null : null

  // Pending fields for the current detail view (if any)
  const detailPendingFields = detailIntegration && pendingFields?.slug === detailIntegration.slug
    ? pendingFields
    : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-neutral-900 rounded-2xl shadow-xl w-[820px] max-h-[700px] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {detailIntegration ? (
          // ── Detail view ──────────────────────────────────────────────────────
          <>
            {/* Detail header */}
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-neutral-100 dark:border-neutral-800">
              <button
                onClick={handleBackToGrid}
                className="flex items-center gap-1.5 text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 transition-colors"
              >
                <ArrowLeft size={14} />
                <span className="text-[12px] font-medium">Integrations</span>
              </button>
              <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 transition-colors">
                <X size={16} />
              </button>
            </div>

            {/* Detail body */}
            <div className="overflow-y-auto flex-1 px-8 py-6">
              {/* App identity */}
              <div className="flex items-center gap-4 mb-5">
                <div className="w-10 h-10 rounded-xl border border-neutral-100 dark:border-neutral-800 flex items-center justify-center bg-white dark:bg-neutral-800 flex-shrink-0">
                  {detailIntegration.slug === 'coagent:mobile' ? (
                    <svg className="w-6 h-6" viewBox="0 0 32 32" fill="none">
                      <rect width="32" height="32" rx="7" fill="#1C1C1E"/>
                      <rect x="11" y="6" width="10" height="20" rx="2" stroke="white" strokeWidth="1.5" fill="none"/>
                      <circle cx="16" cy="23" r="1" fill="white"/>
                    </svg>
                  ) : detailIntegration.slug === 'coagent:whatsapp' ? (
                    <svg className="w-6 h-6" viewBox="0 0 32 32" fill="none">
                      <rect width="32" height="32" rx="7" fill="#25D366"/>
                      <path d="M16 7.5c-4.694 0-8.5 3.806-8.5 8.5 0 1.497.39 2.9 1.07 4.115L7.5 24.5l4.55-1.02A8.46 8.46 0 0016 24.5c4.694 0 8.5-3.806 8.5-8.5s-3.806-8.5-8.5-8.5zm4.15 11.47c-.175.49-.875.897-1.225.955-.35.058-.79.082-1.275-.08-.295-.1-.675-.232-1.16-.455-2.04-.935-3.375-2.99-3.475-3.13-.1-.14-.82-1.09-.82-2.08s.52-1.475.705-1.675c.185-.2.405-.25.54-.25h.39c.125 0 .295-.047.46.35.175.42.59 1.44.64 1.545.05.105.085.23.017.37-.068.14-.1.227-.2.35-.1.122-.21.273-.3.367-.1.1-.205.21-.088.41.117.2.52.855 1.115 1.385.765.68 1.41.89 1.61.99.2.1.315.085.43-.05.115-.135.49-.57.62-.765.13-.195.26-.163.44-.098.18.065 1.14.537 1.335.635.195.098.325.147.375.23.05.082.05.478-.125.968z" fill="white"/>
                    </svg>
                  ) : detailIntegration.slug === 'coagent:imessage' ? (
                    <svg className="w-6 h-6" viewBox="0 0 32 32" fill="none">
                      <rect width="32" height="32" rx="7" fill="#34C759"/>
                      <path d="M16 7C10.477 7 6 10.582 6 15c0 2.52 1.537 4.768 3.938 6.254-.204 1.48-.89 2.87-.89 2.87s2.47-.354 4.072-1.372C14.05 23.23 15 23.35 16 23.35c5.523 0 10-3.582 10-7.35S21.523 7 16 7z" fill="white"/>
                    </svg>
                  ) : detailIntegration.slug === 'coagent:contacts' ? (
                    <svg className="w-6 h-6" viewBox="0 0 32 32" fill="none">
                      <rect width="32" height="32" rx="7" fill="#A2845E"/>
                      <circle cx="16" cy="13" r="4.5" fill="white"/>
                      <path d="M8.5 24.5c0-4.142 3.358-7.5 7.5-7.5s7.5 3.358 7.5 7.5" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
                    </svg>
                  ) : detailIntegration.domain ? (
                    <img
                      src={`https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${detailIntegration.domain}&size=128`}
                      alt={detailIntegration.name}
                      className="w-6 h-6 object-contain rounded-sm"
                      onError={e => { (e.target as HTMLImageElement).style.opacity = '0' }}
                    />
                  ) : detailIntegration.icon ? (
                    <div className="w-6 h-6" dangerouslySetInnerHTML={{ __html: detailIntegration.icon.replace(/viewBox/, 'class="w-6 h-6" viewBox') }} />
                  ) : detailIntegration.custom ? (
                    <div className="w-6 h-6 rounded bg-neutral-200 dark:bg-neutral-700 flex items-center justify-center">
                      <span className="text-[10px] font-bold text-neutral-500 dark:text-neutral-400">+</span>
                    </div>
                  ) : (
                    <img
                      src={`https://logos.composio.dev/api/${detailIntegration.slug}`}
                      alt={detailIntegration.name}
                      className="w-6 h-6 object-contain"
                      onError={e => { (e.target as HTMLImageElement).style.opacity = '0' }}
                    />
                  )}
                </div>
                <div>
                  <p className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">{detailIntegration.name}</p>
                  {detailIntegration.description && (
                    <p className="text-[12px] text-neutral-400 dark:text-neutral-500 mt-0.5">{detailIntegration.description}</p>
                  )}
                </div>
              </div>

              {/* Capabilities */}
              {detailIntegration.capabilities && (
                <div className="mb-5">
                  <p className="text-[11px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-2">What the agent can do</p>
                  <ul className="flex flex-col gap-1.5">
                    {detailIntegration.capabilities.split(', ').map((cap, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="mt-[5px] w-1 h-1 rounded-full bg-neutral-300 dark:bg-neutral-600 flex-shrink-0" />
                        <span className="text-[13px] text-neutral-700 dark:text-neutral-300">{cap}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* CoAgent Mobile QR code pairing */}
              {detailIntegration.slug === 'coagent:mobile' && (
                <div className="mb-5 p-4 rounded-xl border border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800 flex flex-col items-center gap-3">
                  {mobileQrDataUrl ? (
                    <>
                      <p className="text-[12px] font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Scan with your iPhone camera to connect</p>
                      <img src={mobileQrDataUrl} alt="CoAgent Mobile QR Code" className="w-48 h-48 rounded-lg" />
                      <p className="text-[11px] text-neutral-400 dark:text-neutral-500 text-center">
                        Open the CoAgent app on your iPhone and scan this code
                      </p>
                    </>
                  ) : (
                    <p className="text-[12px] text-neutral-400 dark:text-neutral-500">
                      {relayCredentials === null ? 'Loading...' : 'Relay not configured. Activate your relay in Settings first.'}
                    </p>
                  )}
                </div>
              )}

              {/* WhatsApp QR code pairing */}
              {detailIntegration.slug === 'coagent:whatsapp' && !detailIntegration.connected && whatsappQr && (
                <div className="mb-5 p-4 rounded-xl border border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800 flex flex-col items-center gap-3">
                  <p className="text-[12px] font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">Scan with WhatsApp</p>
                  <img src={whatsappQr} alt="WhatsApp QR Code" className="w-48 h-48 rounded-lg" />
                  <p className="text-[11px] text-neutral-400 dark:text-neutral-500 text-center">
                    Open WhatsApp on your phone → Settings → Linked Devices → Link a Device
                  </p>
                </div>
              )}

              {/* Pending fields (shown inline in detail view) */}
              {detailPendingFields && detailPendingFields.fields.length > 0 && (
                <div className="mb-5 p-4 rounded-xl border border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800">
                  <p className="text-[12px] font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider mb-3">Required credentials</p>
                  <div className="flex flex-col gap-2">
                    {detailPendingFields.fields.map((field, i) => (
                      <div key={field.name} className="flex flex-col gap-1">
                        <input
                          autoFocus={i === 0}
                          type="text"
                          placeholder={field.displayName}
                          title={field.description}
                          value={fieldValues[field.name] ?? ''}
                          onChange={e => setFieldValues(prev => ({ ...prev, [field.name]: e.target.value }))}
                          onKeyDown={e => e.key === 'Enter' && handleFieldSubmit()}
                          className="text-[13px] px-3 py-2 border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-900 outline-none focus:border-neutral-400 dark:focus:border-neutral-500 transition-colors text-neutral-800 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500"
                        />
                        {(field.helpText || field.helpUrl) && (
                          <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
                            {field.helpText}
                            {field.helpUrl && (
                              <>
                                {field.helpText ? ' ' : ''}
                                <a
                                  href={field.helpUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-neutral-600 dark:text-neutral-300 hover:underline"
                                >
                                  {field.helpText ? 'Open →' : `Find your ${field.displayName} →`}
                                </a>
                              </>
                            )}
                          </p>
                        )}
                      </div>
                    ))}
                    {detailPendingFields.fields.some(f => !f.helpUrl) && (
                      <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
                        {detailPendingFields.fields.filter(f => !f.helpUrl).map(f => f.description).join('. ')}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Connect / Disconnect button */}
              <div className="flex items-center gap-3">
                {detailPendingFields && detailPendingFields.fields.length > 0 ? (
                  <>
                    <button
                      type="button"
                      onClick={handleFieldSubmit}
                      disabled={!detailPendingFields.fields.every(f => fieldValues[f.name]?.trim())}
                      className="text-[13px] font-medium px-4 py-2 rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Connect
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelFields}
                      className="text-[13px] font-medium px-4 py-2 rounded-xl text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800 transition-colors"
                    >
                      Cancel
                    </button>
                  </>
                ) : detailIntegration.connected ? (
                  <button
                    type="button"
                    onClick={() => onDisconnect(detailIntegration.slug)}
                    className="text-[13px] font-medium px-4 py-2 rounded-xl text-red-500 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950 transition-colors"
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleConnect(detailIntegration.slug)}
                    className="text-[13px] font-medium px-4 py-2 rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 transition-colors"
                  >
                    Connect
                  </button>
                )}

                {detailIntegration.custom && (
                  <button
                    type="button"
                    onClick={() => { onDelete?.(detailIntegration.slug); handleBackToGrid() }}
                    className="text-[13px] font-medium px-4 py-2 rounded-xl text-red-500 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950 transition-colors"
                  >
                    Delete
                  </button>
                )}

                <div className="flex items-center gap-1.5 ml-1">
                  <span className={cn('w-1.5 h-1.5 rounded-full', detailIntegration.connected ? 'bg-emerald-400' : 'bg-neutral-300 dark:bg-neutral-600')} />
                  <span className="text-[12px] text-neutral-400 dark:text-neutral-500">
                    {detailIntegration.connected ? 'Connected' : 'Not connected'}
                  </span>
                </div>
              </div>

              {/* Notification triggers */}
              {detailIntegration.connected && detailIntegration.triggers && detailIntegration.triggers.length > 0 && (
                <div className="mt-5">
                  <p className="text-[11px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-1.5">Notifications</p>
                  <p className="text-[11px] text-neutral-400 dark:text-neutral-500 mb-3">
                    Events are collected in the background and processed during your regular heartbeats.
                  </p>
                  <div className="flex flex-col gap-2">
                    {detailIntegration.triggers.map(trigger => (
                      <label key={trigger.slug} className="flex items-center gap-2.5 cursor-pointer group">
                        <input
                          type="checkbox"
                          checked={trigger.enabled}
                          onChange={e => onToggleTrigger?.(trigger.slug, detailIntegration.slug, e.target.checked)}
                          className="w-3.5 h-3.5 rounded border-neutral-300 dark:border-neutral-600 text-neutral-900 dark:text-neutral-100 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                        />
                        <span className="text-[13px] text-neutral-700 dark:text-neutral-300 group-hover:text-neutral-900 dark:group-hover:text-neutral-100 transition-colors">
                          {trigger.label}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

            </div>

            {/* Footer */}
            <div className="px-6 py-3 border-t border-neutral-100 dark:border-neutral-800">
              <p className="text-[12px] text-neutral-400 dark:text-neutral-500">
                Need something else?{' '}
                <button
                  onClick={() => { onClose(); onChat?.('@integration-builder') }}
                  className="text-neutral-600 dark:text-neutral-300 hover:underline"
                >
                  Create one →
                </button>
              </p>
            </div>
          </>
        ) : (
          // ── Grid view ────────────────────────────────────────────────────────
          <>
            {/* Header */}
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-neutral-100 dark:border-neutral-800">
              <h2 className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">Integrations</h2>
              <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 transition-colors">
                <X size={16} />
              </button>
            </div>

            {/* Search */}
            <div className="px-6 py-3 border-b border-neutral-100 dark:border-neutral-800">
              <input
                autoFocus
                type="text"
                placeholder="Search..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full text-[13px] bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2 outline-none focus:border-neutral-400 dark:focus:border-neutral-500 transition-colors text-neutral-800 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500"
              />
            </div>

            {/* Grid */}
            <div className="overflow-y-auto flex-1 px-6 py-4">
              {filtered.length === 0 ? (
                <p className="text-[13px] text-neutral-400 dark:text-neutral-500 text-center py-8">No integrations found.</p>
              ) : (
                <div className="flex flex-col gap-4">
                  {/* Connected section */}
                  {!search && connectedIntegrations.length > 0 && (
                    <div>
                      <p className="text-[11px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-2">Connected</p>
                      <div className="grid grid-cols-3 gap-2">
                        {connectedIntegrations.map(integration => (
                          <button
                            key={integration.slug}
                            type="button"
                            onClick={() => setDetailSlug(integration.slug)}
                            className="flex items-center gap-3 p-3 rounded-xl border border-emerald-100 dark:border-emerald-900/50 bg-emerald-50/60 dark:bg-emerald-950/30 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 hover:border-emerald-200 dark:hover:border-emerald-800 transition-colors text-left w-full"
                          >
                            {integration.slug === 'coagent:mobile' ? (
                              <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 32 32" fill="none">
                                <rect width="32" height="32" rx="7" fill="#1C1C1E"/>
                                <rect x="11" y="6" width="10" height="20" rx="2" stroke="white" strokeWidth="1.5" fill="none"/>
                                <circle cx="16" cy="23" r="1" fill="white"/>
                              </svg>
                            ) : integration.slug === 'coagent:whatsapp' ? (
                              <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 32 32" fill="none">
                                <rect width="32" height="32" rx="7" fill="#25D366"/>
                                <path d="M16 7.5c-4.694 0-8.5 3.806-8.5 8.5 0 1.497.39 2.9 1.07 4.115L7.5 24.5l4.55-1.02A8.46 8.46 0 0016 24.5c4.694 0 8.5-3.806 8.5-8.5s-3.806-8.5-8.5-8.5zm4.15 11.47c-.175.49-.875.897-1.225.955-.35.058-.79.082-1.275-.08-.295-.1-.675-.232-1.16-.455-2.04-.935-3.375-2.99-3.475-3.13-.1-.14-.82-1.09-.82-2.08s.52-1.475.705-1.675c.185-.2.405-.25.54-.25h.39c.125 0 .295-.047.46.35.175.42.59 1.44.64 1.545.05.105.085.23.017.37-.068.14-.1.227-.2.35-.1.122-.21.273-.3.367-.1.1-.205.21-.088.41.117.2.52.855 1.115 1.385.765.68 1.41.89 1.61.99.2.1.315.085.43-.05.115-.135.49-.57.62-.765.13-.195.26-.163.44-.098.18.065 1.14.537 1.335.635.195.098.325.147.375.23.05.082.05.478-.125.968z" fill="white"/>
                              </svg>
                            ) : integration.slug === 'coagent:imessage' ? (
                              <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 32 32" fill="none">
                                <rect width="32" height="32" rx="7" fill="#34C759"/>
                                <path d="M16 7C10.477 7 6 10.582 6 15c0 2.52 1.537 4.768 3.938 6.254-.204 1.48-.89 2.87-.89 2.87s2.47-.354 4.072-1.372C14.05 23.23 15 23.35 16 23.35c5.523 0 10-3.582 10-7.35S21.523 7 16 7z" fill="white"/>
                              </svg>
                            ) : integration.slug === 'coagent:contacts' ? (
                              <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 32 32" fill="none">
                                <rect width="32" height="32" rx="7" fill="#A2845E"/>
                                <circle cx="16" cy="13" r="4.5" fill="white"/>
                                <path d="M8.5 24.5c0-4.142 3.358-7.5 7.5-7.5s7.5 3.358 7.5 7.5" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
                              </svg>
                            ) : integration.domain ? (
                              <img
                                src={`https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${integration.domain}&size=128`}
                                alt={integration.name}
                                className="w-5 h-5 object-contain flex-shrink-0 rounded-sm"
                                onError={e => { (e.target as HTMLImageElement).style.opacity = '0' }}
                              />
                            ) : integration.icon ? (
                              <div className="w-5 h-5 flex-shrink-0" dangerouslySetInnerHTML={{ __html: integration.icon.replace(/viewBox/, 'class="w-5 h-5" viewBox') }} />
                            ) : integration.custom ? (
                              <div className="w-5 h-5 rounded bg-neutral-200 dark:bg-neutral-700 flex items-center justify-center flex-shrink-0">
                                <span className="text-[10px] font-bold text-neutral-500 dark:text-neutral-400">+</span>
                              </div>
                            ) : (
                              <img
                                src={`https://logos.composio.dev/api/${integration.slug}`}
                                alt={integration.name}
                                className="w-5 h-5 object-contain flex-shrink-0"
                                onError={e => { (e.target as HTMLImageElement).style.opacity = '0' }}
                              />
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200 truncate">{integration.name}</p>
                            </div>
                            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-emerald-400" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {sortedCategories.map(category => {
                    const items = grouped.get(category)!
                    return (
                      <div key={category}>
                        <div className="flex items-center gap-2 mb-2">
                          <p className="text-[11px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">{category}</p>
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-400 dark:text-neutral-500">{items.length}</span>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {items.map(integration => (
                            <button
                              key={integration.slug}
                              type="button"
                              onClick={() => setDetailSlug(integration.slug)}
                              className="flex items-center gap-3 p-3 rounded-xl border border-neutral-100 dark:border-neutral-800 hover:border-neutral-200 dark:hover:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors text-left w-full"
                            >
                              {integration.slug === 'coagent:mobile' ? (
                                <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 32 32" fill="none">
                                  <rect width="32" height="32" rx="7" fill="#1C1C1E"/>
                                  <rect x="11" y="6" width="10" height="20" rx="2" stroke="white" strokeWidth="1.5" fill="none"/>
                                  <circle cx="16" cy="23" r="1" fill="white"/>
                                </svg>
                              ) : integration.slug === 'coagent:whatsapp' ? (
                                <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 32 32" fill="none">
                                  <rect width="32" height="32" rx="7" fill="#25D366"/>
                                  <path d="M16 7.5c-4.694 0-8.5 3.806-8.5 8.5 0 1.497.39 2.9 1.07 4.115L7.5 24.5l4.55-1.02A8.46 8.46 0 0016 24.5c4.694 0 8.5-3.806 8.5-8.5s-3.806-8.5-8.5-8.5zm4.15 11.47c-.175.49-.875.897-1.225.955-.35.058-.79.082-1.275-.08-.295-.1-.675-.232-1.16-.455-2.04-.935-3.375-2.99-3.475-3.13-.1-.14-.82-1.09-.82-2.08s.52-1.475.705-1.675c.185-.2.405-.25.54-.25h.39c.125 0 .295-.047.46.35.175.42.59 1.44.64 1.545.05.105.085.23.017.37-.068.14-.1.227-.2.35-.1.122-.21.273-.3.367-.1.1-.205.21-.088.41.117.2.52.855 1.115 1.385.765.68 1.41.89 1.61.99.2.1.315.085.43-.05.115-.135.49-.57.62-.765.13-.195.26-.163.44-.098.18.065 1.14.537 1.335.635.195.098.325.147.375.23.05.082.05.478-.125.968z" fill="white"/>
                                </svg>
                              ) : integration.slug === 'coagent:imessage' ? (
                                <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 32 32" fill="none">
                                  <rect width="32" height="32" rx="7" fill="#34C759"/>
                                  <path d="M16 7C10.477 7 6 10.582 6 15c0 2.52 1.537 4.768 3.938 6.254-.204 1.48-.89 2.87-.89 2.87s2.47-.354 4.072-1.372C14.05 23.23 15 23.35 16 23.35c5.523 0 10-3.582 10-7.35S21.523 7 16 7z" fill="white"/>
                                </svg>
                              ) : integration.slug === 'coagent:contacts' ? (
                                <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 32 32" fill="none">
                                  <rect width="32" height="32" rx="7" fill="#A2845E"/>
                                  <circle cx="16" cy="13" r="4.5" fill="white"/>
                                  <path d="M8.5 24.5c0-4.142 3.358-7.5 7.5-7.5s7.5 3.358 7.5 7.5" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
                                </svg>
                              ) : integration.domain ? (
                                <img
                                  src={`https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${integration.domain}&size=128`}
                                  alt={integration.name}
                                  className="w-5 h-5 object-contain flex-shrink-0 rounded-sm"
                                  onError={e => { (e.target as HTMLImageElement).style.opacity = '0' }}
                                />
                              ) : integration.icon ? (
                                <div className="w-5 h-5 flex-shrink-0" dangerouslySetInnerHTML={{ __html: integration.icon.replace(/viewBox/, 'class="w-5 h-5" viewBox') }} />
                              ) : integration.custom ? (
                                <div className="w-5 h-5 rounded bg-neutral-200 dark:bg-neutral-700 flex items-center justify-center flex-shrink-0">
                                  <span className="text-[10px] font-bold text-neutral-500 dark:text-neutral-400">+</span>
                                </div>
                              ) : (
                                <img
                                  src={`https://logos.composio.dev/api/${integration.slug}`}
                                  alt={integration.name}
                                  className="w-5 h-5 object-contain flex-shrink-0"
                                  onError={e => { (e.target as HTMLImageElement).style.opacity = '0' }}
                                />
                              )}
                              <div className="flex-1 min-w-0">
                                <p className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200 truncate">{integration.name}</p>
                              </div>
                              <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', integration.connected ? 'bg-emerald-400' : 'bg-neutral-300 dark:bg-neutral-600')} />
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-3 border-t border-neutral-100 dark:border-neutral-800">
              <p className="text-[12px] text-neutral-400 dark:text-neutral-500">
                Need something else?{' '}
                <button
                  onClick={() => { onClose(); onChat?.('@integration-builder') }}
                  className="text-neutral-600 dark:text-neutral-300 hover:underline"
                >
                  Create one →
                </button>
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
