import { View, Text, StyleSheet } from '@react-pdf/renderer'
import type { KpisBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

function deltaColor(delta: string, palette: BrandPalette): string {
  const trimmed = delta.trim()
  if (/^[▲↑+]/.test(trimmed) || /\bup\b/i.test(trimmed)) return palette.success
  if (/^[▼↓-]/.test(trimmed) || /\bdown\b/i.test(trimmed)) return palette.danger
  return palette.neutral
}

export function KpisPdf({ block, palette }: { block: KpisBlock; palette: BrandPalette }) {
  const count = Math.max(1, block.items.length)
  const colCount = Math.min(count, 4) // 4 per row in PDF (tighter than web)
  const styles = StyleSheet.create({
    row: { flexDirection: 'row', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
    card: {
      flexGrow: 1,
      flexBasis: `${100 / colCount - 2}%`,
      borderWidth: 1,
      borderColor: palette.primarySoft,
      borderStyle: 'solid',
      backgroundColor: palette.primaryBg,
      borderRadius: 6,
      padding: 10,
    },
    label: {
      fontSize: 8,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      color: '#6b7280',
      marginBottom: 4,
    },
    value: { fontSize: 18, fontWeight: 700, color: '#111827' },
    delta: { fontSize: 9, fontWeight: 500, marginTop: 3 },
  })
  return (
    <View style={styles.row} wrap={false}>
      {block.items.map((item, i) => (
        <View key={i} style={styles.card} wrap={false}>
          <Text style={styles.label}>{item.label || ' '}</Text>
          <Text style={styles.value}>{item.value || ' '}</Text>
          {item.delta ? (
            <Text style={[styles.delta, { color: deltaColor(item.delta, palette) }]}>{item.delta}</Text>
          ) : null}
        </View>
      ))}
    </View>
  )
}
