import { JSDOM } from 'jsdom'
import { join } from 'path'

// pdfmake's js-md5 dependency needs window in scope
if (typeof globalThis.window === 'undefined') (globalThis as any).window = globalThis

type DocStyle = 'professional' | 'minimal' | 'report'

export async function renderMarkdownToPdf(
  markdown: string,
  style: DocStyle = 'professional',
  title?: string
): Promise<Buffer> {
  const { marked } = await import('marked')
  const htmlToPdfmake = (await import('html-to-pdfmake')).default
  const pdfmakeModule = await import('pdfmake')
  const pdfmake = (pdfmakeModule as any).default || pdfmakeModule

  // Register fonts — resolve('pdfmake') → .../pdfmake/js/index.js, go up 2 levels to package root
  const fontDir = join(require.resolve('pdfmake'), '..', '..', 'build', 'fonts', 'Roboto')
  pdfmake.addFonts({
    Roboto: {
      normal: join(fontDir, 'Roboto-Regular.ttf'),
      bold: join(fontDir, 'Roboto-Medium.ttf'),
      italics: join(fontDir, 'Roboto-Italic.ttf'),
      bolditalics: join(fontDir, 'Roboto-MediumItalic.ttf'),
    },
  })

  // Convert markdown → HTML → pdfmake content
  const html = await marked(markdown)
  const { window } = new JSDOM('')
  const content = htmlToPdfmake(html, { window })

  // Style configs
  const styles: Record<DocStyle, any> = {
    professional: {
      defaultStyle: { fontSize: 10.5, color: '#333333', lineHeight: 1.3, font: 'Roboto' },
      styles: {
        h1: { fontSize: 22, bold: true, color: '#1a2744', margin: [0, 16, 0, 8] },
        h2: { fontSize: 16, bold: true, color: '#1a2744', margin: [0, 14, 0, 6] },
        h3: { fontSize: 13, bold: true, color: '#1a2744', margin: [0, 10, 0, 4] },
        'html-strong': { bold: true },
        'html-em': { italics: true },
        'html-a': { color: '#2563eb', decoration: 'underline' },
      },
      pageMargins: [55, 55, 55, 55] as [number, number, number, number],
    },
    minimal: {
      defaultStyle: { fontSize: 10.5, color: '#222222', lineHeight: 1.3, font: 'Roboto' },
      styles: {
        h1: { fontSize: 20, bold: true, color: '#000000', margin: [0, 14, 0, 6] },
        h2: { fontSize: 15, bold: true, color: '#000000', margin: [0, 12, 0, 4] },
        h3: { fontSize: 12, bold: true, color: '#000000', margin: [0, 8, 0, 3] },
        'html-strong': { bold: true },
        'html-em': { italics: true },
        'html-a': { color: '#2563eb', decoration: 'underline' },
      },
      pageMargins: [50, 50, 50, 50] as [number, number, number, number],
    },
    report: {
      defaultStyle: { fontSize: 10.5, color: '#333333', lineHeight: 1.4, font: 'Roboto' },
      styles: {
        h1: { fontSize: 24, bold: true, color: '#1a2744', margin: [0, 18, 0, 10] },
        h2: { fontSize: 17, bold: true, color: '#1a2744', margin: [0, 14, 0, 6] },
        h3: { fontSize: 13, bold: true, color: '#1a2744', margin: [0, 10, 0, 4] },
        'html-strong': { bold: true },
        'html-em': { italics: true },
        'html-a': { color: '#2563eb', decoration: 'underline' },
      },
      pageMargins: [60, 75, 60, 65] as [number, number, number, number],
    },
  }

  const cfg = styles[style] || styles.professional

  const docDef: any = {
    content,
    defaultStyle: cfg.defaultStyle,
    styles: cfg.styles,
    pageSize: 'LETTER',
    pageMargins: cfg.pageMargins,
    info: { title: title || 'Document' },
  }

  // Footer with page numbers for professional/report
  if (style !== 'minimal') {
    docDef.footer = (currentPage: number, pageCount: number) => ({
      text: `${currentPage} / ${pageCount}`,
      alignment: 'center',
      fontSize: 8,
      color: '#999999',
      margin: [0, 20, 0, 0],
    })
  }

  // Header for report style (page 2+)
  if (style === 'report' && title) {
    docDef.header = (currentPage: number) => {
      if (currentPage === 1) return null
      return {
        text: title,
        fontSize: 8,
        color: '#999999',
        margin: [60, 20, 60, 0],
      }
    }
  }

  // Generate PDF buffer via stream
  const pdf = pdfmake.createPdf(docDef)
  const stream = await pdf.getStream()
  const chunks: Buffer[] = []
  return new Promise<Buffer>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
    stream.end()
  })
}
