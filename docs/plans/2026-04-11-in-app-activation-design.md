# In-App Activation & Stripe Payment Flow

**Date:** 2026-04-11
**Status:** Approved

## Overview

Replace the current browser-redirect Stripe Checkout flow with a fully in-app activation experience using Stripe Elements. Users download CoAgent from coagent-ai.com, open the app, enter their referral code + email + card, and activate — all without leaving the app.

## User Flow

### Screen 1: Activation (replaces OnboardingActivation.tsx)

Centered card, CoAgent logo on top. Three fields:

1. **Referral code** — required, validates on blur via `GET /invite/validate`
2. **Email** — required, for Stripe customer + account recovery
3. **Card** — Stripe CardElement, inline, matches dark/light mode

Below the fields: tier/price label determined by the referral code (e.g. "Founder — Free forever", "Early Access — Free for 6 months, then $49/mo", "Standard — $79/mo").

Button: **"Start Co-Agent"**

**Tier-adaptive behavior:**
- **Founder ($0/mo):** Card field hidden entirely. Just referral code + email → instant activation.
- **Early Access (6mo free → $49/mo):** Card shown with "Free for 6 months" label. Stripe SetupIntent — card saved but not charged.
- **Standard ($79/mo):** Card shown with "$79/mo" label. Stripe PaymentIntent — card charged immediately.

### Screen 2: Onboarding Tour (existing)

After activation succeeds, the existing onboarding tour runs (connect integrations, set name, etc.).

## Architecture

### New Relay Endpoint: `POST /subscribe`

**Input:** `{ referralCode, email }`

**Logic:**
1. Validate referral code exists (`ref:{code}` KV lookup)
2. Look up referrer's token to determine tier + price
3. Create Stripe Customer with email
4. Based on tier:
   - **Founder:** No Stripe subscription. Generate token with `active: true` immediately.
   - **Early Access:** Create Subscription with `trial_period_days: 183`. Return SetupIntent `clientSecret`.
   - **Standard:** Create Subscription. Return PaymentIntent `clientSecret` from first invoice.
5. Generate token + referralCode for new user
6. Save TokenData to KV (Founder: `active: true`, others: `active: false` until payment confirms)
7. Create KV lookups: `stripe:{customerId}`, `ref:{newReferralCode}`, `email:{email}`

**Output:** `{ clientSecret?, token, tier, price, referralCode }`

### New Relay Endpoint: `POST /recover`

**Input:** `{ email }`

**Logic:** Look up `email:{email}` → return token if found.

**Output:** `{ token }` or 404

### Modified Webhook: `invoice.payment_succeeded`

- On first successful payment (or trial start), set `active: true` on the token
- Existing commission logic unchanged

### Existing Endpoints (unchanged)

- `GET /invite/validate` — validates referral code
- `POST /partner/connect-onboard` — Stripe Connect for partners
- Admin endpoints — token management, referral stats
- All other webhooks — subscription.deleted, charge.refunded, account.updated

## Desktop App Changes

### New Dependency

- `@stripe/stripe-js` — Stripe.js loader
- `@stripe/react-stripe-js` — React components (Elements, CardElement)

### New Environment Variable

- `VITE_STRIPE_PK` — Stripe publishable key

### New Component: ActivationScreen

Replaces `OnboardingActivation.tsx`. Single-screen form with:
- Referral code input (validates on blur)
- Email input
- Stripe CardElement (hidden for Founder tier)
- Submit button
- Tier/price display

**On submit:**
1. Call `POST /subscribe` with `{ referralCode, email }`
2. If tier requires payment: `stripe.confirmCardPayment(clientSecret)` or `stripe.confirmCardSetup(clientSecret)`
3. If Founder: skip Stripe confirmation (no card needed)
4. On success: save token to localStorage + call `activateRelay(token, relayUrl)`
5. Transition to onboarding tour

### App.tsx Changes

Minimal — same gate logic (`if (!activated) return <ActivationScreen />`), just points to new component.

## What We're NOT Building

- No plan picker UI (referral code determines tier)
- No password system (token-based auth, magic link recovery)
- No in-app billing management (Stripe handles via email receipts)
- No admin dashboard UI (API endpoints sufficient)
- No Supabase migration (KV continues working)

## Stripe Dashboard Prerequisites

Before this works in production:
1. Create three Products + Prices in Stripe Dashboard
2. Copy real Price IDs into relay's `PRICE_TO_TIER` mapping (replacing placeholders)
3. Set `STRIPE_API_KEY` and `STRIPE_WEBHOOK_SECRET` as Cloudflare Worker secrets
4. Enable webhook events: checkout.session.completed, invoice.payment_succeeded, charge.refunded, account.updated, customer.subscription.deleted
5. Get publishable key for `VITE_STRIPE_PK`
