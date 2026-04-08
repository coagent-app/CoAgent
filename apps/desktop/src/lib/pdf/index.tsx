// apps/desktop/src/lib/pdf/index.ts
// Public entry: render a Canvas block document to a base64 PDF.
// This replaces the old html2canvas-based renderer in canvas-pdf.ts.

import { pdf } from '@react-pdf/renderer'
import type { BlockDocument } from '@coagent/shared'
import { CanvasPdfDocument } from './CanvasPdfDocument'
import { buildBrandPalette, type BrandInput } from './theme'

export interface RenderedPdf {
  base64: string
  pageCount: number
}

export interface RenderCanvasPdfOptions {
  doc: BlockDocument
  brand?: {
    companyName?: string
    primary?: string
    secondary?: string
    tertiary?: string
    logoDataUri?: string
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

export async function renderCanvasDocumentToPdf(opts: RenderCanvasPdfOptions): Promise<RenderedPdf> {
  const { doc, brand } = opts
  const brandInput: BrandInput = {
    primary: brand?.primary,
    secondary: brand?.secondary,
    tertiary: brand?.tertiary,
  }
  const palette = buildBrandPalette(brandInput)

  const instance = pdf(
    <CanvasPdfDocument
      doc={doc}
      palette={palette}
      companyName={brand?.companyName}
      logoDataUri={brand?.logoDataUri}
    />
  )
  const blob = await instance.toBlob()
  const base64 = await blobToBase64(blob)
  return { base64, pageCount: 0 }
}
