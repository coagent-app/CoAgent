import React, { useState } from 'react'
import { Sparkles, MessageSquare, ArrowRight, Moon, Plug, Search, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentSettings, Integration } from '@coagent/shared'

const MIN_CONNECTIONS = 3

interface PendingFields {
  slug: string
  fields: { name: string; displayName: string; description: string; helpUrl?: string; helpText?: string }[]
}

interface OnboardingTourProps {
  settings: AgentSettings | null
  onUpdate: (patch: Partial<AgentSettings>) => void
  onOpenIntegrations: () => void
  onNavigate: (view: string) => void
  onActivate?: (token: string, relayUrl: string) => void
  onEnableWakeScheduling?: () => void
  hasRelay?: boolean
  setTourDone: (done: boolean) => void
  integrations?: Integration[]
  onConnect?: (slug: string, params?: Record<string, string>) => void
  pendingFields?: PendingFields | null
  onClearPendingFields?: () => void
}

type Step = 'welcome' | 'wake' | 'integrations'

// ── Integration icon renderer ─────────────────────────────────────────────────

function IntegrationIcon({ integration, size = 5 }: { integration: Integration; size?: number }) {
  const cls = `w-${size} h-${size} flex-shrink-0`

  if (integration.slug === 'coagent:whatsapp') return (
    <svg className={cls} viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="7" fill="#25D366"/>
      <path d="M16 7.5c-4.694 0-8.5 3.806-8.5 8.5 0 1.497.39 2.9 1.07 4.115L7.5 24.5l4.55-1.02A8.46 8.46 0 0016 24.5c4.694 0 8.5-3.806 8.5-8.5s-3.806-8.5-8.5-8.5zm4.15 11.47c-.175.49-.875.897-1.225.955-.35.058-.79.082-1.275-.08-.295-.1-.675-.232-1.16-.455-2.04-.935-3.375-2.99-3.475-3.13-.1-.14-.82-1.09-.82-2.08s.52-1.475.705-1.675c.185-.2.405-.25.54-.25h.39c.125 0 .295-.047.46.35.175.42.59 1.44.64 1.545.05.105.085.23.017.37-.068.14-.1.227-.2.35-.1.122-.21.273-.3.367-.1.1-.205.21-.088.41.117.2.52.855 1.115 1.385.765.68 1.41.89 1.61.99.2.1.315.085.43-.05.115-.135.49-.57.62-.765.13-.195.26-.163.44-.098.18.065 1.14.537 1.335.635.195.098.325.147.375.23.05.082.05.478-.125.968z" fill="white"/>
    </svg>
  )
  if (integration.slug === 'coagent:imessage') return (
    <svg className={cls} viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="7" fill="#34C759"/>
      <path d="M16 7C10.477 7 6 10.582 6 15c0 2.52 1.537 4.768 3.938 6.254-.204 1.48-.89 2.87-.89 2.87s2.47-.354 4.072-1.372C14.05 23.23 15 23.35 16 23.35c5.523 0 10-3.582 10-7.35S21.523 7 16 7z" fill="white"/>
    </svg>
  )
  if (integration.slug === 'coagent:contacts') return (
    <svg className={cls} viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="7" fill="#A2845E"/>
      <circle cx="16" cy="13" r="4.5" fill="white"/>
      <path d="M8.5 24.5c0-4.142 3.358-7.5 7.5-7.5s7.5 3.358 7.5 7.5" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
    </svg>
  )
  if (integration.slug === 'coagent:mobile') return (
    <svg className={cls} viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="7" fill="#1C1C1E"/>
      <rect x="11" y="6" width="10" height="20" rx="2" stroke="white" strokeWidth="1.5" fill="none"/>
      <circle cx="16" cy="23" r="1" fill="white"/>
    </svg>
  )
  if (integration.domain) return (
    <img
      src={`https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${integration.domain}&size=128`}
      alt={integration.name}
      className={cn(cls, 'object-contain rounded-sm')}
      onError={e => { (e.target as HTMLImageElement).style.opacity = '0' }}
    />
  )
  if (integration.icon) return (
    <img src={`data:image/svg+xml;utf8,${encodeURIComponent(integration.icon)}`} className={cls} alt={integration.name} />
  )
  if (integration.custom) return (
    <div className={cn(cls, 'rounded bg-neutral-200 dark:bg-neutral-700 flex items-center justify-center')}>
      <span className="text-[10px] font-bold text-neutral-500 dark:text-neutral-400">+</span>
    </div>
  )
  return (
    <img
      src={`https://logos.composio.dev/api/${integration.slug}`}
      alt={integration.name}
      className={cn(cls, 'object-contain')}
      onError={e => { (e.target as HTMLImageElement).style.opacity = '0' }}
    />
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function OnboardingTour({ settings, onUpdate, onOpenIntegrations, onNavigate, onActivate, onEnableWakeScheduling, hasRelay, setTourDone, integrations, onConnect, pendingFields, onClearPendingFields }: OnboardingTourProps) {
  const [activationCode, setActivationCode] = useState('')
  const [activationError, setActivationError] = useState('')
  const [activating, setActivating] = useState(false)
  const [step, setStep] = useState<Step>('welcome')
  const [search, setSearch] = useState('')
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [connecting, setConnecting] = useState<string | null>(null)

  const connectedCount = integrations?.filter(i => i.connected).length ?? 0
  const canContinue = connectedCount >= MIN_CONNECTIONS

  function finish() {
    setTourDone(true)
    onNavigate('chat')
  }

  const isMac = navigator.platform?.toLowerCase().includes('mac')

  function advanceFromWelcome() {
    if (isMac) setStep('wake')
    else setStep('integrations')
  }

  function advanceFromWake() {
    setStep('integrations')
  }

  function handleConnect(slug: string) {
    setConnecting(slug)
    onConnect?.(slug)
  }

  function handleFieldSubmit() {
    if (!pendingFields) return
    const allFilled = pendingFields.fields.every(f => fieldValues[f.name]?.trim())
    if (!allFilled) return
    onConnect?.(pendingFields.slug, fieldValues)
    setFieldValues({})
  }

  // Filter integrations for the grid
  const allIntegrations = integrations ?? []
  const filtered = search
    ? allIntegrations.filter(i => {
        const q = search.toLowerCase()
        return i.name.toLowerCase().includes(q) ||
          i.slug.toLowerCase().includes(q) ||
          (i.category?.toLowerCase().includes(q) ?? false)
      })
    : allIntegrations

  // Group by category
  const grouped = new Map<string, Integration[]>()
  for (const i of filtered) {
    const cat = i.category || 'Other'
    if (!grouped.has(cat)) grouped.set(cat, [])
    grouped.get(cat)!.push(i)
  }
  for (const items of grouped.values()) {
    items.sort((a, b) => {
      // Connected first
      if (a.connected && !b.connected) return -1
      if (!a.connected && b.connected) return 1
      return a.name.localeCompare(b.name)
    })
  }
  const sortedCategories = [...grouped.keys()].sort((a, b) => {
    if (a === 'CoAgent') return -1
    if (b === 'CoAgent') return 1
    return a.localeCompare(b)
  })

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50 dark:bg-black/60" />

      <div className="fixed inset-0 z-50 flex items-center justify-center">
        {/* Wider modal for integrations step */}
        <div className={cn(
          'bg-white dark:bg-neutral-900 rounded-2xl shadow-2xl overflow-hidden transition-all duration-300',
          step === 'integrations' ? 'w-[680px] max-h-[85vh] flex flex-col' : 'w-[420px]'
        )}>
          {step === 'welcome' && (
            <div className="p-8 text-center">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-neutral-800 to-neutral-950 dark:from-neutral-100 dark:to-neutral-300 flex items-center justify-center mx-auto mb-5 shadow-lg">
                <Sparkles className="w-8 h-8 text-white dark:text-neutral-900" />
              </div>
              <h2 className="text-[22px] font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
                Welcome to Co-Agent
              </h2>
              <p className="text-[13px] text-neutral-400 dark:text-neutral-500 mb-1">
                Private Beta
              </p>
              <p className="text-[14px] text-neutral-500 dark:text-neutral-400 leading-relaxed mb-6">
                Your personal AI operator that runs privately on your machine. Connect your apps, and it handles the rest.
              </p>

              {!hasRelay ? (
                <div className="text-left">
                  <input
                    type="text"
                    value={activationCode}
                    onChange={e => { setActivationCode(e.target.value); setActivationError('') }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && activationCode.trim()) {
                        setActivating(true)
                        onActivate?.(activationCode.trim(), (import.meta.env.VITE_RELAY_URL as string))
                        setTimeout(() => setActivating(false), 3000)
                      }
                    }}
                    placeholder="Enter your activation code"
                    className="w-full px-4 py-3 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 text-[14px] text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-600 mb-3"
                    autoFocus
                  />
                  {activationError && <p className="text-[12px] text-red-500 mb-3">{activationError}</p>}
                  <button
                    onClick={() => {
                      if (!activationCode.trim()) { setActivationError('Enter your activation code'); return }
                      setActivating(true)
                      onActivate?.(activationCode.trim(), (import.meta.env.VITE_RELAY_URL as string))
                      setTimeout(() => setActivating(false), 3000)
                    }}
                    disabled={activating}
                    className="w-full py-2.5 rounded-xl bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[14px] font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {activating ? 'Activating...' : 'Activate'}
                  </button>
                </div>
              ) : (
                <button
                  onClick={advanceFromWelcome}
                  className="w-full py-2.5 rounded-xl bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[14px] font-medium hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
                >
                  <MessageSquare className="w-4 h-4" />
                  Continue
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}
            </div>
          )}

          {step === 'wake' && (
            <div className="p-8 text-center">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center mx-auto mb-5 shadow-lg">
                <Moon className="w-8 h-8 text-white" />
              </div>
              <h2 className="text-[22px] font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
                Background scheduling
              </h2>
              <p className="text-[14px] text-neutral-500 dark:text-neutral-400 leading-relaxed mb-4">
                Co-Agent runs background checks on your email, calendar, and tasks even when your Mac is asleep. This requires a one-time admin password to allow scheduled wake-ups.
              </p>
              <p className="text-[12px] text-neutral-400 dark:text-neutral-500 mb-6">
                This only grants permission for wake scheduling — nothing else is modified on your system.
              </p>
              <button
                onClick={() => { onEnableWakeScheduling?.(); advanceFromWake() }}
                className="w-full py-2.5 rounded-xl bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[14px] font-medium hover:opacity-90 transition-opacity mb-2"
              >
                Enable background scheduling
              </button>
              <button
                onClick={advanceFromWake}
                className="w-full py-2.5 rounded-xl text-neutral-400 dark:text-neutral-500 text-[13px] hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
              >
                Skip for now
              </button>
            </div>
          )}

          {step === 'integrations' && (
            <>
              {/* Header */}
              <div className="px-6 pt-5 pb-4 border-b border-neutral-100 dark:border-neutral-800">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h2 className="text-[17px] font-semibold text-neutral-900 dark:text-neutral-100">
                      Connect your apps
                    </h2>
                    <p className="text-[13px] text-neutral-400 dark:text-neutral-500 mt-0.5">
                      Connect at least {MIN_CONNECTIONS} apps to get started
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {/* Progress dots */}
                    {Array.from({ length: MIN_CONNECTIONS }).map((_, i) => (
                      <div
                        key={i}
                        className={cn(
                          'w-2.5 h-2.5 rounded-full transition-colors',
                          i < connectedCount ? 'bg-emerald-400' : 'bg-neutral-200 dark:bg-neutral-700'
                        )}
                      />
                    ))}
                    {connectedCount > MIN_CONNECTIONS && (
                      <span className="text-[11px] text-emerald-500 font-medium ml-0.5">+{connectedCount - MIN_CONNECTIONS}</span>
                    )}
                  </div>
                </div>

                {/* Search */}
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-neutral-400 dark:text-neutral-500" />
                  <input
                    type="text"
                    placeholder="Search integrations..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="w-full text-[13px] bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg pl-9 pr-3 py-2 outline-none focus:border-neutral-400 dark:focus:border-neutral-500 transition-colors text-neutral-800 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500"
                  />
                </div>
              </div>

              {/* Inline credential form */}
              {pendingFields && pendingFields.fields.length > 0 && (
                <div className="px-6 py-3 border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50">
                  <p className="text-[13px] font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                    Enter credentials for {allIntegrations.find(i => i.slug === pendingFields.slug)?.name ?? pendingFields.slug}
                  </p>
                  {pendingFields.fields.map(f => (
                    <div key={f.name} className="mb-2">
                      <label className="block text-[12px] font-medium text-neutral-500 dark:text-neutral-400 mb-1">{f.displayName}</label>
                      <input
                        type="password"
                        value={fieldValues[f.name] || ''}
                        onChange={e => setFieldValues(v => ({ ...v, [f.name]: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter') handleFieldSubmit() }}
                        placeholder={f.displayName}
                        className="w-full px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[13px] text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-600"
                      />
                      {f.helpUrl && (
                        <a href={f.helpUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-500 hover:underline mt-1 inline-block">
                          {f.helpText || 'Get your key'}
                        </a>
                      )}
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <button
                      onClick={handleFieldSubmit}
                      disabled={!pendingFields.fields.every(f => fieldValues[f.name]?.trim())}
                      className="px-4 py-1.5 rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[13px] font-medium hover:opacity-90 disabled:opacity-40"
                    >
                      Connect
                    </button>
                    <button
                      onClick={() => { onClearPendingFields?.(); setFieldValues({}) }}
                      className="px-4 py-1.5 rounded-lg text-neutral-500 text-[13px] hover:bg-neutral-100 dark:hover:bg-neutral-700"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Integration grid */}
              <div className="overflow-y-auto flex-1 px-6 py-4">
                {filtered.length === 0 ? (
                  <p className="text-[13px] text-neutral-400 dark:text-neutral-500 text-center py-8">No integrations found.</p>
                ) : (
                  <div className="flex flex-col gap-4">
                    {sortedCategories.map(category => {
                      const items = grouped.get(category)!
                      return (
                        <div key={category}>
                          <div className="flex items-center gap-2 mb-2">
                            <p className="text-[11px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">{category}</p>
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-400 dark:text-neutral-500">{items.length}</span>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            {items.map(integration => (
                              <div
                                key={integration.slug}
                                className={cn(
                                  'flex items-center gap-3 p-3 rounded-xl border transition-colors',
                                  integration.connected
                                    ? 'border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/60 dark:bg-emerald-950/30'
                                    : 'border-neutral-100 dark:border-neutral-800 hover:border-neutral-200 dark:hover:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800/50'
                                )}
                              >
                                <IntegrationIcon integration={integration} />
                                <div className="flex-1 min-w-0">
                                  <p className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200 truncate">{integration.name}</p>
                                </div>
                                {integration.connected ? (
                                  <span className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium flex-shrink-0">
                                    <Check className="w-3 h-3" />
                                    Connected
                                  </span>
                                ) : (
                                  <button
                                    onClick={() => handleConnect(integration.slug)}
                                    className="text-[12px] font-medium px-3 py-1 rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:opacity-90 transition-opacity flex-shrink-0"
                                  >
                                    Connect
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="px-6 py-4 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
                <p className="text-[13px] text-neutral-500 dark:text-neutral-400">
                  {connectedCount < MIN_CONNECTIONS
                    ? `${MIN_CONNECTIONS - connectedCount} more to go`
                    : `${connectedCount} app${connectedCount !== 1 ? 's' : ''} connected`
                  }
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={finish}
                    className="text-[13px] text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
                  >
                    Skip for now
                  </button>
                  <button
                    onClick={finish}
                    disabled={!canContinue}
                    className={cn(
                      'px-5 py-2 rounded-xl text-[14px] font-medium transition-all flex items-center gap-2',
                      canContinue
                        ? 'bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:opacity-90'
                        : 'bg-neutral-200 dark:bg-neutral-800 text-neutral-400 dark:text-neutral-600 cursor-not-allowed'
                    )}
                  >
                    Continue
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
