/**
 * Writes laid-out pages (layout.ts) as a PDF with pdfkit (MIT): embedded, subset TrueType fonts (Noto Sans, Noto Sans
 * Devanagari) with ToUnicode maps (text can be copied and searched), vector shapes, PNG/JPEG images, document
 * information. Deterministic: with a fixed `createdOn` (tests) the bytes are the same on every run. The PDF is produced
 * as a stream (pages are written as they are drawn; nothing but the current page is buffered by pdfkit).
 */
import PDFDocument from 'pdfkit'
import { Readable } from 'node:stream'
import type { Page } from './layout.ts'
import { loadFaces } from './text.ts'

export interface PdfMeta { title?: string; author?: string; subject?: string; keywords?: string; createdOn: Date }

export interface PdfInput {
  pageW: number
  pageH: number
  pages: Page[]
  images: Map<string, Buffer>
  meta: PdfMeta
}

/** the PDF as a stream of bytes */
export function pdfStream(inp: PdfInput): Readable {
  const doc = new PDFDocument({
    autoFirstPage: false, margin: 0, compress: true, pdfVersion: '1.7',
    info: {
      Title: inp.meta.title ?? '', Author: inp.meta.author ?? '', Subject: inp.meta.subject ?? '', Keywords: inp.meta.keywords ?? '',
      Creator: 'Appbuilder print templates', Producer: 'Appbuilder (pdfkit)', CreationDate: inp.meta.createdOn, ModDate: inp.meta.createdOn,
    },
    displayTitle: !!inp.meta.title,
  } as PDFKit.PDFDocumentOptions)
  for (const f of loadFaces().values()) doc.registerFont(f.id, f.bytes)
  // pdfkit pulls pages lazily from this generator so a large document is not built in memory before it is read
  let pageIndex = 0
  const drawNext = (): boolean => {
    if (pageIndex >= inp.pages.length) return false
    const p = inp.pages[pageIndex++]
    doc.addPage({ size: [inp.pageW, inp.pageH], margin: 0 })
    drawPage(doc, p, inp.images)
    return true
  }
  // draw page by page as the consumer reads (back pressure through the stream)
  const out = new Readable({ read() { /* fed below */ } })
  doc.on('data', (c: Buffer) => { if (!out.push(c)) paused = true })
  doc.on('end', () => out.push(null))
  doc.on('error', (e: Error) => out.destroy(e))
  let paused = false
  let finished = false
  const pump = () => {
    if (finished) return
    paused = false
    while (!paused) {
      if (!drawNext()) {
        finished = true
        doc.end()
        return
      }
    }
  }
  out._read = () => { if (!finished) setImmediate(pump) }
  return out
}

export async function pdfBuffer(inp: PdfInput): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of pdfStream(inp)) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

function drawPage(doc: PDFKit.PDFDocument, p: Page, images: Map<string, Buffer>): void {
  let clipDepth = 0
  for (const o of p.ops) {
    switch (o.t) {
      case 'text':
        if (o.actual !== undefined) (doc as unknown as { markContent(t: string, o: unknown): void }).markContent('Span', { actual: o.actual })
        doc.font(o.face).fontSize(o.size).fillColor(o.color)
        doc.text(o.text, o.x, o.y, { lineBreak: false, baseline: 'alphabetic', ...(o.synthItalic ? { oblique: 12 } : {}) } as PDFKit.Mixins.TextOptions)
        if (o.endActual) (doc as unknown as { endMarkedContent(): void }).endMarkedContent()
        break
      case 'rect':
        if (o.fill && o.stroke) doc.rect(o.x, o.y, o.w, o.h).lineWidth(o.lw ?? 0.5).fillAndStroke(o.fill, o.stroke)
        else if (o.fill) doc.rect(o.x, o.y, o.w, o.h).fill(o.fill)
        else if (o.stroke) doc.rect(o.x, o.y, o.w, o.h).lineWidth(o.lw ?? 0.5).stroke(o.stroke)
        break
      case 'line':
        doc.save()
        doc.moveTo(o.x1, o.y1).lineTo(o.x2, o.y2).lineWidth(o.lw)
        if (o.dash) doc.dash(o.dash[0], { space: o.dash[1] ?? o.dash[0] })
        doc.stroke(o.color)
        doc.restore()
        break
      case 'path':
        doc.save()
        doc.translate(o.x, o.y)
        doc.path(o.d)
        if (o.fill && o.stroke) doc.lineWidth(o.lw ?? 1).fillAndStroke(o.fill, o.stroke)
        else if (o.fill) doc.fill(o.fill)
        else if (o.stroke) doc.lineWidth(o.lw ?? 1).stroke(o.stroke)
        doc.restore()
        break
      case 'image': {
        const b = images.get(o.key)
        if (b) doc.image(b, o.x, o.y, { width: o.w, height: o.h })
        break
      }
      case 'clip':
        doc.save()
        doc.rect(o.x, o.y, o.w, o.h).clip()
        clipDepth++
        break
      case 'unclip':
        if (clipDepth > 0) { doc.restore(); clipDepth-- }
        break
    }
  }
  while (clipDepth-- > 0) doc.restore()
}
