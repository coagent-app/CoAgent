# In-App Activation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the browser-redirect Stripe Checkout flow with a fully in-app activation experience using Stripe Elements — referral code, email, card entry, and activation all happen inside the desktop app.

**Architecture:** New `POST /subscribe` relay endpoint creates Stripe Customer + Subscription and returns a `clientSecret`. The desktop app uses `@stripe/react-stripe-js` to collect card details inline via CardElement, then confirms payment/setup client-side. Tier is determined by the referrer's tier (Founder = no card, Early Access = SetupIntent, Standard = PaymentIntent).

**Tech Stack:** Stripe API (server), @stripe/react-stripe-js + @stripe/stripe-js (client), Cloudflare Workers KV (existing), React 18 + Tailwind (existing)

---

## Task 1: Enhance `GET /invite/validate` to return tier info

**Files:**
- Modify: `relay/src/index.ts:2173-2182`

Currently returns `{ valid: boolean }`. Needs to also return `tier` and display info so the frontend knows whether to show the card field.

**Step 1: Add tier label mapping**

Add this constant near `PRICE_TO_TIER` (around line 176):

```typescript
const TIER_INFO: Record<string, { label: string; needsCard: boolean; cardLabel?: string }> = {
  founder:      { label: 'Founder — Free forever',                         needsCard: false },
  early_access: { label: 'Early Access — Free for 6 months, then $49/mo',  needsCard: true, cardLabel: 'Free for 6 months' },
  standard:     { label: 'Standard — $79/mo',                              needsCard: true, cardLabel: '$79/mo' },
}
```

**Step 2: Update the validate handler**

Replace the validate handler (lines 2173-2182) so it looks up the referrer's tier and returns it:

```typescript
if (request.method === 'GET' && url.pathname === '/invite/validate') {
  const ipKey = (request.headers.get('cf-connecting-ip') || 'unknown').slice(0, 16)
  const rateCheck = checkRateLimit(ipKey, 'general')
  if (rateCheck) return rateCheck

  const ref = url.searchParams.get('ref')
  if (!ref) return jsonResponse({ error: 'Missing ref parameter' }, 400)

  const ownerToken = await env.TOKENS.get(`ref:${ref}`)
  if (!ownerToken) return jsonResponse({ valid: false })

  const ownerData = await getToken(env, ownerToken)
  const tier = ownerData?.tier || 'standard'
  const info = TIER_INFO[tier] || TIER_INFO.standard

  return jsonResponse({ valid: true, tier, ...info })
}
```

**Step 3: Commit**

```bash
git add relay/src/index.ts
git commit -m "feat(relay): return tier info from /invite/validate"
```

---

## Task 2: Add `POST /subscribe` endpoint

**Files:**
- Modify: `relay/src/index.ts` (add new route after `/invite/redeem` block, around line 2222)

This is the core new endpoint. It creates a Stripe Customer, optionally a Subscription, generates a token, and returns data the client needs to confirm payment.

**Step 1: Add the endpoint**

Insert after the `/invite/redeem` handler block (after line 2222):

```typescript
if (request.method === 'POST' && url.pathname === '/subscribe') {
  const ipKey = (request.headers.get('cf-connecting-ip') || 'unknown').slice(0, 16)
  const rateCheck = checkRateLimit(ipKey, 'general')
  if (rateCheck) return rateCheck

  const body = await request.json() as { referralCode?: string; email?: string }
  if (!body.referralCode) return jsonResponse({ error: 'Missing referralCode' }, 400)
  if (!body.email) return jsonResponse({ error: 'Missing email' }, 400)
  const email = body.email.trim().toLowerCase()

  // Check if email already has an account
  const existingToken = await env.TOKENS.get(`email:${email}`)
  if (existingToken) {
    return jsonResponse({ error: 'An account with this email already exists. Use account recovery.' }, 409)
  }

  // Validate referral code
  const ownerToken = await env.TOKENS.get(`ref:${body.referralCode}`)
  if (!ownerToken) return jsonResponse({ error: 'Invalid referral code' }, 404)

  const ownerData = await getToken(env, ownerToken)
  const tier = ownerData?.tier || 'standard'
  const info = TIER_INFO[tier] || TIER_INFO.standard

  // Determine price ID for this tier
  const tierToPriceMap: Record<string, string> = {}
  for (const [pid, pInfo] of Object.entries(PRICE_TO_TIER)) {
    tierToPriceMap[pInfo.tier] = pid
  }
  const priceId = tierToPriceMap[tier] || 'price_standard_placeholder'
  const commissionRate = PRICE_TO_TIER[priceId]?.rate || 0.10

  // Create Stripe Customer
  const customer = await stripeApiCall(env, 'POST', '/customers', { email })
  if (customer.error) {
    return jsonResponse({ error: 'Failed to create customer', details: customer.error.message }, 500)
  }

  // Generate token + referral code for new user
  const token = generateToken()
  const referralCode = generateReferralCode()
  const prevId = parseInt(await env.TOKENS.get('_next_user_id') || '0')
  const userId = prevId + 1
  await env.TOKENS.put('_next_user_id', String(userId))

  let clientSecret: string | undefined
  let confirmType: 'payment' | 'setup' | undefined

  if (tier === 'founder') {
    // No subscription needed — activate immediately
  } else if (tier === 'early_access') {
    // Create subscription with trial
    const sub = await stripeApiCall(env, 'POST', '/subscriptions', {
      customer: customer.id,
      'items[0][price]': priceId,
      trial_period_days: '183',
      'payment_settings[save_default_payment_method]': 'on_subscription',
    })
    if (sub.error) {
      return jsonResponse({ error: 'Failed to create subscription', details: sub.error.message }, 500)
    }
    // Create SetupIntent to collect card for after trial
    const si = await stripeApiCall(env, 'POST', '/setup_intents', {
      customer: customer.id,
      'payment_method_types[0]': 'card',
    })
    if (si.error) {
      return jsonResponse({ error: 'Failed to create setup intent', details: si.error.message }, 500)
    }
    clientSecret = si.client_secret
    confirmType = 'setup'
  } else {
    // Standard — create subscription, get PaymentIntent from first invoice
    const sub = await stripeApiCall(env, 'POST', '/subscriptions', {
      customer: customer.id,
      'items[0][price]': priceId,
      payment_behavior: 'default_incomplete',
      'expand[0]': 'latest_invoice.payment_intent',
    })
    if (sub.error) {
      return jsonResponse({ error: 'Failed to create subscription', details: sub.error.message }, 500)
    }
    clientSecret = sub.latest_invoice?.payment_intent?.client_secret
    if (!clientSecret) {
      return jsonResponse({ error: 'No payment intent returned from Stripe' }, 500)
    }
    confirmType = 'payment'
  }

  // All tiers get active: true immediately.
  // Founder: no card needed. Early Access: on trial. Standard: payment confirmed client-side.
  // If Standard payment fails, user stays on activation screen. Subscription.deleted webhook
  // will revoke if Stripe cancels the incomplete subscription.
  const tokenData: TokenData = {
    userId,
    stripeCustomerId: customer.id,
    model: 'claude-sonnet-4-6',
    usage: freshUsage(),
    createdAt: new Date().toISOString(),
    active: true,
    tier,
    referralCode,
    referredBy: body.referralCode,
    commissionRate,
  }
  await saveToken(env, token, tokenData)

  // KV lookups
  await env.TOKENS.put(`stripe:${customer.id}`, token)
  await env.TOKENS.put(`ref:${referralCode}`, token)
  await env.TOKENS.put(`email:${email}`, token)

  console.log(`[Subscribe] New ${tier} user #${userId} (ref: ${body.referralCode}): ${token.slice(0, 8)}...`)

  return jsonResponse({
    token,
    clientSecret,
    confirmType,
    tier,
    referralCode,
    ...info,
  })
}
```

**Step 2: Commit**

```bash
git add relay/src/index.ts
git commit -m "feat(relay): add POST /subscribe endpoint for in-app activation"
```

---

## Task 3: Add `POST /recover` endpoint

**Files:**
- Modify: `relay/src/index.ts` (add after the `/subscribe` handler)

Simple email-based account recovery — looks up the token by email.

**Step 1: Add the endpoint**

```typescript
if (request.method === 'POST' && url.pathname === '/recover') {
  const ipKey = (request.headers.get('cf-connecting-ip') || 'unknown').slice(0, 16)
  const rateCheck = checkRateLimit(ipKey, 'general')
  if (rateCheck) return rateCheck

  const body = await request.json() as { email?: string }
  if (!body.email) return jsonResponse({ error: 'Missing email' }, 400)
  const email = body.email.trim().toLowerCase()

  const token = await env.TOKENS.get(`email:${email}`)
  if (!token) return jsonResponse({ error: 'No account found with this email' }, 404)

  return jsonResponse({ token })
}
```

**Step 2: Commit**

```bash
git add relay/src/index.ts
git commit -m "feat(relay): add POST /recover for email-based account recovery"
```

---

## Task 4: Install Stripe dependencies and add env variable

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/.env` (or create if needed)

**Step 1: Install packages**

```bash
cd apps/desktop && pnpm add @stripe/stripe-js @stripe/react-stripe-js
```

**Step 2: Add env variable**

Add to `apps/desktop/.env` (create if not present):

```
VITE_STRIPE_PK=pk_test_placeholder
```

This will be replaced with the real publishable key from Stripe Dashboard before production.

**Step 3: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat(desktop): add Stripe.js dependencies"
```

---

## Task 5: Rewrite OnboardingActivation.tsx with Stripe Elements

**Files:**
- Modify: `apps/desktop/src/components/OnboardingActivation.tsx`

This is the main UI change. Replace the entire file with the new activation screen that uses Stripe Elements.

**Step 1: Rewrite the component**

Replace the entire contents of `OnboardingActivation.tsx`:

```tsx
import React, { useState, useCallback, useMemo } from 'react'
import { Sparkles, Loader2, CheckCircle2, Mail } from 'lucide-react'
import { loadStripe } from '@stripe/stripe-js'
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js'

const RELAY_URL = (import.meta.env.VITE_RELAY_URL as string).replace(/\/$/, '')
const stripePromise = import.meta.env.VITE_STRIPE_PK
  ? loadStripe(import.meta.env.VITE_STRIPE_PK as string)
  : null

interface OnboardingActivationProps {
  onActivated: (token: string) => void
}

interface TierInfo {
  valid: boolean
  tier?: string
  label?: string
  needsCard?: boolean
  cardLabel?: string
}

type Screen = 'activate' | 'recover' | 'success'

function ActivationForm({ onActivated }: { onActivated: (token: string) => void }) {
  const stripe = useStripe()
  const elements = useElements()

  const [screen, setScreen] = useState<Screen>('activate')
  const [referralCode, setReferralCode] = useState('')
  const [email, setEmail] = useState('')
  const [recoverEmail, setRecoverEmail] = useState('')
  const [tierInfo, setTierInfo] = useState<TierInfo | null>(null)
  const [validatingRef, setValidatingRef] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

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
    if (!email.trim()) { setError('Enter your email'); return }
    if (!tierInfo?.valid) { setError('Invalid referral code'); return }

    setLoading(true)
    setError('')

    try {
      // 1. Call /subscribe
      const res = await fetch(`${RELAY_URL}/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referralCode: code, email: email.trim() }),
      })
      const data = await res.json() as any
      if (!res.ok) { setError(data.error || 'Subscription failed'); setLoading(false); return }

      // 2. Confirm payment/setup if needed
      if (data.confirmType === 'payment' && stripe && elements) {
        const card = elements.getElement(CardElement)
        if (!card) { setError('Card not ready'); setLoading(false); return }
        const { error: stripeError } = await stripe.confirmCardPayment(data.clientSecret, {
          payment_method: { card },
        })
        if (stripeError) { setError(stripeError.message || 'Payment failed'); setLoading(false); return }
      } else if (data.confirmType === 'setup' && stripe && elements) {
        const card = elements.getElement(CardElement)
        if (!card) { setError('Card not ready'); setLoading(false); return }
        const { error: stripeError } = await stripe.confirmCardSetup(data.clientSecret, {
          payment_method: { card },
        })
        if (stripeError) { setError(stripeError.message || 'Card setup failed'); setLoading(false); return }
      }
      // Founder tier: no Stripe confirmation needed

      // 3. Success — save token and activate
      localStorage.setItem('coagent-token', data.token)
      setScreen('success')
      setTimeout(() => onActivated(data.token), 1200)
    } catch {
      setError('Connection failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [referralCode, email, tierInfo, stripe, elements, onActivated])

  // Account recovery
  const handleRecover = useCallback(async () => {
    if (!recoverEmail.trim()) { setError('Enter your email'); return }
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${RELAY_URL}/recover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: recoverEmail.trim() }),
      })
      const data = await res.json() as any
      if (!res.ok) { setError(data.error || 'No account found'); setLoading(false); return }
      localStorage.setItem('coagent-token', data.token)
      setScreen('success')
      setTimeout(() => onActivated(data.token), 1200)
    } catch {
      setError('Connection failed')
    } finally {
      setLoading(false)
    }
  }, [recoverEmail, onActivated])

  const showCard = tierInfo?.valid && tierInfo.needsCard

  const cardStyle = useMemo(() => ({
    style: {
      base: {
        fontSize: '14px',
        color: document.documentElement.classList.contains('dark') ? '#e5e5e5' : '#171717',
        '::placeholder': { color: '#a3a3a3' },
      },
      invalid: { color: '#ef4444' },
    },
  }), [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="w-[400px] rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
        <div className="p-8 text-center">
          {/* Logo */}
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-neutral-800 to-neutral-950 dark:from-neutral-100 dark:to-neutral-300 flex items-center justify-center mx-auto mb-5 shadow-lg">
            <Sparkles className="w-8 h-8 text-white dark:text-neutral-900" />
          </div>

          <h2 className="text-[22px] font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
            Welcome to Co-Agent
          </h2>
          <p className="text-[14px] text-neutral-500 dark:text-neutral-400 leading-relaxed mb-6">
            Your personal AI operator that runs privately on your machine.
          </p>

          {/* Activate screen */}
          {screen === 'activate' && (
            <div className="text-left space-y-3">
              {/* Referral code */}
              <div>
                <input
                  type="text"
                  value={referralCode}
                  onChange={e => { setReferralCode(e.target.value); setError(''); setTierInfo(null) }}
                  onBlur={validateReferral}
                  onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
                  placeholder="Referral code"
                  className="w-full px-4 py-3 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 text-[14px] text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-600"
                  autoFocus
                />
                {validatingRef && (
                  <p className="text-[12px] text-neutral-400 mt-1">Validating...</p>
                )}
              </div>

              {/* Email */}
              <input
                type="email"
                value={email}
                onChange={e => { setEmail(e.target.value); setError('') }}
                onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
                placeholder="Email"
                className="w-full px-4 py-3 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 text-[14px] text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-600"
              />

              {/* Card — shown only when tier requires it */}
              {showCard && (
                <div className="px-4 py-3 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800">
                  <CardElement options={cardStyle} />
                </div>
              )}

              {/* Tier label */}
              {tierInfo?.valid && tierInfo.label && (
                <p className="text-[12px] text-neutral-500 dark:text-neutral-400 text-center pt-1">
                  {tierInfo.label}
                </p>
              )}

              {error && <p className="text-[12px] text-red-500">{error}</p>}

              <button
                onClick={handleSubmit}
                disabled={loading || !tierInfo?.valid}
                className="w-full py-2.5 rounded-xl bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[14px] font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Start Co-Agent'}
              </button>

              <button
                onClick={() => { setScreen('recover'); setError('') }}
                className="w-full text-[12px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors pt-1"
              >
                Already have an account? Recover access
              </button>
            </div>
          )}

          {/* Recovery screen */}
          {screen === 'recover' && (
            <div className="text-left space-y-3">
              <input
                type="email"
                value={recoverEmail}
                onChange={e => { setRecoverEmail(e.target.value); setError('') }}
                onKeyDown={e => { if (e.key === 'Enter') handleRecover() }}
                placeholder="Email used during activation"
                className="w-full px-4 py-3 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 text-[14px] text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-600"
                autoFocus
              />
              {error && <p className="text-[12px] text-red-500">{error}</p>}
              <button
                onClick={handleRecover}
                disabled={loading}
                className="w-full py-2.5 rounded-xl bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[14px] font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Recover Account'}
              </button>
              <button
                onClick={() => { setScreen('activate'); setError('') }}
                className="w-full text-[12px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors pt-1"
              >
                Back to activation
              </button>
            </div>
          )}

          {/* Success */}
          {screen === 'success' && (
            <div>
              <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto mb-3" />
              <p className="text-[15px] font-medium text-neutral-900 dark:text-neutral-100">
                You're all set!
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function OnboardingActivation({ onActivated }: OnboardingActivationProps) {
  if (!stripePromise) {
    // Fallback if no Stripe PK configured — show form without card
    return <ActivationForm onActivated={onActivated} />
  }

  return (
    <Elements stripe={stripePromise}>
      <ActivationForm onActivated={onActivated} />
    </Elements>
  )
}
```

**Step 2: Verify the build compiles**

```bash
cd apps/desktop && pnpm build
```

Check for TypeScript errors. Fix any import issues.

**Step 3: Commit**

```bash
git add apps/desktop/src/components/OnboardingActivation.tsx
git commit -m "feat(desktop): rewrite activation screen with embedded Stripe Elements"
```

---

## Task 6: Update App.tsx gate logic

**Files:**
- Modify: `apps/desktop/src/App.tsx:117-127`

Minimal change — the gate already works, just remove the deep-link listener dependency since we no longer use browser redirect.

**Step 1: Verify gate logic**

The existing gate at `App.tsx:117-127` already does:
```tsx
if (!activated && !connected) {
  return (
    <OnboardingActivation
      onActivated={(token) => {
        setActivated(true)
        activateRelay(token, import.meta.env.VITE_RELAY_URL as string)
      }}
    />
  )
}
```

This works as-is. The `OnboardingActivation` import on line 15 already points to the file we rewrote. No changes needed to `App.tsx`.

**Step 2: Verify full app builds and runs**

```bash
cd apps/desktop && pnpm build
```

**Step 3: Commit (only if changes were needed)**

If App.tsx required no changes, skip this commit.

---

## Task 7: Manual smoke test checklist

After deploying the relay changes:

1. **Founder flow:** Enter a founder's referral code → card field should be hidden → click "Start Co-Agent" → should activate instantly
2. **Early Access flow:** Enter an early-access referral code → card field appears with "Free for 6 months" → enter test card `4242 4242 4242 4242` → should activate
3. **Standard flow:** Enter a standard referral code → card field appears with "$79/mo" → enter test card → should charge and activate
4. **Invalid code:** Enter gibberish → should show "Invalid referral code" on blur
5. **Duplicate email:** Try to subscribe with an already-used email → should show error
6. **Recovery:** Click "Recover access" → enter a registered email → should recover token
7. **Recovery miss:** Enter unknown email → should show "No account found"

---

## Stripe Dashboard Prerequisites (manual, before production)

1. Create three Products + Prices in Stripe Dashboard
2. Replace placeholder Price IDs in `PRICE_TO_TIER` mapping in `relay/src/index.ts`
3. Set `STRIPE_API_KEY` and `STRIPE_WEBHOOK_SECRET` as Cloudflare Worker secrets
4. Set `VITE_STRIPE_PK` in desktop `.env` with real publishable key
5. Enable webhook events: `checkout.session.completed`, `invoice.payment_succeeded`, `charge.refunded`, `account.updated`, `customer.subscription.deleted`
