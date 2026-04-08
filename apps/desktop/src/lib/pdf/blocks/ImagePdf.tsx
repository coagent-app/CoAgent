import { View, Image, Text, StyleSheet } from '@react-pdf/renderer'
import type { ImageBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

export function ImagePdf({ block, palette: _palette }: { block: ImageBlock; palette: BrandPalette }) {
  const styles = StyleSheet.create({
    wrap: { marginVertical: 6 },
    img: { width: '100%', objectFit: 'contain' },
    caption: { fontSize: 9, color: '#6b7280', textAlign: 'center', marginTop: 4, fontStyle: 'italic' },
  })
  return (
    <View style={styles.wrap} wrap={false}>
      <Image src={block.src} style={styles.img} />
      {block.caption ? <Text style={styles.caption}>{block.caption}</Text> : null}
    </View>
  )
}
