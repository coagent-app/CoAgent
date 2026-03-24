// apps/desktop/src/components/SettingsPane.tsx
import React, { useState, useEffect } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { AgentSettings, DayName, Autonomy, RelayUsage } from '@coagent/shared'

type SettingsTab = 'general' | 'model' | 'keys'

interface SettingsPaneProps {
  settings: AgentSettings | null
  onUpdate: (patch: Partial<AgentSettings>) => void
  relayActive?: boolean
  relayModel?: string | null
  onSetRelayModel?: (model: string) => void
  relayUsage?: RelayUsage | null
  onActivateRelay?: (token: string, relayUrl: string) => void
  onRefreshRelayStatus?: () => void
  apiKeyStatus: { anthropic: boolean; composio: boolean; openai: boolean } | null
  onUpdateApiKeys: (keys: { anthropic?: string; composio?: string; openai?: string }) => void
  onSetModel: (model: string) => void
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
  { value: 'autonomous', label: 'Autonomous', description: 'May send emails and make changes without asking' },
]

// --- Model tab data ---

interface ModelOption {
  id: string
  provider: string
  label: string
  description: string
  badge?: string
}

const MODEL_OPTIONS: ModelOption[] = [
  { id: 'claude-opus-4-6', provider: 'Anthropic', label: 'Claude Opus 4.6', description: 'Most powerful — deep reasoning' },
  { id: 'claude-sonnet-4-6', provider: 'Anthropic', label: 'Claude Sonnet 4.6', description: 'Best balance of quality and cost', badge: 'Recommended' },
  { id: 'claude-haiku-4-5', provider: 'Anthropic', label: 'Claude Haiku 4.5', description: 'Fast and affordable — may skip approval steps' },
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
    default:
      return null
  }
}

// --- Tab: General ---

function GeneralTab({ settings, onUpdate }: { settings: AgentSettings; onUpdate: (patch: Partial<AgentSettings>) => void }) {
  const s = settings
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
        <Input key={s.name} className="text-[13.5px] dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-500" placeholder="Your name" defaultValue={s.name} onBlur={e => onUpdate({ name: e.target.value })} />
      </FieldRow>
      <FieldRow label="Email">
        <Input key={s.email} className="text-[13.5px] dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-500" placeholder="your@email.com" defaultValue={s.email} onBlur={e => onUpdate({ email: e.target.value })} />
      </FieldRow>
      <FieldRow label="What you do">
        <Input key={s.role} className="text-[13.5px] dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-500" placeholder="e.g. real estate agent, sales manager" defaultValue={s.role} onBlur={e => onUpdate({ role: e.target.value })} />
      </FieldRow>
      <FieldRow label="Timezone">
        <select value={tzValue} onChange={e => handleTimezoneChange(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-[13.5px] text-neutral-800 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-ring">
          {TIMEZONES.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
        </select>
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
              Uses OpenAI TTS — costs extra
            </span>
          </div>
        </FieldRow>
      )}
    </>
  )
}

// --- Tab: Model ---

function ModelTab({ settings, onSetModel }: { settings: AgentSettings; onSetModel: (id: string) => void }) {
  const selectedModel = settings.powerModel || 'claude-sonnet-4-6'

  return (
    <>
      <SectionHeader eyebrow="AI Model" title="Choose your model" />
      <p className="text-[13px] text-neutral-500 dark:text-neutral-400 mb-5">
        This model powers all of your agent's actions. You're billed at the exact provider rate — no markup.
      </p>
      <div className="flex flex-col gap-2.5">
        {MODEL_OPTIONS.map(model => {
          const selected = selectedModel === model.id
          return (
            <button
              type="button"
              key={model.id}
              onClick={() => onSetModel(model.id)}
              disabled={false}
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
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                    {model.badge}
                  </span>
                )}
              </div>
              <p className="text-[12.5px] text-neutral-500 dark:text-neutral-400 ml-6">{model.description}</p>
            </button>
          )
        })}
      </div>
    </>
  )
}

// --- Tab: API Keys ---

function ApiKeyField({ label, description, linkUrl, linkLabel, required, configured, onSave }: {
  label: string
  description: string
  linkUrl?: string
  linkLabel?: string
  required?: boolean
  configured: boolean
  onSave: (key: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')

  function handleSave() {
    if (value.trim()) {
      onSave(value.trim())
      setValue('')
      setEditing(false)
    }
  }

  return (
    <div className="mb-5 px-4 py-3.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <div className={cn('w-2 h-2 rounded-full', configured ? 'bg-emerald-500' : 'bg-neutral-300 dark:bg-neutral-600')} />
          <span className="text-[13.5px] font-semibold text-neutral-900 dark:text-neutral-100">
            {label} {required && <span className="text-red-400 text-[11px]">required</span>}
          </span>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-[12px] text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            {configured ? 'Change' : 'Add key'}
          </button>
        )}
      </div>
      <p className="text-[12px] text-neutral-400 dark:text-neutral-500 mb-2">
        {description}
        {linkUrl && (
          <> <a href={linkUrl} target="_blank" rel="noreferrer" className="text-neutral-600 dark:text-neutral-300 hover:underline">{linkLabel || 'Get a key'} &rarr;</a></>
        )}
      </p>
      {editing && (
        <div className="flex gap-2 mt-2">
          <Input
            type="password"
            className="text-[13px] flex-1 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100"
            placeholder="sk-..."
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()}
            autoFocus
          />
          <button
            type="button"
            onClick={handleSave}
            disabled={!value.trim()}
            className="px-3 py-1.5 text-[12px] font-medium rounded-md bg-neutral-900 text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => { setEditing(false); setValue('') }}
            className="px-3 py-1.5 text-[12px] font-medium rounded-md text-neutral-500 hover:text-neutral-700 dark:text-neutral-400"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

function KeysTab({ apiKeyStatus, onUpdateApiKeys }: {
  apiKeyStatus: { anthropic: boolean; composio: boolean; openai: boolean } | null
  onUpdateApiKeys: (keys: { anthropic?: string; composio?: string; openai?: string }) => void
}) {
  return (
    <>
      <SectionHeader eyebrow="Configuration" title="API Keys" />
      <p className="text-[13px] text-neutral-500 dark:text-neutral-400 mb-5">
        Your keys are stored locally on your machine and never sent anywhere except directly to each service.
      </p>
      <ApiKeyField
        label="Anthropic"
        description="Powers the AI agent."
        linkUrl="https://console.anthropic.com"
        linkLabel="Get a key"
        required
        configured={apiKeyStatus?.anthropic ?? false}
        onSave={(key) => onUpdateApiKeys({ anthropic: key })}
      />
      <ApiKeyField
        label="Composio"
        description="Enables Gmail, Calendar, Slack and 80+ integrations."
        linkUrl="https://composio.dev"
        linkLabel="Get a key"
        configured={apiKeyStatus?.composio ?? false}
        onSave={(key) => onUpdateApiKeys({ composio: key })}
      />
      <ApiKeyField
        label="OpenAI"
        description="Enables semantic file search."
        linkUrl="https://platform.openai.com/api-keys"
        linkLabel="Get a key"
        configured={apiKeyStatus?.openai ?? false}
        onSave={(key) => onUpdateApiKeys({ openai: key })}
      />
    </>
  )
}

// --- Main ---

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'model', label: 'Model' },
  { id: 'keys', label: 'API Keys' },
]

export function SettingsPane({ settings, onUpdate, apiKeyStatus, onUpdateApiKeys, onSetModel }: SettingsPaneProps) {
  const [tab, setTab] = useState<SettingsTab>('general')

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
          {tab === 'keys' && <KeysTab apiKeyStatus={apiKeyStatus} onUpdateApiKeys={onUpdateApiKeys} />}
          <div className="h-8" />
        </div>
      </ScrollArea>
    </div>
  )
}
