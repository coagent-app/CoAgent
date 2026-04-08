import { View, Text, StyleSheet } from '@react-pdf/renderer'
import type { TextBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g

function stripMarkdown(s: string): string {
  // Minimal: bold/italic/code markers, placeholders, bullet glyphs.
  return s
    .replace(PLACEHOLDER_RE, '…')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}

// Split a line into alternating normal/bold spans based on **..** markers.
function parseInlineBold(s: string): Array<{ text: string; bold: boolean }> {
  const parts = s.split(/\*\*(.*?)\*\*/g)
  // split with a capture group alternates: [normal, bold, normal, bold, ...]
  return parts.map((part, i) => ({ text: part, bold: i % 2 === 1 })).filter(p => p.text !== '')
}

type PdfStyle = ReturnType<typeof StyleSheet.create>[string]

// Render a line as a <Text> with optional inline bold spans.
function InlineText({ text, style }: { text: string; style: PdfStyle }) {
  if (!text.includes('**')) {
    return <Text style={style}>{text}</Text>
  }
  const segments = parseInlineBold(text)
  return (
    <Text style={style}>
      {segments.map((seg, i) =>
        seg.bold
          ? <Text key={i} style={{ fontWeight: 700 }}>{seg.text}</Text>
          : <Text key={i}>{seg.text}</Text>
      )}
    </Text>
  )
}

export function TextPdf({ block, palette: _palette }: { block: TextBlock; palette: BrandPalette }) {
  const styles = StyleSheet.create({
    wrap: { marginBottom: 8 },
    h1: { fontSize: 16, fontWeight: 700, color: '#111827', marginTop: 10, marginBottom: 5 },
    h2: { fontSize: 14, fontWeight: 700, color: '#111827', marginTop: 8, marginBottom: 4 },
    h3: { fontSize: 12, fontWeight: 700, color: '#111827', marginTop: 6, marginBottom: 3 },
    p: { fontSize: 11, color: '#374151', lineHeight: 1.55, marginBottom: 4 },
    bullet: { fontSize: 11, color: '#374151', lineHeight: 1.55, marginBottom: 2, marginLeft: 12 },
  })

  const source = block.markdown || ''
  const lines = source.split(/\n+/).map(l => l.trim()).filter(Boolean)

  return (
    <View style={styles.wrap}>
      {lines.map((line, i) => {
        // Heading level 3 (must check before h2/h1 since ## would match h3 prefix)
        const h3Match = line.match(/^### (.+)$/)
        if (h3Match) {
          return <Text key={i} style={styles.h3}>{stripMarkdown(h3Match[1])}</Text>
        }

        // Heading level 2
        const h2Match = line.match(/^## (.+)$/)
        if (h2Match) {
          return <Text key={i} style={styles.h2}>{stripMarkdown(h2Match[1])}</Text>
        }

        // Heading level 1
        const h1Match = line.match(/^# (.+)$/)
        if (h1Match) {
          return <Text key={i} style={styles.h1}>{stripMarkdown(h1Match[1])}</Text>
        }

        // Bullet list item
        const bulletMatch = line.match(/^[-*]\s+(.+)$/)
        if (bulletMatch) {
          const clean = stripMarkdown(bulletMatch[1])
          return <Text key={i} style={styles.bullet}>{`• ${clean}`}</Text>
        }

        // Numbered list item — pass through as-is (number already present)
        const numberedMatch = line.match(/^\d+\.\s+(.+)$/)
        if (numberedMatch) {
          const clean = stripMarkdown(line)
          return <Text key={i} style={styles.bullet}>{clean}</Text>
        }

        // Paragraph — strip single-star italic + code but preserve ** for bold
        const clean = line.replace(PLACEHOLDER_RE, '…').replace(/\*(.*?)\*/g, '$1').replace(/`([^`]+)`/g, '$1')
        return <InlineText key={i} text={clean} style={styles.p} />
      })}
    </View>
  )
}
