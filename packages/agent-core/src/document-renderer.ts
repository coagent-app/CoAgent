/**
 * Document renderer — converts markdown to professional PDFs using pdfmake.
 *
 * Markdown → tokens → pdfmake document definition → PDF buffer.
 * Supports three styles (professional, minimal, report) and optional branding.
 */
import { createRequire } from 'module'

type DocStyle = 'professional' | 'minimal' | 'report'

export interface BrandKit {
  companyName?: string
  accentColor?: string   // hex, e.g. '#1a2744'
  logoBase64?: string    // data URI or raw base64 PNG/JPEG
}

export interface LayoutOverrides {
  accentColor?: string       // override accent per-document
  columns?: 1 | 2           // 1 = normal, 2 = two-column body
  density?: 'compact' | 'normal' | 'spacious'  // affects spacing + font sizes
  headerStyle?: 'left' | 'centered' | 'banner'  // how H1 renders
  tableStyle?: 'striped' | 'bordered' | 'minimal' // table appearance
  pageNumbers?: boolean      // override show/hide
}

// ── pdfmake setup ──────────────────────────────────────────────────────────

let pdfmakeReady = false
let pdfmake: any

function ensurePdfmake() {
  if (pdfmakeReady) return
  const req = createRequire(__filename)
  pdfmake = req('pdfmake/build/pdfmake.js')
  const vfsFonts: Record<string, string> = req('pdfmake/build/vfs_fonts.js')

  // Load base64-encoded font files into pdfmake's virtual filesystem
  for (const [name, data] of Object.entries(vfsFonts)) {
    pdfmake.virtualfs.writeFileSync(name, Buffer.from(data, 'base64'))
  }

  pdfmake.fonts = {
    Roboto: {
      normal: 'Roboto-Regular.ttf',
      bold: 'Roboto-Medium.ttf',
      italics: 'Roboto-Italic.ttf',
      bolditalics: 'Roboto-MediumItalic.ttf',
    },
  }
  pdfmakeReady = true
}

// ── Style configs ──────────────────────────────────────────────────────────

interface StyleConfig {
  accentColor: string
  h1Size: number
  h2Size: number
  h3Size: number
  bodySize: number
  lineHeight: number
  showPageNumbers: boolean
  showHeaderLine: boolean
}

const STYLE_CONFIGS: Record<DocStyle, StyleConfig> = {
  professional: {
    accentColor: '#1a2744',
    h1Size: 20, h2Size: 14, h3Size: 12, bodySize: 10,
    lineHeight: 1.35,
    showPageNumbers: true, showHeaderLine: true,
  },
  minimal: {
    accentColor: '#333333',
    h1Size: 18, h2Size: 13, h3Size: 11, bodySize: 10,
    lineHeight: 1.3,
    showPageNumbers: false, showHeaderLine: false,
  },
  report: {
    accentColor: '#1a2744',
    h1Size: 22, h2Size: 15, h3Size: 12, bodySize: 10,
    lineHeight: 1.4,
    showPageNumbers: true, showHeaderLine: true,
  },
}

// ── Markdown tokenizer ─────────────────────────────────────────────────────

interface Token {
  type: 'h1' | 'h2' | 'h3' | 'paragraph' | 'bullet' | 'numbered' | 'hr' | 'table' | 'pagebreak'
  text?: string
  rows?: string[][]
  items?: string[]
}

function tokenizeMarkdown(md: string): Token[] {
  const lines = md.split('\n')
  const tokens: Token[] = []
  let i = 0

  while (i < lines.length) {
    const trimmed = lines[i].trim()

    if (!trimmed) { i++; continue }

    // Explicit page break: === or \pagebreak
    if (/^(={3,})$/.test(trimmed) || trimmed === '\\pagebreak') {
      tokens.push({ type: 'pagebreak' })
      i++; continue
    }

    // --- or *** = horizontal rule (NOT a page break)
    if (/^(-{3,}|\*{3,})$/.test(trimmed) && tokens.length > 0) {
      tokens.push({ type: 'hr' })
      i++; continue
    }

    if (trimmed.startsWith('### ')) {
      tokens.push({ type: 'h3', text: trimmed.slice(4) })
      i++; continue
    }
    if (trimmed.startsWith('## ')) {
      tokens.push({ type: 'h2', text: trimmed.slice(3) })
      i++; continue
    }
    if (trimmed.startsWith('# ')) {
      tokens.push({ type: 'h1', text: trimmed.slice(2) })
      i++; continue
    }

    if (trimmed.startsWith('|')) {
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const row = lines[i].trim()
        if (/^\|[\s\-:|]+\|$/.test(row)) { i++; continue }
        rows.push(row.split('|').slice(1, -1).map(c => c.trim()))
        i++
      }
      if (rows.length > 0) tokens.push({ type: 'table', rows })
      continue
    }

    if (/^[-*+]\s/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^[-*+]\s/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''))
        i++
      }
      tokens.push({ type: 'bullet', items })
      continue
    }

    if (/^\d+\.\s/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''))
        i++
      }
      tokens.push({ type: 'numbered', items })
      continue
    }

    let text = ''
    while (
      i < lines.length && lines[i].trim() &&
      !lines[i].trim().startsWith('#') &&
      !lines[i].trim().startsWith('|') &&
      !/^[-*+]\s/.test(lines[i].trim()) &&
      !/^\d+\.\s/.test(lines[i].trim()) &&
      !/^(-{3,}|\*{3,})$/.test(lines[i].trim())
    ) {
      text += (text ? ' ' : '') + lines[i].trim()
      i++
    }
    if (text) tokens.push({ type: 'paragraph', text })
  }

  return tokens
}

/** Parse inline markdown into pdfmake text array */
function parseInline(text: string, baseStyle: Record<string, any> = {}): any {
  const parts: any[] = []
  const regex = /\*\*(.+?)\*\*|__(.+?)__|`(.+?)`|\*(.+?)\*|_(.+?)_|\[([^\]]+)\]\([^)]+\)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), ...baseStyle })
    }
    if (match[1] || match[2]) {
      parts.push({ text: match[1] || match[2], bold: true, ...baseStyle })
    } else if (match[3]) {
      parts.push({ text: match[3], background: '#f0f0f0', ...baseStyle })
    } else if (match[4] || match[5]) {
      parts.push({ text: match[4] || match[5], italics: true, ...baseStyle })
    } else if (match[6]) {
      parts.push({ text: match[6], color: '#2563eb', ...baseStyle })
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), ...baseStyle })
  }

  if (parts.length === 0) return { text, ...baseStyle }
  if (parts.length === 1) return parts[0]
  return { text: parts }
}

// ── PDF rendering ──────────────────────────────────────────────────────────

export async function renderMarkdownToPdf(
  markdown: string,
  style: DocStyle = 'professional',
  title?: string,
  brand?: BrandKit,
  layout?: LayoutOverrides,
): Promise<Buffer> {
  ensurePdfmake()

  const baseCfg = STYLE_CONFIGS[style] || STYLE_CONFIGS.professional

  // Apply density overrides
  const densityScale = layout?.density === 'compact' ? 0.85 : layout?.density === 'spacious' ? 1.2 : 1
  const spacingScale = layout?.density === 'compact' ? 0.6 : layout?.density === 'spacious' ? 1.5 : 1

  const cfg: StyleConfig = {
    ...baseCfg,
    h1Size: Math.round(baseCfg.h1Size * densityScale),
    h2Size: Math.round(baseCfg.h2Size * densityScale),
    h3Size: Math.round(baseCfg.h3Size * densityScale),
    bodySize: Math.round(baseCfg.bodySize * densityScale),
    lineHeight: baseCfg.lineHeight * (layout?.density === 'compact' ? 0.95 : layout?.density === 'spacious' ? 1.15 : 1),
    showPageNumbers: layout?.pageNumbers ?? baseCfg.showPageNumbers,
  }

  const accent = layout?.accentColor || brand?.accentColor || cfg.accentColor
  const headerStyle = layout?.headerStyle || 'left'
  const tableVariant = layout?.tableStyle || 'striped'
  const useColumns = layout?.columns === 2
  const tokens = tokenizeMarkdown(markdown)
  const contentWidth = 504 // Letter width (612) minus margins (54 * 2)

  // ── Convert tokens to pdfmake content elements ──

  function renderToken(token: Token): any {
    switch (token.type) {
      case 'pagebreak':
        return { text: '', pageBreak: 'after' }

      case 'h1': {
        const items: any[] = []
        const m = spacingScale
        if (headerStyle === 'banner') {
          // Full-width accent banner with white text
          items.push({
            table: { widths: ['*'], body: [[{
              ...parseInline(token.text!, { color: '#ffffff', bold: true }),
              fontSize: cfg.h1Size,
              fillColor: accent,
              margin: [12, 8, 12, 8],
            }]] },
            layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
            margin: [0, Math.round(10 * m), 0, Math.round(6 * m)],
          })
        } else if (headerStyle === 'centered') {
          items.push({
            ...parseInline(token.text!, { color: accent }),
            style: 'h1',
            alignment: 'center',
            margin: [0, Math.round(10 * m), 0, Math.round(4 * m)],
          })
          if (cfg.showHeaderLine) {
            items.push({
              canvas: [{ type: 'line', x1: contentWidth * 0.3, y1: 0, x2: contentWidth * 0.7, y2: 0, lineWidth: 1.5, lineColor: accent }],
              margin: [0, 0, 0, Math.round(6 * m)],
            })
          }
        } else {
          // Default left-aligned
          if (cfg.showHeaderLine) {
            items.push({
              canvas: [{ type: 'rect', x: 0, y: 0, w: contentWidth, h: 2, color: accent }],
              margin: [0, Math.round(8 * m), 0, Math.round(4 * m)],
            })
          }
          items.push({
            ...parseInline(token.text!, { color: accent }),
            style: 'h1',
            margin: [0, cfg.showHeaderLine ? 0 : Math.round(10 * m), 0, Math.round(6 * m)],
          })
        }
        return items.length === 1 ? items[0] : { stack: items, unbreakable: true }
      }

      case 'h2': {
        const sm = spacingScale
        const items: any[] = [{
          ...parseInline(token.text!, { color: accent }),
          style: 'h2',
          margin: [0, Math.round(8 * sm), 0, Math.round(2 * sm)],
        }]
        if (cfg.showHeaderLine) {
          items.push({
            canvas: [{ type: 'line', x1: 0, y1: 0, x2: contentWidth, y2: 0, lineWidth: 0.5, lineColor: '#cccccc' }],
            margin: [0, 1, 0, Math.round(4 * sm)],
          })
        }
        return items.length === 1 ? items[0] : { stack: items, unbreakable: true }
      }

      case 'h3':
        return {
          ...parseInline(token.text!, { color: '#333333' }),
          style: 'h3',
          margin: [0, Math.round(6 * spacingScale), 0, Math.round(3 * spacingScale)],
        }

      case 'paragraph':
        return {
          ...parseInline(token.text!),
          style: 'body',
          margin: [0, 0, 0, Math.round(4 * spacingScale)],
        }

      case 'bullet':
        return {
          ul: token.items!.map(item => parseInline(item)),
          style: 'body',
          margin: [0, 0, 0, Math.round(4 * spacingScale)],
          markerColor: accent,
        }

      case 'numbered':
        return {
          ol: token.items!.map(item => parseInline(item)),
          style: 'body',
          margin: [0, 0, 0, Math.round(4 * spacingScale)],
          markerColor: accent,
        }

      case 'hr':
        return {
          canvas: [{ type: 'line', x1: 0, y1: 0, x2: contentWidth, y2: 0, lineWidth: 1, lineColor: '#cccccc' }],
          margin: [0, Math.round(6 * spacingScale), 0, Math.round(6 * spacingScale)],
        }

      case 'table': {
        const rows = token.rows!
        if (rows.length === 0) return null
        const numCols = Math.max(...rows.map(r => r.length))

        const tableBody = rows.map((row, ri) => {
          const isHeader = ri === 0
          const cells: any[] = []
          for (let ci = 0; ci < numCols; ci++) {
            const cellText = row[ci] || ''
            if (tableVariant === 'minimal') {
              cells.push({
                ...parseInline(cellText, isHeader ? { bold: true } : {}),
                margin: [4, 3, 4, 3],
              })
            } else if (tableVariant === 'bordered') {
              cells.push({
                ...parseInline(cellText, isHeader ? { bold: true, color: '#ffffff' } : {}),
                fillColor: isHeader ? accent : undefined,
                margin: [4, 3, 4, 3],
              })
            } else {
              // striped (default)
              cells.push({
                ...parseInline(cellText, isHeader ? { bold: true, color: '#ffffff' } : {}),
                fillColor: isHeader ? accent : (ri % 2 === 0 ? '#f5f5f5' : undefined),
                margin: [4, 3, 4, 3],
              })
            }
          }
          return cells
        })

        const tableLayout = tableVariant === 'minimal'
          ? { hLineWidth: (i: number) => i === 1 ? 0.5 : 0, vLineWidth: () => 0, hLineColor: () => '#cccccc' }
          : tableVariant === 'bordered'
          ? { hLineWidth: () => 1, vLineWidth: () => 1, hLineColor: () => accent, vLineColor: () => accent }
          : { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => '#dddddd', vLineColor: () => '#dddddd' }

        return {
          table: {
            headerRows: 1,
            dontBreakRows: true,
            keepWithHeaderRows: 1,
            widths: Array(numCols).fill('*'),
            body: tableBody,
          },
          layout: tableLayout,
          margin: [0, 2, 0, Math.round(6 * spacingScale)],
        }
      }

      default:
        return null
    }
  }

  const content: any[] = []

  // Group headings with what follows so they don't orphan at page bottoms.
  // Collects consecutive headings (e.g. h2 → h3) plus the first content block
  // into a single unbreakable stack.
  for (let ti = 0; ti < tokens.length; ti++) {
    const token = tokens[ti]
    const isHeading = token.type === 'h1' || token.type === 'h2' || token.type === 'h3'

    if (isHeading) {
      const group: any[] = [renderToken(token)]

      // Collect any following headings (h2 → h3 → h3 etc.)
      let lookahead = ti + 1
      while (lookahead < tokens.length) {
        const next = tokens[lookahead]
        const nextIsHeading = next.type === 'h1' || next.type === 'h2' || next.type === 'h3'
        if (nextIsHeading) {
          group.push(renderToken(next))
          lookahead++
        } else if (next.type === 'pagebreak') {
          break // don't group across explicit page breaks
        } else {
          // First content block — include it and stop
          group.push(renderToken(next))
          lookahead++
          break
        }
      }

      if (group.length > 1 && group.every(Boolean)) {
        content.push({ stack: group, unbreakable: true })
        ti = lookahead - 1 // skip consumed tokens
      } else {
        const el = group[0]
        if (el) content.push(el)
      }
      continue
    }

    const el = renderToken(token)
    if (el) content.push(el)
  }

  // Brand: logo at top of first page
  if (brand?.logoBase64) {
    content.unshift({
      image: brand.logoBase64,
      width: 120,
      margin: [0, 0, 0, 12],
    })
  }

  // Two-column layout: wrap content after first H1 block into columnGap columns
  let finalContent: any[] = content
  if (useColumns && content.length > 1) {
    // Keep the first element (title/logo) full-width, rest in 2 columns
    const header = content[0]
    const body = content.slice(1)
    finalContent = [header, { columns: [{ stack: body.filter((_, i) => i % 2 === 0), width: '*' }, { stack: body.filter((_, i) => i % 2 === 1), width: '*' }], columnGap: 18 }]
  }

  const docDefinition: any = {
    pageSize: 'LETTER',
    pageMargins: [54, 60, 54, 54],
    content: finalContent,
    styles: {
      h1: { fontSize: cfg.h1Size, bold: true, color: accent, lineHeight: cfg.lineHeight },
      h2: { fontSize: cfg.h2Size, bold: true, color: accent, lineHeight: cfg.lineHeight },
      h3: { fontSize: cfg.h3Size, bold: true, color: '#333333', lineHeight: cfg.lineHeight },
      body: { fontSize: cfg.bodySize, color: '#333333', lineHeight: cfg.lineHeight },
    },
    defaultStyle: {
      font: 'Roboto',
      fontSize: cfg.bodySize,
      color: '#333333',
      lineHeight: cfg.lineHeight,
    },
  }

  // Page numbers
  if (cfg.showPageNumbers) {
    docDefinition.footer = (currentPage: number, pageCount: number) => ({
      text: `${currentPage} / ${pageCount}`,
      alignment: 'center',
      fontSize: 8,
      color: '#999999',
      margin: [0, 20, 0, 0],
    })
  }

  // Brand: company name in footer alongside page numbers
  if (brand?.companyName && cfg.showPageNumbers) {
    docDefinition.footer = (currentPage: number, pageCount: number) => ({
      columns: [
        { text: brand.companyName!, fontSize: 8, color: '#999999', margin: [54, 20, 0, 0] },
        { text: `${currentPage} / ${pageCount}`, alignment: 'right', fontSize: 8, color: '#999999', margin: [0, 20, 54, 0] },
      ],
    })
  }

  // Report style: title in header on page 2+
  if (style === 'report' && title) {
    docDefinition.header = (currentPage: number) => {
      if (currentPage === 1) return null
      return { text: title, fontSize: 8, color: '#999999', margin: [54, 20, 54, 0] }
    }
  }

  const doc = pdfmake.createPdf(docDefinition)
  return await doc.getBuffer()
}

// ── Template system ─────────────────────────────────────────────────────────

export type DocumentTemplate = 'resume' | 'proposal' | 'invoice' | 'letter' | 'report' | 'brief' | 'newsletter'

export type TemplateData =
  | ResumeData
  | ProposalData
  | InvoiceData
  | LetterData
  | ReportData
  | BriefData
  | NewsletterData

export interface ResumeData {
  template: 'resume'
  name: string
  contact: { email?: string; phone?: string; location?: string; linkedin?: string; website?: string }
  summary?: string
  experience: { company: string; role: string; dates: string; bullets: string[] }[]
  skills: { category: string; items: string[] }[]
  education: { school: string; degree: string; dates?: string }[]
  certifications?: string[]
}

export interface ProposalData {
  template: 'proposal'
  title: string
  client: string
  company?: string
  date?: string
  summary: string
  scope: string[]
  timeline?: { phase: string; dates: string; description: string }[]
  pricing: { item: string; description?: string; amount: string }[]
  total: string
  terms?: string
}

export interface InvoiceData {
  template: 'invoice'
  invoiceNumber: string
  date: string
  dueDate: string
  from: { company: string; address?: string; email?: string; phone?: string }
  to: { name: string; company?: string; address?: string; email?: string }
  lineItems: { description: string; quantity: number; rate: string; amount: string }[]
  subtotal: string
  tax?: string
  taxRate?: string
  total: string
  notes?: string
  paymentTerms?: string
}

export interface LetterData {
  template: 'letter'
  from: { name: string; company?: string; address?: string; email?: string; phone?: string }
  date: string
  to: { name: string; company?: string; address?: string }
  salutation: string
  body: string[]
  closing: string
  senderName: string
  senderTitle?: string
}

export interface ReportData {
  template: 'report'
  title: string
  subtitle?: string
  author?: string
  date?: string
  abstract?: string
  sections: { heading: string; subheading?: string; body: string; figures?: { caption: string; note?: string }[] }[]
  footnotes?: string[]
}

export interface BriefData {
  template: 'brief'
  to: string
  from: string
  date: string
  re: string
  body: string[]
  keyTakeaways: string[]
  actionItems: { action: string; owner: string; deadline: string }[]
}

export interface NewsletterData {
  template: 'newsletter'
  name: string
  issue?: string
  date?: string
  articles: { title: string; body: string; pullQuote?: string }[]
  tableOfContents?: string[]
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function resolveAccent(brand?: BrandKit, fallback = '#1a2744'): string {
  return brand?.accentColor || fallback
}

/**
 * Coerce a value that should be an array into an actual array.
 * Handles the common LLM failure modes:
 *   - already an array  → returned as-is
 *   - a newline/semicolon-separated string → split into elements
 *   - any other truthy scalar → wrapped in a single-element array
 *   - null / undefined / empty string → empty array
 */
function ensureArray<T>(val: T[] | T | string | undefined | null): T[] {
  if (Array.isArray(val)) return val
  if (typeof val === 'string' && val.trim()) {
    return val.split(/\n|(?:;\s*)/).map(s => s.trim()).filter(Boolean) as any
  }
  if (val) return [val] as any
  return []
}

/**
 * Coerce a value that should be a plain string.
 * Handles arrays by joining them, falls back to empty string.
 */
function ensureString(val: string | string[] | undefined | null, separator = ' '): string {
  if (typeof val === 'string') return val
  if (Array.isArray(val)) return val.join(separator)
  return ''
}

function hr(color = '#cccccc', margin: [number, number, number, number] = [0, 8, 0, 8]): any {
  // Use a table with a single bottom border instead of a canvas line.
  // Canvas lines require an explicit x2 coordinate and overflow column boundaries;
  // a table cell with a bottom border automatically fills whatever width its parent
  // column provides, making this safe in both full-width and narrow sidebar contexts.
  return {
    table: {
      widths: ['*'],
      body: [[{ text: '', border: [false, false, false, true], borderColor: [color, color, color, color], margin: [0, 0, 0, 0] }]],
    },
    layout: {
      hLineWidth: (_i: number, _node: any) => 0.75,
      vLineWidth: () => 0,
      hLineColor: () => color,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin,
  }
}

function sectionLabel(text: string, accent: string): any {
  return {
    text: text.toUpperCase(),
    fontSize: 7.5,
    bold: true,
    color: accent,
    letterSpacing: 1,
    margin: [0, 0, 0, 3],
  }
}

// ── Resume template ─────────────────────────────────────────────────────────

function buildResume(rawData: ResumeData, brand?: BrandKit): any {
  const d = rawData as any
  // Normalize top-level fields — LLM may send snake_case or synonym variants
  const data: ResumeData = {
    ...rawData,
    name: rawData.name || d.full_name || d.fullName || '',
    contact: {
      email: d.contact?.email || d.email || '',
      phone: d.contact?.phone || d.phone || '',
      location: d.contact?.location || d.location || d.contact?.city || '',
      linkedin: d.contact?.linkedin || d.linkedin || '',
      website: d.contact?.website || d.website || d.contact?.url || '',
    },
    summary: rawData.summary || d.objective || d.profile || d.professional_summary || '',
    experience: ensureArray(rawData.experience || d.work_experience || d.work).map((exp: any) => ({
      company: exp.company || exp.employer || exp.organization || '',
      role: exp.role || exp.title || exp.position || exp.job_title || '',
      dates: exp.dates || exp.date || exp.period || exp.duration || '',
      bullets: ensureArray(exp.bullets || exp.achievements || exp.responsibilities || exp.description),
    })),
    skills: ensureArray(rawData.skills || d.skill_groups || d.skill_categories).map((s: any) => {
      if (typeof s === 'string') return { category: s, items: [] }
      return {
        category: s.category || s.name || s.group || '',
        items: ensureArray(s.items || s.skills || s.list || s.technologies),
      }
    }),
    education: ensureArray(rawData.education || d.educational_background).map((ed: any) => ({
      school: ed.school || ed.institution || ed.university || ed.college || '',
      degree: ed.degree || ed.program || ed.major || ed.qualification || '',
      dates: ed.dates || ed.date || ed.period || ed.year || '',
    })),
    certifications: ensureArray(rawData.certifications || d.certs || d.certifications),
  }

  const accent = resolveAccent(brand, '#1a2744')

  // Contact info row
  const contactParts: string[] = []
  if (data.contact.email) contactParts.push(data.contact.email)
  if (data.contact.phone) contactParts.push(data.contact.phone)
  if (data.contact.location) contactParts.push(data.contact.location)
  if (data.contact.linkedin) contactParts.push(data.contact.linkedin)
  if (data.contact.website) contactParts.push(data.contact.website)

  // Left sidebar content
  const sidebar: any[] = []

  // Skills
  if (data.skills.length > 0) {
    sidebar.push(sectionLabel('Skills', accent))
    sidebar.push(hr(accent, [0, 2, 0, 6]))
    for (const group of data.skills) {
      sidebar.push({ text: group.category, fontSize: 8.5, bold: true, color: '#333333', margin: [0, 4, 0, 2] })
      for (const item of group.items) {
        sidebar.push({
          table: {
            widths: ['*'],
            body: [[{
              text: item,
              fontSize: 7.5,
              color: '#555555',
              fillColor: '#f0f0f0',
              margin: [4, 2, 4, 2],
            }]],
          },
          layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
          margin: [0, 1, 0, 1],
        })
      }
    }
  }

  // Education
  if (data.education.length > 0) {
    sidebar.push({ text: '', margin: [0, 10, 0, 0] })
    sidebar.push(sectionLabel('Education', accent))
    sidebar.push(hr(accent, [0, 2, 0, 6]))
    for (const ed of data.education) {
      sidebar.push({ text: ed.school, fontSize: 8.5, bold: true, color: '#333333', margin: [0, 3, 0, 1] })
      sidebar.push({ text: ed.degree, fontSize: 8, color: '#555555', margin: [0, 0, 0, 1] })
      if (ed.dates) sidebar.push({ text: ed.dates, fontSize: 7.5, color: '#888888', margin: [0, 0, 0, 3] })
    }
  }

  // Certifications
  if (data.certifications && data.certifications.length > 0) {
    sidebar.push({ text: '', margin: [0, 10, 0, 0] })
    sidebar.push(sectionLabel('Certifications', accent))
    sidebar.push(hr(accent, [0, 2, 0, 6]))
    for (const cert of data.certifications) {
      sidebar.push({ text: `• ${cert}`, fontSize: 8, color: '#555555', margin: [0, 2, 0, 1] })
    }
  }

  // Right main content
  const main: any[] = []

  // Summary
  if (data.summary) {
    main.push(sectionLabel('Professional Summary', accent))
    main.push(hr(accent, [0, 2, 0, 5]))
    main.push({ text: data.summary, fontSize: 9.5, color: '#444444', lineHeight: 1.4, margin: [0, 0, 0, 10] })
  }

  // Experience
  if (data.experience.length > 0) {
    main.push(sectionLabel('Experience', accent))
    main.push(hr(accent, [0, 2, 0, 5]))
    for (const exp of data.experience) {
      // Company / dates row
      main.push({
        columns: [
          { text: exp.company, fontSize: 10.5, bold: true, color: '#222222', width: '*' },
          { text: exp.dates, fontSize: 8.5, color: '#888888', alignment: 'right', width: 'auto' },
        ],
        margin: [0, 4, 0, 1],
      })
      main.push({ text: exp.role, fontSize: 9.5, italics: true, color: '#555555', margin: [0, 0, 0, 3] })
      for (const bullet of exp.bullets) {
        main.push({
          text: `• ${bullet}`,
          fontSize: 9,
          color: '#444444',
          lineHeight: 1.35,
          margin: [8, 1, 0, 1],
        })
      }
      main.push({ text: '', margin: [0, 4, 0, 0] })
    }
  }

  const headerBlock: any[] = [
    // Name
    { text: data.name, fontSize: 24, bold: true, color: accent, margin: [0, 0, 0, 4] },
    // Contact row
    {
      text: contactParts.join('  |  '),
      fontSize: 8.5,
      color: '#555555',
      margin: [0, 0, 0, 8],
    },
    // Divider under header — table-based so it spans the full content width (532pt)
    // without requiring a hardcoded canvas coordinate.
    {
      table: {
        widths: ['*'],
        body: [[{ text: '', border: [false, false, false, true], borderColor: [accent, accent, accent, accent], margin: [0, 0, 0, 0] }]],
      },
      layout: {
        hLineWidth: (_i: number, _node: any) => 1.5,
        vLineWidth: () => 0,
        hLineColor: () => accent,
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 0,
        paddingBottom: () => 0,
      },
      margin: [0, 0, 0, 12],
    },
  ]

  return {
    pageSize: 'LETTER',
    pageMargins: [40, 40, 40, 40],
    content: [
      // Full-width header
      { stack: headerBlock },
      // Two-column body
      {
        columns: [
          // Left sidebar (30%)
          {
            width: '28%',
            stack: sidebar,
          },
          // Gutter
          { width: 16, text: '' },
          // Right main (70%)
          {
            width: '*',
            stack: main,
          },
        ],
      },
    ],
    styles: {
      body: { fontSize: 9, color: '#444444', lineHeight: 1.35 },
    },
    defaultStyle: { font: 'Roboto', fontSize: 9, color: '#444444' },
  }
}

// ── Proposal template ────────────────────────────────────────────────────────

function buildProposal(rawData: ProposalData, brand?: BrandKit): any {
  const d = rawData as any
  // Normalize — LLM may use snake_case or synonym variants
  const data: ProposalData = {
    ...rawData,
    title: rawData.title || d.proposal_title || d.name || '',
    client: rawData.client || d.client_name || d.customer || '',
    company: rawData.company || d.company_name || d.our_company || '',
    date: rawData.date || d.proposal_date || '',
    summary: ensureString(rawData.summary || d.executive_summary || d.overview || ''),
    scope: ensureArray(rawData.scope || d.scope_of_work || d.deliverables || d.services),
    timeline: ensureArray(rawData.timeline || d.project_timeline || d.phases || d.schedule).map((p: any) => ({
      phase: p.phase || p.name || p.milestone || '',
      dates: p.dates || p.date || p.timeline || p.period || '',
      description: p.description || p.details || p.tasks || '',
    })),
    pricing: ensureArray(rawData.pricing || d.price_items || d.line_items || d.lineItems || d.items).map((p: any) => ({
      item: p.item || p.name || p.service || p.description || '',
      description: p.description || p.details || p.notes || '',
      amount: ensureString(p.amount || p.price || p.cost || p.fee || ''),
    })),
    total: ensureString(rawData.total || d.total_amount || d.grand_total || ''),
    terms: rawData.terms || d.terms_and_conditions || d.payment_terms || '',
  }

  const accent = resolveAccent(brand, '#1a2744')
  const date = data.date || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  const content: any[] = []

  // ── Cover page ──
  const coverStack: any[] = []
  if (brand?.logoBase64) {
    coverStack.push({ image: brand.logoBase64, width: 100, alignment: 'center', margin: [0, 60, 0, 20] })
    coverStack.push({ text: '', margin: [0, 20, 0, 0] })
  } else {
    coverStack.push({ text: '', margin: [0, 120, 0, 0] })
  }
  coverStack.push(
    {
      text: data.title,
      fontSize: 28,
      bold: true,
      color: accent,
      alignment: 'center',
      margin: [0, 0, 0, 24],
    },
    { canvas: [{ type: 'line', x1: 100, y1: 0, x2: 415, y2: 0, lineWidth: 1.5, lineColor: accent }], margin: [0, 0, 0, 24] },
    ...(data.company ? [{ text: data.company, fontSize: 13, color: '#555555', alignment: 'center', margin: [0, 0, 0, 8] }] : []),
    {
      text: `Prepared for: ${data.client}`,
      fontSize: 12,
      color: '#555555',
      alignment: 'center',
      margin: [0, 0, 0, 8],
    },
    { text: date, fontSize: 11, color: '#888888', alignment: 'center', margin: [0, 0, 0, 0] },
  )
  content.push({ stack: coverStack })

  content.push({ text: '', pageBreak: 'after' })

  // ── Executive Summary ──
  content.push({
    stack: [
      {
        text: 'Executive Summary',
        fontSize: 16,
        bold: true,
        color: accent,
        margin: [0, 0, 0, 8],
      },
      // Left-border accent block: thin colored cell + text cell, zero-padding layout
      {
        table: {
          widths: [4, '*'],
          body: [[
            {
              text: '',
              fillColor: accent,
              border: [false, false, false, false],
              margin: [0, 0, 0, 0],
            },
            {
              text: data.summary,
              fontSize: 10.5,
              color: '#333333',
              lineHeight: 1.45,
              border: [false, false, false, false],
              margin: [10, 6, 6, 6],
            },
          ]],
        },
        layout: {
          hLineWidth: () => 0,
          vLineWidth: () => 0,
          paddingLeft: () => 0,
          paddingRight: () => 0,
          paddingTop: () => 0,
          paddingBottom: () => 0,
        },
        margin: [0, 0, 0, 20],
      },
    ],
    unbreakable: false,
  })

  // ── Scope of Work ──
  content.push({
    text: 'Scope of Work',
    fontSize: 14,
    bold: true,
    color: accent,
    margin: [0, 8, 0, 6],
  })
  for (const item of data.scope) {
    content.push({
      columns: [
        {
          width: 14,
          text: '-',
          fontSize: 10,
          color: accent,
          bold: true,
          margin: [0, 1, 0, 0],
        },
        {
          text: item,
          fontSize: 10,
          color: '#333333',
          lineHeight: 1.4,
          width: '*',
        },
      ],
      margin: [0, 3, 0, 3],
    })
  }

  // ── Timeline ──
  if (data.timeline && data.timeline.length > 0) {
    content.push({
      text: 'Project Timeline',
      fontSize: 14,
      bold: true,
      color: accent,
      margin: [0, 18, 0, 8],
    })
    const tlBody = [
      [
        { text: 'Phase', bold: true, color: '#ffffff', fillColor: accent, fontSize: 9, margin: [6, 5, 6, 5] },
        { text: 'Dates', bold: true, color: '#ffffff', fillColor: accent, fontSize: 9, margin: [6, 5, 6, 5] },
        { text: 'Description', bold: true, color: '#ffffff', fillColor: accent, fontSize: 9, margin: [6, 5, 6, 5] },
      ],
      ...data.timeline.map((row, i) => {
        // Support both 'dates' and 'date' field names defensively (LLM may produce either)
        const rowAny = row as any
        const dateCell = row.dates || rowAny.date || ''
        const bg = i % 2 === 1 ? '#f5f7fa' : undefined
        return [
          { text: row.phase, fontSize: 9, margin: [6, 4, 6, 4], fillColor: bg },
          { text: dateCell, fontSize: 9, margin: [6, 4, 6, 4], fillColor: bg },
          { text: row.description, fontSize: 9, margin: [6, 4, 6, 4], fillColor: bg },
        ]
      }),
    ]
    content.push({
      table: { widths: [130, 100, '*'], body: tlBody },
      layout: { hLineWidth: () => 0.5, vLineWidth: () => 0, hLineColor: () => '#dddddd' },
      margin: [0, 0, 0, 16],
    })
  }

  // ── Pricing ──
  content.push({
    text: 'Pricing',
    fontSize: 14,
    bold: true,
    color: accent,
    margin: [0, 8, 0, 8],
  })
  const pricingBody = [
    [
      { text: 'Item', bold: true, color: '#ffffff', fillColor: accent, fontSize: 9, margin: [6, 5, 6, 5] },
      { text: 'Description', bold: true, color: '#ffffff', fillColor: accent, fontSize: 9, margin: [6, 5, 6, 5] },
      { text: 'Amount', bold: true, color: '#ffffff', fillColor: accent, fontSize: 9, alignment: 'right', margin: [6, 5, 6, 5] },
    ],
    ...data.pricing.map((row, i) => [
      { text: row.item, fontSize: 9, margin: [6, 4, 6, 4], fillColor: i % 2 === 1 ? '#f5f7fa' : undefined },
      { text: row.description || '', fontSize: 9, color: '#666666', margin: [6, 4, 6, 4], fillColor: i % 2 === 1 ? '#f5f7fa' : undefined },
      { text: row.amount, fontSize: 9, alignment: 'right', margin: [6, 4, 6, 4], fillColor: i % 2 === 1 ? '#f5f7fa' : undefined },
    ]),
    // Total row
    [
      { text: '', border: [false, true, false, false], borderColor: ['transparent', '#cccccc', 'transparent', 'transparent'], colSpan: 2, margin: [0, 0, 0, 0] },
      {},
      {
        text: `Total: ${data.total}`,
        fontSize: 11,
        bold: true,
        color: '#ffffff',
        fillColor: accent,
        alignment: 'right',
        margin: [6, 6, 6, 6],
        border: [false, true, false, false],
      },
    ],
  ]
  content.push({
    table: { widths: ['*', '*', 120], body: pricingBody },
    layout: { hLineWidth: () => 0.5, vLineWidth: () => 0, hLineColor: () => '#dddddd' },
    margin: [0, 0, 0, 20],
  })

  // ── Terms ──
  if (data.terms) {
    content.push(hr('#dddddd', [0, 6, 0, 10]))
    content.push({ text: 'Terms & Conditions', fontSize: 10, bold: true, color: '#888888', margin: [0, 0, 0, 4] })
    content.push({ text: data.terms, fontSize: 8.5, color: '#888888', lineHeight: 1.4 })
  }

  return {
    pageSize: 'LETTER',
    pageMargins: [54, 60, 54, 54],
    content,
    footer: (currentPage: number, pageCount: number) => {
      if (currentPage === 1) return null
      return {
        columns: [
          { text: data.company || data.title, fontSize: 8, color: '#aaaaaa', margin: [54, 16, 0, 0] },
          { text: `${currentPage} / ${pageCount}`, fontSize: 8, color: '#aaaaaa', alignment: 'right', margin: [0, 16, 54, 0] },
        ],
      }
    },
    defaultStyle: { font: 'Roboto', fontSize: 10, color: '#333333' },
  }
}

// ── Invoice template ─────────────────────────────────────────────────────────

function buildInvoice(rawData: InvoiceData, brand?: BrandKit): any {
  const d = rawData as any
  // Normalize — LLM may send snake_case, synonyms, or flat fields
  // Cast sub-objects to `any` so we can probe arbitrary variant field names
  const fromRaw: any = rawData.from || d.sender || d.bill_from || {}
  const toRaw: any = rawData.to || d.recipient || d.bill_to || d.client || {}
  const data: InvoiceData = {
    ...rawData,
    invoiceNumber: rawData.invoiceNumber || d.invoice_number || d.number || d.id || '',
    date: rawData.date || d.invoice_date || d.issued_date || '',
    dueDate: rawData.dueDate || d.due_date || d.payment_due || '',
    from: {
      company: fromRaw.company || fromRaw.name || fromRaw.company_name || '',
      address: fromRaw.address || fromRaw.street || fromRaw.location || '',
      email: fromRaw.email || '',
      phone: fromRaw.phone || fromRaw.telephone || '',
    },
    to: {
      name: toRaw.name || toRaw.contact || toRaw.client_name || '',
      company: toRaw.company || toRaw.company_name || toRaw.organization || '',
      address: toRaw.address || toRaw.street || '',
      email: toRaw.email || '',
    },
    lineItems: ensureArray(rawData.lineItems || d.line_items || d.items || d.services).map((item: any) => ({
      description: item.description || item.name || item.service || item.item || '',
      quantity: Number(item.quantity || item.qty || item.units || 1),
      rate: ensureString(item.rate || item.unit_price || item.price || item.unit_rate || ''),
      amount: ensureString(item.amount || item.total || item.subtotal || item.line_total || ''),
    })),
    subtotal: ensureString(rawData.subtotal || d.sub_total || d.subtotal_amount || ''),
    tax: ensureString(rawData.tax || d.tax_amount || d.vat || ''),
    taxRate: ensureString(rawData.taxRate || d.tax_rate || d.vat_rate || ''),
    total: ensureString(rawData.total || d.total_amount || d.grand_total || d.amount_due || ''),
    notes: rawData.notes || d.additional_notes || d.memo || '',
    paymentTerms: rawData.paymentTerms || d.payment_terms || d.terms || '',
  }

  const accent = resolveAccent(brand, '#1a2744')

  const content: any[] = []

  // ── Header bar ──
  content.push({
    columns: [
      {
        width: '*',
        stack: [
          ...(brand?.logoBase64 ? [{ image: brand.logoBase64, width: 90, margin: [0, 0, 0, 4] }] : []),
          { text: data.from.company, fontSize: 16, bold: true, color: accent },
          ...(data.from.address ? [{ text: data.from.address, fontSize: 9, color: '#666666' }] : []),
          ...(data.from.email ? [{ text: data.from.email, fontSize: 9, color: '#666666' }] : []),
          ...(data.from.phone ? [{ text: data.from.phone, fontSize: 9, color: '#666666' }] : []),
        ],
      },
      {
        width: 'auto',
        stack: [
          { text: 'INVOICE', fontSize: 32, bold: true, color: accent, alignment: 'right' },
          { text: `#${data.invoiceNumber}`, fontSize: 11, color: '#666666', alignment: 'right', margin: [0, 2, 0, 0] },
        ],
      },
    ],
    margin: [0, 0, 0, 16],
  })

  content.push({
    table: { widths: ['*'], body: [[{ text: '', fillColor: accent, border: [false, false, false, false], margin: [0, 0, 0, 0] }]] },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0.75, paddingBottom: () => 0.75 },
    margin: [0, 0, 0, 16],
  })

  // ── Info block ──
  content.push({
    columns: [
      {
        width: '*',
        stack: [
          { text: 'BILL TO', fontSize: 7.5, bold: true, color: accent, letterSpacing: 1, margin: [0, 0, 0, 4] },
          { text: data.to.name, fontSize: 11, bold: true, color: '#222222' },
          ...(data.to.company ? [{ text: data.to.company, fontSize: 9, color: '#555555' }] : []),
          ...(data.to.address ? [{ text: data.to.address, fontSize: 9, color: '#555555' }] : []),
          ...(data.to.email ? [{ text: data.to.email, fontSize: 9, color: '#555555' }] : []),
        ],
      },
      {
        width: 160,
        table: {
          widths: ['*', 'auto'],
          body: [
            [
              { text: 'Invoice Date', fontSize: 9, color: '#888888', margin: [0, 3, 0, 3], border: [false, false, false, false] },
              { text: data.date, fontSize: 9, color: '#333333', bold: true, alignment: 'right', margin: [0, 3, 0, 3], border: [false, false, false, false] },
            ],
            [
              { text: 'Due Date', fontSize: 9, color: '#888888', margin: [0, 3, 0, 3], border: [false, false, false, false] },
              { text: data.dueDate, fontSize: 9, color: '#333333', bold: true, alignment: 'right', margin: [0, 3, 0, 3], border: [false, false, false, false] },
            ],
          ],
        },
        layout: 'noBorders',
      },
    ],
    margin: [0, 0, 0, 24],
  })

  // ── Line items table ──
  const itemRows = data.lineItems.map((item, i) => [
    { text: item.description, fontSize: 9.5, margin: [8, 6, 8, 6], fillColor: i % 2 === 1 ? '#f7f8fa' : undefined },
    { text: String(item.quantity), fontSize: 9.5, alignment: 'center', margin: [4, 6, 4, 6], fillColor: i % 2 === 1 ? '#f7f8fa' : undefined },
    { text: item.rate, fontSize: 9.5, alignment: 'right', margin: [4, 6, 8, 6], fillColor: i % 2 === 1 ? '#f7f8fa' : undefined },
    { text: item.amount, fontSize: 9.5, alignment: 'right', margin: [4, 6, 8, 6], fillColor: i % 2 === 1 ? '#f7f8fa' : undefined },
  ])

  content.push({
    table: {
      headerRows: 1,
      widths: ['*', 50, 80, 80],
      body: [
        [
          { text: 'Description', bold: true, color: '#ffffff', fillColor: accent, fontSize: 9, margin: [8, 7, 8, 7] },
          { text: 'Qty', bold: true, color: '#ffffff', fillColor: accent, fontSize: 9, alignment: 'center', margin: [4, 7, 4, 7] },
          { text: 'Rate', bold: true, color: '#ffffff', fillColor: accent, fontSize: 9, alignment: 'right', margin: [4, 7, 8, 7] },
          { text: 'Amount', bold: true, color: '#ffffff', fillColor: accent, fontSize: 9, alignment: 'right', margin: [4, 7, 8, 7] },
        ],
        ...itemRows,
      ],
    },
    layout: { hLineWidth: () => 0.5, vLineWidth: () => 0, hLineColor: () => '#e0e0e0' },
    margin: [0, 0, 0, 0],
  })

  // ── Summary block ──
  const summaryRows: any[][] = [
    [
      { text: 'Subtotal', fontSize: 9.5, color: '#666666', alignment: 'right', margin: [0, 4, 8, 4], border: [false, false, false, false] },
      { text: data.subtotal, fontSize: 9.5, color: '#333333', alignment: 'right', margin: [0, 4, 0, 4], border: [false, false, false, false] },
    ],
  ]
  if (data.tax) {
    summaryRows.push([
      { text: `Tax${data.taxRate ? ` (${data.taxRate})` : ''}`, fontSize: 9.5, color: '#666666', alignment: 'right', margin: [0, 4, 8, 4], border: [false, false, false, false] },
      { text: data.tax, fontSize: 9.5, color: '#333333', alignment: 'right', margin: [0, 4, 0, 4], border: [false, false, false, false] },
    ])
  }
  summaryRows.push([
    { text: 'Total Due', fontSize: 12, bold: true, color: accent, alignment: 'right', fillColor: '#f0f4fa', margin: [8, 7, 8, 7], border: [false, true, false, false], borderColor: ['transparent', accent, 'transparent', 'transparent'] },
    { text: data.total, fontSize: 12, bold: true, color: accent, alignment: 'right', fillColor: '#f0f4fa', margin: [0, 7, 8, 7], border: [false, true, false, false], borderColor: ['transparent', accent, 'transparent', 'transparent'] },
  ])

  content.push({
    columns: [
      { width: '*', text: '' },
      {
        width: 220,
        table: { widths: ['*', 90], body: summaryRows },
        layout: { hLineWidth: (i: number, node: any) => i === node.table.body.length - 1 || i === node.table.body.length ? 1 : 0, vLineWidth: () => 0, hLineColor: () => accent },
        margin: [0, 8, 0, 0],
      },
    ],
    margin: [0, 0, 0, 24],
  })

  // ── Notes / payment terms ──
  if (data.notes || data.paymentTerms) {
    content.push(hr('#e0e0e0', [0, 4, 0, 10]))
    if (data.paymentTerms) {
      content.push({ text: `Payment Terms: ${data.paymentTerms}`, fontSize: 8.5, color: '#888888', margin: [0, 0, 0, 4] })
    }
    if (data.notes) {
      content.push({ text: data.notes, fontSize: 8.5, color: '#888888', lineHeight: 1.4 })
    }
  }

  return {
    pageSize: 'LETTER',
    pageMargins: [48, 48, 48, 48],
    content,
    defaultStyle: { font: 'Roboto', fontSize: 9.5, color: '#333333' },
  }
}

// ── Letter template ──────────────────────────────────────────────────────────

function buildLetter(rawData: LetterData, brand?: BrandKit): any {
  const d = rawData as any
  // Cast sub-objects to `any` so we can probe arbitrary variant field names
  const fromRaw: any = rawData.from || d.sender || d.author || {}
  const toRaw: any = rawData.to || d.recipient || d.addressee || {}
  const data: LetterData = {
    ...rawData,
    from: {
      name: fromRaw.name || fromRaw.full_name || '',
      company: fromRaw.company || fromRaw.organization || fromRaw.company_name || '',
      address: fromRaw.address || fromRaw.street || '',
      email: fromRaw.email || '',
      phone: fromRaw.phone || fromRaw.telephone || '',
    },
    date: rawData.date || d.letter_date || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    to: {
      name: toRaw.name || toRaw.full_name || toRaw.contact || '',
      company: toRaw.company || toRaw.organization || '',
      address: toRaw.address || toRaw.street || '',
    },
    salutation: rawData.salutation || d.greeting || d.dear || 'Dear Sir or Madam,',
    body: ensureArray(rawData.body || d.content || d.paragraphs || d.message),
    closing: rawData.closing || d.sign_off || d.signoff || d.valediction || 'Sincerely,',
    senderName: rawData.senderName || d.sender_name || fromRaw.name || '',
    senderTitle: rawData.senderTitle || d.sender_title || d.title || fromRaw.title || '',
  }

  const accent = resolveAccent(brand, '#1a2744')

  const content: any[] = []

  // ── Letterhead ──
  content.push({
    stack: [
      ...(brand?.logoBase64 ? [{ image: brand.logoBase64, width: 100, margin: [0, 0, 0, 6] }] : []),
      { text: data.from.company || data.from.name, fontSize: 14, bold: true, color: accent },
      ...(data.from.address ? [{ text: data.from.address, fontSize: 9, color: '#666666' }] : []),
      ...(data.from.email ? [{ text: data.from.email, fontSize: 9, color: '#666666' }] : []),
      ...(data.from.phone ? [{ text: data.from.phone, fontSize: 9, color: '#666666' }] : []),
    ],
    margin: [0, 0, 0, 4],
  })

  content.push({
    table: { widths: ['*'], body: [[{ text: '', fillColor: accent, border: [false, false, false, false], margin: [0, 0, 0, 0] }]] },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 1, paddingBottom: () => 1 },
    margin: [0, 4, 0, 20],
  })

  // ── Date ──
  content.push({ text: data.date, fontSize: 10, color: '#555555', alignment: 'right', margin: [0, 0, 0, 20] })

  // ── Recipient ──
  content.push({
    stack: [
      { text: data.to.name, fontSize: 10.5, bold: true, color: '#222222' },
      ...(data.to.company ? [{ text: data.to.company, fontSize: 10, color: '#444444' }] : []),
      ...(data.to.address ? [{ text: data.to.address, fontSize: 10, color: '#444444' }] : []),
    ],
    margin: [0, 0, 0, 20],
  })

  // ── Salutation ──
  content.push({ text: data.salutation, fontSize: 10.5, color: '#222222', margin: [0, 0, 0, 14] })

  // ── Body paragraphs ──
  for (const paragraph of data.body) {
    content.push({ text: paragraph, fontSize: 10.5, color: '#333333', lineHeight: 1.55, margin: [0, 0, 0, 12] })
  }

  // ── Closing ──
  content.push({ text: data.closing, fontSize: 10.5, color: '#333333', margin: [0, 20, 0, 0] })
  content.push({ text: '', margin: [0, 40, 0, 0] }) // signature space
  content.push({ text: data.senderName, fontSize: 10.5, bold: true, color: '#222222' })
  if (data.senderTitle) {
    content.push({ text: data.senderTitle, fontSize: 10, color: '#666666' })
  }
  if (data.from.company) {
    content.push({ text: data.from.company, fontSize: 10, color: '#666666' })
  }

  return {
    pageSize: 'LETTER',
    pageMargins: [72, 54, 72, 54],
    content,
    defaultStyle: { font: 'Roboto', fontSize: 10.5, color: '#333333' },
  }
}

// ── Report template ──────────────────────────────────────────────────────────

function buildReport(rawData: ReportData, brand?: BrandKit): any {
  const d = rawData as any
  const data: ReportData = {
    ...rawData,
    title: rawData.title || d.report_title || d.name || '',
    subtitle: rawData.subtitle || d.sub_title || d.tagline || '',
    author: rawData.author || d.written_by || d.prepared_by || d.author_name || '',
    date: rawData.date || d.report_date || d.published || '',
    abstract: rawData.abstract || d.executive_summary || d.overview || d.summary || '',
    sections: ensureArray(rawData.sections || d.body || d.chapters || d.parts).map((sec: any) => ({
      heading: sec.heading || sec.title || sec.name || sec.section || '',
      subheading: sec.subheading || sec.subtitle || sec.sub_heading || '',
      body: ensureString(sec.body || sec.content || sec.text || sec.description || ''),
      figures: ensureArray(sec.figures || sec.images || sec.charts).map((fig: any) => {
        if (typeof fig === 'string') return { caption: fig, note: '' }
        return {
          caption: fig.caption || fig.title || fig.label || '',
          note: fig.note || fig.description || '',
        }
      }),
    })),
    footnotes: ensureArray(rawData.footnotes || d.notes || d.references || d.endnotes),
  }

  const accent = resolveAccent(brand, '#1a2744')
  const date = data.date || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  const content: any[] = []

  // ── Title page ──
  content.push({
    stack: [
      { text: '', margin: [0, 100, 0, 0] },
      ...(brand?.logoBase64 ? [{ image: brand.logoBase64, width: 80, alignment: 'center', margin: [0, 0, 0, 24] }] : []),
      { text: data.title, fontSize: 28, bold: true, color: accent, alignment: 'center', margin: [0, 0, 0, 16] },
      ...(data.subtitle ? [{ text: data.subtitle, fontSize: 14, color: '#666666', alignment: 'center', margin: [0, 0, 0, 12] }] : []),
      { canvas: [{ type: 'line', x1: 80, y1: 0, x2: 435, y2: 0, lineWidth: 1, lineColor: accent }], margin: [0, 8, 0, 16] },
      ...(data.author ? [{ text: `Prepared by: ${data.author}`, fontSize: 10, color: '#888888', alignment: 'center', margin: [0, 0, 0, 6] }] : []),
      { text: date, fontSize: 10, color: '#888888', alignment: 'center' },
    ],
  })

  if (data.abstract) {
    content.push({ text: '', margin: [0, 40, 0, 0] })
    content.push({ text: 'Abstract', fontSize: 11, bold: true, color: accent, alignment: 'center', margin: [0, 0, 0, 8] })
    content.push({
      table: {
        widths: ['*'],
        body: [[{
          text: data.abstract,
          fontSize: 9.5,
          color: '#555555',
          lineHeight: 1.45,
          italics: true,
          margin: [20, 10, 20, 10],
          border: [false, false, false, false],
          fillColor: '#f7f8fa',
        }]],
      },
      layout: 'noBorders',
      margin: [30, 0, 30, 0],
    })
  }

  content.push({ text: '', pageBreak: 'after' })

  // ── Body sections (numbered) ──
  let sectionNumber = 0
  for (const section of data.sections) {
    sectionNumber++
    content.push({
      stack: [
        {
          text: `${sectionNumber}. ${section.heading}`,
          fontSize: 14,
          bold: true,
          color: accent,
          margin: [0, 10, 0, 4],
        },
        hr('#dddddd', [0, 0, 0, 8]),
        ...(section.subheading ? [{
          text: section.subheading,
          fontSize: 11,
          bold: true,
          color: '#555555',
          margin: [0, 0, 0, 6],
        }] : []),
        { text: section.body, fontSize: 10.5, color: '#333333', lineHeight: 1.5, margin: [0, 0, 0, 10] },
        ...(section.figures ? section.figures.map((fig, fi) => ({
          stack: [
            {
              table: {
                widths: ['*'],
                body: [[{ text: fig.note || `[Figure ${sectionNumber}.${fi + 1}]`, fontSize: 9, color: '#888888', italics: true, alignment: 'center', margin: [0, 20, 0, 20], fillColor: '#f5f5f5', border: [false, false, false, false] }]],
              },
              layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => '#dddddd', vLineColor: () => '#dddddd' },
              margin: [30, 0, 30, 4],
            },
            { text: `Figure ${sectionNumber}.${fi + 1}: ${fig.caption}`, fontSize: 8.5, color: '#888888', italics: true, alignment: 'center', margin: [0, 0, 0, 12] },
          ],
        })) : []),
      ],
    })
  }

  // ── Footnotes ──
  if (data.footnotes && data.footnotes.length > 0) {
    content.push(hr('#cccccc', [0, 20, 0, 8]))
    data.footnotes.forEach((note, i) => {
      content.push({ text: `${i + 1}. ${note}`, fontSize: 8, color: '#888888', margin: [0, 2, 0, 2] })
    })
  }

  return {
    pageSize: 'LETTER',
    pageMargins: [60, 54, 60, 54],
    content,
    header: (currentPage: number) => {
      if (currentPage <= 1) return null
      return {
        columns: [
          { text: data.title, fontSize: 7.5, color: '#aaaaaa', margin: [60, 18, 0, 0] },
          ...(data.author ? [{ text: data.author, fontSize: 7.5, color: '#aaaaaa', alignment: 'right', margin: [0, 18, 60, 0] }] : []),
        ],
      }
    },
    footer: (currentPage: number, pageCount: number) => {
      if (currentPage <= 1) return null
      return { text: `Page ${currentPage} of ${pageCount}`, fontSize: 8, color: '#aaaaaa', alignment: 'right', margin: [0, 16, 60, 0] }
    },
    defaultStyle: { font: 'Roboto', fontSize: 10.5, color: '#333333' },
  }
}

// ── Brief/Memo template ──────────────────────────────────────────────────────

function buildBrief(rawData: BriefData, brand?: BrandKit): any {
  const d = rawData as any
  // Normalize action items — LLM sends task/due/assignee instead of action/deadline/owner
  const normalizeActionItem = (item: any) => {
    if (typeof item === 'string') return { action: item, owner: '', deadline: '' }
    return {
      action: item.action || item.task || item.description || item.item || '',
      owner: item.owner || item.assignee || item.assigned_to || item.responsible || '',
      deadline: item.deadline || item.due || item.due_date || item.date || '',
    }
  }
  const data: BriefData = {
    ...rawData,
    to: rawData.to || d.recipient || d.to_name || '',
    from: rawData.from || d.sender || d.from_name || d.author || '',
    date: rawData.date || d.memo_date || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    re: rawData.re || d.subject || d.regarding || d.re_line || d.topic || '',
    body: ensureArray(rawData.body || d.content || d.paragraphs || d.message || d.body_text),
    keyTakeaways: ensureArray(rawData.keyTakeaways || d.key_takeaways || d.takeaways || d.key_points || d.highlights),
    actionItems: ensureArray(rawData.actionItems || d.action_items || d.actions || d.tasks || d.next_steps).map(normalizeActionItem),
  }

  const accent = resolveAccent(brand, '#1a2744')

  const content: any[] = []

  // ── Header block ──
  content.push({
    stack: [
      ...(brand?.logoBase64 ? [{ image: brand.logoBase64, width: 80, margin: [0, 0, 0, 6] }] : []),
      {
        text: 'MEMORANDUM',
        fontSize: 18,
        bold: true,
        color: accent,
        letterSpacing: 2,
        margin: [0, 0, 0, 10],
      },
    ],
  })

  // Header fields table
  const headerFields: any[][] = [
    ['TO', data.to],
    ['FROM', data.from],
    ['DATE', data.date],
    ['RE', data.re],
  ].map(([label, value]) => [
    { text: label + ':', fontSize: 9.5, bold: true, color: accent, border: [false, false, false, false], margin: [0, 3, 8, 3] },
    { text: value, fontSize: 9.5, color: '#333333', border: [false, false, false, false], margin: [0, 3, 0, 3] },
  ])

  content.push({
    table: { widths: [40, '*'], body: headerFields },
    layout: 'noBorders',
    margin: [0, 0, 0, 4],
  })

  content.push({
    table: { widths: ['*'], body: [[{ text: '', fillColor: accent, border: [false, false, false, false], margin: [0, 0, 0, 0] }]] },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 1, paddingBottom: () => 1 },
    margin: [0, 2, 0, 16],
  })

  // ── Body ──
  for (const para of data.body) {
    content.push({ text: para, fontSize: 10, color: '#333333', lineHeight: 1.45, margin: [0, 0, 0, 10] })
  }

  // ── Key Takeaways box ──
  if (data.keyTakeaways.length > 0) {
    content.push({ text: '', margin: [0, 6, 0, 0] })
    content.push({
      table: {
        widths: ['*'],
        body: [[{
          stack: [
            { text: 'Key Takeaways', fontSize: 9.5, bold: true, color: accent, margin: [0, 0, 0, 6] },
            ...data.keyTakeaways.map(item => ({
              columns: [
                { width: 12, text: '•', color: accent, bold: true, fontSize: 10, margin: [0, 0, 0, 0] },
                { text: item, fontSize: 9.5, color: '#333333', lineHeight: 1.35, width: '*' },
              ],
              margin: [0, 2, 0, 2],
            })),
          ],
          fillColor: '#f0f4fa',
          margin: [12, 10, 12, 10],
          border: [false, false, false, false],
        }]],
      },
      layout: {
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 0,
        paddingBottom: () => 0,
      },
      margin: [0, 0, 0, 14],
    })
  }

  // ── Action items ──
  if (data.actionItems.length > 0) {
    content.push({ text: 'Action Items', fontSize: 10.5, bold: true, color: accent, margin: [0, 4, 0, 6] })
    const aiBody = [
      [
        { text: '#', bold: true, color: '#ffffff', fillColor: accent, fontSize: 8.5, margin: [6, 5, 6, 5] },
        { text: 'Action', bold: true, color: '#ffffff', fillColor: accent, fontSize: 8.5, margin: [6, 5, 6, 5] },
        { text: 'Owner', bold: true, color: '#ffffff', fillColor: accent, fontSize: 8.5, margin: [6, 5, 6, 5] },
        { text: 'Deadline', bold: true, color: '#ffffff', fillColor: accent, fontSize: 8.5, margin: [6, 5, 6, 5] },
      ],
      ...data.actionItems.map((item, i) => [
        { text: String(i + 1), fontSize: 8.5, margin: [6, 4, 6, 4], fillColor: i % 2 === 1 ? '#f5f7fa' : undefined },
        { text: item.action, fontSize: 8.5, margin: [6, 4, 6, 4], fillColor: i % 2 === 1 ? '#f5f7fa' : undefined },
        { text: item.owner, fontSize: 8.5, margin: [6, 4, 6, 4], fillColor: i % 2 === 1 ? '#f5f7fa' : undefined },
        { text: item.deadline, fontSize: 8.5, margin: [6, 4, 6, 4], fillColor: i % 2 === 1 ? '#f5f7fa' : undefined },
      ]),
    ]
    content.push({
      table: { widths: [20, '*', 90, 80], body: aiBody },
      layout: { hLineWidth: () => 0.5, vLineWidth: () => 0, hLineColor: () => '#dddddd' },
    })
  }

  return {
    pageSize: 'LETTER',
    pageMargins: [54, 48, 54, 48],
    content,
    defaultStyle: { font: 'Roboto', fontSize: 10, color: '#333333' },
  }
}

// ── Newsletter template ──────────────────────────────────────────────────────

function buildNewsletter(rawData: NewsletterData, brand?: BrandKit): any {
  const d = rawData as any
  const data: NewsletterData = {
    ...rawData,
    // LLM commonly sends 'masthead' or 'newsletter_name' instead of 'name'
    name: rawData.name || d.masthead || d.newsletter_name || d.publication || d.title || '',
    issue: rawData.issue || d.issue_number || d.edition || d.volume || '',
    date: rawData.date || d.publish_date || d.published_date || '',
    articles: ensureArray(rawData.articles || d.stories || d.posts || d.sections || d.content).map((art: any) => {
      if (typeof art === 'string') return { title: '', body: art, pullQuote: '' }
      return {
        // LLM sends 'headline' or 'subject' instead of 'title'
        title: art.title || art.headline || art.subject || art.name || '',
        body: ensureString(art.body || art.content || art.text || art.article || art.copy || ''),
        pullQuote: art.pullQuote || art.pull_quote || art.quote || art.callout || '',
      }
    }),
    tableOfContents: ensureArray(rawData.tableOfContents || d.table_of_contents || d.toc || d.contents),
  }

  const accent = resolveAccent(brand, '#1a2744')
  const issueDate = [data.issue, data.date].filter(Boolean).join(' — ')

  const content: any[] = []

  // ── Masthead ──
  const mastheadStack: any[] = []
  if (brand?.logoBase64) {
    mastheadStack.push({
      columns: [
        { image: brand.logoBase64, width: 40, margin: [0, 2, 10, 0] },
        {
          stack: [
            { text: data.name, fontSize: 22, bold: true, color: '#ffffff', margin: [0, 0, 0, 2] },
            ...(issueDate ? [{ text: issueDate, fontSize: 9, color: '#cccccc' }] : []),
          ],
          width: '*',
        },
      ],
    })
  } else {
    mastheadStack.push(
      { text: data.name, fontSize: 22, bold: true, color: '#ffffff', margin: [0, 0, 0, 2] },
      ...(issueDate ? [{ text: issueDate, fontSize: 9, color: '#cccccc' }] : []),
    )
  }
  content.push({
    table: {
      widths: ['*'],
      body: [[{
        stack: mastheadStack,
        fillColor: accent,
        margin: [16, 12, 16, 12],
        border: [false, false, false, false],
      }]],
    },
    layout: 'noBorders',
    margin: [0, 0, 0, 0],
  })
  content.push({
    table: { widths: ['*'], body: [[{ text: '', fillColor: '#e8b400', border: [false, false, false, false], margin: [0, 0, 0, 0] }]] },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 1.5, paddingBottom: () => 1.5 },
    margin: [0, 0, 0, 12],
  })

  // ── Table of contents / In This Issue ──
  if (data.tableOfContents && data.tableOfContents.length > 0) {
    content.push({
      columns: [
        { width: '*', text: '' },
        {
          width: 200,
          table: {
            widths: ['*'],
            body: [[{
              stack: [
                { text: 'IN THIS ISSUE', fontSize: 7.5, bold: true, color: accent, letterSpacing: 1, margin: [0, 0, 0, 6] },
                ...data.tableOfContents.map((item, i) => ({
                  text: `${i + 1}.  ${item}`,
                  fontSize: 8.5,
                  color: '#444444',
                  margin: [0, 2, 0, 2],
                })),
              ],
              fillColor: '#f5f7fa',
              margin: [10, 8, 10, 8],
              border: [false, false, false, false],
            }]],
          },
          layout: 'noBorders',
        },
      ],
      margin: [0, 0, 0, 16],
    })
  }

  // ── Articles in two-column layout ──
  for (let i = 0; i < data.articles.length; i++) {
    const article = data.articles[i]

    // Section divider line + article title
    if (i > 0) {
      content.push({
        stack: [
          hr('#cccccc', [0, 8, 0, 10]),
        ],
      })
    }

    // Two-column article
    const leftCol: any[] = [
      {
        text: article.title,
        fontSize: 13,
        bold: true,
        color: accent,
        margin: [0, 0, 0, 6],
      },
    ]

    // Split body at roughly the midpoint for two columns
    const sentences = article.body.split('. ')
    const mid = Math.ceil(sentences.length / 2)
    const leftText = sentences.slice(0, mid).join('. ') + (sentences.length > 1 ? '.' : '')
    const rightText = sentences.slice(mid).join('. ') + (sentences.length > mid ? '.' : '')

    leftCol.push({ text: leftText, fontSize: 9.5, color: '#333333', lineHeight: 1.5 })

    const rightCol: any[] = []

    if (article.pullQuote) {
      rightCol.push({
        table: {
          widths: [3, '*'],
          body: [[
            { text: '', fillColor: accent, border: [false, false, false, false], margin: [0, 0, 0, 0] },
            {
              text: `"${article.pullQuote}"`,
              fontSize: 12,
              italics: true,
              color: '#333333',
              lineHeight: 1.45,
              margin: [10, 8, 6, 8],
              border: [false, false, false, false],
            },
          ]],
        },
        layout: {
          hLineWidth: () => 0,
          vLineWidth: () => 0,
          paddingLeft: () => 0,
          paddingRight: () => 0,
          paddingTop: () => 0,
          paddingBottom: () => 0,
        },
        margin: [0, 0, 0, 10],
      })
    }

    if (rightText.trim()) {
      rightCol.push({ text: rightText, fontSize: 9.5, color: '#333333', lineHeight: 1.5 })
    }

    content.push({
      columns: [
        { width: '*', stack: leftCol },
        { width: 14, text: '' }, // gutter
        { width: '*', stack: rightCol.length > 0 ? rightCol : [{ text: '', fontSize: 9.5 }] },
      ],
      margin: [0, 0, 0, 8],
    })
  }

  return {
    pageSize: 'LETTER',
    pageMargins: [40, 40, 40, 48],
    content,
    footer: (currentPage: number, pageCount: number) => ({
      columns: [
        { text: data.name, fontSize: 7.5, color: '#aaaaaa', margin: [40, 12, 0, 0] },
        { text: `${currentPage} / ${pageCount}`, fontSize: 7.5, color: '#aaaaaa', alignment: 'right', margin: [0, 12, 40, 0] },
      ],
    }),
    defaultStyle: { font: 'Roboto', fontSize: 9.5, color: '#333333' },
  }
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function renderTemplatedDocument(
  data: TemplateData,
  brand?: BrandKit,
): Promise<Buffer> {
  ensurePdfmake()

  let docDefinition: any

  switch (data.template) {
    case 'resume':
      docDefinition = buildResume(data, brand)
      break
    case 'proposal':
      docDefinition = buildProposal(data, brand)
      break
    case 'invoice':
      docDefinition = buildInvoice(data, brand)
      break
    case 'letter':
      docDefinition = buildLetter(data, brand)
      break
    case 'report':
      docDefinition = buildReport(data, brand)
      break
    case 'brief':
      docDefinition = buildBrief(data, brand)
      break
    case 'newsletter':
      docDefinition = buildNewsletter(data, brand)
      break
    default: {
      const _exhaustive: never = data
      throw new Error(`Unknown template: ${(_exhaustive as any).template}`)
    }
  }

  // Always inject font config
  docDefinition.defaultStyle = {
    font: 'Roboto',
    ...docDefinition.defaultStyle,
  }

  const doc = pdfmake.createPdf(docDefinition)
  return await doc.getBuffer()
}
