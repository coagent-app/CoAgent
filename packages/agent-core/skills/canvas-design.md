# Canvas Design Skill

You are writing a Canvas — a live TSX React component rendered in a sandboxed
iframe. Read this entire file before calling `write_canvas`. Every rule exists
to prevent documents from looking generic, cloned, or "AI-generated slop."

A Canvas is what you use for **any** document the user wants to see as a
finished artifact: proposals, flyers, reports, one-pagers, dashboards, letters,
invoices, résumés, meeting notes, agendas. If the output has visual intent,
it's a Canvas.

---

## 1. The Runtime Environment

The `code` argument to `write_canvas` is a **full TSX module** ending in a
default-exported React component. It runs inside a same-origin iframe with:

- **React 18** + hooks (available as `React` and via `import`)
- **Tailwind CSS** via the Play CDN (all utility classes work)
- **recharts** for any chart (`import { LineChart, BarChart, PieChart, Line, Bar, Pie, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts'`)
- **lucide-react** for icons (`import { FileText, Mail, Check, ArrowRight, ... } from 'lucide-react'`)
- **`@brand` module** — the user's brand kit

**Nothing else.** No shadcn, no Radix, no Chart.js, no framer-motion, no router.
If you import from any other package the canvas will show a parse error.

### The `@brand` module

```tsx
import { brand, Logo, Signature } from '@brand'
```

- `brand.name` — user's company name (string, may be empty)
- `brand.logoUrl` — data URI or empty string if no logo uploaded
- `brand.primary` — hex color (required, e.g. `'#1a2744'`)
- `brand.secondary` — hex color or empty string
- `brand.tertiary` — hex color or empty string
- `brand.fontHeading` / `brand.fontBody` — CSS font stacks
- `<Logo />` — renders the logo, or falls back to the company name in primary
  color if no logo is set. Accepts `className` and `style`.
- `<Signature />` — renders the company name in the heading font + primary
  color. Use in letter signatures, footers, cover pages.

**Always use `brand.primary` for accents, headings, buttons, rules.** Never
hardcode colors like `text-blue-600`. If the user hasn't set a brand, the
defaults still work.

---

## 2. Module Shape

Every Canvas looks like this:

```tsx
import { brand, Logo } from '@brand'
import { FileText } from 'lucide-react'

export default function Invoice() {
  return (
    <div className="max-w-3xl mx-auto p-12 font-sans bg-white text-neutral-900">
      {/* content */}
    </div>
  )
}
```

Rules:
- Exactly one default export.
- The component takes no props.
- The outermost element **must** set a width, padding, and `bg-white`. The
  iframe body has a white background already, but an explicit wrapper is
  what makes the document feel like "paper" rather than a webpage.
- Use `max-w-3xl` (768px) as the default canvas width. Go wider (`max-w-5xl`)
  for dashboards with charts, narrower (`max-w-xl`) for letters and invoices.
- Use `mx-auto` to center.
- Use `p-12` (48px) as the default page padding. Never less than `p-8`.

---

## 3. Composition Recipes

### Invoice / Statement

```tsx
<div className="max-w-2xl mx-auto p-12 bg-white text-neutral-900">
  <header className="flex justify-between items-start mb-12">
    <Logo />
    <div className="text-right">
      <div className="text-[11px] uppercase tracking-widest text-neutral-500">Invoice</div>
      <div className="text-2xl font-semibold" style={{ color: brand.primary }}>#1032</div>
      <div className="text-sm text-neutral-500 mt-1">Mar 28, 2026</div>
    </div>
  </header>

  <section className="grid grid-cols-2 gap-8 mb-10 text-sm">
    <div>
      <div className="text-[10px] uppercase tracking-widest text-neutral-400 mb-1">From</div>
      <div className="font-medium">{brand.name}</div>
    </div>
    <div>
      <div className="text-[10px] uppercase tracking-widest text-neutral-400 mb-1">Bill To</div>
      <div className="font-medium">ACME Corp</div>
      <div className="text-neutral-500">billing@acme.com</div>
    </div>
  </section>

  <table className="w-full text-sm mb-10">
    <thead>
      <tr className="border-b-2" style={{ borderColor: brand.primary }}>
        <th className="text-left py-2 text-[10px] uppercase tracking-widest text-neutral-500">Item</th>
        <th className="text-right py-2 text-[10px] uppercase tracking-widest text-neutral-500">Qty</th>
        <th className="text-right py-2 text-[10px] uppercase tracking-widest text-neutral-500">Rate</th>
        <th className="text-right py-2 text-[10px] uppercase tracking-widest text-neutral-500">Amount</th>
      </tr>
    </thead>
    <tbody>
      {lineItems.map((item, i) => (
        <tr key={i} className="border-b border-neutral-100">
          <td className="py-3">{item.desc}</td>
          <td className="py-3 text-right">{item.qty}</td>
          <td className="py-3 text-right">${item.rate}</td>
          <td className="py-3 text-right font-medium">${item.qty * item.rate}</td>
        </tr>
      ))}
    </tbody>
  </table>

  <div className="flex justify-end">
    <div className="w-48">
      <div className="flex justify-between text-sm mb-2">
        <span className="text-neutral-500">Subtotal</span>
        <span>${subtotal}</span>
      </div>
      <div className="flex justify-between text-base font-semibold pt-2 border-t-2" style={{ borderColor: brand.primary }}>
        <span>Total</span>
        <span style={{ color: brand.primary }}>${total}</span>
      </div>
    </div>
  </div>
</div>
```

### Proposal / One-pager

- Lead with a hero: `<Logo />` top-left, title bottom-left, big number or tag
  bottom-right. Use `py-20` for vertical breathing room.
- Follow with a 2-column problem/solution section (`grid grid-cols-2 gap-12`).
- Use a KPI row: 3 or 4 cells, each with a big number in `brand.primary` and a
  one-line caption underneath in `text-[11px] uppercase tracking-widest`.
- Close with a dark CTA section: `bg-neutral-900 text-white p-12 rounded-lg`,
  tagline + next-steps list.

### Report with charts

Always wrap recharts in a fixed-height div, **never** use `ResponsiveContainer`
inside a scrolling parent — the iframe resize will feed back into recharts and
cause runaway layout.

```tsx
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'

<div style={{ width: '100%', height: 280 }}>
  <LineChart width={640} height={260} data={data} margin={{ top: 16, right: 24, bottom: 16, left: 8 }}>
    <CartesianGrid stroke="#f0f0f0" strokeDasharray="3 3" />
    <XAxis dataKey="month" stroke="#999" fontSize={11} />
    <YAxis stroke="#999" fontSize={11} />
    <Tooltip />
    <Line type="monotone" dataKey="revenue" stroke={brand.primary} strokeWidth={2} dot={{ r: 3 }} />
  </LineChart>
</div>
```

### Letter

- `max-w-xl` (576px) — letters are narrow.
- `<Logo />` top, date right-aligned below it.
- Recipient block, then body paragraphs with `leading-relaxed`.
- Close with `<Signature />`.

---

## 4. Typography & Spacing Rules

- **Never** use Tailwind's default `text-base` for body copy in a document —
  it reads as "webpage." Use `text-[14px]` or `text-[15px]` with `leading-relaxed`.
- Headings: `text-3xl` or `text-4xl` for titles, `font-semibold` (not `font-bold`),
  always colored with `style={{ color: brand.primary }}`.
- Eyebrow text (the tiny label above a heading): `text-[10px] uppercase tracking-widest text-neutral-500`.
- Section gaps: use `mb-10` or `mb-12` between sections, **never** `mb-4`. If
  sections feel cramped, the document looks generic.
- Tables: `border-b-2` on the header row using `brand.primary`, `border-b border-neutral-100`
  between rows. No zebra striping.
- Rules & dividers: `border-t-2` with `brand.primary` for strong separators,
  `border-t border-neutral-200` for soft ones.

---

## 5. Hard Rules

1. **One default export.** No named exports, no multiple components at the top
   level. You can define helper components inside the file, but only one is
   exported.
2. **No external state.** No `useState` for data that isn't UI-internal — all
   content must be hardcoded strings/objects in the component body. The user
   never interacts with the canvas directly; they ask you to regenerate or
   patch it.
3. **No `fetch`, no `setTimeout`, no effects that hit the network.** The
   iframe is sandboxed and these will either silently fail or error.
4. **No inline SVG larger than a glyph.** Use lucide-react icons. If the user
   asks for an illustration, use a bold typographic treatment instead.
5. **No `dangerouslySetInnerHTML`.** Ever.
6. **No images via URL.** The only image you can use is `<Logo />`. If the
   user uploads a specific image, they'll reference it by filename and you'll
   skip the image (write a placeholder caption instead). In v1 there is no
   image upload-to-canvas flow.
7. **Colors come from `brand`.** Never hardcode `text-blue-600`, `bg-red-500`,
   etc. Use `brand.primary` for accents and Tailwind's neutral scale for text
   and borders.
8. **Width is fixed.** Outermost wrapper sets a `max-w-*` — don't try to be
   responsive beyond that. The canvas renders at one size.

---

## 6. Workflow

1. User asks for a document.
2. Think about which recipe fits (invoice / proposal / report / letter / custom).
3. Pull specifics from the conversation (names, numbers, dates, line items).
4. Call `write_canvas` with a full TSX module. The code streams to the user
   in real time — they watch it materialize.
5. If the user asks for edits, call `patch_canvas` with the full updated code
   and the existing `canvas_id`.

**Never call `write_canvas` with placeholder lorem ipsum.** If you don't have
the details, ask the user first.

**Never call `write_canvas` twice in one turn.** One document per request.

---

## 7. When NOT to use a Canvas

- Plain chat answers ("what's the capital of France")
- Short lists or bullet points inside a chat response
- Code snippets the user is going to paste elsewhere
- Anything the user explicitly asks to be in the chat itself

Use a Canvas when the user says "make me a…", "draft a…", "write up a…",
"put together a…", or when they'd clearly want to export a PDF at the end.
