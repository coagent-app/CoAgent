# CoAgent Partners Program Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace usage-based billing with flat subscriptions and automated affiliate payouts via Stripe Connect Express.

**Architecture:** Extend the existing Cloudflare Worker relay (`relay/src/index.ts`) with new fields on `TokenData`, three new webhook handlers, Stripe API calls for Connect and Transfers, and a referral stats admin endpoint. No new services — everything lives in the existing relay worker.

**Tech Stack:** Cloudflare Workers, KV, Stripe API (Checkout, Connect Express, Transfers), TypeScript

---

### Task 1: Update TokenData and Remove Legacy Fields

**Files:**
- Modify: `relay/src/index.ts:1-49` (Env interface + TokenData)

**Step 1: Add `STRIPE_API_KEY` to Env interface**

In `relay/src/index.ts`, add after `STRIPE_WEBHOOK_SECRET`:

```typescript
STRIPE_API_KEY: string           // Stripe secret key — for outbound API calls (Transfers, Connect)
```

**Step 2: Update TokenData interface**

Replace the existing `TokenData` interface (lines 39-49) with:

```typescript
interface TokenData {
  userId: number
  stripeCustomerId: string
  model: string
  usage: UsageData
  createdAt: string
  active: boolean
  admin?: boolean
  // Partners program
  tier: 'founder' | 'early_access' | 'standard'
  referralCode: string          // unique per user, e.g. "REF_a7b3c9"
  referredBy?: string           // referral code of whoever referred them
  stripeConnectId?: string      // Stripe Connect Express account ID
  commissionRate: number        // 0.25, 0.15, or 0.10
  accruedCommission?: number    // cents — unpaid commission waiting for Connect onboarding
}
```

**Step 3: Add referral code generator**

Add after the existing `generateToken()` function (line 148-152):

```typescript
function generateReferralCode(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return 'REF_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}
```

**Step 4: Add tier detection helper**

Add after `generateReferralCode`:

```typescript
// Stripe Price IDs — set these after creating products in Stripe Dashboard
const PRICE_TO_TIER: Record<string, { tier: TokenData['tier']; rate: number }> = {
  // Replace these with actual Stripe Price IDs after creating them
  'price_founder_placeholder':      { tier: 'founder',      rate: 0.25 },
  'price_early_access_placeholder': { tier: 'early_access', rate: 0.15 },
  'price_standard_placeholder':     { tier: 'standard',     rate: 0.10 },
}

function tierFromSession(session: any): { tier: TokenData['tier']; rate: number } {
  // Stripe checkout session includes line_items with price ID
  const priceId = session.metadata?.price_id || session.line_items?.data?.[0]?.price?.id
  return PRICE_TO_TIER[priceId] || { tier: 'standard', rate: 0.10 }
}
```

**Step 5: Verify it compiles**

Run: `cd /Users/brettponters/AI-Projects/CoAgent/relay && npx wrangler deploy --dry-run`
Expected: No type errors. (Existing code that references `supportAmount` or `expiresAt` will break — fix in next steps.)

**Step 6: Fix all references to removed fields**

Search for `supportAmount` and `expiresAt` in `relay/src/index.ts`. Update every `TokenData` creation to use the new fields instead. Specifically:

- In `handleStripeWebhook` `checkout.session.completed` case (~line 673): replace `supportAmount: 0` with `tier`, `referralCode`, `commissionRate` fields (full replacement in Task 2).
- In `/admin/create-token` handler (~line 1822): replace `supportAmount: 0, expiresAt` with new fields. Keep `expiresAt` only here for admin-created beta tokens if needed, or remove and rely on tier system.
- In `validateRequest` (~line 339): the `expiresAt` check can stay — admin tokens may still use it. Add a fallback: `if ((data as any).expiresAt && ...)`.

**Step 7: Commit**

```bash
git add relay/src/index.ts
git commit -m "feat(relay): update TokenData for partners program — add tier, referralCode, commissionRate, stripeConnectId"
```

---

### Task 2: Update checkout.session.completed Webhook

**Files:**
- Modify: `relay/src/index.ts:649-718` (handleStripeWebhook)

**Step 1: Rewrite the checkout.session.completed case**

Replace the existing `checkout.session.completed` case (lines 664-689) with:

```typescript
case 'checkout.session.completed': {
  const session = event.data.object
  const token = generateToken()
  const referralCode = generateReferralCode()

  // Assign a numeric user ID
  const prevId = parseInt(await env.TOKENS.get('_next_user_id') || '0')
  const userId = prevId + 1
  await env.TOKENS.put('_next_user_id', String(userId))

  // Determine tier from the Price ID
  const { tier, rate } = tierFromSession(session)

  // Referral attribution
  const referredBy = session.client_reference_id || undefined

  const tokenData: TokenData = {
    userId,
    stripeCustomerId: session.customer,
    model: 'claude-sonnet-4-6',
    usage: freshUsage(),
    createdAt: new Date().toISOString(),
    active: true,
    tier,
    referralCode,
    referredBy,
    commissionRate: rate,
  }
  await saveToken(env, token, tokenData)

  // Reverse lookups
  await env.TOKENS.put(`stripe:${session.customer}`, token)
  await env.TOKENS.put(`ref:${referralCode}`, token)

  console.log(`New ${tier} user #${userId} (ref: ${referredBy || 'organic'}): ${token.slice(0, 8)}...`)

  return jsonResponse({ ok: true })
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/brettponters/AI-Projects/CoAgent/relay && npx wrangler deploy --dry-run`
Expected: No type errors.

**Step 3: Commit**

```bash
git add relay/src/index.ts
git commit -m "feat(relay): referral attribution on checkout — tier detection, referralCode, client_reference_id"
```

---

### Task 3: Add invoice.payment_succeeded Webhook Handler

**Files:**
- Modify: `relay/src/index.ts` (add new case in handleStripeWebhook switch)

**Step 1: Add the Stripe API call helper**

Add after `verifyStripeSignature` function (~line 607):

```typescript
async function stripeApiCall(env: Env, method: string, path: string, body?: Record<string, string>): Promise<any> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${env.STRIPE_API_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  })
  return res.json()
}
```

**Step 2: Add invoice.payment_succeeded case**

Add before the `default:` case in the `handleStripeWebhook` switch:

```typescript
// Subscription renewed → calculate and pay affiliate commission
case 'invoice.payment_succeeded': {
  const invoice = event.data.object
  if (invoice.billing_reason === 'subscription_create') {
    // First invoice — may be $0 for trials. Skip if zero.
    if (invoice.amount_paid === 0) return jsonResponse({ ok: true })
  }

  // Find the paying user's token
  const payerToken = await env.TOKENS.get(`stripe:${invoice.customer}`)
  if (!payerToken) return jsonResponse({ ok: true })
  const payerData = await getToken(env, payerToken)
  if (!payerData?.referredBy) return jsonResponse({ ok: true }) // organic user, no commission

  // Find the referrer
  const referrerToken = await env.TOKENS.get(`ref:${payerData.referredBy}`)
  if (!referrerToken) return jsonResponse({ ok: true })
  const referrerData = await getToken(env, referrerToken)
  if (!referrerData) return jsonResponse({ ok: true })

  // Calculate commission in cents
  const commissionCents = Math.round(invoice.amount_paid * referrerData.commissionRate)
  if (commissionCents <= 0) return jsonResponse({ ok: true })

  if (referrerData.stripeConnectId) {
    // Partner has Connect account — transfer immediately
    try {
      await stripeApiCall(env, 'POST', '/transfers', {
        amount: String(commissionCents),
        currency: 'usd',
        destination: referrerData.stripeConnectId,
        description: `CoAgent affiliate commission — user #${payerData.userId}`,
      })
      console.log(`[Commission] Paid ${commissionCents}c to ${referrerData.referralCode} (user #${referrerData.userId})`)
    } catch (e) {
      console.error(`[Commission] Transfer failed:`, (e as Error).message)
    }
  } else {
    // Partner hasn't onboarded Connect yet — accrue
    referrerData.accruedCommission = (referrerData.accruedCommission || 0) + commissionCents
    await saveToken(env, referrerToken, referrerData)
    console.log(`[Commission] Accrued ${commissionCents}c for ${referrerData.referralCode} (no Connect account yet)`)
  }

  return jsonResponse({ ok: true })
}
```

**Step 3: Verify it compiles**

Run: `cd /Users/brettponters/AI-Projects/CoAgent/relay && npx wrangler deploy --dry-run`
Expected: No type errors.

**Step 4: Commit**

```bash
git add relay/src/index.ts
git commit -m "feat(relay): auto-pay affiliate commissions on invoice.payment_succeeded"
```

---

### Task 4: Add charge.refunded Webhook Handler

**Files:**
- Modify: `relay/src/index.ts` (add new case in handleStripeWebhook switch)

**Step 1: Add charge.refunded case**

Add before the `default:` case:

```typescript
// Refund → reverse affiliate commission
case 'charge.refunded': {
  const charge = event.data.object
  const payerToken = await env.TOKENS.get(`stripe:${charge.customer}`)
  if (!payerToken) return jsonResponse({ ok: true })
  const payerData = await getToken(env, payerToken)
  if (!payerData?.referredBy) return jsonResponse({ ok: true })

  const referrerToken = await env.TOKENS.get(`ref:${payerData.referredBy}`)
  if (!referrerToken) return jsonResponse({ ok: true })
  const referrerData = await getToken(env, referrerToken)
  if (!referrerData?.stripeConnectId) return jsonResponse({ ok: true })

  const reversalCents = Math.round(charge.amount_refunded * referrerData.commissionRate)
  if (reversalCents <= 0) return jsonResponse({ ok: true })

  try {
    // Find the original transfer and reverse it
    const transfers = await stripeApiCall(env, 'GET',
      `/transfers?destination=${referrerData.stripeConnectId}&limit=10`)
    const original = transfers.data?.find((t: any) =>
      t.description?.includes(`user #${payerData.userId}`))
    if (original) {
      await stripeApiCall(env, 'POST', `/transfers/${original.id}/reversals`, {
        amount: String(reversalCents),
      })
      console.log(`[Commission] Reversed ${reversalCents}c from ${referrerData.referralCode}`)
    }
  } catch (e) {
    console.error(`[Commission] Reversal failed:`, (e as Error).message)
  }

  return jsonResponse({ ok: true })
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/brettponters/AI-Projects/CoAgent/relay && npx wrangler deploy --dry-run`

**Step 3: Commit**

```bash
git add relay/src/index.ts
git commit -m "feat(relay): reverse affiliate commission on charge.refunded"
```

---

### Task 5: Add Stripe Connect Onboarding

**Files:**
- Modify: `relay/src/index.ts` (add account.updated webhook case + Connect onboarding endpoint)

**Step 1: Add account.updated webhook case**

Add before the `default:` case in `handleStripeWebhook`:

```typescript
// Connect account onboarding completed
case 'account.updated': {
  const account = event.data.object
  if (!account.charges_enabled) return jsonResponse({ ok: true }) // not fully onboarded yet

  // Find which partner this Connect account belongs to
  const partnerToken = await env.TOKENS.get(`connect:${account.id}`)
  if (!partnerToken) return jsonResponse({ ok: true })
  const partnerData = await getToken(env, partnerToken)
  if (!partnerData) return jsonResponse({ ok: true })

  partnerData.stripeConnectId = account.id
  await saveToken(env, partnerToken, partnerData)

  // Pay out any accrued commission
  if (partnerData.accruedCommission && partnerData.accruedCommission > 0) {
    try {
      await stripeApiCall(env, 'POST', '/transfers', {
        amount: String(partnerData.accruedCommission),
        currency: 'usd',
        destination: account.id,
        description: `CoAgent affiliate commission — accrued backpay`,
      })
      console.log(`[Connect] Paid accrued ${partnerData.accruedCommission}c to ${partnerData.referralCode}`)
      partnerData.accruedCommission = 0
      await saveToken(env, partnerToken, partnerData)
    } catch (e) {
      console.error(`[Connect] Accrued payout failed:`, (e as Error).message)
    }
  }

  console.log(`[Connect] Account ${account.id} onboarded for user #${partnerData.userId}`)
  return jsonResponse({ ok: true })
}
```

**Step 2: Add Connect onboarding link endpoint**

Add before the `// --- Composio proxy ---` section (~line 1893), after the admin endpoints:

```typescript
// --- Partner Connect onboarding ---
if (url.pathname === '/partner/connect-onboard' && request.method === 'POST') {
  const result = await validateRequest(request, env)
  if (result instanceof Response) return result

  const data = result.data

  // Create a Stripe Connect Express account
  const account = await stripeApiCall(env, 'POST', '/accounts', {
    type: 'express',
    capabilities: { transfers: { requested: 'true' } } as any,
    metadata: { coagent_user_id: String(data.userId), referral_code: data.referralCode } as any,
  })

  // Store reverse lookup
  await env.TOKENS.put(`connect:${account.id}`, result.token)

  // Create the onboarding link
  const link = await stripeApiCall(env, 'POST', '/account_links', {
    account: account.id,
    refresh_url: 'https://coagent.ai/connect/retry',
    return_url: 'https://coagent.ai/connect/done',
    type: 'account_onboarding',
  })

  return jsonResponse({ url: link.url })
}
```

Note: The `capabilities` and `metadata` params need to be passed as form-encoded nested params. Update `stripeApiCall` or use a more complete form encoder if needed — Stripe expects `capabilities[transfers][requested]=true`.

**Step 3: Update stripeApiCall to handle nested params**

Replace the `stripeApiCall` function with a version that handles nested objects:

```typescript
async function stripeApiCall(env: Env, method: string, path: string, body?: Record<string, any>): Promise<any> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${env.STRIPE_API_KEY}`,
  }

  let reqBody: string | undefined
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    const params = new URLSearchParams()
    function flatten(obj: any, prefix = '') {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}[${k}]` : k
        if (typeof v === 'object' && v !== null) flatten(v, key)
        else params.append(key, String(v))
      }
    }
    flatten(body)
    reqBody = params.toString()
  }

  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers,
    body: reqBody,
  })
  return res.json()
}
```

**Step 4: Verify it compiles**

Run: `cd /Users/brettponters/AI-Projects/CoAgent/relay && npx wrangler deploy --dry-run`

**Step 5: Commit**

```bash
git add relay/src/index.ts
git commit -m "feat(relay): Stripe Connect Express onboarding + accrued commission payout"
```

---

### Task 6: Add Admin Referral Stats Endpoint

**Files:**
- Modify: `relay/src/index.ts` (extend list-tokens + add referral-stats)

**Step 1: Extend `/admin/list-tokens` response**

In the list-tokens handler (~line 1857), add the new fields to the `users.push()` call:

```typescript
users.push({
  token: key.name.slice(0, 8) + '...',
  userId: data.userId,
  model: data.model,
  active: data.active,
  admin: data.admin || false,
  createdAt: data.createdAt,
  label: data.stripeCustomerId,
  totalCostUsd: data.usage?.totalCostUsd ?? 0,
  // Partners program
  tier: data.tier || 'standard',
  referralCode: data.referralCode || null,
  commissionRate: data.commissionRate ?? 0,
  referredBy: data.referredBy || null,
  stripeConnectId: data.stripeConnectId || null,
  accruedCommission: data.accruedCommission || 0,
})
```

**Step 2: Add `/admin/referral-stats` endpoint**

Add after the `/admin/revoke-token` handler (~line 1891):

```typescript
if (url.pathname === '/admin/referral-stats' && request.method === 'GET') {
  const result = await validateRequest(request, env)
  if (result instanceof Response) return result
  const rateCheck = checkRateLimit(result.token, 'admin')
  if (rateCheck) return rateCheck
  if (!result.data.admin) return jsonResponse({ error: 'Admin access required' }, 403)

  // Scan all tokens
  let cursor: string | undefined
  let allKeys: any[] = []
  do {
    const result = await env.TOKENS.list({ cursor, limit: 1000 })
    allKeys.push(...result.keys)
    cursor = result.list_complete ? undefined : result.cursor
  } while (cursor)

  // Build referral map: referralCode → { partner info, referred users }
  const allTokens: { key: string; data: TokenData }[] = []
  for (const key of allKeys) {
    if (key.name.startsWith('_') || key.name.startsWith('stripe:') || key.name.startsWith('ref:') || key.name.startsWith('connect:')) continue
    const data = await getToken(env, key.name)
    if (data) allTokens.push({ key: key.name, data })
  }

  // Group by referral code
  const partners = allTokens.filter(t => t.data.referralCode)
  const stats = partners.map(p => {
    const referred = allTokens.filter(t => t.data.referredBy === p.data.referralCode)
    return {
      userId: p.data.userId,
      tier: p.data.tier,
      referralCode: p.data.referralCode,
      commissionRate: p.data.commissionRate,
      connectStatus: p.data.stripeConnectId ? 'active' : 'pending',
      accruedCommission: p.data.accruedCommission || 0,
      referredCount: referred.length,
      referredUsers: referred.map(r => ({
        userId: r.data.userId,
        tier: r.data.tier,
        active: r.data.active,
      })),
    }
  }).filter(s => s.referredCount > 0 || s.tier === 'founder' || s.tier === 'early_access')

  return jsonResponse({ partners: stats })
}
```

**Step 3: Verify it compiles**

Run: `cd /Users/brettponters/AI-Projects/CoAgent/relay && npx wrangler deploy --dry-run`

**Step 4: Commit**

```bash
git add relay/src/index.ts
git commit -m "feat(relay): admin referral-stats endpoint + extended list-tokens"
```

---

### Task 7: Update Admin Create-Token for Partner Tiers

**Files:**
- Modify: `relay/src/index.ts:1805-1834` (admin create-token handler)

**Step 1: Update the create-token handler**

Replace the existing `/admin/create-token` handler to support the new fields:

```typescript
if (url.pathname === '/admin/create-token' && request.method === 'POST') {
  const result = await validateRequest(request, env)
  if (result instanceof Response) return result
  const rateCheck = checkRateLimit(result.token, 'admin')
  if (rateCheck) return rateCheck
  const adminData = result.data
  if (!adminData.admin) return jsonResponse({ error: 'Admin access required' }, 403)

  const body = await request.json() as {
    label?: string
    days?: number
    tier?: TokenData['tier']
  }
  const token = generateToken()
  const referralCode = generateReferralCode()
  const prevId = parseInt(await env.TOKENS.get('_next_user_id') || '0')
  const userId = prevId + 1
  await env.TOKENS.put('_next_user_id', String(userId))

  const tier = body.tier || 'standard'
  const rateMap = { founder: 0.25, early_access: 0.15, standard: 0.10 }

  const tokenData: TokenData = {
    userId,
    stripeCustomerId: body.label || `beta-user-${userId}`,
    model: 'claude-sonnet-4-6',
    usage: freshUsage(),
    createdAt: new Date().toISOString(),
    active: true,
    tier,
    referralCode,
    commissionRate: rateMap[tier],
  }
  await saveToken(env, token, tokenData)
  await env.TOKENS.put(`ref:${referralCode}`, token)

  return jsonResponse({ ok: true, token, userId, referralCode, tier })
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/brettponters/AI-Projects/CoAgent/relay && npx wrangler deploy --dry-run`

**Step 3: Commit**

```bash
git add relay/src/index.ts
git commit -m "feat(relay): admin create-token supports partner tiers"
```

---

### Task 8: Add wrangler.toml Config + Deploy

**Files:**
- Modify: `relay/wrangler.toml`

**Step 1: Verify STRIPE_API_KEY is set in Cloudflare secrets**

Run: `cd /Users/brettponters/AI-Projects/CoAgent/relay && npx wrangler secret list`
Expected: Check if `STRIPE_API_KEY` exists. If not:

Run: `npx wrangler secret put STRIPE_API_KEY`
Then paste the Stripe secret key when prompted.

**Step 2: Configure Stripe webhook events**

In the Stripe Dashboard (https://dashboard.stripe.com/webhooks), update the webhook endpoint to listen for:
- `checkout.session.completed` (existing)
- `customer.subscription.deleted` (existing)
- `invoice.payment_succeeded` (new)
- `charge.refunded` (new)
- `account.updated` (new)

**Step 3: Create Stripe Products and Prices**

In the Stripe Dashboard:
1. Create product "CoAgent Founder" with price $0/mo recurring
2. Create product "CoAgent Early Access" with price $49/mo recurring, 183-day trial
3. Create product "CoAgent Standard" with price $79/mo recurring

Copy the Price IDs (e.g. `price_xxx`) and update `PRICE_TO_TIER` in `relay/src/index.ts`.

**Step 4: Generate checkout links**

In Stripe Dashboard → Payment Links, create three links:
1. Founder link (using Founder price)
2. Early Access link (using Early Access price)
3. Standard link (using Standard price)

Each link supports `?client_reference_id=REF_xxx` appended by partners.

**Step 5: Deploy**

Run: `cd /Users/brettponters/AI-Projects/CoAgent/relay && npx wrangler deploy`

**Step 6: Commit any final config changes**

```bash
git add relay/
git commit -m "feat(relay): partners program — Stripe Connect, affiliate commissions, referral tracking"
```
