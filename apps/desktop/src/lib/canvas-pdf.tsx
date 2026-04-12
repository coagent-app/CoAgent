// canvas-pdf.tsx — converts markdown + brand values into a PDF blob using @react-pdf/renderer

import React from 'react'
import {
  Document,
  Page,
  Text,
  View,
  Image,
  StyleSheet,
  pdf,
} from '@react-pdf/renderer'
import type { BrandValues } from '@/lib/canvas-brand'

// ---------------------------------------------------------------------------
// Markdown block types
// ---------------------------------------------------------------------------

type BlockType =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'paragraph'
  | 'hr'
  | 'ul'
  | 'ol'
  | 'blockquote'
  | 'code'
  | 'table'
  | 'mermaid'

interface TextSegment {
  text: string
  bold: boolean
}

interface Block {
  type: BlockType
  // For headings / paragraphs / blockquote — parsed into segments for inline bold
  segments?: TextSegment[]
  // For ul/ol — each item parsed into segments
  items?: TextSegment[][]
  // For code blocks / mermaid
  code?: string
  // For mermaid — pre-rendered PNG data URI
  imageDataUri?: string
  // For tables
  headers?: string[]
  rows?: string[][]
}

// ---------------------------------------------------------------------------
// Inline parser: splits text on **bold** markers
// ---------------------------------------------------------------------------

function parseInline(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  const re = /\*\*(.+?)\*\*/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      segments.push({ text: text.slice(last, match.index), bold: false })
    }
    segments.push({ text: match[1], bold: true })
    last = match.index + match[0].length
  }
  if (last < text.length) {
    segments.push({ text: text.slice(last), bold: false })
  }
  return segments.length > 0 ? segments : [{ text, bold: false }]
}

// ---------------------------------------------------------------------------
// Markdown block parser (line-based, no external deps)
// ---------------------------------------------------------------------------

function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block (``` or ```lang)
    if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing ```
      const lang = line.trim().slice(3).trim().toLowerCase()
      if (lang === 'mermaid') {
        blocks.push({ type: 'mermaid', code: codeLines.join('\n') })
      } else {
        blocks.push({ type: 'code', code: codeLines.join('\n') })
      }
      continue
    }

    // Heading
    const h1 = /^# (.+)$/.exec(line)
    if (h1) {
      blocks.push({ type: 'h1', segments: parseInline(h1[1].trim()) })
      i++
      continue
    }
    const h2 = /^## (.+)$/.exec(line)
    if (h2) {
      blocks.push({ type: 'h2', segments: parseInline(h2[1].trim()) })
      i++
      continue
    }
    const h3 = /^### (.+)$/.exec(line)
    if (h3) {
      blocks.push({ type: 'h3', segments: parseInline(h3[1].trim()) })
      i++
      continue
    }

    // Horizontal rule: lines that are only dashes / asterisks / underscores
    if (/^(\s*[-*_]){3,}\s*$/.test(line) && line.trim().length > 0) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    // Blockquote
    if (line.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      blocks.push({
        type: 'blockquote',
        segments: parseInline(quoteLines.join(' ')),
      })
      continue
    }

    // GFM table: detect by presence of | characters
    if (line.includes('|')) {
      // Collect all contiguous pipe-containing lines
      const tableLines: string[] = []
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i])
        i++
      }
      if (tableLines.length >= 2) {
        const parseRow = (row: string) =>
          row
            .split('|')
            .map((c) => c.trim())
            .filter((c) => c.length > 0)

        const headers = parseRow(tableLines[0])
        // tableLines[1] is the alignment row — skip it
        const rows = tableLines.slice(2).map(parseRow)
        blocks.push({ type: 'table', headers, rows })
        continue
      }
      // Fallback: not a real table, treat as paragraph
    }

    // Unordered list
    if (/^[-*+] /.test(line)) {
      const items: TextSegment[][] = []
      while (i < lines.length && /^[-*+] /.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^[-*+] /, '')))
        i++
      }
      blocks.push({ type: 'ul', items })
      continue
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const items: TextSegment[][] = []
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\d+\. /, '')))
        i++
      }
      blocks.push({ type: 'ol', items })
      continue
    }

    // Empty line — skip
    if (line.trim() === '') {
      i++
      continue
    }

    // Paragraph: collect consecutive non-empty, non-special lines
    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('>') &&
      !/^(\s*[-*_]){3,}\s*$/.test(lines[i]) &&
      !lines[i].trimStart().startsWith('```') &&
      !/^[-*+] /.test(lines[i]) &&
      !/^\d+\. /.test(lines[i]) &&
      !lines[i].includes('|')
    ) {
      paraLines.push(lines[i])
      i++
    }
    if (paraLines.length > 0) {
      blocks.push({
        type: 'paragraph',
        segments: parseInline(paraLines.join(' ')),
      })
    }
  }

  return blocks
}

// ---------------------------------------------------------------------------
// StyleSheet factory — brand-aware
// ---------------------------------------------------------------------------

function makeStyles(brand: BrandValues) {
  return StyleSheet.create({
    page: {
      backgroundColor: '#ffffff',
      paddingTop: 40,
      paddingBottom: 40,
      paddingLeft: 48,
      paddingRight: 48,
      fontFamily: 'Helvetica',
    },
    logoWrapper: {
      alignItems: 'flex-start',
      marginBottom: 24,
    },
    logoImage: {
      maxHeight: 48,
      maxWidth: 180,
    },
    logoText: {
      fontSize: 18,
      fontWeight: 'bold',
      color: brand.primary,
    },
    h1: {
      fontSize: 24,
      fontWeight: 'bold',
      color: brand.primary,
      marginTop: 14,
      marginBottom: 6,
      minPresenceAhead: 40,
    },
    h2: {
      fontSize: 18,
      fontWeight: 'bold',
      color: brand.primary,
      marginTop: 12,
      marginBottom: 5,
      minPresenceAhead: 36,
    },
    h3: {
      fontSize: 14,
      fontWeight: 'bold',
      color: brand.primary,
      marginTop: 10,
      marginBottom: 4,
      minPresenceAhead: 30,
    },
    paragraph: {
      fontSize: 11,
      marginBottom: 6,
      lineHeight: 1.5,
      color: '#1a1a1a',
    },
    paragraphBold: {
      fontWeight: 'bold',
      color: '#111111',
    },
    hr: {
      borderBottomWidth: 2,
      borderBottomColor: brand.primary,
      marginTop: 12,
      marginBottom: 12,
    },
    blockquoteWrapper: {
      borderLeftWidth: 3,
      borderLeftColor: brand.primary,
      paddingLeft: 10,
      paddingTop: 4,
      paddingBottom: 4,
      marginTop: 6,
      marginBottom: 6,
      backgroundColor: '#f9f9f9',
      minPresenceAhead: 20,
    },
    blockquoteText: {
      fontSize: 11,
      color: '#555555',
      lineHeight: 1.6,
    },
    codeBlock: {
      backgroundColor: '#f3f4f6',
      padding: 10,
      marginTop: 6,
      marginBottom: 6,
      minPresenceAhead: 20,
    },
    codeText: {
      fontSize: 10,
      fontFamily: 'Courier',
      color: '#1a1a1a',
    },
    listItem: {
      fontSize: 11,
      lineHeight: 1.6,
      color: '#1a1a1a',
      marginBottom: 3,
    },
    listWrapper: {
      marginBottom: 6,
    },
    listRow: {
      flexDirection: 'row',
      marginBottom: 3,
    },
    bullet: {
      width: 16,
      fontSize: 11,
      color: '#1a1a1a',
    },
    listContent: {
      flex: 1,
      fontSize: 11,
      lineHeight: 1.6,
      color: '#1a1a1a',
    },
    tableWrapper: {
      marginTop: 6,
      marginBottom: 6,
    },
    tableHeaderRow: {
      flexDirection: 'row',
      backgroundColor: brand.primary,
    },
    tableHeaderCell: {
      flex: 1,
      padding: 6,
      fontSize: 10,
      fontWeight: 'bold',
      color: '#ffffff',
    },
    tableRow: {
      flexDirection: 'row',
      borderBottomWidth: 1,
      borderBottomColor: '#eeeeee',
    },
    tableRowAlt: {
      flexDirection: 'row',
      borderBottomWidth: 1,
      borderBottomColor: '#eeeeee',
      backgroundColor: '#f9f9f9',
    },
    tableCell: {
      flex: 1,
      padding: 6,
      fontSize: 10,
      color: '#1a1a1a',
    },
    mermaidWrapper: {
      marginTop: 6,
      marginBottom: 6,
      alignItems: 'center' as const,
      minPresenceAhead: 60,
    },
    mermaidImage: {
      maxWidth: 480,
      maxHeight: 320,
    },
  })
}

// ---------------------------------------------------------------------------
// Inline text renderer — handles bold segments within a parent Text
// ---------------------------------------------------------------------------

function InlineText({
  segments,
  style,
  boldStyle,
}: {
  segments: TextSegment[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  style: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  boldStyle: any
}) {
  return (
    <Text style={style}>
      {segments.map((seg, idx) =>
        seg.bold ? (
          <Text key={idx} style={boldStyle}>
            {seg.text}
          </Text>
        ) : (
          <Text key={idx}>{seg.text}</Text>
        )
      )}
    </Text>
  )
}

// ---------------------------------------------------------------------------
// Main Document component
// ---------------------------------------------------------------------------

function CanvasDocument({
  blocks,
  brand,
  title,
}: {
  blocks: Block[]
  brand: BrandValues
  title?: string
}) {
  const styles = makeStyles(brand)

  return (
    <Document title={title}>
      <Page size="A4" style={styles.page}>
        {/* Logo / brand header — top-left aligned */}
        {(brand.logoUrl || brand.name) && (
          <View style={styles.logoWrapper}>
            {brand.logoUrl ? (
              <Image src={brand.logoUrl} style={styles.logoImage} />
            ) : (
              <Text style={styles.logoText}>{brand.name}</Text>
            )}
          </View>
        )}

        {blocks.map((block, idx) => {
          switch (block.type) {
            case 'h1':
              return (
                <InlineText
                  key={idx}
                  segments={block.segments!}
                  style={styles.h1}
                  boldStyle={styles.paragraphBold}
                />
              )
            case 'h2':
              return (
                <InlineText
                  key={idx}
                  segments={block.segments!}
                  style={styles.h2}
                  boldStyle={styles.paragraphBold}
                />
              )
            case 'h3':
              return (
                <InlineText
                  key={idx}
                  segments={block.segments!}
                  style={styles.h3}
                  boldStyle={styles.paragraphBold}
                />
              )

            case 'paragraph':
              return (
                <InlineText
                  key={idx}
                  segments={block.segments!}
                  style={styles.paragraph}
                  boldStyle={{ ...styles.paragraph, ...styles.paragraphBold }}
                />
              )

            case 'hr':
              return <View key={idx} style={styles.hr} />

            case 'blockquote':
              return (
                <View key={idx} style={styles.blockquoteWrapper}>
                  <InlineText
                    segments={block.segments!}
                    style={styles.blockquoteText}
                    boldStyle={{ ...styles.blockquoteText, fontWeight: 'bold' }}
                  />
                </View>
              )

            case 'code':
              return (
                <View key={idx} style={styles.codeBlock}>
                  <Text style={styles.codeText}>{block.code}</Text>
                </View>
              )

            case 'ul':
              return (
                <View key={idx} style={styles.listWrapper}>
                  {(block.items ?? []).map((item, j) => (
                    <View key={j} style={styles.listRow} wrap={false}>
                      <Text style={styles.bullet}>{'•  '}</Text>
                      <InlineText
                        segments={item}
                        style={styles.listContent}
                        boldStyle={{ ...styles.listContent, fontWeight: 'bold' }}
                      />
                    </View>
                  ))}
                </View>
              )

            case 'ol':
              return (
                <View key={idx} style={styles.listWrapper}>
                  {(block.items ?? []).map((item, j) => (
                    <View key={j} style={styles.listRow} wrap={false}>
                      <Text style={styles.bullet}>{`${j + 1}.  `}</Text>
                      <InlineText
                        segments={item}
                        style={styles.listContent}
                        boldStyle={{ ...styles.listContent, fontWeight: 'bold' }}
                      />
                    </View>
                  ))}
                </View>
              )

            case 'mermaid':
              return block.imageDataUri ? (
                <View key={idx} wrap={false} style={styles.mermaidWrapper}>
                  <Image src={block.imageDataUri} style={{ maxWidth: 360, maxHeight: 240 }} />
                </View>
              ) : (
                <View key={idx} style={styles.codeBlock}>
                  <Text style={{ ...styles.codeText, color: '#666', fontSize: 9, marginBottom: 4 }}>[Diagram]</Text>
                  <Text style={styles.codeText}>{block.code}</Text>
                </View>
              )

            case 'table': {
              const headers = block.headers ?? []
              const rows = block.rows ?? []
              return (
                <View key={idx} style={styles.tableWrapper}>
                  {/* Header row */}
                  <View style={styles.tableHeaderRow}>
                    {headers.map((h, j) => (
                      <Text key={j} style={styles.tableHeaderCell}>
                        {h}
                      </Text>
                    ))}
                  </View>
                  {/* Data rows */}
                  {rows.map((row, j) => (
                    <View
                      key={j}
                      style={j % 2 === 0 ? styles.tableRow : styles.tableRowAlt}
                    >
                      {row.map((cell, k) => (
                        <Text key={k} style={styles.tableCell}>
                          {cell}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              )
            }

            default:
              return null
          }
        })}
      </Page>
    </Document>
  )
}

// ---------------------------------------------------------------------------
// Mermaid → PNG pre-renderer (uses the mermaid library in the browser)
// ---------------------------------------------------------------------------

async function renderMermaidBlocks(blocks: Block[]): Promise<void> {
  const mermaidBlocks = blocks.filter(b => b.type === 'mermaid' && b.code)
  if (mermaidBlocks.length === 0) return

  try {
    const mermaid = (await import('mermaid')).default
    // Always re-initialize to ensure PDF gets the right theme (shared mermaid instance)
    {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: 'base',
        themeVariables: {
          fontFamily: 'Helvetica, Arial, sans-serif',
          fontSize: '13px',
          background: '#ffffff',
          mainBkg: '#ffffff',
          primaryColor: '#dbeafe',
          primaryTextColor: '#1e3a5f',
          primaryBorderColor: '#3b82f6',
          secondaryColor: '#fce7f3',
          secondaryBorderColor: '#ec4899',
          tertiaryColor: '#d1fae5',
          tertiaryBorderColor: '#10b981',
          lineColor: '#374151',
          pie1: '#3b82f6',
          pie2: '#10b981',
          pie3: '#f59e0b',
          pie4: '#ef4444',
          pie5: '#8b5cf6',
          pie6: '#06b6d4',
          pie7: '#ec4899',
          pie8: '#f97316',
        },
        xyChart: {
          backgroundColor: 'transparent',
          plotColorPalette: '#3b82f6,#10b981,#ef4444,#f59e0b,#8b5cf6,#06b6d4,#ec4899,#f97316',
        },
      })
    }

    for (let i = 0; i < mermaidBlocks.length; i++) {
      const block = mermaidBlocks[i]
      try {
        const id = `pdf-mermaid-${Date.now()}-${i}`
        const { svg } = await mermaid.render(id, block.code!)
        // Convert SVG to PNG data URI via canvas
        const pngDataUri = await svgToPng(svg, 700, 400)
        block.imageDataUri = pngDataUri
      } catch (err) {
        console.warn('[canvas-pdf] mermaid render failed for block:', err)
        // Leave imageDataUri undefined — will fall back to showing code
      }
    }
  } catch (err) {
    console.warn('[canvas-pdf] mermaid import failed:', err)
  }
}

function svgToPng(svgString: string, maxW: number, maxH: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new window.Image()
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    img.onload = () => {
      // Scale to fit within maxW × maxH while preserving aspect ratio
      let w = img.naturalWidth || maxW
      let h = img.naturalHeight || maxH
      const scale = Math.min(maxW / w, maxH / h, 2) // cap at 2x
      w = Math.round(w * scale)
      h = Math.round(h * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('SVG to PNG conversion failed'))
    }
    img.src = url
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function renderCanvasPdf(
  markdown: string,
  brand: BrandValues,
  title?: string
): Promise<Blob> {
  const blocks = parseMarkdown(markdown)
  // Pre-render mermaid diagrams to PNG before building the PDF
  await renderMermaidBlocks(blocks)
  const instance = pdf(<CanvasDocument blocks={blocks} brand={brand} title={title} />)
  return instance.toBlob()
}
