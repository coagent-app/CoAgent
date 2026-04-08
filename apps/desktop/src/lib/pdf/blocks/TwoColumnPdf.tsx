import { View, StyleSheet } from '@react-pdf/renderer'
import type { TwoColumnBlock, ColumnBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'
import { BlockPdfDispatcher } from './dispatch'

export function TwoColumnPdf({ block, palette }: { block: TwoColumnBlock; palette: BrandPalette }) {
  const ratio = block.ratio || '1:1'
  const [lf, rf] = ratio === '1:2' ? [1, 2] : ratio === '2:1' ? [2, 1] : [1, 1]
  const styles = StyleSheet.create({
    row: { flexDirection: 'row', gap: 12, marginBottom: 8 },
    col: {},
  })
  return (
    <View style={styles.row}>
      <View style={[styles.col, { flex: lf }]}>
        <BlockPdfDispatcher block={block.left as ColumnBlock} palette={palette} />
      </View>
      <View style={[styles.col, { flex: rf }]}>
        <BlockPdfDispatcher block={block.right as ColumnBlock} palette={palette} />
      </View>
    </View>
  )
}
