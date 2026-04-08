import { View, StyleSheet } from '@react-pdf/renderer'
import type { DividerBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

export function DividerPdf({ block: _block, palette }: { block: DividerBlock; palette: BrandPalette }) {
  const styles = StyleSheet.create({
    line: { height: 1, width: '100%', backgroundColor: palette.primarySoft, marginVertical: 8 },
  })
  return <View style={styles.line} />
}
