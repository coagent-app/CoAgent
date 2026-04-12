# CoAgent Partners Program — Design

## Overview

Replace usage-based billing with flat subscriptions. Three tiers with affiliate commissions paid automatically via Stripe Connect Express.

## Pricing

| Tier | Spots | Price | Affiliate Commission |
|------|-------|-------|---------------------|
| Founder | 20 | Free forever ($0/mo subscription) | 25% recurring |
| Early Access | 30 | Free 6 months → $49/mo forever | 15% recurring |
| Standard | Unlimited | $79/mo | 10% recurring |

Founders get a $0 Stripe subscription (keeps them in the system). Early Access uses Stripe's native `trial_period_days: 183`. Standard is a straightforward $79/mo subscription.

## Data Model

Extend `TokenData` in `relay/src/index.ts`:

```typescript
interface TokenData {
  // Existing
  userId: number
  stripeCustomerId: string
  model: string
  usage: UsageData
  createdAt: string
  active: boolean
  admin?: boolean

  // New
  tier: 'founder' | 'early_access' | 'standard'
  referralCode: string        // unique per user, e.g. "REF_a7b3c9"
  referredBy?: string         // referral code of whoever referred them
  stripeConnectId?: string    // Stripe Connect Express account ID
  commissionRate: number      // 0.25, 0.15, or 0.10

  // Removed: supportAmount, expiresAt (flat pricing replaces both)
}
```

**New KV lookups:**
- `ref:{referralCode}` → token
- `connect:{connectAccountId}` → token

## Referral Attribution

Partners share personalized checkout links with `client_reference_id`:

```
checkout.stripe.com/c/pay_xxx?client_reference_id=REF_a7b3c9
```

On `checkout.session.completed`, the webhook reads `session.client_reference_id`, looks up `ref:REF_a7b3c9` in KV to find the partner's token, and stores the referral on the new user's `TokenData.referredBy`.

No landing page, cookies, or tracking pixels needed.

## Commission & Payouts

### Partner onboarding
1. After token creation, partner receives a Stripe Connect Express onboarding link
2. Partner fills in bank details (Stripe handles KYC)
3. `account.updated` webhook stores `stripeConnectId` on their token

### Commission flow
On `invoice.payment_succeeded`:
1. Look up paying user's `referredBy`
2. Look up partner's token via `ref:{referralCode}`
3. Calculate commission: subscription price × `commissionRate`
4. `stripe.transfers.create()` to partner's Connect account

### Edge cases
- **Partner hasn't completed Connect onboarding**: accrue commission in KV, transfer once they onboard
- **Payment fails**: no webhook, no commission
- **Refund/chargeback**: `charge.refunded` triggers a reversal transfer
- **Partner refers a Founder**: $0 × 25% = $0 commission (commissions only on paying users)

## Webhook Events

| Event | Action |
|-------|--------|
| `checkout.session.completed` | Create token with tier, commissionRate, referralCode, referredBy attribution |
| `customer.subscription.deleted` | Revoke token (existing, no changes) |
| `invoice.payment_succeeded` | Calculate + transfer commission to referrer's Connect account |
| `charge.refunded` | Reverse commission transfer |
| `account.updated` | Store stripeConnectId on partner's token |

## Environment

New env var needed:

```
STRIPE_API_KEY  — for outbound Stripe API calls (Transfers, Connect account links)
```

Existing `STRIPE_WEBHOOK_SECRET` remains for inbound webhook verification.

## Admin Endpoints

Extend `GET /admin/list-tokens` to include tier, referralCode, commissionRate, stripeConnectId.

New endpoint `GET /admin/referral-stats`:
- Per-partner: referral code, tier, referred user count, monthly/all-time commissions, Connect status, accrued unpaid commissions.
