import { View, Text, Image, StyleSheet } from '@react-pdf/renderer'
import type { SignoffBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

export function SignoffPdf({ block, palette }: { block: SignoffBlock; palette: BrandPalette }) {
  const styles = StyleSheet.create({
    wrap: {
      marginTop: 16,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: palette.primarySoft,
      borderTopStyle: 'solid',
    },
    sig: { height: 42, marginBottom: 4, objectFit: 'contain' },
    name: { fontSize: 12, fontWeight: 600, color: '#111827' },
    title: { fontSize: 10, color: '#6b7280' },
    date: { fontSize: 9, color: '#9ca3af', marginTop: 2 },
  })
  return (
    <View style={styles.wrap} wrap={false}>
      {block.signatureDataUri ? <Image src={block.signatureDataUri} style={styles.sig} /> : null}
      <Text style={styles.name}>{block.name}</Text>
      {block.title ? <Text style={styles.title}>{block.title}</Text> : null}
      {block.date ? <Text style={styles.date}>{block.date}</Text> : null}
    </View>
  )
}
