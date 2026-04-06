// apps/desktop/src/components/SettingsPane.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { AgentSettings, DayName, Autonomy, RelayUsage, UsageSummary, AdminUser } from '@coagent/shared'

type SettingsTab = 'general' | 'model' | 'brand' | 'usage' | 'admin'

/** Controlled input that syncs with server value and auto-saves on change with debounce */
function useDebouncedField(serverValue: string, onSave: (val: string) => void, delay = 600) {
  const [local, setLocal] = useState(serverValue)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedRef = useRef(serverValue)
  // Sync from server when it changes (e.g. on initial load or external update)
  useEffect(() => { savedRef.current = serverValue; setLocal(serverValue) }, [serverValue])
  const onChange = useCallback((val: string) => {
    setLocal(val)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (val !== savedRef.current) {
        savedRef.current = val
        onSave(val)
      }
    }, delay)
  }, [onSave, delay])
  // Also save immediately on blur
  const onBlur = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    if (local !== savedRef.current) {
      savedRef.current = local
      onSave(local)
    }
  }, [local, onSave])
  return { value: local, onChange, onBlur }
}

interface SettingsPaneProps {
  settings: AgentSettings | null
  onUpdate: (patch: Partial<AgentSettings>) => void
  relayActive?: boolean
  relayModel?: string | null
  onSetRelayModel?: (model: string) => void
  relayUsage?: RelayUsage | null
  onActivateRelay?: (token: string, relayUrl: string) => void
  onRefreshRelayStatus?: () => void
  onSetModel: (model: string) => void
  usage?: UsageSummary | null
  onRefreshUsage?: () => void
  isAdmin?: boolean
  adminUsers?: AdminUser[]
  adminNewToken?: { token: string; userId: string } | null
  onAdminCreateToken?: (label: string) => void
  onAdminListTokens?: () => void
  onAdminRevokeToken?: (token: string) => void
  onClearAdminNewToken?: () => void
}

// --- Shared UI ---

function SectionHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="mb-5">
      <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-0.5">{eyebrow}</p>
      <h2 className="text-[17px] font-bold tracking-tight text-neutral-900 dark:text-neutral-100">{title}</h2>
    </div>
  )
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 mb-4">
      <label className="text-[12.5px] font-medium text-neutral-600 dark:text-neutral-400">{label}</label>
      {children}
    </div>
  )
}

// --- General tab data ---

const TIMEZONES = [
  { value: '__detect__', label: 'Detect automatically' },
  { value: 'America/New_York', label: 'Eastern (ET)' },
  { value: 'America/Chicago', label: 'Central (CT)' },
  { value: 'America/Denver', label: 'Mountain (MT)' },
  { value: 'America/Phoenix', label: 'Arizona (no DST)' },
  { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
  { value: 'America/Anchorage', label: 'Alaska (AKT)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (HT)' },
]

const ALL_DAYS: DayName[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const DAY_LABELS: Record<DayName, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun'
}

function buildHourOptions() {
  const options: { value: number; label: string }[] = []
  for (let h = 0; h <= 24; h++) {
    let label: string
    if (h === 0) label = '12am'
    else if (h === 12) label = '12pm'
    else if (h === 24) label = 'midnight'
    else if (h < 12) label = `${h}am`
    else label = `${h - 12}pm`
    options.push({ value: h, label })
  }
  return options
}

const HOUR_OPTIONS = buildHourOptions()
const DETECTED_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

const AUTONOMY_OPTIONS: { value: Autonomy; label: string; description: string }[] = [
  { value: 'ask_first', label: 'Ask first', description: 'Queue almost everything for approval before acting' },
  { value: 'balanced', label: 'Balanced', description: 'Act on routine tasks automatically, queue anything that sends or edits' },
  { value: 'agent', label: 'Agent', description: 'Reads and researches freely — queues all actions unless you specifically ask' },
  { value: 'autonomous', label: 'Autonomous', description: 'May send emails and make changes without asking' },
]

// --- Model tab data ---

interface ModelOption {
  id: string
  provider: string
  label: string
  description: string
  price: string
  badge?: string
}

const MODEL_OPTIONS: ModelOption[] = [
  { id: 'kimi-k2.5', provider: 'Kimi', label: 'Kimi K2.5', description: '8x cheaper — strong reasoning, 256K context', price: '$0.60 / $2.50 per M tokens', badge: 'Default' },
  { id: 'claude-sonnet-4-6', provider: 'Anthropic', label: 'Claude Sonnet 4.6', description: 'Best quality — prompt caching saves ~60%', price: '$3 / $15 per M tokens' },
  { id: 'claude-opus-4-6', provider: 'Anthropic', label: 'Claude Opus 4.6', description: 'Most powerful — deep reasoning', price: '$15 / $75 per M tokens' },
]

function ProviderLogo({ provider, className = '' }: { provider: string; className?: string }) {
  const size = 'w-4 h-4 flex-shrink-0'
  const cls = `${size} ${className}`

  switch (provider) {
    case 'Anthropic':
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="#D97757">
          <path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z" />
        </svg>
      )
    case 'Kimi':
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="currentColor">
          <path d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z" fill="#1783FF" />
          <path d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z" />
        </svg>
      )
    default:
      return null
  }
}

// --- Tab: General ---

function GeneralTab({ settings, onUpdate }: { settings: AgentSettings; onUpdate: (patch: Partial<AgentSettings>) => void }) {
  const s = settings
  const nameField = useDebouncedField(s.name, useCallback((v: string) => onUpdate({ name: v }), [onUpdate]))
  const emailField = useDebouncedField(s.email, useCallback((v: string) => onUpdate({ email: v }), [onUpdate]))
  const roleField = useDebouncedField(s.role, useCallback((v: string) => onUpdate({ role: v }), [onUpdate]))
  const agentNameField = useDebouncedField(s.agent_name || '', useCallback((v: string) => onUpdate({ agent_name: v }), [onUpdate]))
  const instructionsField = useDebouncedField(s.custom_instructions || '', useCallback((v: string) => onUpdate({ custom_instructions: v }), [onUpdate]))
  const tzValue = TIMEZONES.find(t => t.value === s.timezone) ? s.timezone : '__detect__'

  function handleTimezoneChange(value: string) {
    if (value === '__detect__') {
      onUpdate({ timezone: DETECTED_TZ })
    } else {
      onUpdate({ timezone: value })
    }
  }

  function toggleDay(day: DayName) {
    const current = s.active_days
    if (current.includes(day) && current.length === 1) return
    const next = current.includes(day) ? current.filter(d => d !== day) : [...current, day]
    const ordered = ALL_DAYS.filter(d => next.includes(d))
    onUpdate({ active_days: ordered })
  }

  return (
    <>
      <SectionHeader eyebrow="Profile" title="About you" />
      <FieldRow label="Name">
        <Input className="text-[13.5px] dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-500" placeholder="Your name" value={nameField.value} onChange={e => nameField.onChange(e.target.value)} onBlur={nameField.onBlur} />
      </FieldRow>
      <FieldRow label="Email">
        <Input className="text-[13.5px] dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-500" placeholder="your@email.com" value={emailField.value} onChange={e => emailField.onChange(e.target.value)} onBlur={emailField.onBlur} />
      </FieldRow>
      <FieldRow label="What you do">
        <Input className="text-[13.5px] dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-500" placeholder="e.g. real estate agent, sales manager" value={roleField.value} onChange={e => roleField.onChange(e.target.value)} onBlur={roleField.onBlur} />
      </FieldRow>
      <FieldRow label="Timezone">
        <select value={tzValue} onChange={e => handleTimezoneChange(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-[13.5px] text-neutral-800 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-ring">
          {TIMEZONES.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
        </select>
      </FieldRow>

      <Separator className="my-6 dark:bg-neutral-800" />

      <SectionHeader eyebrow="Agent" title="Your agent" />
      <FieldRow label="Agent name">
        <Input className="text-[13.5px] dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-500" placeholder="e.g. Jarvis, Friday, Atlas" value={agentNameField.value} onChange={e => agentNameField.onChange(e.target.value)} onBlur={agentNameField.onBlur} />
      </FieldRow>

      <Separator className="my-6 dark:bg-neutral-800" />

      <SectionHeader eyebrow="Instructions" title="Custom instructions" />
      <FieldRow label="Tell your agent how to behave, what to prioritize, or any context it should always have">
        <textarea
          className="w-full min-h-[120px] rounded-md border border-input bg-background px-3 py-2 text-[13.5px] text-neutral-800 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-ring resize-y"
          placeholder="e.g. A good lead has $1M+ revenue and runs paid ads. Always follow up within 24 hours. Prefer email over Slack for client communication."
          value={instructionsField.value}
          onChange={e => instructionsField.onChange(e.target.value)}
          onBlur={instructionsField.onBlur}
        />
      </FieldRow>

      <Separator className="my-6 dark:bg-neutral-800" />

      <SectionHeader eyebrow="Schedule" title="Active hours" />
      <FieldRow label="Active window">
        <div className="flex items-center gap-2">
          <select value={s.active_hours.start} onChange={e => onUpdate({ active_hours: { ...s.active_hours, start: Number(e.target.value) } })} className="h-9 rounded-md border border-input bg-background px-3 py-1 text-[13.5px] text-neutral-800 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-ring">
            {HOUR_OPTIONS.filter(o => o.value < 24).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <span className="text-[13px] text-neutral-400 dark:text-neutral-500">to</span>
          <select value={s.active_hours.end} onChange={e => onUpdate({ active_hours: { ...s.active_hours, end: Number(e.target.value) } })} className="h-9 rounded-md border border-input bg-background px-3 py-1 text-[13.5px] text-neutral-800 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-ring">
            {HOUR_OPTIONS.filter(o => o.value > s.active_hours.start).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </FieldRow>
      <FieldRow label="Active days">
        <div className="flex gap-1.5 flex-wrap">
          {ALL_DAYS.map(day => {
            const active = s.active_days.includes(day)
            return (
              <button type="button" key={day} onClick={() => toggleDay(day)} className={cn(
                'px-3 py-1 rounded-full text-[12.5px] font-medium border transition-colors',
                active
                  ? 'bg-neutral-900 text-white border-neutral-900 dark:bg-neutral-100 dark:text-neutral-900 dark:border-neutral-100'
                  : 'bg-white text-neutral-500 border-neutral-300 hover:border-neutral-500 dark:bg-neutral-900 dark:text-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-500'
              )}>
                {DAY_LABELS[day]}
              </button>
            )
          })}
        </div>
      </FieldRow>
      <FieldRow label="Heartbeat interval">
        <div className="flex items-center gap-2">
          <select
            value={s.heartbeat_interval}
            onChange={e => onUpdate({ heartbeat_interval: Number(e.target.value) })}
            className="h-9 rounded-md border border-input bg-background px-3 py-1 text-[13.5px] text-neutral-800 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value={0}>Disabled</option>
            <option value={15}>Every 15 minutes</option>
            <option value={30}>Every 30 minutes</option>
            <option value={60}>Every hour</option>
            <option value={120}>Every 2 hours</option>
            <option value={240}>Every 4 hours</option>
          </select>
        </div>
        <p className="text-[11.5px] text-neutral-400 dark:text-neutral-500 mt-0.5">
          How often the agent wakes up to check to-dos, monitor services, and handle tasks.
        </p>
      </FieldRow>

      <Separator className="my-6 dark:bg-neutral-800" />

      <SectionHeader eyebrow="Behavior" title="Autonomy level" />
      <div className="flex flex-col gap-2.5">
        {AUTONOMY_OPTIONS.map(opt => {
          const selected = s.autonomy === opt.value
          return (
            <button type="button" key={opt.value} onClick={() => onUpdate({ autonomy: opt.value })} className={cn(
              'w-full text-left px-4 py-3.5 rounded-xl border transition-colors',
              selected
                ? 'border-neutral-900 bg-neutral-50 dark:border-neutral-400 dark:bg-neutral-800'
                : 'border-neutral-200 bg-white hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-600'
            )}>
              <div className="flex items-center gap-2.5 mb-0.5">
                <div className={cn('w-3.5 h-3.5 rounded-full border-2 flex-shrink-0', selected ? 'border-neutral-900 bg-neutral-900 dark:border-neutral-200 dark:bg-neutral-200' : 'border-neutral-300 dark:border-neutral-600')} />
                <span className={cn('text-[13.5px] font-semibold', selected ? 'text-neutral-900 dark:text-neutral-100' : 'text-neutral-700 dark:text-neutral-300')}>{opt.label}</span>
              </div>
              <p className="text-[12.5px] text-neutral-500 dark:text-neutral-400 ml-6">{opt.description}</p>
            </button>
          )
        })}
      </div>

      <Separator className="my-6 dark:bg-neutral-800" />

      <SectionHeader eyebrow="Voice" title="Push-to-talk" />
      <FieldRow label="Enable voice input">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onUpdate({ voice_enabled: !s.voice_enabled })}
            className={cn(
              'relative w-10 h-6 rounded-full transition-colors',
              s.voice_enabled
                ? 'bg-neutral-900 dark:bg-neutral-100'
                : 'bg-neutral-300 dark:bg-neutral-700'
            )}
          >
            <span className={cn(
              'absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white dark:bg-neutral-900 transition-transform',
              s.voice_enabled && 'translate-x-4'
            )} />
          </button>
          <span className="text-[12.5px] text-neutral-500 dark:text-neutral-400">
            Hold {s.voice_hotkey.replace('Control', 'Ctrl')} to talk
          </span>
        </div>
      </FieldRow>
      {s.voice_enabled && (
        <>
        <FieldRow label="Speak responses">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onUpdate({ voice_response: !s.voice_response })}
              className={cn(
                'relative w-10 h-6 rounded-full transition-colors',
                s.voice_response
                  ? 'bg-neutral-900 dark:bg-neutral-100'
                  : 'bg-neutral-300 dark:bg-neutral-700'
              )}
            >
              <span className={cn(
                'absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white dark:bg-neutral-900 transition-transform',
                s.voice_response && 'translate-x-4'
              )} />
            </button>
            <span className="text-[12.5px] text-neutral-500 dark:text-neutral-400">
              Uses OpenAI TTS
            </span>
          </div>
        </FieldRow>
        {s.voice_response && (<>
          <FieldRow label="Voice">
            <select
              value={s.voice_voice || 'alloy'}
              onChange={e => onUpdate({ voice_voice: e.target.value })}
              className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[13px] text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-600"
            >
              <option value="alloy">Alloy</option>
              <option value="ash">Ash</option>
              <option value="coral">Coral</option>
              <option value="echo">Echo</option>
              <option value="fable">Fable</option>
              <option value="onyx">Onyx</option>
              <option value="nova">Nova</option>
              <option value="sage">Sage</option>
              <option value="shimmer">Shimmer</option>
            </select>
          </FieldRow>
          <FieldRow label="Volume">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round((s.voice_volume ?? 0.5) * 100)}
                onChange={e => {
                  const v = parseInt(e.target.value) / 100
                  onUpdate({ voice_volume: v })
                  import('@/lib/voice').then(m => m.setTtsVolume(v))
                }}
                className="w-32 accent-neutral-500"
              />
              <span className="text-[12px] text-neutral-500 w-8">{Math.round((s.voice_volume ?? 0.5) * 100)}%</span>
            </div>
          </FieldRow>
        </>)}
        </>
      )}

    </>
  )
}


// --- Tab: Model ---

function ModelTab({ settings, onSetModel }: { settings: AgentSettings; onSetModel: (id: string) => void }) {
  const selectedModel = settings.powerModel || 'kimi-k2.5'

  return (
    <>
      <SectionHeader eyebrow="AI Model" title="Choose your model" />
      <p className="text-[13px] text-neutral-500 dark:text-neutral-400 mb-5">
        This model powers all of your agent's thinking and actions.
      </p>

      <div className="flex flex-col gap-2.5">
        {MODEL_OPTIONS.map(model => {
          const selected = selectedModel === model.id
          return (
            <button
              type="button"
              key={model.id}
              onClick={() => onSetModel(model.id)}
              className={cn(
                'w-full text-left px-4 py-3.5 rounded-xl border transition-colors',
                selected
                  ? 'border-neutral-900 bg-neutral-50 dark:border-neutral-400 dark:bg-neutral-800'
                  : 'border-neutral-200 bg-white hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-600'
              )}
            >
              <div className="flex items-center gap-2.5 mb-0.5">
                <div className={cn('w-3.5 h-3.5 rounded-full border-2 flex-shrink-0', selected ? 'border-neutral-900 bg-neutral-900 dark:border-neutral-200 dark:bg-neutral-200' : 'border-neutral-300 dark:border-neutral-600')} />
                <ProviderLogo provider={model.provider} className={selected ? 'text-neutral-700 dark:text-neutral-300' : 'text-neutral-400 dark:text-neutral-500'} />
                <span className={cn('text-[13.5px] font-semibold', selected ? 'text-neutral-900 dark:text-neutral-100' : 'text-neutral-700 dark:text-neutral-300')}>
                  {model.label}
                </span>
                {model.badge && (
                  <span className={cn(
                    'text-[10px] font-semibold px-1.5 py-0.5 rounded-full',
                    model.badge === 'Default'
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                      : 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400'
                  )}>
                    {model.badge}
                  </span>
                )}
              </div>
              <div className="ml-6 flex items-center gap-3">
                <p className="text-[12.5px] text-neutral-500 dark:text-neutral-400">{model.description}</p>
                <span className="text-[11px] text-neutral-400 dark:text-neutral-500 whitespace-nowrap">{model.price}</span>
              </div>
            </button>
          )
        })}
      </div>

    </>
  )
}

// --- Tab: Usage ---

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function UsageTab({ usage, onRefresh }: { usage: UsageSummary | null; onRefresh?: () => void }) {
  useEffect(() => { onRefresh?.() }, [onRefresh])

  if (!usage) {
    return (
      <>
        <SectionHeader eyebrow="Billing" title="Token Usage" />
        <p className="text-[13px] text-neutral-400 dark:text-neutral-500">Loading usage data...</p>
      </>
    )
  }

  const categories: { key: 'chat' | 'file_ingestion' | 'nightly_job'; label: string }[] = [
    { key: 'chat', label: 'Chat & Heartbeats' },
    { key: 'file_ingestion', label: 'File Ingestion' },
    { key: 'nightly_job', label: 'Nightly Job' },
  ]

  return (
    <>
      <SectionHeader eyebrow="Billing" title="Token Usage" />
      <p className="text-[13px] text-neutral-500 dark:text-neutral-400 mb-5">
        Estimated costs for the last 30 days. Billed at exact provider rates.
      </p>

      {/* Total cost card */}
      <div className="px-4 py-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 mb-5">
        <p className="text-[11px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-1">Estimated Total</p>
        <p className="text-[28px] font-bold text-neutral-900 dark:text-neutral-100 tracking-tight">
          ${usage.estimatedCostUsd.toFixed(2)}
        </p>
        <div className="flex gap-4 mt-2">
          <span className="text-[12px] text-neutral-500 dark:text-neutral-400">{formatTokens(usage.totalInputTokens)} input</span>
          <span className="text-[12px] text-neutral-500 dark:text-neutral-400">{formatTokens(usage.totalOutputTokens)} output</span>
          {usage.totalCacheReadTokens > 0 && (
            <span className="text-[12px] text-emerald-600 dark:text-emerald-400">{formatTokens(usage.totalCacheReadTokens)} cached</span>
          )}
        </div>
      </div>

      {/* Breakdown by category */}
      <SectionHeader eyebrow="Breakdown" title="By category" />
      <div className="flex flex-col gap-2.5">
        {categories.map(({ key, label }) => {
          const cat = usage.byCategory[key]
          const totalTokens = cat.inputTokens + cat.outputTokens
          if (totalTokens === 0) return null
          return (
            <div key={key} className="px-4 py-3 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">{label}</span>
                <span className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">${cat.costUsd.toFixed(2)}</span>
              </div>
              <div className="flex gap-4">
                <span className="text-[12px] text-neutral-400 dark:text-neutral-500">{formatTokens(cat.inputTokens)} in</span>
                <span className="text-[12px] text-neutral-400 dark:text-neutral-500">{formatTokens(cat.outputTokens)} out</span>
                {cat.cacheReadTokens > 0 && (
                  <span className="text-[12px] text-emerald-600 dark:text-emerald-400">{formatTokens(cat.cacheReadTokens)} cached</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

// --- Tab: Admin ---

function AdminTab({
  users,
  newToken,
  onCreateToken,
  onListTokens,
  onRevokeToken,
  onClearNewToken,
}: {
  users: AdminUser[]
  newToken: { token: string; userId: string } | null
  onCreateToken: (label: string) => void
  onListTokens: () => void
  onRevokeToken: (token: string) => void
  onClearNewToken: () => void
}) {
  const [label, setLabel] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => { onListTokens() }, [onListTokens])

  function handleGenerate() {
    if (!label.trim()) return
    onCreateToken(label.trim())
    setLabel('')
  }

  function handleCopy(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <>
      <SectionHeader eyebrow="Admin" title="Relay tokens" />
      <p className="text-[13px] text-neutral-500 dark:text-neutral-400 mb-5">
        Create tokens for other users to connect their agent to your relay.
      </p>

      {/* Create token */}
      <div className="px-4 py-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 mb-5">
        <p className="text-[12px] font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-widest mb-3">Create token</p>
        <div className="flex gap-2">
          <Input
            className="text-[13.5px] dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-500"
            placeholder="Label (e.g. Alice's agent)"
            value={label}
            onChange={e => setLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleGenerate() }}
          />
          <button
            type="button"
            onClick={handleGenerate}
            disabled={!label.trim()}
            className="px-4 py-2 rounded-lg text-[13px] font-semibold bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 disabled:opacity-40 hover:opacity-90 transition-opacity flex-shrink-0"
          >
            Generate
          </button>
        </div>

        {newToken && (
          <div className="mt-3 flex items-center gap-2">
            <div className="flex-1 font-mono text-[12px] px-3 py-2 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 truncate select-all">
              {newToken.token}
            </div>
            <button
              type="button"
              onClick={() => handleCopy(newToken.token)}
              className="px-3 py-2 rounded-lg text-[12px] font-semibold border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors flex-shrink-0"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={onClearNewToken}
              className="px-2 py-2 rounded-lg text-[12px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Users table */}
      <SectionHeader eyebrow="Users" title="Active tokens" />
      {users.length === 0 ? (
        <p className="text-[13px] text-neutral-400 dark:text-neutral-500">No tokens yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {users.map(user => (
            <div
              key={user.token}
              className="px-4 py-3 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100 truncate">
                      {user.label || user.userId}
                    </span>
                    <span className={cn(
                      'text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0',
                      user.active
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                        : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
                    )}>
                      {user.active ? 'Active' : 'Revoked'}
                    </span>
                  </div>
                  <div className="flex gap-3 text-[11.5px] text-neutral-400 dark:text-neutral-500">
                    <span>{user.userId}</span>
                    {user.costUsd > 0 && <span>${user.costUsd.toFixed(2)}</span>}
                    <span>{new Date(user.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onRevokeToken(user.token)}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-[12px] font-medium border transition-colors flex-shrink-0',
                    user.active
                      ? 'border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800'
                      : 'border-neutral-200 dark:border-neutral-700 text-emerald-600 dark:text-emerald-400 hover:bg-neutral-50 dark:hover:bg-neutral-800'
                  )}
                >
                  {user.active ? 'Revoke' : 'Activate'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// --- Brand tab ---

function BrandTab({ settings, onUpdate }: { settings: AgentSettings; onUpdate: (patch: Partial<AgentSettings>) => void }) {
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  // Optimistic local preview so logo appears immediately (before server roundtrip)
  const [localLogo, setLocalLogo] = useState<string | null>(null)
  const logoSrc = localLogo ?? settings.brand_logo
  // Clear local preview once server confirms (settings.brand_logo matches)
  useEffect(() => {
    if (localLogo && settings.brand_logo === localLogo) setLocalLogo(null)
  }, [settings.brand_logo, localLogo])

  const handleLogoFile = (file: File) => {
    if (!file.type.startsWith('image/')) return
    if (file.size > 2 * 1024 * 1024) return // 2MB limit
    setUploading(true)
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setLocalLogo(reader.result)
        onUpdate({ brand_logo: reader.result })
      }
      setUploading(false)
    }
    reader.onerror = () => setUploading(false)
    reader.readAsDataURL(file)
  }

  return (
    <>
      <SectionHeader eyebrow="Branding" title="Brand Kit" />
      <p className="text-[12px] text-neutral-500 dark:text-neutral-400 mb-5 -mt-2">
        Applied automatically to all generated documents.
      </p>

      <FieldRow label="Company Name">
        <Input
          value={settings.brand_company}
          onChange={e => onUpdate({ brand_company: e.target.value })}
          placeholder="Acme Corp"
          className="text-[13px] h-9"
        />
      </FieldRow>

      <FieldRow label="Accent Color">
        <div className="flex items-center gap-3">
          <input
            type="color"
            value={settings.brand_color || '#1a2744'}
            onChange={e => onUpdate({ brand_color: e.target.value })}
            className="w-9 h-9 rounded-lg border border-neutral-200 dark:border-neutral-700 cursor-pointer p-0.5 bg-transparent"
          />
          <Input
            value={settings.brand_color}
            onChange={e => {
              const v = e.target.value
              if (/^#[0-9a-fA-F]{0,6}$/.test(v) || v === '') onUpdate({ brand_color: v })
            }}
            placeholder="#1a2744"
            className="text-[13px] h-9 w-32 font-mono"
          />
          {settings.brand_color && (
            <button
              type="button"
              onClick={() => onUpdate({ brand_color: '' })}
              className="text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              Reset
            </button>
          )}
        </div>
      </FieldRow>

      <FieldRow label="Logo">
        {logoSrc ? (
          <div className="flex items-center gap-4">
            <div className="w-20 h-20 rounded-lg border border-neutral-200 dark:border-neutral-700 flex items-center justify-center bg-neutral-50 dark:bg-neutral-900 overflow-hidden p-2">
              <img src={logoSrc} alt="Logo" className="max-w-full max-h-full object-contain" />
            </div>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  const input = document.createElement('input')
                  input.type = 'file'
                  input.accept = 'image/png,image/jpeg,image/svg+xml'
                  input.onchange = () => {
                    const file = input.files?.[0]
                    if (file) handleLogoFile(file)
                  }
                  input.click()
                }}
                className="px-3 py-1.5 rounded-lg text-[12px] font-medium border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
              >
                Change
              </button>
              <button
                type="button"
                onClick={() => { setLocalLogo(null); onUpdate({ brand_logo: '' }) }}
                className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => {
              e.preventDefault()
              setDragOver(false)
              const file = e.dataTransfer.files?.[0]
              if (file) handleLogoFile(file)
            }}
            onClick={() => {
              const input = document.createElement('input')
              input.type = 'file'
              input.accept = 'image/png,image/jpeg,image/svg+xml'
              input.onchange = () => {
                const file = input.files?.[0]
                if (file) handleLogoFile(file)
              }
              input.click()
            }}
            className={cn(
              'w-full h-24 rounded-lg border-2 border-dashed flex flex-col items-center justify-center cursor-pointer transition-colors',
              uploading
                ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/20'
                : dragOver
                  ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/20'
                  : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600'
            )}
          >
            {uploading ? (
              <span className="text-[12px] text-blue-500">Uploading…</span>
            ) : (
              <>
                <span className="text-[12px] text-neutral-400 dark:text-neutral-500">
                  Drop logo here or click to upload
                </span>
                <span className="text-[10px] text-neutral-300 dark:text-neutral-600 mt-1">
                  PNG, JPEG, or SVG — max 2MB
                </span>
              </>
            )}
          </div>
        )}
      </FieldRow>

      {/* Preview */}
      {(settings.brand_company || settings.brand_color || logoSrc) && (
        <>
          <Separator className="my-5" />
          <p className="text-[11px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-3">Preview</p>
          <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 p-5 bg-white dark:bg-neutral-900">
            {logoSrc && (
              <img src={logoSrc} alt="" className="h-8 mb-3 object-contain" />
            )}
            <div
              className="h-1 rounded-full mb-3"
              style={{ backgroundColor: settings.brand_color || '#1a2744', width: '100%' }}
            />
            <h3
              className="text-[16px] font-bold mb-1"
              style={{ color: settings.brand_color || '#1a2744' }}
            >
              Sample Document Title
            </h3>
            <p className="text-[11px] text-neutral-500">
              This is how your branded documents will look.
            </p>
            {settings.brand_company && (
              <p className="text-[10px] text-neutral-400 mt-4 pt-2 border-t border-neutral-100 dark:border-neutral-800">
                {settings.brand_company}
              </p>
            )}
          </div>
        </>
      )}
    </>
  )
}

// --- Main ---

const BASE_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'model', label: 'Model' },
  { id: 'brand', label: 'Brand' },
  { id: 'usage', label: 'Usage' },
]

export function SettingsPane({ settings, onUpdate, onSetModel, usage, onRefreshUsage, isAdmin, adminUsers, adminNewToken, onAdminCreateToken, onAdminListTokens, onAdminRevokeToken, onClearAdminNewToken, relayActive, onActivateRelay }: SettingsPaneProps) {
  const [tab, setTab] = useState<SettingsTab>('general')
  const TABS = isAdmin ? [...BASE_TABS, { id: 'admin' as SettingsTab, label: 'Admin' }] : BASE_TABS

  if (!settings) {
    return (
      <div className="flex-1 bg-white dark:bg-neutral-950 flex items-center justify-center">
        <span className="text-[13px] text-neutral-400 dark:text-neutral-500">Loading settings…</span>
      </div>
    )
  }

  return (
    <div className="flex-1 bg-white dark:bg-neutral-950 flex flex-col">
      {/* Sub-nav pills */}
      <div className="px-8 pt-6 pb-0">
        <div className="flex gap-1 p-1 bg-neutral-100 dark:bg-neutral-900 rounded-lg w-fit">
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'px-4 py-1.5 rounded-md text-[12.5px] font-medium transition-colors',
                tab === t.id
                  ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-800 dark:text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-300'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <ScrollArea className="flex-1">
        <div className="px-8 py-6 max-w-xl">
          {tab === 'general' && <GeneralTab settings={settings} onUpdate={onUpdate} />}
          {tab === 'model' && <ModelTab settings={settings} onSetModel={onSetModel} />}
          {tab === 'brand' && <BrandTab settings={settings} onUpdate={onUpdate} />}
          {tab === 'usage' && <UsageTab usage={usage ?? null} onRefresh={onRefreshUsage} />}
          {tab === 'admin' && isAdmin && (
            <AdminTab
              users={adminUsers ?? []}
              newToken={adminNewToken ?? null}
              onCreateToken={onAdminCreateToken ?? (() => {})}
              onListTokens={onAdminListTokens ?? (() => {})}
              onRevokeToken={onAdminRevokeToken ?? (() => {})}
              onClearNewToken={onClearAdminNewToken ?? (() => {})}
            />
          )}
          <div className="h-8" />
        </div>
      </ScrollArea>
    </div>
  )
}
