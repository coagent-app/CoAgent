# AI-Native Document & Presentation Platforms — Competitive Intelligence

**Date:** 2026-04-07
**Scope:** Data model, template/variation strategy, AI generation flow, rendering tech, anti-patterns
**Platforms:** Gamma, Tome, Beautiful.ai, Notion AI, Canva Magic Design, Pitch, Decktopus, SlidesAI

---

## 1. Gamma (gamma.app)

### Data model
Gamma's primitive is the **card** — not a fixed slide. Per Gamma's own help center, cards are "the fundamental building blocks of your presentations, documents, or webpages — each acting like a flexible slide, section, or canvas." Cards are stacked vertically in a scrollable list (web-document-like) by default but can be locked to 16:9 aspect ratios when needed.

Inside cards, content is composed of **blocks** — text, image, chart, embed, layout-block, etc. — that can be inserted via slash commands (`/`). Cards support nesting (nested cards, toggles) and "smart layout templates" for timelines, columns, and galleries.

- **Linear or canvas?** Linear list of cards; each card is content-first and grows in height to fit content.
- **Nesting?** Yes — blocks inside cards, nested cards, toggles.
- **Layouts?** Hybrid: declarative responsive web layout + a library of "card layouts" (image left, image right, gallery, timeline, etc.) the user or AI picks.
- **Z-index/overlap?** No general overlap; cards are flow-based (CSS-grid-style), not free-form canvas.
- **Content vs layout?** Content lives in blocks; layout is a property of the card and can be swapped via "Remix."

### Template / variation strategy
Hybrid auto-layout + theme library. Per third-party reviews: *"Gamma orchestrates over 20 advanced AI models... to write text, generate images, and build structural layouts simultaneously"* and *"The AI pulls from different layout types (timelines, icon grids, image galleries, bullet lists) and varies the structure across Gamma slides to prevent monotony."* Themes (100+) supply colors, fonts, accent images, and a unified palette is enforced across slides including AI-generated images.

### AI generation flow
Four entry points: one-line prompt, paste outline, upload doc (PDF/DOCX/PPTX), or import URL. User picks output (Presentation / Document / Webpage / Social) and a theme. Generation runs ~30–60s for ~15 cards. Iteration is supported card-by-card via the "Agent" feature ("Imagine" is the AI design canvas). Multi-model orchestration (Claude, GPT, DALL-E, Gemini, Flux, Luma).

### Rendering technology
Browser-based, web-native (responsive HTML/CSS), built on responsive web-design principles so output adapts from phone to ultrawide without manual resizing. PDF export is reasonably reliable; **PPTX export is notoriously poor** because dynamic vertical web cards don't map to fixed 16:9 boxes — third-party reviewers report *"text shifting, spacing changing, and formatting often requiring manual cleanup"* and *"all embedded content becomes static images when exporting to PowerPoint."*

### What keeps output non-formulaic
1. Auto-varied card layouts across a deck (the AI deliberately mixes timeline / grid / gallery / two-column / hero).
2. Cards grow to fit content (no awkward whitespace or text overflow).
3. Theme palette + AI image generation harmonized to the palette.
4. Web-native (no slide-shaped constraints).

**Sources:** [Gamma developer docs](https://developers.gamma.app), [What are cards in Gamma](https://help.gamma.app/en/articles/11016396-what-are-cards-in-gamma-and-how-to-do-they-work), [Editing/designing collection](https://help.gamma.app/en/collections/12178871-editing-designing-formatting-in-gamma), [Gamma alternatives review (Alai)](https://getalai.com/blog/gamma-alternatives), [SketchBubble Gamma deep dive](https://www.sketchbubble.com/blog/gamma-explained-a-comprehensive-deep-dive-into-the-ai-powered-presentation-platform/), [Lenny's Newsletter on Gamma](https://www.lennysnewsletter.com/p/how-50-people-built-a-profitable-ai-unicorn).

---

## 2. Tome (tome.app)

### Data model
Tome's primitive was the **tile** (a flexible non-16:9 frame). Layout was driven by a **constraint solver assembling everything inside a responsive CSS grid** so content would reflow across devices. Per a third-party engineering review: *"A diffusion cluster running Stable Diffusion 3 renders bespoke imagery, while a constraint-solver assembles everything inside a responsive CSS grid so the same story reads cleanly on phones or 4K monitors."*

- **Linear or canvas?** Linear sequence of tiles; tiles use percentage-based positioning, not pixels.
- **Nesting?** Limited — tiles contain blocks (text, image, embed), no deep nesting.
- **Layouts?** Generative — *"a proprietary 'layout interpreter,' introduced in October 2023, that rewrites GPT output into abstract layout tokens before anything touches the rendering layer."*
- **Content vs layout?** Decoupled — GPT emits a JSON plan, the interpreter converts it to layout tokens, then the renderer paints.

### Template / variation strategy
**Generative + token-based.** Tome did not have a hand-crafted template gallery the way Beautiful.ai does. Instead, the layout interpreter produced "abstract layout tokens" (color, spacing ratios, font scales) that the renderer composed at draw time. This is the most "from-scratch" approach in this set.

### AI generation flow
*"User intent, audience, and tonal guidance flow into a GPT-4o fine-tune that returns a JSON plan: slide intents, textual scaffolding, alt-text, and layout constraints."* GPT-4 generated narrative prose; Stable Diffusion XL generated artwork in parallel. Brand metadata (palette, logo ratios, font stacks) was injected at render time.

Latency optimization: the layout interpreter dropped generation time from ~34s to ~13s for a 10-tile deck.

### Rendering technology
**WebGL canvas** with relative percentage positioning. Server transmitted lightweight JSON scene graphs to clients rather than image streams.

### Why Tome failed (critical for CoAgent)
Tome **shut down its presentation product in March 2025** after laying off ~1/3 of staff in October 2024. The narrative-first / WebGL approach hit fatal limitations:

- *"Users couldn't export to PowerPoint or present in standard formats, limiting adoption in corporate settings."*
- *"Tome could create content fast. But it lacked the detailed control users needed to make their slides look great."* — design inflexibility
- *"AI-generated narratives often contained errors or lacked nuance, requiring heavy manual revision that negated time savings."*
- CEO Keith Peiris: *"It becomes really hard trying to build a consumer product for millions of people and sorting out your own costs when most of them don't pay."*

Tome pivoted to sales automation and abandoned slides entirely.

**Sources:** [Tome AI Dissected (a-bots.com)](https://a-bots.com/blog/Tome-AI-Review), [Tome Pivot Analysis (autoppt)](https://autoppt.com/blog/tome-app-pivot-away-from-presentations/), [Tome 2025 Deep Dive (Skywork)](https://skywork.ai/skypage/en/Tome-AI:-A-2025-Deep-Dive-into-the-AI-Storyteller's-Dramatic-Pivot/1972903305876140032).

---

## 3. Beautiful.ai

### Data model
Primitive: the **Smart Slide** — a pre-designed layout with declared "slots" for content. There are **300+ Smart Slide layouts** organized by purpose: data, comparisons, quotes, timelines, image grids, agendas, big number, SWOT, Venn, funnels, org charts, etc.

- **Linear or canvas?** Linear list of slides, each fixed-aspect (16:9 standard).
- **Nesting?** No — slots are flat inside a slide.
- **Layouts?** **Template-driven**, not declarative. Each Smart Slide is a hand-crafted layout that auto-rebalances when content is added/removed.
- **Z-index/overlap?** Hidden from user — engine handles spacing.
- **Content vs layout?** Strict separation — content fills predefined slots.

### Template / variation strategy
**Template-first**. As Beautiful.ai puts it: *"Smart Slides are responsive, intelligent layouts that automatically adapt your content as you edit—applying professional design rules in real time. Choose from over 300 Smart Slide layouts."* The "AI" here is mostly **rules-based design enforcement**, not generative layout. Brand themes inject colors, fonts, and logos across all slides.

### AI generation flow
User enters topic + sets "rules of the road" (theme, image source: AI / web / stock / none). The AI generates an outline, picks Smart Slides for each section, fills slots, and applies the theme. Iteration is per-slide.

### Rendering technology
Browser-based React app. Each Smart Slide is essentially a parameterized React component with internal layout logic. PDF/PPTX export is more reliable than Gamma's because slides are already 16:9-shaped.

### Why output is consistent BUT formulaic
Per critical reviews: *"Each Smart Slide has fixed slots with set positions for titles, images, and text areas. Users cannot add a second content block to one slide, combine a diagram with a metrics panel, or build layouts that don't already exist in the library, resulting in regularly having to adapt messages to fit templates rather than building layouts that serve the message."*

The 300-template library is broad but **exhaustible** — power users hit the wall and "regularly adapt their message to fit the template rather than building a layout that serves the message."

**Sources:** [Smart Slides page](https://www.beautiful.ai/smart-slides), [Slide Templates](https://www.beautiful.ai/slide-templates), [Beautiful.ai criticism (Alai)](https://getalai.com/blog/beautiful-ai-alternative), [Kroma review](https://kroma.ai/beautiful-ai-review/).

---

## 4. Notion AI

### Data model
Notion is **the gold standard for block-based document architecture**. Per Notion's own engineering blog: *"Everything you see in Notion is a block. Text, images, lists, a row in a database, even pages themselves—these are all blocks."*

Each block has four attributes:
1. **ID** (UUID v4)
2. **Type** (paragraph, heading_1, callout, image, table, column_list, toggle, etc.)
3. **Properties** (type-specific data — title, checked status, language)
4. **Content + Parent** (dual-pointer tree: ordered child IDs + single parent ID)

Indentation is **structural, not presentational** — it modifies the render tree.

The Notion API supports ~30 block types: paragraph, headings (1–4 with toggleable variants), quote, code, callout, divider, bulleted_list_item, numbered_list_item, to_do, image, audio, video, pdf, file, bookmark, link_preview, embed, table, table_row, column_list, column, toggle, child_database, child_page, breadcrumb, table_of_contents, synced_block, equation, and more.

- **Linear or canvas?** Tree (infinite nesting via parent/content pointers).
- **Layouts?** Mostly declarative (block flow + column_list for multi-column). No free positioning.
- **Z-index?** None — pure document flow.
- **Content vs layout?** Fused — type implies presentation.

### Template / variation strategy
**Block-first.** No templates per se; instead, Notion AI composes blocks into a page, with model routing deciding which model handles which task. Per Notion's blog: *"Tasks broken down by category and routed to models based on quality, latency, and cost. Writing a product spec is routed to high-reasoning models for long-form generation, while auto-filling fields in a project tracker uses specialized, cost-efficient, fine-tuned models that cut latency in half."*

### AI generation flow
Block-level: type `/ai` or `/summarize` to invoke AI on a block, or use AI Blocks (predefined: Summarize, Translate, Brainstorm, custom prompt). Notion AI also generates full pages from prompts. The AI generates **structured block JSON**, not natural language to be parsed.

The huge advantage Notion claims: *"In a traditional document, 'April 30' might just be a string of text, but in Notion, it's a due date property attached to a task block assigned to Jane Smith, enabling AI to understand your workspace's structure and relationships rather than just searching keywords."*

### Rendering technology
React app, document flow, no canvas. Exports to PDF, Markdown, HTML.

### Limitations
Pages all look uniform — *"some criticism centers on the rigid structure of blocks themselves... once you've created a page as a full-width block, there's no easy way to turn it into a neat inline link."* Notion AI is **not designed for visual variety** — it's designed for structured knowledge work. Pages are typographically excellent but visually homogeneous.

**Sources:** [Exploring Notion's Data Model](https://www.notion.com/blog/data-model-behind-notion), [Speed, Structure, and Smarts: The Notion AI Way](https://www.notion.com/blog/speed-structure-and-smarts-the-notion-ai-way), [Notion API block reference](https://developers.notion.com/reference/block), [Notion AI limitations (eesel)](https://www.eesel.ai/blog/notion-ai-limitations-best-practices).

---

## 5. Canva Magic Design

### Data model
Canva's primitive is the **page** (or "design") composed of **freely positioned elements** on a 2D canvas — text frames, images, shapes, videos, embeds. Real z-index, real overlap, real free positioning. Closer to Figma/PowerPoint than to Notion/Gamma.

- **Linear or canvas?** Free canvas per page; multi-page documents are linear sequences.
- **Layouts?** Template-driven (huge library of hand-crafted templates).
- **Z-index/overlap?** Yes — full layering control.
- **Content vs layout?** Fused on canvas, but Magic Design uses templates as decoupled structure.

### Template / variation strategy
**Template-first at extreme scale.** Per OpenAI's Canva case study and Canva docs: *"Magic Design pairs OpenAI's API with Canva's own AI design engine and library of over 100 million assets and templates."*

The AI's job is **template selection**, not generation. *"Magic Design analyzes the images, text, or ideas you provide and recommends layouts that match your theme and style."* The original template creator gets credited and compensated each time.

### AI generation flow
User enters prompt, uploads images/logo, or provides text. AI surfaces a curated set of templates from the 100M library. User picks one and Canva fills it with their content. Iteration = pick a different template.

### Rendering technology
Browser-based, custom WebGL/Canvas renderer (Canva built their own). Native PDF/PPTX/PNG export pipeline. Magic Layers (announced 2024) brings creative control to AI content via a layer-based mental model.

### Why output looks varied
Canva relies on **library scale**, not algorithm cleverness. With 100M templates created by professional designers, the AI doesn't need to compose anything — just retrieve well. The variety is real because the templates are real human design work.

**Sources:** [Magic Design](https://www.canva.com/magic-design/), [Use Magic Design help](https://www.canva.com/help/use-magic-design/), [Canva + OpenAI case study](https://openai.com/index/canva/), [Magic Layers announcement](https://www.canva.com/newsroom/news/magic-layers/).

---

## 6. Pitch (pitch.com)

### Data model
Primitive: **slide** (16:9) composed of freely positioned **blocks** (text, image, shape, chart, video). Closer to PowerPoint/Canva than to Notion/Gamma.

- **Linear or canvas?** Free canvas per slide.
- **Layouts?** Template-driven gallery + smart formatting helpers (Smart Tidying, Smart Swapping, Automatic Grouping).
- **Content vs layout?** Fused.

Per Pitch's smart formatting docs: *"Smart tidying allows you to quickly align multiple blocks of the same type... Pitch evenly distributes the space between items on one axis, and aligns them along the other axis."* *"Smart swapping allows you to quickly switch the position of two blocks of the same type."*

### Template / variation strategy
**Template-first with manual editing.** Pitch ships a curated template library and the AI fills it. Reviewers note: *"Pitch still feels very much like a manual design tool at its core, which is great for those who want total control but might be slower for users who want the AI to do the heavy lifting."*

### AI generation flow
Pitch 2.0 added an AI presentation generator that *"fills blank slides magically in seconds with topic-specific structure, content, and layouts matching selected color palettes and fonts."* Iteration is heavily manual.

### Rendering technology
**Built in Clojure/ClojureScript.** Per the founding CTO's account: *"Clojure as their primary programming language and the web as their primary application delivery platform. These choices were made to make room for curiosity and creativity among the engineering team."* They use REPL-driven development. Browser-based renderer with smart-formatting layout engine and animation continuity across slides.

### Strengths
Real-time collaboration, presentation analytics (slide-level view counts and duration), branded asset library, video uploads. Templates are *"some of the most modern and 'tech forward' in the industry."*

**Sources:** [Pitch 2.0 announcement](https://pitch.com/blog/introducing-pitch-2-0), [Smart formatting help](https://help.pitch.com/en/articles/3998376-use-smart-formatting), [Tower blog: developing Pitch desktop](https://www.git-tower.com/blog/developing-for-the-desktop-pitch/), [Pitch.com review (24slides)](https://24slides.com/presentbetter/pitch-review).

---

## 7. Decktopus

### Data model
Primitive: **slide** with structured fields (title, subtitle, body, image slot, speaker notes). Closest to Beautiful.ai's slot-based model but with stronger AI workflow scaffolding.

- **Linear or canvas?** Linear, slot-based.
- **Layouts?** Template-driven (smaller library than Beautiful.ai).
- **Content vs layout?** Strict separation.

### Template / variation strategy
**Template-first.** Pre-built layouts; user picks template, AI fills slots. Multi-modal inputs: DOCX, JSON, MD, PDF, PPTX, TXT.

### AI generation flow
The engine is called **DecktoGPT**. Per Decktopus help: user enters topic ("What do you want to create?"), optionally uploads up to 5 supporting files, AI builds outline, user approves outline, AI generates content + visuals + speaker notes + Q&A suggestions in 2–4 minutes. Strong "presentation workflow" framing — it's not just slides, it generates supporting artifacts.

### Rendering technology
Browser-based. Standard HTML/CSS template rendering.

### Why it's mid-tier
Decktopus targets ease over visual sophistication. Reviewers note slides look professional but conventional. The differentiator is the **end-to-end workflow** (research → content → design → speaker notes → Q&A), not visual variety.

**Sources:** [Decktopus AI homepage](https://www.decktopus.com/), [Create with DecktoGPT help](https://help.decktopus.com/en/articles/35-create-your-presentation-with-decktogpt), [Decktopus 2025 review (Skywork)](https://skywork.ai/skypage/en/Decktopus-AI-Your-Ultimate-Guide-to-AI-Powered-Presentations-(2025-Review)/1972862370373627904).

---

## 8. SlidesAI (slidesai.io)

### Data model
SlidesAI is a **Google Slides / PowerPoint add-in** — it doesn't own the data model. It writes into the host application's slide schema. Primitives are whatever Google/Microsoft expose.

- **Linear or canvas?** Inherits from host app (free canvas inside fixed slides).
- **Layouts?** Template-driven; SlidesAI ships its own template set on top of Google Slides templates.

### Template / variation strategy
**Template-first, library-limited.** Per critical reviews: *"Since SlidesAI uses templates, your slides might not feel unique, and you can't try wild design ideas or super-custom layouts."* *"Template variety is still limited compared to Beautiful.ai."*

### AI generation flow
User pastes text (5-10 word topics ideal) or detailed notes, picks presentation type (general/educational/sales/conference), tone, audience, slide count, color preset. AI generates a structured slide list and writes it directly into the host application.

### Rendering technology
**No custom renderer.** Native Google Slides / PowerPoint rendering. Export quality is therefore excellent (it IS PowerPoint), but visual ceiling is also bounded by what Google Slides looks like.

### Why output is formulaic
*"SlidesAI operates primarily within the constraints of an add-in, which means it lacks the deep, canvas level control found in standalone AI native platforms... when you want to move beyond simple bullet points or basic layouts, the tool can feel restrictive."*

**Sources:** [SlidesAI on Google Workspace](https://workspace.google.com/marketplace/app/slidesaiio_create_slides_with_ai/904276957168), [Plus AI's SlidesAI review](https://plusai.com/blog/slidesai-and-other-ai-presentation-tools), [SlidesAI Review (Slidepeak)](https://slidepeak.com/blog/slidesai-review).

---

## SYNTHESIS

### 1. Pattern taxonomy

| Pattern | Platforms | How variety emerges |
|---|---|---|
| **Template-first (slot fillers)** | Beautiful.ai, SlidesAI, Decktopus, Canva Magic Design, Pitch | Hand-crafted templates; AI's job is selection or slot-fill. Variety is bounded by library size. |
| **Block-first (semantic doc)** | Notion AI | Compose from many small primitives; layout is structural, not visual. Variety is low but consistency is perfect. |
| **Narrative/Generative-first (no templates)** | Tome (defunct), partially Gamma | AI generates layout tokens or layout structure from scratch; renderer paints from tokens. Variety is high but quality is unpredictable. |
| **Hybrid (auto-layout cards + theme)** | Gamma | Cards are content-first with grow-to-fit; AI picks from a small palette of card layouts (timeline, gallery, two-column, hero) and the theme handles look. **This is the most successful pattern by user metrics.** |

The clearest dividing line is **canvas vs flow**:
- Canvas (free positioning, z-index): Canva, Pitch, PowerPoint-like — high ceiling, high friction.
- Flow (cards/blocks/slots, no overlap): Gamma, Notion, Beautiful.ai, Tome — lower ceiling, near-zero friction, AI-friendly.

### 2. The "variety unlock" — what works

**Gamma is the clear winner on visually-varied AI output** ($100M ARR, ~50M users at ~50 employees per the Lenny's Newsletter interview). Why:
1. **Card-as-flexible-frame**: cards grow to fit content, eliminating awkward whitespace.
2. **Layout palette, not template library**: the AI picks from ~10–20 layout primitives (timeline, image-left, image-right, two-column, gallery, hero, KPI grid) and **mixes them across a single deck**. No deck looks like just one template.
3. **Theme-driven harmony**: a unified palette + AI image generation tuned to that palette means even varied layouts look cohesive.
4. **Web-native**: no fixed-aspect-ratio constraint.

**Canva is the winner on absolute design quality** because they have 100M human-made templates. The AI is just a search engine over them. This isn't replicable by a small team.

**Beautiful.ai produces consistent but formulaic output** because the slot system can't compose new layouts. Power users escape to PowerPoint.

**Tome had the most ambitious tech (layout interpreter, WebGL canvas, layout tokens) and DIED** because (a) no PPTX export, (b) users couldn't fine-tune, (c) generated content quality was inconsistent. The lesson: generative-from-scratch is high-risk for B2B.

**Notion AI is the king of structured doc output** but has zero visual variety. Pages are uniform on purpose.

**SlidesAI / Decktopus / Pitch** are mid-tier — none has a distinctive variety unlock.

### 3. Recommendations for CoAgent

**CoAgent's current state:** linear block model (header, text, kpis, table, callout, two_column, image, divider, signoff, footer, chart) → React/CSS preview → @react-pdf/renderer export. Single LLM via `create_document`/`update_document` tool loop. Audience: freelancers producing client-ready deliverables.

This is **architecturally closest to Gamma** (linear, content-first, flow-based, AI fills primitives) and **architecturally closest to Notion** for the data model (typed blocks with properties).

**Ranked recommendations:**

#### #1 — Adopt Gamma's "card layout palette" pattern (HIGH PRIORITY)
Rather than expanding the block library further, introduce a **layout-variant property on a small set of "section" containers**. Examples:
- A `section` container with variants: `hero`, `two_column`, `image_left`, `image_right`, `kpi_grid`, `timeline`, `gallery`, `quote_callout`, `comparison`.
- Each variant is a hand-designed React + CSS layout that consumes a typed payload.
- The LLM picks the variant based on content type.
- Variants share the brand kit (colors, fonts, accent images) so the deck stays cohesive.

This gives you variety **without** template explosion. Critically, it's reversible (the variant is just a string property) and AI-friendly (the LLM only picks from a closed enum).

**Why this beats template-first:** template libraries are exhaustible (Beautiful.ai's 300 templates still feel formulaic). A small palette of varied layouts + brand-kit-driven theming produces more apparent variety per unit of engineering effort.

#### #2 — Add a "theme" layer separate from blocks (HIGH PRIORITY)
Steal from Gamma and Tome: **brand metadata (colors, fonts, accent images, logo) is injected at render time, not stored on blocks**. The block schema stays content-only. Themes can be swapped without touching content. This enables:
- Per-client theme overrides (real estate agent's brand vs marketing consultant's brand).
- Theme experimentation without re-running the LLM.
- Future "remix" feature (re-render the same content in a different theme).

Tome's lesson: *"Brand metadata—color palettes, logo ratios, font stacks—is injected at render time, guaranteeing compliance without hand policing."*

#### #3 — Adopt Notion's block-with-properties schema (MEDIUM PRIORITY)
Notion's four-attribute model (id, type, properties, content+parent) is the cleanest. CoAgent's blocks are already typed; add:
- Stable UUIDs per block (so the LLM can reference and update by ID instead of replacing the whole doc).
- A `properties` bag for type-specific data (e.g., kpi block has `value`, `label`, `delta`, `delta_direction`).
- Optional `content` array for nesting (e.g., `two_column` contains two `column` children, each containing blocks).

This makes incremental updates (`update_document` tool calls that modify a single block) tractable. Right now, full-doc replacement is slow and prone to drift.

#### #4 — Multi-model routing (MEDIUM PRIORITY)
Notion's pattern: *"Tasks broken down by category and routed to models based on quality, latency, and cost."* For CoAgent:
- Long-form narrative (executive summary, market analysis): high-reasoning model (Claude Opus / GPT-5).
- KPI extraction, table population, chart data: cheap fast model (Haiku / GPT-5-mini).
- Image generation: dedicated diffusion model.

This drops cost and latency without sacrificing the parts that matter.

#### #5 — REJECT generative-from-scratch layout (Tome's approach)
Do NOT build a layout interpreter that generates layouts from tokens. Tome did exactly this and **shut down**. The output quality variance was fatal for B2B. Freelancers need predictable, client-ready output every time. Stick with hand-crafted variants picked by the LLM.

#### #6 — REJECT free-canvas model (Canva/Pitch)
Do NOT add z-index, overlap, or free positioning. It is incompatible with `@react-pdf/renderer`, makes AI generation harder (the LLM has to reason about pixel coordinates), and adds friction without clear benefit for the target output (weekly seller updates, audits, retrospectives — none of which need overlapping elements).

#### #7 — REJECT massive template library (Beautiful.ai/Canva)
You don't have 100M templates and won't. Don't try. A palette of 10–15 well-designed layout variants + theming will outperform a sprawling template library managed by one team.

### 4. Anti-patterns to avoid

| Anti-pattern | Who did it | Lesson |
|---|---|---|
| **Generative-from-scratch layout** | Tome | Output variance kills B2B trust. Shut down March 2025. |
| **No PPTX/PDF export parity** | Tome, Gamma (PPTX) | Users need to share with non-users. *"Gamma's greatest strength (its fluid web architecture) is the root of its biggest flaw: terrible PowerPoint export fidelity."* For CoAgent, PDF export must be 1:1 with preview. |
| **Slot-rigid templates that can't combine** | Beautiful.ai | *"Users cannot add a second content block to one slide, combine a diagram with a metrics panel, or build layouts that don't already exist."* — power users get stuck. |
| **One-look-fits-all blocks** | Notion AI | All pages look identical. Fine for knowledge work, fatal for client deliverables. |
| **Add-in dependency** | SlidesAI | Inheriting host app's ceiling means you can't differentiate. |
| **Manual slide editing forced on users** | Pitch | Defeats the point of AI generation; users get bored and leave. |
| **Consumer-priced free tier with massive model costs** | Tome | Peiris: *"It becomes really hard trying to build a consumer product for millions of people and sorting out your own costs when most of them don't pay."* CoAgent's freelancer/B2B focus is correct — keep it. |
| **AI-generated content with no fact-checking** | Tome, others | *"AI-generated narratives often contained errors or lacked nuance, requiring heavy manual revision that negated time savings."* For freelancer deliverables (financial reports, marketing audits), CoAgent needs verifiable data sources, not pure generation. Ground in user-supplied data. |

---

## Concrete next steps for CoAgent

1. **Introduce `section` container blocks with `layout_variant` enum.** Start with: `hero`, `two_column`, `image_left`, `image_right`, `kpi_grid`, `timeline`, `comparison`, `quote_callout`, `gallery`. Build each as a React component + matching @react-pdf component.
2. **Extract theme into a separate top-level document property.** Move colors, fonts, header image, logo URL, accent color out of individual blocks. Render layer reads from theme, blocks read from content only.
3. **Give every block a stable UUID** so `update_document` can target individual blocks for surgical edits instead of full-doc replacement. This unlocks fast iteration like Gamma's per-card regenerate.
4. **Build a "remix" tool** that re-renders the current document with a different layout_variant assignment per section, keeping content frozen. This is cheap (no LLM call) and feels magical.
5. **Add a content-type → preferred-layout heuristic** so the LLM doesn't have to re-derive on every doc. e.g., kpi data → `kpi_grid`, before/after screenshots → `two_column`, testimonial → `quote_callout`, schedule → `timeline`.
6. **Multi-model routing in agent-core**: route content generation to a high-reasoning model and structured data extraction (KPIs, tables) to a cheap fast model.

The single highest-leverage change is **#1 (layout variants)** — that's where Gamma's apparent variety comes from, and it's a small, reversible change to CoAgent's existing block model.

---

## Source list

- [Gamma — What are cards](https://help.gamma.app/en/articles/11016396-what-are-cards-in-gamma-and-how-to-do-they-work)
- [Gamma — Editing/designing collection](https://help.gamma.app/en/collections/12178871-editing-designing-formatting-in-gamma)
- [Gamma developer docs](https://developers.gamma.app)
- [SketchBubble: Gamma deep dive](https://www.sketchbubble.com/blog/gamma-explained-a-comprehensive-deep-dive-into-the-ai-powered-presentation-platform/)
- [Alai: Gamma alternatives review](https://getalai.com/blog/gamma-alternatives)
- [Lenny's Newsletter: 50 people built profitable AI unicorn (Gamma)](https://www.lennysnewsletter.com/p/how-50-people-built-a-profitable-ai-unicorn)
- [Tome AI Dissected (a-bots.com)](https://a-bots.com/blog/Tome-AI-Review)
- [Tome's Pivot Analysis (autoppt)](https://autoppt.com/blog/tome-app-pivot-away-from-presentations/)
- [Tome AI 2025 Deep Dive (Skywork)](https://skywork.ai/skypage/en/Tome-AI:-A-2025-Deep-Dive-into-the-AI-Storyteller's-Dramatic-Pivot/1972903305876140032)
- [Beautiful.ai — Smart Slides](https://www.beautiful.ai/smart-slides)
- [Beautiful.ai — Slide templates](https://www.beautiful.ai/slide-templates)
- [Alai: Beautiful.ai criticism](https://getalai.com/blog/beautiful-ai-alternative)
- [Kroma: Beautiful.ai review](https://kroma.ai/beautiful-ai-review/)
- [Notion: Exploring Notion's Data Model](https://www.notion.com/blog/data-model-behind-notion)
- [Notion: Speed, Structure, and Smarts: The Notion AI Way](https://www.notion.com/blog/speed-structure-and-smarts-the-notion-ai-way)
- [Notion API: Block reference](https://developers.notion.com/reference/block)
- [Notion AI limitations (eesel)](https://www.eesel.ai/blog/notion-ai-limitations-best-practices)
- [Canva: Magic Design](https://www.canva.com/magic-design/)
- [Canva: Use Magic Design help](https://www.canva.com/help/use-magic-design/)
- [OpenAI: Canva case study](https://openai.com/index/canva/)
- [Canva: Magic Layers announcement](https://www.canva.com/newsroom/news/magic-layers/)
- [Pitch: Pitch 2.0 announcement](https://pitch.com/blog/introducing-pitch-2-0)
- [Pitch: Smart formatting help](https://help.pitch.com/en/articles/3998376-use-smart-formatting)
- [Tower blog: Developing Pitch desktop app](https://www.git-tower.com/blog/developing-for-the-desktop-pitch/)
- [24slides: Pitch.com review](https://24slides.com/presentbetter/pitch-review)
- [Decktopus: How it works](https://www.decktopus.com/)
- [Decktopus: DecktoGPT help](https://help.decktopus.com/en/articles/35-create-your-presentation-with-decktogpt)
- [Skywork: Decktopus 2025 review](https://skywork.ai/skypage/en/Decktopus-AI-Your-Ultimate-Guide-to-AI-Powered-Presentations-(2025-Review)/1972862370373627904)
- [Plus AI: SlidesAI review](https://plusai.com/blog/slidesai-and-other-ai-presentation-tools)
- [Slidepeak: SlidesAI review](https://slidepeak.com/blog/slidesai-review)
- [SlidesAI on Google Workspace marketplace](https://workspace.google.com/marketplace/app/slidesaiio_create_slides_with_ai/904276957168)
- [Presenton (open-source Gamma alternative on GitHub)](https://github.com/presenton/presenton)
