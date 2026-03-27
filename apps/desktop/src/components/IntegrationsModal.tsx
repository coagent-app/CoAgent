import React, { useEffect, useState } from 'react'
import { X, ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Integration } from '@coagent/shared'

interface PendingFields {
  slug: string
  fields: { name: string; displayName: string; description: string }[]
}

interface IntegrationsModalProps {
  open: boolean
  onClose: () => void
  integrations: Integration[]
  onConnect: (slug: string, params?: Record<string, string>) => void
  onDisconnect: (slug: string) => void
  pendingFields: PendingFields | null
  onClearPendingFields: () => void
}

export function IntegrationsModal({ open, onClose, integrations, onConnect, onDisconnect, pendingFields, onClearPendingFields }: IntegrationsModalProps) {
  const [search, setSearch] = useState('')
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [detailSlug, setDetailSlug] = useState<string | null>(null)

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

  const filtered = integrations.filter(i =>
    i.name.toLowerCase().includes(search.toLowerCase())
  )

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
                  <img
                    src={`https://logos.composio.dev/api/${detailIntegration.slug}`}
                    alt={detailIntegration.name}
                    className="w-6 h-6 object-contain"
                    onError={e => { (e.target as HTMLImageElement).style.opacity = '0' }}
                  />
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

              {/* Pending fields (shown inline in detail view) */}
              {detailPendingFields && detailPendingFields.fields.length > 0 && (
                <div className="mb-5 p-4 rounded-xl border border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800">
                  <p className="text-[12px] font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider mb-3">Required credentials</p>
                  <div className="flex flex-col gap-2">
                    {detailPendingFields.fields.map((field, i) => (
                      <input
                        key={field.name}
                        autoFocus={i === 0}
                        type="text"
                        placeholder={field.displayName}
                        title={field.description}
                        value={fieldValues[field.name] ?? ''}
                        onChange={e => setFieldValues(prev => ({ ...prev, [field.name]: e.target.value }))}
                        onKeyDown={e => e.key === 'Enter' && handleFieldSubmit()}
                        className="text-[13px] px-3 py-2 border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-900 outline-none focus:border-neutral-400 dark:focus:border-neutral-500 transition-colors text-neutral-800 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500"
                      />
                    ))}
                    {detailPendingFields.fields.length > 0 && (
                      <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
                        {detailPendingFields.fields.map(f => f.description).join('. ')}
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

                <div className="flex items-center gap-1.5 ml-1">
                  <span className={cn('w-1.5 h-1.5 rounded-full', detailIntegration.connected ? 'bg-emerald-400' : 'bg-neutral-300 dark:bg-neutral-600')} />
                  <span className="text-[12px] text-neutral-400 dark:text-neutral-500">
                    {detailIntegration.connected ? 'Connected' : 'Not connected'}
                  </span>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-3 border-t border-neutral-100 dark:border-neutral-800">
              <p className="text-[12px] text-neutral-400 dark:text-neutral-500">
                Need something else?{' '}
                <a
                  href="https://github.com/brettponters/coagent/issues"
                  target="_blank"
                  rel="noreferrer"
                  className="text-neutral-600 dark:text-neutral-300 hover:underline"
                >
                  Request an integration →
                </a>
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
                  {[...grouped.entries()].map(([category, items]) => (
                    <div key={category}>
                      <p className="text-[11px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider mb-2">{category}</p>
                      <div className="grid grid-cols-3 gap-2">
                        {items.map(integration => (
                          <button
                            key={integration.slug}
                            type="button"
                            onClick={() => setDetailSlug(integration.slug)}
                            className="flex items-center gap-3 p-3 rounded-xl border border-neutral-100 dark:border-neutral-800 hover:border-neutral-200 dark:hover:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors text-left w-full"
                          >
                            <img
                              src={`https://logos.composio.dev/api/${integration.slug}`}
                              alt={integration.name}
                              className="w-5 h-5 object-contain flex-shrink-0"
                              onError={e => { (e.target as HTMLImageElement).style.opacity = '0' }}
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200 truncate">{integration.name}</p>
                            </div>
                            <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', integration.connected ? 'bg-emerald-400' : 'bg-neutral-300 dark:bg-neutral-600')} />
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-3 border-t border-neutral-100 dark:border-neutral-800">
              <p className="text-[12px] text-neutral-400 dark:text-neutral-500">
                Need something else?{' '}
                <a
                  href="https://github.com/brettponters/coagent/issues"
                  target="_blank"
                  rel="noreferrer"
                  className="text-neutral-600 dark:text-neutral-300 hover:underline"
                >
                  Request an integration →
                </a>
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
