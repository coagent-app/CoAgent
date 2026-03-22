import React, { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { INTEGRATION_DESCRIPTIONS } from '@/lib/integrationIcons'
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

  // Reset field values when pending fields change
  useEffect(() => {
    if (pendingFields) {
      const initial: Record<string, string> = {}
      for (const f of pendingFields.fields) initial[f.name] = ''
      setFieldValues(initial)
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

  useEffect(() => {
    if (!open) { setSearch(''); return }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (pendingFields) { handleCancelFields() }
        else { onClose() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, pendingFields])

  if (!open) return null

  const filtered = integrations.filter(i =>
    i.name.toLowerCase().includes(search.toLowerCase())
  )

  const pendingName = pendingFields ? integrations.find(i => i.slug === pendingFields.slug)?.name ?? pendingFields.slug : ''

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-neutral-900 rounded-2xl shadow-xl w-[820px] max-h-[700px] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-neutral-100 dark:border-neutral-800">
          <h2 className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">Integrations</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Dynamic fields prompt */}
        {pendingFields && (
          <div className="px-6 py-4 border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800">
            <p className="text-[12.5px] font-medium text-neutral-700 dark:text-neutral-300 mb-2">Connect {pendingName}</p>
            <div className="flex flex-col gap-2">
              {pendingFields.fields.map((field, i) => (
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
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleFieldSubmit}
                  className="text-[12px] font-medium px-3 py-2 rounded-lg bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 transition-colors"
                >
                  Connect
                </button>
                <button
                  type="button"
                  onClick={handleCancelFields}
                  className="text-[12px] font-medium px-3 py-2 rounded-lg text-neutral-500 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700 transition-colors"
                >
                  Cancel
                </button>
              </div>
              {pendingFields.fields.length > 0 && (
                <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
                  {pendingFields.fields.map(f => f.description).join('. ')}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Search */}
        <div className="px-6 py-3 border-b border-neutral-100 dark:border-neutral-800">
          <input
            autoFocus={!pendingFields}
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
            <div className="grid grid-cols-3 gap-2">
              {filtered.map(integration => {
                return (
                  <div
                    key={integration.slug}
                    className="flex items-center gap-3 p-3 rounded-xl border border-neutral-100 dark:border-neutral-800 hover:border-neutral-200 dark:hover:border-neutral-700 transition-colors"
                  >
                    <img
                      src={`https://logos.composio.dev/api/${integration.slug}`}
                      alt={integration.name}
                      className="w-5 h-5 object-contain flex-shrink-0"
                      onError={e => { (e.target as HTMLImageElement).style.opacity = '0' }}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200 truncate">{integration.name}</p>
                      {INTEGRATION_DESCRIPTIONS[integration.slug] && (
                        <p className="text-[11px] text-neutral-400 dark:text-neutral-500 truncate">{INTEGRATION_DESCRIPTIONS[integration.slug]}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={cn('w-1.5 h-1.5 rounded-full', integration.connected ? 'bg-emerald-400' : 'bg-neutral-300 dark:bg-neutral-600')} />
                      <button
                        onClick={() => integration.connected ? onDisconnect(integration.slug) : handleConnect(integration.slug)}
                        className={cn(
                          'text-[11px] font-medium px-2.5 py-1 rounded-lg transition-colors',
                          integration.connected
                            ? 'text-neutral-500 hover:text-red-500 hover:bg-red-50 dark:text-neutral-400 dark:hover:text-red-400 dark:hover:bg-red-950'
                            : 'text-neutral-600 bg-neutral-100 hover:bg-neutral-200 dark:text-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700'
                        )}
                      >
                        {integration.connected ? 'Disconnect' : 'Connect'}
                      </button>
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
      </div>
    </div>
  )
}
