import React, { useState, useCallback, useEffect } from 'react'
import { Loader2, CheckCircle2, Mail, Calendar, BarChart3, Zap, ExternalLink } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-shell'

const RELAY_URL = (import.meta.env.VITE_RELAY_URL as string).replace(/\/$/, '')

interface OnboardingActivationProps {
  onActivated: (token: string) => void
}

interface TierInfo {
  valid: boolean
  tier?: string
  label?: string
}

export function OnboardingActivation({ onActivated }: OnboardingActivationProps) {
  const [success, setSuccess] = useState(false)
  const [referralCode, setReferralCode] = useState('')
  const [tierInfo, setTierInfo] = useState<TierInfo | null>(null)
  const [validatingRef, setValidatingRef] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [waitingForCheckout, setWaitingForCheckout] = useState(false)

  // Listen for deep link return from Stripe Checkout
  useEffect(() => {
    const unlisten = listen<{ token?: string; sessionId?: string }>('deep-link-activate', async (event) => {
      const { token, sessionId } = event.payload

      if (token) {
        // Direct token activation (e.g. from a link)
        localStorage.setItem('coagent-token', token)
        setSuccess(true)
        setTimeout(() => onActivated(token), 1200)
        return
      }

      if (sessionId) {
        // Exchange Stripe checkout session for token
        setWaitingForCheckout(false)
        setLoading(true)
        setError('')
        try {
          const res = await fetch(`${RELAY_URL}/subscribe/checkout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
          const data = await res.json() as any
          if (!res.ok) {
            setError(data.error || 'Activation failed')
            setLoading(false)
            return
          }
          localStorage.setItem('coagent-token', data.token)
          setSuccess(true)
          setTimeout(() => onActivated(data.token), 1200)
        } catch {
          setError('Connection failed. Please try again.')
        } finally {
          setLoading(false)
        }
      }
    })

    return () => { unlisten.then(fn => fn()) }
  }, [onActivated])

  // Validate referral code on blur
  const validateReferral = useCallback(async () => {
    const code = referralCode.trim()
    if (!code) { setTierInfo(null); return }
    setValidatingRef(true)
    setError('')
    try {
      const res = await fetch(`${RELAY_URL}/invite/validate?ref=${encodeURIComponent(code)}`)
      const data = await res.json() as TierInfo
      setTierInfo(data)
      if (!data.valid) setError('Invalid referral code')
    } catch {
      setError('Connection failed')
    } finally {
      setValidatingRef(false)
    }
  }, [referralCode])

  // Submit activation
  const handleSubmit = useCallback(async () => {
    const code = referralCode.trim()
    if (!code) { setError('Enter your referral code'); return }

    // Validate first if not yet done
    if (!tierInfo) {
      setValidatingRef(true)
      setError('')
      try {
        const res = await fetch(`${RELAY_URL}/invite/validate?ref=${encodeURIComponent(code)}`)
        const data = await res.json() as TierInfo
        setTierInfo(data)
        if (!data.valid) { setError('Invalid referral code'); setValidatingRef(false); return }
        setValidatingRef(false)
        // Continue with the validated tier below
        await activate(code, data.tier || 'standard')
      } catch {
        setError('Connection failed')
        setValidatingRef(false)
      }
      return
    }

    if (!tierInfo.valid) { setError('Invalid referral code'); return }
    await activate(code, tierInfo.tier || 'standard')
  }, [referralCode, tierInfo])

  const activate = useCallback(async (code: string, tier: string) => {
    setLoading(true)
    setError('')

    try {
      if (tier === 'founder') {
        // Founders: direct activation — no Stripe
        const res = await fetch(`${RELAY_URL}/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ referralCode: code }),
        })
        const data = await res.json() as any
        if (!res.ok) { setError(data.error || 'Activation failed'); setLoading(false); return }

        localStorage.setItem('coagent-token', data.token)
        setSuccess(true)
        setTimeout(() => onActivated(data.token), 1200)
      } else {
        // Paid tiers: open Stripe Checkout in browser
        const res = await fetch(`${RELAY_URL}/invite/redeem`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ referralCode: code }),
        })
        const data = await res.json() as any
        if (!res.ok) { setError(data.error || 'Failed to start checkout'); setLoading(false); return }

        // Open Stripe Checkout in default browser
        await open(data.checkoutUrl)
        setLoading(false)
        setWaitingForCheckout(true)
      }
    } catch {
      setError('Connection failed. Please try again.')
      setLoading(false)
    }
  }, [onActivated])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="w-[440px] rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
        {/* Header gradient bar */}
        <div className="h-1.5 bg-gradient-to-r from-neutral-900 via-neutral-600 to-neutral-900 dark:from-neutral-100 dark:via-neutral-400 dark:to-neutral-100" />

        <div className="p-8 text-center">
          {/* Logo */}
          <img
            src="/coagent-logo.png"
            alt="Co-Agent"
            className="w-16 h-16 rounded-2xl mx-auto mb-4 shadow-lg"
          />

          <h2 className="text-[22px] font-semibold text-neutral-900 dark:text-neutral-100 mb-1">
            Welcome to Co-Agent
          </h2>
          <p className="text-[13px] text-neutral-400 dark:text-neutral-500 mb-4">
            Private Beta
          </p>

          {/* Feature highlights */}
          {!success && !waitingForCheckout && (
            <div className="grid grid-cols-2 gap-2 mb-6">
              {[
                { icon: Mail, text: 'Email & follow-ups' },
                { icon: Calendar, text: 'Calendar & scheduling' },
                { icon: BarChart3, text: 'Marketing & leads' },
                { icon: Zap, text: 'Runs on your machine' },
              ].map(({ icon: Icon, text }) => (
                <div key={text} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-neutral-50 dark:bg-neutral-800/50">
                  <Icon className="w-3.5 h-3.5 text-neutral-400 dark:text-neutral-500 shrink-0" />
                  <span className="text-[11.5px] text-neutral-500 dark:text-neutral-400">{text}</span>
                </div>
              ))}
            </div>
          )}

          {/* Activation form */}
          {!success && !waitingForCheckout && (
            <div className="text-left space-y-3">
              <div>
                <label className="block text-[11px] font-medium text-neutral-500 dark:text-neutral-400 mb-1.5 uppercase tracking-wider">Referral Code</label>
                <input
                  type="text"
                  value={referralCode}
                  onChange={e => { setReferralCode(e.target.value); setError(''); setTierInfo(null) }}
                  onBlur={validateReferral}
                  onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
                  placeholder="REF_..."
                  className="w-full px-4 py-2.5 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 text-[14px] text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-600"
                  autoFocus
                />
                {validatingRef && (
                  <p className="text-[11px] text-neutral-400 mt-1">Validating...</p>
                )}
              </div>

              {/* Tier label */}
              {tierInfo?.valid && tierInfo.label && (
                <div className="flex items-center justify-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  <p className="text-[12px] text-neutral-500 dark:text-neutral-400">
                    {tierInfo.label}
                  </p>
                </div>
              )}

              {error && <p className="text-[12px] text-red-500">{error}</p>}

              <button
                onClick={handleSubmit}
                disabled={loading}
                className="w-full py-2.5 rounded-xl bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[14px] font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                ) : tierInfo?.valid && tierInfo.tier !== 'founder' ? (
                  <span className="inline-flex items-center gap-1.5">Continue to Payment <ExternalLink className="w-3.5 h-3.5" /></span>
                ) : (
                  'Start Co-Agent'
                )}
              </button>
            </div>
          )}

          {/* Waiting for Stripe Checkout */}
          {waitingForCheckout && (
            <div className="py-4 space-y-4">
              <Loader2 className="w-8 h-8 animate-spin text-neutral-400 mx-auto" />
              <p className="text-[14px] text-neutral-600 dark:text-neutral-300">
                Complete payment in your browser
              </p>
              <p className="text-[12px] text-neutral-400 dark:text-neutral-500">
                You'll be redirected back here automatically
              </p>
              {error && <p className="text-[12px] text-red-500">{error}</p>}
              <button
                onClick={() => { setWaitingForCheckout(false); setLoading(false) }}
                className="text-[12px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 underline"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Success */}
          {success && (
            <div className="py-4">
              <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" />
              <p className="text-[16px] font-medium text-neutral-900 dark:text-neutral-100 mb-1">
                You're in!
              </p>
              <p className="text-[13px] text-neutral-400 dark:text-neutral-500">
                Setting up your workspace...
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
