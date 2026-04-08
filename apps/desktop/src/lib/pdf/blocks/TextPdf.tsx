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

export function TextPdf({ block, palette: _palette }: { block: TextBlock; palette: BrandPalette }) {
  const styles = StyleSheet.create({
    wrap: { marginBottom: 8 },
    p: { fontSize: 11, color: '#374151', lineHeight: 1.55, marginBottom: 4 },
    bullet: { fontSize: 11, color: '#374151', lineHeight: 1.55, marginBottom: 2, marginLeft: 12 },
  })
  const source = block.markdown || ''
  const lines = source.split(/\n+/).map(l => l.trim()).filter(Boolean)
  return (
    <View style={styles.wrap}>
      {lines.map((line, i) => {
        const isBullet = /^[-*]\s+/.test(line)
        const clean = stripMarkdown(isBullet ? line.replace(/^[-*]\s+/, '') : line)
        return (
          <Text key={i} style={isBullet ? styles.bullet : styles.p}>
            {isBullet ? `• ${clean}` : clean}
          </Text>
        )
      })}
    </View>
  )
}
