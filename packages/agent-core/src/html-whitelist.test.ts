import { describe, it, expect } from 'vitest'
import { validateHtml } from './html-whitelist.js'

// ── Sample valid HTML ──────────────────────────────────────────────────────

const VALID_PROPOSAL = `
<div class="doc">
  <div class="doc-page">
    <div class="doc-header">
      <h1 class="ed-title">Marketing Proposal</h1>
      <p class="ed-eyebrow">Q2 2026</p>
    </div>
    <div class="doc-body">
      <section class="sec-hero" id="s1">
        <h2 class="ed-title">Grow Your Pipeline</h2>
        <p class="ed-lede">A focused growth program built for you.</p>
      </section>
      <div class="sec-kpi" id="s2">
        <div>
          <span class="ed-stat-value">3x</span>
          <span class="ed-stat-label">Lead Growth</span>
        </div>
        <div>
          <span class="ed-stat-value">$120k</span>
          <span class="ed-stat-label">Expected Revenue</span>
        </div>
        <div>
          <span class="ed-stat-value">90</span>
          <span class="ed-stat-label">Days to Results</span>
        </div>
      </div>
      <div class="sec-split" id="s3">
        <div>
          <p class="ed-body">We focus on high-intent search channels.</p>
        </div>
        <div>
          <p class="ed-body">Your brand, amplified across the right audiences.</p>
        </div>
      </div>
    </div>
    <div class="doc-footer">
      <p class="ed-signature">Brett Ponters, CoAgent</p>
    </div>
  </div>
</div>
`

// ── Tests ─────────────────────────────────────────────────────────────────

describe('validateHtml', () => {
  it('accepts a valid full-doc HTML with hero, kpi, split sections', () => {
    const result = validateHtml(VALID_PROPOSAL)
    expect(result.ok).toBe(true)
  })

  it('rejects an unknown tag (<marquee>)', () => {
    const html = `<div class="doc"><marquee>Flash sale!</marquee></div>`
    const result = validateHtml(html)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('disallowed_tag')
      expect(result.detail).toMatch(/marquee/)
    }
  })

  it('rejects a disallowed class (completely unknown, no whitelisted prefix)', () => {
    // "rainbow" has no whitelisted prefix — it is not doc/sec-/ed-/text-/bg-/etc.
    const html = `<div class="doc"><p class="rainbow danger">Hello</p></div>`
    const result = validateHtml(html)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('disallowed_class')
      expect(result.detail).toMatch(/rainbow/)
    }
  })

  it('rejects an inline event handler (onclick) on an otherwise-allowed tag', () => {
    // Use <div> (allowed tag) to ensure the rejection is from the attribute, not the tag.
    const html = `<div class="doc"><div onclick="alert(1)" class="sec">Click me</div></div>`
    const result = validateHtml(html)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('disallowed_attribute')
      expect(result.detail).toMatch(/onclick/i)
    }
  })

  it('rejects a javascript: url in href', () => {
    const html = `<div class="doc"><a href="javascript:alert(1)">XSS</a></div>`
    const result = validateHtml(html)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('disallowed_url')
    }
  })

  it('rejects a <script> tag', () => {
    const html = `<div class="doc"><script>alert(1)</script></div>`
    const result = validateHtml(html)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('disallowed_tag')
      expect(result.detail).toMatch(/script/)
    }
  })

  it('allows Tailwind layout utility classes (p-4, bg-primary, grid-cols-3)', () => {
    const html = `<div class="doc"><div class="grid grid-cols-3 gap-6 p-4 bg-primary text-primary-foreground rounded">Content</div></div>`
    const result = validateHtml(html)
    expect(result.ok).toBe(true)
  })

  it('allows editable leaf classes (ed-title)', () => {
    const html = `<div class="doc"><h1 class="ed-title" id="t1">My Title</h1></div>`
    const result = validateHtml(html)
    expect(result.ok).toBe(true)
  })

  it('allows valid http href links', () => {
    const html = `<div class="doc"><a href="https://coagent.ai">Visit</a></div>`
    const result = validateHtml(html)
    expect(result.ok).toBe(true)
  })

  it('rejects inline style attributes', () => {
    const html = `<div class="doc"><p style="color: red">Hello</p></div>`
    const result = validateHtml(html)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('disallowed_attribute')
      expect(result.detail).toMatch(/style/)
    }
  })

  it('rejects <iframe>', () => {
    const html = `<div class="doc"><iframe src="https://evil.com"></iframe></div>`
    const result = validateHtml(html)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('disallowed_tag')
    }
  })

  it('allows sec-* section classes', () => {
    const html = `<div class="doc"><section class="sec-hero mb-12"><h1 class="ed-title">Hero</h1></section></div>`
    const result = validateHtml(html)
    expect(result.ok).toBe(true)
  })

  it('allows data-editable attribute', () => {
    const html = `<div class="doc"><h1 class="ed-title" data-editable id="h1">Title</h1></div>`
    const result = validateHtml(html)
    expect(result.ok).toBe(true)
  })

  it('rejects unknown attribute (data-custom-evil)', () => {
    const html = `<div class="doc"><p data-custom-evil="yes">Hello</p></div>`
    const result = validateHtml(html)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('disallowed_attribute')
    }
  })
})
