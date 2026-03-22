# CoAgent Ideas

## Sector Presets / Onboarding Templates

Instead of a generic setup, offer preset configurations during onboarding based on the user's industry. User picks "What do you do?" and gets a tailored starting point.

### Preset Examples

**Real Estate**
- Integrations: Gmail, Google Calendar, DocuSign, Follow Up Boss, Google Drive
- Agent behavior: Watch for new leads, schedule showings, draft offer summaries, track closing timelines
- Autonomy: Balanced

**Sales**
- Integrations: HubSpot, Salesforce, LinkedIn, Gmail, Google Calendar
- Agent behavior: Monitor deal stage changes, follow-up reminders, contact research, meeting prep
- Autonomy: Balanced

**E-commerce**
- Integrations: Shopify, Gmail, Slack, Stripe, Google Sheets
- Agent behavior: Watch for orders, handle customer emails, flag refund requests, inventory alerts
- Autonomy: Autonomous

**Agency / Marketing**
- Integrations: Slack, Notion, Google Drive, Monday, Gmail
- Agent behavior: Track project updates, draft briefs, manage approvals, summarize meeting notes
- Autonomy: Ask first

### What Each Preset Controls

1. Which integrations are pre-selected to connect
2. The agent's system prompt (domain-specific behavior and knowledge)
3. Default autonomy level
4. Suggested active hours

### Implementation

- `presets.ts` with configs for each sector
- First-run onboarding screen where the user picks a preset
- Everything after that is the same app — user can still customize manually
- Presets are a starting point, not a lock-in

### Why This Matters

- Better onboarding — less setup friction
- Enables vertical marketing ("CoAgent for Real Estate" hits harder than "AI productivity agent")
- Agent is immediately useful instead of generic
- Can charge differently per vertical if needed

---

## Multi-Provider LLM (Managed by Us)

We hold all API keys. Users never see or manage keys — they just use CoAgent and we handle the AI backend.

### Providers We Manage

- Anthropic (Claude Sonnet/Opus) — primary
- OpenAI (GPT-4o, o1) — fallback / specific tasks
- Google (Gemini) — cost optimization for simple tasks
- Open-source via Groq/Together/Fireworks — cheapest tier for low-stakes tasks

### Architecture

- **Proxy service** — lightweight backend that sits between the desktop app and LLM providers
- App authenticates with a license key or account token (issued at purchase/signup)
- Proxy receives the request, picks the right provider/model, forwards it, streams response back
- All API keys live on our server, never on the user's machine
- Proxy logs every call: user_id, model, input_tokens, output_tokens, timestamp

### Model Selection (in Settings)

User picks their preferred model in Settings. One choice, used for everything.

**Available models (grouped by provider):**
- **Anthropic**: Claude Sonnet (recommended), Claude Opus
- **OpenAI**: GPT-4o, o1
- **Google**: Gemini Pro, Gemini Flash
- **Open-source**: Llama, Mixtral (via Groq/Together)

Each model shows:
- Name and provider
- One-liner description ("Best balance of quality and cost")
- Cost per ~1k messages estimate (so users understand the price difference)
- A "Recommended" badge on Claude Sonnet

**How it works:**
- Default is Claude Sonnet on first launch
- User's choice is stored in their account settings on the proxy
- Proxy routes all requests to the chosen provider/model
- Available models list is served by the proxy — we can add/remove models without an app update

### What Changes in the App

- Remove `ANTHROPIC_API_KEY` from local `.env`
- Replace direct Anthropic SDK calls with proxy endpoint calls
- Add license key / account auth flow on first launch
- Agent.ts creates the Anthropic client pointing at our proxy URL instead of api.anthropic.com
- Settings pane gets a "Model" section with the model picker

---

## Usage Tracking / Billing

Need to know how much each user costs so we can price the product.

### What to Track

- API calls per user (input tokens, output tokens, model used)
- Tool calls (Composio actions count toward their plan too)
- Storage usage (files uploaded)
- Active hours / heartbeats

### How

- **Proxy-side logging**: every request through the proxy logs { user_id, timestamp, model, input_tokens, output_tokens, cost_usd }
- **Local mirror**: app also keeps a lightweight local log so user can see their usage in Settings without hitting the server
- **Stripe metering**: proxy pushes usage events to Stripe for billing (metered billing or tiered plans)
- **Dashboard in Settings**: daily/weekly/monthly usage, which tasks cost the most, total spend

### Pricing Model: Pass-Through + Choose Your Price (Rocket Money Style)

No markup on AI costs. Users pay exactly what the API costs — same rates as Anthropic's public pricing. CoAgent makes money through a voluntary monthly support subscription where the user picks their own amount.

**Why this works:**
- Builds trust — users know they're not getting gouged on API costs
- Lowers barrier to entry — people try it because it's transparent
- Voluntary support converts well when the product is genuinely useful (Rocket Money proves this)
- No pricing tiers to manage, no "am I on the right plan?" friction

**How it works:**
- API usage billed at exact Anthropic/OpenAI/etc. rates (pass-through, no margin)
- Monthly support amount chosen by user: $0, $3, $5, $10, $20, or custom
- Suggested default: $5/mo ("buy us a coffee")
- Users can change their support amount anytime

**What users see in Settings:**
- This month's API usage: $4.23
- Your monthly support: $5/mo [Change]
- Total: $9.23

### Billing Platform: Stripe

Stripe is the best fit for this model:
- **Metered billing API** — proxy reports exact token usage per user, Stripe calculates the bill
- **Flexible subscriptions** — user-chosen amount for the support subscription
- **Stripe Tax** ($0.50/transaction) — handles tax compliance so we don't have to
- **Stripe Billing Portal** — users can update payment method, view invoices, change support amount
- Usage dashboard and revenue analytics built in

**Flow:**
1. User downloads CoAgent (free trial, 7 days, capped at $5 in API costs)
2. User creates account on coagent.ai (Stripe Checkout)
3. Picks their monthly support amount (suggested $5, minimum $0)
4. Enters payment method for API usage billing
5. Gets account token — app authenticates with proxy
6. Monthly invoice: exact API costs + chosen support amount

---

## Distribution / Getting It Out There

### DMG / Auto-Updater

- Tauri bundler already generates .dmg (macOS), .msi (Windows), .AppImage (Linux)
- Add `tauri-plugin-updater` for automatic updates — checks a JSON endpoint for new versions
- Host update files on GitHub Releases or S3/R2
- Code signing: Apple Developer cert for macOS notarization, otherwise users get Gatekeeper warnings

### Marketing / Discovery

- Landing page (coagent.ai or similar)
- Product Hunt launch
- Vertical-specific landing pages ("CoAgent for Real Estate Agents")
- YouTube demo videos showing real workflows
- Reddit (r/SideProject, r/artificial, r/realestate, etc.)
- Twitter/X — build in public, show progress
- Beta waitlist to build anticipation before launch
