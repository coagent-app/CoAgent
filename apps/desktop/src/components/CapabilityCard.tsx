import React, { useState } from 'react'
import { Check, ExternalLink, Key } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Capability {
  name: string
  description: string
  checked: boolean
}

interface AuthField {
  name: string
  displayName: string
  description: string
  helpUrl?: string
  helpText?: string
}

interface CapabilityCardProps {
  name: string
  capabilities: Capability[]
  authFields?: AuthField[]
  onConfirm: (selected: string[], authValues?: Record<string, string>) => void
}

export function CapabilityCard({ name, capabilities, authFields, onConfirm }: CapabilityCardProps) {
  const [items, setItems] = useState(capabilities)
  const [confirmed, setConfirmed] = useState(false)
  const [authValues, setAuthValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    authFields?.forEach(f => { init[f.name] = '' })
    return init
  })

  function toggle(idx: number) {
    if (confirmed) return
    setItems(prev => prev.map((item, i) => i === idx ? { ...item, checked: !item.checked } : item))
  }

  function handleConfirm() {
    const selected = items.filter(i => i.checked).map(i => i.name)
    if (selected.length === 0) return
    // Check all required auth fields are filled
    if (authFields && authFields.length > 0) {
      const missing = authFields.some(f => !authValues[f.name]?.trim())
      if (missing) return
    }
    setConfirmed(true)
    onConfirm(selected, authFields && authFields.length > 0 ? authValues : undefined)
  }

  const hasEmptyAuth = authFields && authFields.length > 0 && authFields.some(f => !authValues[f.name]?.trim())
  const noneChecked = items.every(i => !i.checked)

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 p-4 max-w-md">
      <p className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-200 mb-3">
        Set up {name} — select capabilities:
      </p>
      <div className="flex flex-col gap-1.5 mb-4">
        {items.map((cap, i) => (
          <button
            key={cap.name}
            type="button"
            onClick={() => toggle(i)}
            disabled={confirmed}
            className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors',
              cap.checked
                ? 'bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800'
                : 'bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700',
              !confirmed && 'hover:border-neutral-300 dark:hover:border-neutral-600'
            )}
          >
            <div className={cn(
              'w-4 h-4 rounded border flex items-center justify-center flex-shrink-0',
              cap.checked
                ? 'bg-emerald-500 border-emerald-500'
                : 'border-neutral-300 dark:border-neutral-600'
            )}>
              {cap.checked && <Check size={10} className="text-white" strokeWidth={3} />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">{cap.name}</p>
              <p className="text-[11px] text-neutral-400 dark:text-neutral-500">{cap.description}</p>
            </div>
          </button>
        ))}
      </div>

      {/* Auth fields */}
      {authFields && authFields.length > 0 && (
        <div className="mb-4 flex flex-col gap-2.5">
          <p className="text-[11px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest flex items-center gap-1.5">
            <Key size={11} />
            Credentials
          </p>
          {authFields.map(field => (
            <div key={field.name}>
              <div className="flex items-center gap-1.5 mb-1">
                <label className="text-[12px] font-medium text-neutral-700 dark:text-neutral-300">
                  {field.displayName}
                </label>
                {field.helpUrl && (
                  <a
                    href={field.helpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-500 hover:text-blue-600 transition-colors"
                    title={field.helpText || 'Get your key'}
                  >
                    <ExternalLink size={10} />
                  </a>
                )}
              </div>
              {field.description && (
                <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-1">{field.description}</p>
              )}
              <input
                type="password"
                value={authValues[field.name] || ''}
                onChange={e => setAuthValues(prev => ({ ...prev, [field.name]: e.target.value }))}
                disabled={confirmed}
                placeholder={field.helpText || `Enter ${field.displayName.toLowerCase()}`}
                className="w-full text-[12px] px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          ))}
        </div>
      )}

      {!confirmed ? (
        <button
          type="button"
          onClick={handleConfirm}
          disabled={noneChecked || !!hasEmptyAuth}
          className="text-[13px] font-medium px-4 py-2 rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Confirm
        </button>
      ) : (
        <p className="text-[12px] text-emerald-500 font-medium">Confirmed — building integration...</p>
      )}
    </div>
  )
}
