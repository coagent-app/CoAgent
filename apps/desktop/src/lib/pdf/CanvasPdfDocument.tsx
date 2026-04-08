import { Document, Page, View, Text, Image, StyleSheet } from '@react-pdf/renderer'
import type { BlockDocument } from '@coagent/shared'
import type { BrandPalette } from './theme'
import { BlockPdfDispatcher } from './blocks/dispatch'

interface Props {
  doc: BlockDocument
  palette: BrandPalette
  companyName?: string
  logoDataUri?: string
}

export function CanvasPdfDocument({ doc, palette, companyName, logoDataUri }: Props) {
  const styles = StyleSheet.create({
    page: {
      paddingTop: 48,
      paddingBottom: 56,
      paddingHorizontal: 56,
      backgroundColor: '#ffffff',
      fontFamily: 'Helvetica',
    },
    runningHeader: {
      position: 'absolute',
      top: 20,
      left: 56,
      right: 56,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    runningLogo: { height: 14, objectFit: 'contain' },
    runningCompany: { fontSize: 8, color: '#9ca3af' },
    runningFooter: {
      position: 'absolute',
      bottom: 20,
      left: 56,
      right: 56,
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    footerText: { fontSize: 8, color: '#9ca3af' },
    body: { gap: 10 },
  })

  return (
    <Document title={doc.title} author={companyName || 'CoAgent'}>
      <Page size="LETTER" style={styles.page} wrap>
        <View style={styles.runningHeader} fixed>
          {logoDataUri ? (
            <Image src={logoDataUri} style={styles.runningLogo} />
          ) : (
            <Text style={styles.runningCompany}>{companyName || ' '}</Text>
          )}
          <Text style={styles.runningCompany}>{doc.title}</Text>
        </View>

        <View style={styles.body}>
          {doc.blocks.map(block => (
            <BlockPdfDispatcher key={block.id} block={block} palette={palette} />
          ))}
        </View>

        <View style={styles.runningFooter} fixed>
          <Text style={styles.footerText}>{companyName || 'CoAgent'}</Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  )
}
