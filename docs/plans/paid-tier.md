# CoAgent — Business Model & Pricing

## Overview

CoAgent is a closed-source desktop app distributed as two separate DMG files:

- **CoAgent Free** — User picks their AI model, pays at-cost for all API usage + $0.0001/call platform fee. Integrations (Gmail, Calendar, etc.) included and managed by us.
- **CoAgent Pro** — Same thing, higher priority support, future premium features.

There is no BYOK / open-source version. All API calls route through our infrastructure so we can meter usage, manage Composio integrations, and provide a zero-setup experience.

---

## Pricing Model

### How It Works

Users pay exactly what the underlying APIs cost, plus a $0.0001 (one hundredth of a cent) platform fee per call. No markup on API costs. The platform fee is so small it's essentially invisible, but adds up at scale.

### What the User Sees

One bill. No line items for Composio, Voyage, or individual providers. Just:

```
Usage this month:
  AI calls:        $12.47  (at-cost passthrough)
  Platform fee:     $0.31  (3,100 calls x $0.0001)
  ─────────────────────────
  Total:           $12.78
```

### Cost Breakdown Per Call

| Component | Cost | Who Pays |
|---|---|---|
| LLM (Anthropic/OpenAI/Gemini) | Varies by model & tokens | Passed through to user at cost |
| Voyage embeddings | ~$0.10/M tokens | Bundled into usage |
| Composio actions | Covered by our plan | Bundled into usage |
| Platform fee | $0.0001/call | Our margin |

### Our Expenses (Fixed)

| Service | Plan | Cost | Covers |
|---|---|---|---|
| Composio | Free | $0/mo | 20k tool calls/mo (~30 active users) |
| Composio | Starter | $29/mo | 200k tool calls/mo (~300 users) |
| Composio | Growth | $229/mo | 2M tool calls/mo (~3000 users) |
| Voyage | Pay-as-you-go | Pennies | Passed through |

### Revenue Math

At $0.0001/call:

| Users | Avg calls/day | Monthly calls | Platform revenue | Composio cost | Profit |
|---|---|---|---|---|---|
| 50 | 30 | 45,000 | $4.50 | $0 (free tier) | $4.50 |
| 200 | 30 | 180,000 | $18 | $0 (free tier) | $18 |
| 500 | 30 | 450,000 | $45 | $29 | $16 |
| 2,000 | 30 | 1,800,000 | $180 | $29 | $151 |
| 5,000 | 30 | 4,500,000 | $450 | $229 | $221 |

Platform fee alone won't make us rich. The real play is building a user base on near-zero margins, then introducing premium features later (team workspaces, priority models, advanced integrations, etc.) that justify a higher tier.

Donations are also accepted for users who want to support development.

---

## Multi-Model Support

Users pick their AI provider during onboarding. We proxy all calls and pass through costs at the provider's rate.

### Supported Providers (planned)

| Provider | Models | Input/Output per 1M tokens |
|---|---|---|
| Anthropic | Sonnet 4.6, Haiku 4.5 | $3/$15 (Sonnet), $0.80/$4 (Haiku) |
| OpenAI | GPT-4o, GPT-4o-mini | $2.50/$10 (4o), $0.15/$0.60 (mini) |
| Google | Gemini 2.5 Pro, Flash | $1.25/$10 (Pro), $0.075/$0.30 (Flash) |
| OpenRouter | Any model | Varies |

User can switch models in Settings at any time. Cheaper models = cheaper bill.

---

## Architecture

```
User's machine                          Our infrastructure
├── CoAgent.app (DMG)                   ├── Auth API (Cloudflare Worker)
│   └── session token stored            │   ├── Signup / login
│       locally                         │   ├── Stripe billing
│                                       │   └── Issues session + userId
└── ~/.coagent/                         │
    ├── session.json                    ├── API Proxy (Cloudflare Worker)
    └── local data                      │   ├── Routes LLM calls to chosen provider
        (memory, files, etc.)           │   ├── Routes Voyage calls
                                        │   ├── Meters every call per user
                                        │   └── $0.0001 platform fee per call
                                        │
                                        └── Composio (our account)
                                            ├── Free tier: 20k calls/mo
                                            └── user_uuid per user (isolated)
```

All data stays on the user's machine. Our infrastructure only handles auth, billing, and API proxying.

### Composio Multi-Tenancy

Composio supports `user_uuid` natively. One API key (ours), many users:

- Each user gets a unique ID from our auth server (e.g. `usr_abc123`)
- All Composio calls use `user_uuid = 'usr_abc123'`
- OAuth connections are fully isolated per user
- User clicks "Connect Gmail" → OAuth popup → done
- No Composio account needed from the user

The composio-integrations.ts functions already accept `userId` as a parameter — just needs to be wired through server.ts with the authenticated user's ID instead of `'default'`.

---

## Distribution

Two separate DMG downloads:

### CoAgent Free
- Full app
- Pick your AI model
- Pay-as-you-go (at cost + $0.0001/call)
- All integrations included
- Community support

### CoAgent Pro (future)
- Everything in Free
- Priority support
- Premium integrations
- Team features
- Higher rate limits
- $X/mo subscription + usage

---

## Onboarding Flow

1. Download DMG, install
2. Open app → Welcome screen
3. Create account (email + password or Google OAuth)
4. Pick AI model (Anthropic / OpenAI / Google)
5. Add payment method (Stripe)
6. Done → lands in chat, integrations ready to connect

No API keys. No terminal. No config files. Just sign in and go.

---

## What Needs to Be Built

### 1. Auth API (Cloudflare Worker)
- Signup / login endpoints
- Session token management
- Stripe integration (payment method, usage billing)
- User ID generation for Composio isolation

### 2. API Proxy (Cloudflare Worker)
- Routes LLM calls to the user's chosen provider
- Routes Voyage embedding calls
- Meters every call per user
- Adds $0.0001 platform fee
- Monthly Stripe invoice generation

### 3. Multi-Model Support (agent-core)
- Abstract LLM provider behind an interface
- Swap Anthropic SDK for provider-agnostic layer
- Support Anthropic, OpenAI, Google, OpenRouter
- Model selection stored in user settings

### 4. Onboarding UI (desktop app)
- Welcome screen with account creation
- Model picker
- Stripe payment element
- Session management (login, logout, token refresh)

### 5. Wire userId Through server.ts
- Authenticated userId from session token
- Pass to all Composio calls
- Pass to API proxy for metering

### 6. Usage Dashboard (Settings)
- Current month usage and cost
- Model switching
- Payment method management
- Invoice history

---

## Implementation Order

1. **Multi-model support** — Abstract LLM layer so the app works with any provider
2. **Auth API** — Cloudflare Worker with signup/login/Stripe
3. **API Proxy** — Usage metering and billing
4. **Onboarding UI** — Account creation, model picker, payment
5. **Wire userId** — Composio multi-tenancy
6. **DMG packaging** — Two builds (Free / Pro)
7. **Usage dashboard** — Billing UI in Settings
