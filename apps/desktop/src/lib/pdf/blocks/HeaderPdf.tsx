import { View, Text, StyleSheet } from '@react-pdf/renderer'
import type { HeaderBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

export function HeaderPdf({ block, palette }: { block: HeaderBlock; palette: BrandPalette }) {
  const styles = StyleSheet.create({
    wrap: {
      paddingBottom: 10,
      marginBottom: 14,
      borderBottomWidth: 1,
      borderBottomColor: palette.primarySoft,
      borderBottomStyle: 'solid',
    },
    eyebrow: {
      fontSize: 9,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: 1.2,
      color: palette.primary,
      marginBottom: 4,
    },
    title: { fontSize: 22, fontWeight: 700, color: '#111827', lineHeight: 1.15 },
    subtitle: { fontSize: 11, color: '#6b7280', marginTop: 4 },
  })
  return (
    <View style={styles.wrap} wrap={false}>
      {block.eyebrow ? <Text style={styles.eyebrow}>{block.eyebrow}</Text> : null}
      <Text style={styles.title}>{block.title || 'Untitled'}</Text>
      {block.subtitle ? <Text style={styles.subtitle}>{block.subtitle}</Text> : null}
    </View>
  )
}
