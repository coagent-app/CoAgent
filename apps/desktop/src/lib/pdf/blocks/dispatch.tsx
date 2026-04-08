import type { DocumentBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'
import { HeaderPdf } from './HeaderPdf'
import { TextPdf } from './TextPdf'
import { KpisPdf } from './KpisPdf'
import { TablePdf } from './TablePdf'
import { CalloutPdf } from './CalloutPdf'
import { ImagePdf } from './ImagePdf'
import { DividerPdf } from './DividerPdf'
import { SignoffPdf } from './SignoffPdf'
import { FooterPdf } from './FooterPdf'
import { ChartPdf } from './ChartPdf'
import { TwoColumnPdf } from './TwoColumnPdf'

export function BlockPdfDispatcher({ block, palette }: { block: DocumentBlock; palette: BrandPalette }) {
  switch (block.type) {
    case 'header':     return <HeaderPdf block={block} palette={palette} />
    case 'text':       return <TextPdf block={block} palette={palette} />
    case 'kpis':       return <KpisPdf block={block} palette={palette} />
    case 'table':      return <TablePdf block={block} palette={palette} />
    case 'callout':    return <CalloutPdf block={block} palette={palette} />
    case 'two_column': return <TwoColumnPdf block={block} palette={palette} />
    case 'image':      return <ImagePdf block={block} palette={palette} />
    case 'divider':    return <DividerPdf block={block} palette={palette} />
    case 'signoff':    return <SignoffPdf block={block} palette={palette} />
    case 'footer':     return <FooterPdf block={block} palette={palette} />
    case 'chart':      return <ChartPdf block={block} palette={palette} />
    default:           return null
  }
}
