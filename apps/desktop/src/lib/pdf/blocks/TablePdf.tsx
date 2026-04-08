import { View, Text, StyleSheet } from '@react-pdf/renderer'
import type { TableBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

export function TablePdf({ block, palette }: { block: TableBlock; palette: BrandPalette }) {
  const styles = StyleSheet.create({
    wrap: { marginVertical: 6 },
    caption: { fontSize: 9, color: '#6b7280', fontStyle: 'italic', marginBottom: 3 },
    table: { width: '100%' },
    headRow: { flexDirection: 'row', backgroundColor: palette.primary },
    headCell: {
      flex: 1,
      padding: 6,
      fontSize: 9,
      fontWeight: 700,
      color: '#ffffff',
    },
    bodyRow: {
      flexDirection: 'row',
      borderBottomWidth: 0.5,
      borderBottomColor: '#e5e7eb',
      borderBottomStyle: 'solid',
    },
    cell: {
      flex: 1,
      padding: 6,
      fontSize: 10,
      color: '#374151',
    },
    cellEmph: {
      fontWeight: 600,
    },
  })
  return (
    <View style={styles.wrap}>
      {block.caption ? <Text style={styles.caption}>{block.caption}</Text> : null}
      <View style={styles.table}>
        <View style={styles.headRow} wrap={false}>
          {block.headers.map((h, i) => (
            <Text key={i} style={styles.headCell}>{h || ' '}</Text>
          ))}
        </View>
        {block.rows.map((row, ri) => (
          <View key={ri} style={styles.bodyRow} wrap={false}>
            {row.cells.map((c, ci) => (
              <Text key={ci} style={[styles.cell, row.emphasis ? styles.cellEmph : {}]}>
                {c || ' '}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </View>
  )
}
