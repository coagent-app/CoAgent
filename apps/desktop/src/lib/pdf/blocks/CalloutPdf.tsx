import { View, Text, StyleSheet } from '@react-pdf/renderer'
import type { CalloutBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'
import { PDF_CALLOUT_STYLES } from '../theme'

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g

// Strip single-star italic, code ticks, and placeholders — but intentionally
// leave ** intact so InlineBody can render bold spans.
function cleanup(s: string): string {
  return s.replace(PLACEHOLDER_RE, '…').replace(/\*(.*?)\*/g, '$1').replace(/`([^`]+)`/g, '$1')
}

// Split a string on **...** markers into alternating normal/bold segments.
function parseInlineBold(s: string): Array<{ text: string; bold: boolean }> {
  const parts = s.split(/\*\*(.*?)\*\*/g)
  return parts.map((part, i) => ({ text: part, bold: i % 2 === 1 })).filter(p => p.text !== '')
}

type PdfStyle = ReturnType<typeof StyleSheet.create>[string]

function InlineBody({ text, style }: { text: string; style: PdfStyle }) {
  const prepared = cleanup(text)
  if (!prepared.includes('**')) {
    return <Text style={style}>{prepared}</Text>
  }
  const segments = parseInlineBold(prepared)
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

export function CalloutPdf({ block, palette: _palette }: { block: CalloutBlock; palette: BrandPalette }) {
  const variant = (block.variant in PDF_CALLOUT_STYLES ? block.variant : 'info') as keyof typeof PDF_CALLOUT_STYLES
  const s = PDF_CALLOUT_STYLES[variant]
  const styles = StyleSheet.create({
    wrap: {
      flexDirection: 'row',
      gap: 8,
      padding: 10,
      borderRadius: 6,
      borderWidth: 1,
      borderStyle: 'solid',
      backgroundColor: s.bg,
      borderColor: s.border,
      marginBottom: 8,
    },
    icon: {
      width: 16,
      height: 16,
      borderRadius: 8,
      textAlign: 'center',
      fontSize: 10,
      fontWeight: 700,
      color: s.text,
      paddingTop: 1.5,
    },
    body: { flex: 1 },
    title: { fontSize: 11, fontWeight: 700, color: '#111827', marginBottom: 2 },
    text: { fontSize: 10, color: '#374151', lineHeight: 1.5 },
  })
  return (
    <View style={styles.wrap} wrap={false}>
      <Text style={styles.icon}>{s.icon}</Text>
      <View style={styles.body}>
        {block.title ? <Text style={styles.title}>{block.title}</Text> : null}
        <InlineBody text={block.markdown || ''} style={styles.text} />
      </View>
    </View>
  )
}
