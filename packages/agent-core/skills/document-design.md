# Document Design Skill

You are writing an HTML document using CoAgent's constrained HTML vocabulary.
Read this entire file before emitting any HTML. Every rule here exists to prevent
documents from looking generic, cloned, or "AI-generated slop."

---

## 1. HTML Vocabulary Reference

### Container classes (structural skeleton)

| Class | Purpose |
|---|---|
| `doc` | Root wrapper. Always present. Theme CSS variables are set here. |
| `doc-page` | One page worth of content. Repeat for multi-page docs. |
| `doc-header` | Top-of-page zone: logo, doc title, eyebrow, date. Usually one per page. |
| `doc-body` | Main content area. Contains sections. |
| `doc-footer` | Bottom-of-page footer: contact, tagline, page number. |

### Section classes (children of `.doc-body`)

| Class | Purpose |
|---|---|
| `sec` | Generic section wrapper. Use when no named section fits. |
| `sec-hero` | Full-bleed opening: big title + lede + optional background. One per doc. |
| `sec-kpi` | Horizontal strip of numbers (KPIs, stats, metrics). |
| `sec-split` | Two-column side-by-side layout. Exactly two direct children. |
| `sec-compare` | Before/after or A/B comparison. Two tinted columns. |
| `sec-gallery` | Image grid (2–4 up). |
| `sec-quote` | Pull quote with oversized text and accent rule. |
| `sec-table` | Table wrapper with consistent border/padding treatment. |
| `sec-signoff` | Name/title/date/signature block at doc end. |
| `sec-cta` | Call to action: centered, primary color, one clear action. |

### Leaf editable classes (click-to-edit targets)

Every editable text element **must** use one of these classes and have a stable `id`.

| Class | Used on | Purpose |
|---|---|---|
| `ed-title` | `h1`, `h2` | Primary and secondary headings |
| `ed-eyebrow` | `p`, `span` | Small label above a title (ALL CAPS, muted color) |
| `ed-lede` | `p` | Lead paragraph — first sentence under a title |
| `ed-body` | `p` | Body prose paragraph |
| `ed-stat-value` | `p`, `span` | KPI number (large, bold) |
| `ed-stat-label` | `p`, `span` | KPI label (small, muted) |
| `ed-cell` | `td`, `th` | Table cell content |
| `ed-caption` | `figcaption`, `p` | Image or figure caption |
| `ed-signature` | `p`, `span` | Signoff name, title, date |

---

## 2. Theme Variables

Theme CSS variables are set on the `.doc` root element via inline `style` — but
**never hardcode hex values in Tailwind classes**. Always use these token names:

| CSS variable | Tailwind class | Purpose |
|---|---|---|
| `--background` | `bg-background` | Page background |
| `--foreground` | `text-foreground` | Body ink / primary text |
| `--muted` | `bg-muted` | Subtle background (KPI strips, table headers) |
| `--muted-foreground` | `text-muted-foreground` | Secondary / de-emphasized text |
| `--primary` | `bg-primary`, `text-primary` | Brand accent — use sparingly |
| `--primary-foreground` | `text-primary-foreground` | Text placed on a primary background |
| `--secondary` | `bg-secondary`, `text-secondary` | Optional second brand color |
| `--secondary-foreground` | `text-secondary-foreground` | Text on secondary bg |
| `--accent` | `bg-accent`, `text-accent` | Highlight distinct from primary |
| `--accent-foreground` | `text-accent-foreground` | Text on accent bg |
| `--border` | `border-border` | Dividers, table borders, horizontal rules |
| `--radius` | `rounded` | Border radius token (applied via `border-radius: var(--radius)`) |
| `--font-display` | (set via `style` on heading elements) | Display/title font stack |
| `--font-body` | (set via `style` on body elements) | Body prose font stack |

**Brand kit integration:** On every new document, read the user's brand kit from
settings (brand_primary, brand_secondary, brand_company, brand_logo). Map them
to the theme object. The `write_document` tool accepts a `theme` partial — pass
the brand values there. Do NOT override brand colors the user has explicitly set.

**Setting theme on the `.doc` root:**
```html
<div class="doc" style="--background:#ffffff;--foreground:#111111;--primary:#1a2744;--primary-foreground:#ffffff;--muted:#f4f4f5;--muted-foreground:#71717a;--secondary:#6b7280;--secondary-foreground:#ffffff;--accent:#e11d48;--accent-foreground:#ffffff;--border:#e4e4e7;--radius:0.5rem;">
```

---

## 3. Anti-Slop Design Principles

These rules exist because AI-generated documents converge on the same visual
template. Break the pattern deliberately.

### Typography hierarchy
- **Display font** (`var(--font-display)` or system-ui) for `.ed-title` headings only.
- **Body font** for all prose. Never render body text in a display font.
- Use at most **4 size stops**: `text-sm`, `text-base`, `text-xl`, `text-4xl`.
  Never sprinkle every size — pick the 3 that fit this doc.
- **Weight**: bold for headings, medium or normal for prose. Don't bold whole paragraphs.

### Color discipline
- Brand primary (`--primary`) is for **emphasis only**: one hero background, one CTA
  button, active table headers. Not for every heading and every accent simultaneously.
- Body text: `text-foreground` or `text-muted-foreground`. Never raw hex.
- Max **3 colors visible in any single section**. Background + foreground + one accent.
- When in doubt, use less color. Negative space reads as confidence.

### Spacing rhythm
- Use the 4/8/16/24/48px Tailwind scale: `p-1`, `p-2`, `p-4`, `p-6`, `p-12`.
- Section padding: `py-12` or `py-16` between major sections.
- Consistent `gap-6` or `gap-8` inside grids and KPI strips.
- Never mix spacing scales within the same section (e.g., `p-3` next to `p-8`).

### Negative space
Whitespace is a design element, not empty pixels. Err on the side of more.
- Don't fill every section edge-to-edge with content.
- A hero with 80% text and 20% breathing room reads better than one that's packed.
- `max-w-3xl mx-auto` on body text to keep line length comfortable.

### Alignment
- **Left-align by default** for all body prose and tables.
- **Center** only for: hero titles, standalone CTA buttons, page-level headers.
- Never center body paragraphs.

### One hero. One CTA.
- One `sec-hero` per document. It appears first.
- One `sec-cta` per document. It appears last (or second-to-last if followed by signoff).
- Duplicating heroes or CTAs dilutes impact.

### What to never do
- No purple gradients. No rainbow text.
- No `rounded-3xl` on everything. Reserve `rounded-full` for icons/avatars only.
- No "shadow-2xl" on flat card UI.
- No centering every single element on the page.
- No uniform card grids where every cell is identical height with the same icon + title + 3-line description. That is "feature page slop."
- No placeholder text: `{{NAME}}`, "Lorem ipsum", "TBD", "[insert here]". Real content only or skip the section.

---

## 4. Document Archetypes

These are **starting points**, not fixed templates. Read the user's intent and compose
the structure that best serves the content — not the archetype label.

### Report / Brief
Content: findings, analysis, data, insights.
Typical flow: `sec-hero` (title + 1-line summary) → `sec-kpi` (key numbers) →
`sec` body sections (each covering one finding) → `sec-quote` (key insight or
stakeholder quote) → `sec-signoff`.
Tone: concise, data-first. Tables over bullets when data is tabular.

### Proposal
Content: problem, approach, deliverables, price.
Typical flow: `sec-hero` (value proposition, not just a title) → `sec` (problem) →
`sec` (approach/methodology) → `sec-split` (deliverables + timeline side-by-side) →
`sec-table` (pricing) → `sec-cta` ("Let's get started") → `sec-signoff`.
Tone: confident, outcome-oriented. Lead with results, not process.

### Flyer / Listing
Content: property or service details, key facts, imagery.
Typical flow: `sec-hero` (large image + title + price) → `sec-kpi` (beds/baths/sqft
or equivalent spec strip) → `sec-split` (description left, features list right) →
`sec-cta` (contact / schedule showing).
Tone: concise, visual. Short labels, not paragraphs.

### Letter
Content: formal written correspondence.
Typical flow: `doc-header` (company logo + date) → `sec` (recipient address block) →
`sec` (body paragraphs, 3–5 max) → `sec-signoff` (name, title, signature line).
Tone: professional but not stiff. One clear ask per letter.

### Invoice
Content: billing, line items, totals, payment terms.
Typical flow: `doc-header` (company + invoice number + date) → `sec-split` (bill-to
left, payment details right) → `sec-table` (line items with qty/rate/amount) →
`sec` (totals block — subtotal, tax, total due, styled with emphasis) → `sec` (payment
terms / notes).
Tone: clean, factual. Numbers must be right.

**Remember:** the agent picks composition based on intent. If someone asks for a
"marketing one-pager," it should read like a flyer even if they didn't say "flyer."
If someone asks for a "project recap," it's a report. Use judgment.

---

## 5. Stable ID Discipline

Every top-level section and every editable leaf **must** have a stable `id` attribute.
IDs are what make `patch_document` work. Without them, the agent cannot target
specific elements for scoped edits.

Rules:
- Sections: `id="hero"`, `id="kpi-strip"`, `id="problem"`, `id="approach"`,
  `id="pricing"`, `id="cta"`, `id="signoff"`. Use semantic names, not `id="s1"`.
- Editable leaves: `id="hero-title"`, `id="hero-lede"`, `id="kpi-revenue"`,
  `id="kpi-revenue-label"`, etc.
- IDs must be **unique per document**. No two elements may share the same id.
- IDs must be **stable** — the agent assigned them on `write_document` and will
  reference them in future `patch_document` calls. Don't change them on rewrites.
- Use `id="doc"` as the synthetic target for `patch_document` `set_theme` op
  (no actual element needs this id — it's a convention for the tool).

---

## 6. Brand Kit Integration

On every new document:
1. Read the user's brand settings: `brand_primary`, `brand_secondary`,
   `brand_company`, `brand_logo`.
2. Map to theme:
   - `brand_primary` → `primary` (and derive a readable `primary-foreground`)
   - `brand_secondary` → `secondary` (if set)
   - `brand_company` → `footerText` (company name in footer) and doc header
   - `brand_logo` → `logoDataUri` (render in `doc-header` as `<img>`)
3. Pass the theme partial to `write_document` as the `theme` argument.
4. Do NOT override brand colors unless the user explicitly asks ("make it green").
5. If the brand has no primary color set, default to `#1a2744` (dark navy — safe
   neutral that works across verticals).

---

## 7. Complete Example Documents

These examples use the same brand theme to show how different archetypes compose
differently with the same visual identity.

**Shared theme** (used in all examples):
- primary: `#1a2744` (dark navy)
- primary-foreground: `#ffffff`
- background: `#ffffff`
- foreground: `#111111`
- muted: `#f4f4f5`
- muted-foreground: `#71717a`
- border: `#e4e4e7`
- radius: `0.5rem`

---

### Example A — Proposal

```html
<div class="doc" style="--background:#ffffff;--foreground:#111111;--primary:#1a2744;--primary-foreground:#ffffff;--muted:#f4f4f5;--muted-foreground:#71717a;--secondary:#6b7280;--secondary-foreground:#ffffff;--accent:#e11d48;--accent-foreground:#ffffff;--border:#e4e4e7;--radius:0.5rem;">
  <div class="doc-page">
    <header class="doc-header flex items-center justify-between px-12 py-8 border-b border-border">
      <p id="company-name" class="ed-eyebrow text-sm font-semibold tracking-widest uppercase text-muted-foreground">Acme Creative</p>
      <p id="doc-date" class="ed-body text-sm text-muted-foreground">April 2026</p>
    </header>

    <main class="doc-body">
      <section id="hero" class="sec-hero bg-primary text-primary-foreground px-12 py-20">
        <p id="hero-eyebrow" class="ed-eyebrow text-sm font-semibold tracking-widest uppercase mb-4 opacity-70">Website Redesign Proposal</p>
        <h1 id="hero-title" class="ed-title text-4xl font-bold leading-tight max-w-2xl mb-6">A faster, clearer site that converts visitors into clients</h1>
        <p id="hero-lede" class="ed-lede text-lg opacity-80 max-w-xl">Prepared for Northlight Consulting — April 8, 2026</p>
      </section>

      <section id="problem" class="sec px-12 py-16 max-w-3xl mx-auto">
        <p id="problem-eyebrow" class="ed-eyebrow text-xs font-semibold tracking-widest uppercase text-muted-foreground mb-3">The Problem</p>
        <h2 id="problem-title" class="ed-title text-xl font-bold text-foreground mb-4">Your current site is losing leads before they call</h2>
        <p id="problem-body" class="ed-body text-base text-foreground leading-relaxed">Northlight's homepage takes 5+ seconds to load on mobile and buries the service menu three clicks deep. Visitors who can't find what they need within 8 seconds leave — and 62% of your traffic is mobile. The opportunity cost is measurable.</p>
      </section>

      <section id="approach" class="sec px-12 py-16 bg-muted">
        <div class="max-w-3xl mx-auto">
          <p id="approach-eyebrow" class="ed-eyebrow text-xs font-semibold tracking-widest uppercase text-muted-foreground mb-3">Our Approach</p>
          <h2 id="approach-title" class="ed-title text-xl font-bold text-foreground mb-8">Three phases, twelve weeks</h2>
          <div id="phases" class="sec-split grid grid-cols-2 gap-8">
            <div>
              <p id="phase1-label" class="ed-eyebrow text-xs font-semibold uppercase tracking-widest text-primary mb-2">Phase 1 — Weeks 1–4</p>
              <p id="phase1-body" class="ed-body text-base text-foreground leading-relaxed">Discovery, sitemap, and wireframes. We interview three of your best clients to understand what they searched for and what made them call.</p>
            </div>
            <div>
              <p id="phase2-label" class="ed-eyebrow text-xs font-semibold uppercase tracking-widest text-primary mb-2">Phase 2–3 — Weeks 5–12</p>
              <p id="phase2-body" class="ed-body text-base text-foreground leading-relaxed">Design, development, and launch. Mobile-first, sub-2s load time, SEO-clean markup. Includes one round of revisions and a 30-day post-launch support window.</p>
            </div>
          </div>
        </div>
      </section>

      <section id="pricing" class="sec-table px-12 py-16 max-w-3xl mx-auto">
        <p id="pricing-eyebrow" class="ed-eyebrow text-xs font-semibold tracking-widest uppercase text-muted-foreground mb-6">Investment</p>
        <table class="w-full border-collapse text-sm">
          <thead>
            <tr class="bg-primary text-primary-foreground">
              <th class="ed-cell text-left px-4 py-3 font-semibold">Deliverable</th>
              <th class="ed-cell text-right px-4 py-3 font-semibold">Fee</th>
            </tr>
          </thead>
          <tbody>
            <tr class="border-b border-border">
              <td id="row1-item" class="ed-cell px-4 py-3 text-foreground">Discovery + Strategy</td>
              <td id="row1-fee" class="ed-cell px-4 py-3 text-right text-foreground">$3,500</td>
            </tr>
            <tr class="border-b border-border">
              <td id="row2-item" class="ed-cell px-4 py-3 text-foreground">Design + Development</td>
              <td id="row2-fee" class="ed-cell px-4 py-3 text-right text-foreground">$11,000</td>
            </tr>
            <tr class="border-b border-border">
              <td id="row3-item" class="ed-cell px-4 py-3 text-foreground">30-Day Support</td>
              <td id="row3-fee" class="ed-cell px-4 py-3 text-right text-foreground">Included</td>
            </tr>
            <tr class="bg-muted font-semibold">
              <td id="total-label" class="ed-cell px-4 py-3 text-foreground">Total</td>
              <td id="total-amount" class="ed-cell px-4 py-3 text-right text-foreground">$14,500</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section id="cta" class="sec-cta text-center px-12 py-20 bg-primary text-primary-foreground">
        <h2 id="cta-title" class="ed-title text-2xl font-bold mb-4">Ready to get started?</h2>
        <p id="cta-body" class="ed-body text-base opacity-80 mb-8 max-w-md mx-auto">Reply to this proposal or book a 30-minute call. We can begin within two weeks of agreement.</p>
        <p id="cta-contact" class="ed-body text-sm font-semibold tracking-wide">hello@acmecreative.com · (555) 800-1234</p>
      </section>

      <section id="signoff" class="sec-signoff px-12 py-12 max-w-3xl mx-auto">
        <p id="sig-name" class="ed-signature text-base font-semibold text-foreground">Jordan Riley</p>
        <p id="sig-title" class="ed-signature text-sm text-muted-foreground">Principal Designer, Acme Creative</p>
        <p id="sig-date" class="ed-signature text-sm text-muted-foreground mt-1">April 8, 2026</p>
      </section>
    </main>

    <footer class="doc-footer px-12 py-6 border-t border-border flex justify-between text-xs text-muted-foreground">
      <p id="footer-company" class="ed-body">Acme Creative · acmecreative.com</p>
      <p id="footer-note" class="ed-body">Confidential — prepared for Northlight Consulting</p>
    </footer>
  </div>
</div>
```

---

### Example B — Property Flyer

```html
<div class="doc" style="--background:#ffffff;--foreground:#111111;--primary:#1a2744;--primary-foreground:#ffffff;--muted:#f4f4f5;--muted-foreground:#71717a;--secondary:#6b7280;--secondary-foreground:#ffffff;--accent:#e11d48;--accent-foreground:#ffffff;--border:#e4e4e7;--radius:0.5rem;">
  <div class="doc-page">
    <header class="doc-header flex items-center justify-between px-10 py-6 bg-primary text-primary-foreground">
      <p id="agent-name" class="ed-eyebrow text-sm font-semibold tracking-wider uppercase">Sarah Chen · Licensed Realtor</p>
      <p id="brokerage" class="ed-body text-sm opacity-80">Compass · DRE #02134567</p>
    </header>

    <main class="doc-body">
      <section id="hero" class="sec-hero relative bg-muted overflow-hidden" style="min-height:320px;">
        <div class="absolute inset-0 bg-primary opacity-60"></div>
        <div class="relative px-10 py-16 text-primary-foreground">
          <p id="status-badge" class="ed-eyebrow inline-block text-xs font-bold tracking-widest uppercase bg-accent text-accent-foreground px-3 py-1 mb-6" style="border-radius:var(--radius);">Just Listed</p>
          <h1 id="address" class="ed-title text-4xl font-bold leading-tight mb-2">742 Evergreen Terrace</h1>
          <p id="city-state" class="ed-lede text-lg opacity-90 mb-6">Springfield, IL 62701</p>
          <p id="price" class="ed-stat-value text-3xl font-bold">$649,000</p>
        </div>
      </section>

      <section id="specs" class="sec-kpi grid grid-cols-4 divide-x divide-border bg-muted">
        <div class="px-6 py-5 text-center">
          <p id="beds-value" class="ed-stat-value text-2xl font-bold text-foreground">4</p>
          <p id="beds-label" class="ed-stat-label text-xs text-muted-foreground uppercase tracking-wide mt-1">Bedrooms</p>
        </div>
        <div class="px-6 py-5 text-center">
          <p id="baths-value" class="ed-stat-value text-2xl font-bold text-foreground">3</p>
          <p id="baths-label" class="ed-stat-label text-xs text-muted-foreground uppercase tracking-wide mt-1">Bathrooms</p>
        </div>
        <div class="px-6 py-5 text-center">
          <p id="sqft-value" class="ed-stat-value text-2xl font-bold text-foreground">2,410</p>
          <p id="sqft-label" class="ed-stat-label text-xs text-muted-foreground uppercase tracking-wide mt-1">Sq Ft</p>
        </div>
        <div class="px-6 py-5 text-center">
          <p id="lot-value" class="ed-stat-value text-2xl font-bold text-foreground">0.28</p>
          <p id="lot-label" class="ed-stat-label text-xs text-muted-foreground uppercase tracking-wide mt-1">Acres</p>
        </div>
      </section>

      <section id="details" class="sec-split grid grid-cols-2 gap-12 px-10 py-14">
        <div>
          <p id="desc-eyebrow" class="ed-eyebrow text-xs font-semibold tracking-widest uppercase text-muted-foreground mb-3">About This Home</p>
          <p id="desc-body" class="ed-body text-base text-foreground leading-relaxed">A rare corner-lot colonial in Springfield's most walkable neighborhood. Fully renovated kitchen (2024), open-plan living, and a private backyard backing a mature tree line. Top-rated Lincoln Elementary district.</p>
        </div>
        <div>
          <p id="feat-eyebrow" class="ed-eyebrow text-xs font-semibold tracking-widest uppercase text-muted-foreground mb-3">Key Features</p>
          <ul class="space-y-2 text-sm text-foreground">
            <li id="feat-1" class="ed-body">Quartz countertops, stainless appliances, island seating</li>
            <li id="feat-2" class="ed-body">Primary suite with dual walk-in closets</li>
            <li id="feat-3" class="ed-body">2-car attached garage + finished basement</li>
            <li id="feat-4" class="ed-body">New HVAC (2023), roof (2021), windows (2022)</li>
          </ul>
        </div>
      </section>

      <section id="cta" class="sec-cta text-center px-10 py-12 bg-primary text-primary-foreground">
        <h2 id="cta-title" class="ed-title text-xl font-bold mb-3">Schedule a private showing</h2>
        <p id="cta-contact" class="ed-body text-base opacity-90">Sarah Chen · (217) 555-0192 · sarah@compass.com</p>
      </section>
    </main>

    <footer class="doc-footer px-10 py-5 border-t border-border text-xs text-muted-foreground text-center">
      <p id="footer-disclaimer" class="ed-body">Information deemed reliable but not guaranteed. Equal Housing Opportunity. Compass Real Estate.</p>
    </footer>
  </div>
</div>
```

---

### Example C — Consulting Report

```html
<div class="doc" style="--background:#ffffff;--foreground:#111111;--primary:#1a2744;--primary-foreground:#ffffff;--muted:#f4f4f5;--muted-foreground:#71717a;--secondary:#6b7280;--secondary-foreground:#ffffff;--accent:#e11d48;--accent-foreground:#ffffff;--border:#e4e4e7;--radius:0.5rem;">
  <div class="doc-page">
    <header class="doc-header flex items-center justify-between px-12 py-8 border-b border-border">
      <div>
        <p id="company-name" class="ed-eyebrow text-sm font-bold tracking-widest uppercase text-primary">Acme Consulting</p>
        <p id="report-label" class="ed-body text-xs text-muted-foreground mt-1">Q1 2026 Performance Report</p>
      </div>
      <p id="report-date" class="ed-body text-sm text-muted-foreground">April 8, 2026</p>
    </header>

    <main class="doc-body">
      <section id="hero" class="sec-hero px-12 py-16">
        <p id="hero-eyebrow" class="ed-eyebrow text-xs font-semibold tracking-widest uppercase text-muted-foreground mb-4">Prepared for Northlight Consulting</p>
        <h1 id="hero-title" class="ed-title text-4xl font-bold text-foreground leading-tight max-w-2xl mb-4">Q1 grew 34% — three markets are ready to scale</h1>
        <p id="hero-lede" class="ed-lede text-lg text-muted-foreground max-w-xl">Revenue up, customer acquisition cost down, two product lines outperforming forecast. One underperformer needs a decision by end of April.</p>
      </section>

      <section id="kpis" class="sec-kpi grid grid-cols-4 bg-muted border-y border-border">
        <div class="px-8 py-6 border-r border-border">
          <p id="rev-value" class="ed-stat-value text-3xl font-bold text-foreground">$2.4M</p>
          <p id="rev-label" class="ed-stat-label text-xs text-muted-foreground uppercase tracking-wide mt-2">Q1 Revenue</p>
          <p id="rev-delta" class="ed-body text-xs text-accent font-semibold mt-1">+34% YoY</p>
        </div>
        <div class="px-8 py-6 border-r border-border">
          <p id="cac-value" class="ed-stat-value text-3xl font-bold text-foreground">$312</p>
          <p id="cac-label" class="ed-stat-label text-xs text-muted-foreground uppercase tracking-wide mt-2">Avg CAC</p>
          <p id="cac-delta" class="ed-body text-xs text-accent font-semibold mt-1">–18% vs Q4</p>
        </div>
        <div class="px-8 py-6 border-r border-border">
          <p id="nps-value" class="ed-stat-value text-3xl font-bold text-foreground">71</p>
          <p id="nps-label" class="ed-stat-label text-xs text-muted-foreground uppercase tracking-wide mt-2">NPS Score</p>
          <p id="nps-delta" class="ed-body text-xs text-muted-foreground font-semibold mt-1">+4 pts</p>
        </div>
        <div class="px-8 py-6">
          <p id="churn-value" class="ed-stat-value text-3xl font-bold text-foreground">1.8%</p>
          <p id="churn-label" class="ed-stat-label text-xs text-muted-foreground uppercase tracking-wide mt-2">Monthly Churn</p>
          <p id="churn-delta" class="ed-body text-xs text-accent font-semibold mt-1">–0.4 pts</p>
        </div>
      </section>

      <section id="finding-1" class="sec px-12 py-14 max-w-3xl mx-auto border-b border-border">
        <p id="f1-eyebrow" class="ed-eyebrow text-xs font-semibold tracking-widest uppercase text-primary mb-3">Finding 01</p>
        <h2 id="f1-title" class="ed-title text-xl font-bold text-foreground mb-4">Enterprise is the growth engine — SMB needs a decision</h2>
        <p id="f1-body" class="ed-body text-base text-foreground leading-relaxed mb-6">Enterprise segment grew 61% in Q1, now representing 58% of total revenue. The SMB tier grew just 4% and the unit economics no longer support the current support overhead. Recommendation: migrate SMB accounts to a self-serve tier or sunset by Q3.</p>
      </section>

      <section id="quote" class="sec-quote px-12 py-12 border-l-4 border-primary bg-muted mx-12 my-8">
        <blockquote>
          <p id="quote-text" class="ed-lede text-xl italic text-foreground leading-relaxed">"The enterprise wins in Q1 weren't luck — they reflect a product that finally matches the buyer's workflow. The question is whether we capitalize before a competitor does."</p>
          <p id="quote-attr" class="ed-signature text-sm text-muted-foreground mt-4">— VP of Product, Northlight Consulting</p>
        </blockquote>
      </section>

      <section id="signoff" class="sec-signoff px-12 py-12 max-w-3xl mx-auto">
        <p id="sig-name" class="ed-signature text-base font-semibold text-foreground">Alex Morgan</p>
        <p id="sig-title" class="ed-signature text-sm text-muted-foreground">Senior Consultant, Acme Consulting</p>
        <p id="sig-date" class="ed-signature text-sm text-muted-foreground mt-1">April 8, 2026</p>
      </section>
    </main>

    <footer class="doc-footer px-12 py-6 border-t border-border flex justify-between text-xs text-muted-foreground">
      <p id="footer-firm" class="ed-body">Acme Consulting · Q1 2026 Report</p>
      <p id="footer-page" class="ed-body">Confidential</p>
    </footer>
  </div>
</div>
```

---

### Example D — Client Letter

```html
<div class="doc" style="--background:#ffffff;--foreground:#111111;--primary:#1a2744;--primary-foreground:#ffffff;--muted:#f4f4f5;--muted-foreground:#71717a;--secondary:#6b7280;--secondary-foreground:#ffffff;--accent:#e11d48;--accent-foreground:#ffffff;--border:#e4e4e7;--radius:0.5rem;">
  <div class="doc-page max-w-2xl mx-auto">
    <header class="doc-header flex items-start justify-between px-0 pt-12 pb-8 border-b border-border mb-10">
      <div>
        <p id="sender-company" class="ed-eyebrow text-sm font-bold tracking-widest uppercase text-primary">Acme Creative</p>
        <p id="sender-address" class="ed-body text-xs text-muted-foreground mt-1">123 Studio Lane · Chicago, IL 60601</p>
      </div>
      <p id="letter-date" class="ed-body text-sm text-muted-foreground">April 8, 2026</p>
    </header>

    <main class="doc-body px-0">
      <section id="recipient" class="sec mb-8">
        <p id="recipient-name" class="ed-body text-sm font-semibold text-foreground">Ms. Laura Merritt</p>
        <p id="recipient-co" class="ed-body text-sm text-foreground">Northlight Consulting</p>
        <p id="recipient-address" class="ed-body text-sm text-muted-foreground">200 W Monroe St · Springfield, IL 62701</p>
      </section>

      <section id="salutation" class="sec mb-6">
        <p id="salutation-text" class="ed-body text-base text-foreground">Dear Laura,</p>
      </section>

      <section id="body-paras" class="sec space-y-5 mb-10">
        <p id="para-1" class="ed-body text-base text-foreground leading-relaxed">Thank you for the opportunity to present our website redesign proposal. We've worked with a number of professional services firms in the Midwest and believe the approach we've outlined — discovery-first, mobile-priority, client-voice-driven — is the right fit for where Northlight is headed.</p>
        <p id="para-2" class="ed-body text-base text-foreground leading-relaxed">The investment reflects a project scope we can deliver in 12 weeks without subcontracting. Every element from discovery through launch is handled in-house, which means one point of contact for you and no handoff delays between teams.</p>
        <p id="para-3" class="ed-body text-base text-foreground leading-relaxed">If you'd like to discuss any part of the proposal before deciding, I'm available Thursday or Friday this week. A 30-minute call is usually enough to answer the main questions.</p>
      </section>

      <section id="closing" class="sec mb-10">
        <p id="closing-text" class="ed-body text-base text-foreground">Warm regards,</p>
      </section>

      <section id="signoff" class="sec-signoff">
        <p id="sig-name" class="ed-signature text-base font-semibold text-foreground">Jordan Riley</p>
        <p id="sig-title" class="ed-signature text-sm text-muted-foreground">Principal Designer</p>
        <p id="sig-co" class="ed-signature text-sm text-muted-foreground">Acme Creative · hello@acmecreative.com</p>
      </section>
    </main>
  </div>
</div>
```

---

## Quick Reference Checklist

Before emitting any HTML, verify:

- [ ] Root `.doc` element has all CSS variables set inline
- [ ] Every `.sec-*` has a unique, semantic `id`
- [ ] Every `.ed-*` leaf has a unique `id`
- [ ] No hardcoded hex colors in Tailwind classes (use token names)
- [ ] No placeholder text: `{{}}`, TBD, Lorem ipsum
- [ ] Max one `sec-hero` and one `sec-cta` per doc
- [ ] Body text is left-aligned; center reserved for hero + CTA only
- [ ] Brand kit values are reflected in the theme passed to `write_document`
- [ ] For `patch_document`, the `target_id` matches an `id` already in the doc
