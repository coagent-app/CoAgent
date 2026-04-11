import React, { useState } from 'react'
import { Sparkles, MessageSquare, ArrowRight } from 'lucide-react'
import type { AgentSettings } from '@coagent/shared'

interface OnboardingTourProps {
  settings: AgentSettings | null
  onUpdate: (patch: Partial<AgentSettings>) => void
  onOpenIntegrations: () => void
  onNavigate: (view: string) => void
  onActivate?: (token: string, relayUrl: string) => void
  hasRelay?: boolean
  setTourDone: (done: boolean) => void
}

export function OnboardingTour({ settings, onUpdate, onOpenIntegrations, onNavigate, onActivate, hasRelay, setTourDone }: OnboardingTourProps) {
  const [activationCode, setActivationCode] = useState('')
  const [activationError, setActivationError] = useState('')
  const [activating, setActivating] = useState(false)

  function finish() {
    setTourDone(true)
    onNavigate('chat')
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50 dark:bg-black/60" />

      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow-2xl w-[420px] overflow-hidden">
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
                onClick={finish}
                className="w-full py-2.5 rounded-xl bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[14px] font-medium hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
              >
                <MessageSquare className="w-4 h-4" />
                Start chatting
                <ArrowRight className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
