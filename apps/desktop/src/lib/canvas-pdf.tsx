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
  // For code blocks
  code?: string
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
      // Skip mermaid blocks
      if (lang !== 'mermaid') {
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
      paddingTop: 48,
      paddingBottom: 48,
      paddingLeft: 48,
      paddingRight: 48,
      fontFamily: 'Helvetica',
    },
    logoImage: {
      maxHeight: 48,
      marginBottom: 24,
      objectFit: 'contain',
    },
    logoText: {
      fontSize: 18,
      fontWeight: 'bold',
      color: brand.primary,
      marginBottom: 24,
    },
    h1: {
      fontSize: 24,
      fontWeight: 'bold',
      color: brand.primary,
      marginTop: 16,
      marginBottom: 8,
    },
    h2: {
      fontSize: 18,
      fontWeight: 'bold',
      color: brand.primary,
      marginTop: 14,
      marginBottom: 6,
    },
    h3: {
      fontSize: 14,
      fontWeight: 'bold',
      color: brand.primary,
      marginTop: 12,
      marginBottom: 4,
    },
    paragraph: {
      fontSize: 11,
      marginBottom: 8,
      lineHeight: 1.6,
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
      marginTop: 8,
      marginBottom: 8,
      backgroundColor: '#f9f9f9',
    },
    blockquoteText: {
      fontSize: 11,
      color: '#555555',
      lineHeight: 1.6,
    },
    codeBlock: {
      backgroundColor: '#f3f4f6',
      padding: 10,
      marginTop: 8,
      marginBottom: 8,
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
      marginBottom: 8,
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
      marginTop: 8,
      marginBottom: 8,
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
        {/* Logo / brand header */}
        {brand.logoUrl ? (
          <Image src={brand.logoUrl} style={styles.logoImage} />
        ) : brand.name ? (
          <Text style={styles.logoText}>{brand.name}</Text>
        ) : null}

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
                    <View key={j} style={styles.listRow}>
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
                    <View key={j} style={styles.listRow}>
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
// Public API
// ---------------------------------------------------------------------------

export async function renderCanvasPdf(
  markdown: string,
  brand: BrandValues,
  title?: string
): Promise<Blob> {
  const blocks = parseMarkdown(markdown)
  const instance = pdf(<CanvasDocument blocks={blocks} brand={brand} title={title} />)
  return instance.toBlob()
}
