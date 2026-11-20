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

function paint(doc: PDFKit.PDFDocument, fill: string | undefined, stroke: string | undefined, lw: number, fillOpacity: number | undefined, strokeOpacity: number | undefined): void {
  if (fill) doc.fillColor(fill)
  if (stroke) doc.strokeColor(stroke).lineWidth(lw)
  if (fillOpacity !== undefined) doc.fillOpacity(fillOpacity)
  if (strokeOpacity !== undefined) doc.strokeOpacity(strokeOpacity)
}

function finish(doc: PDFKit.PDFDocument, fill: string | undefined, stroke: string | undefined): void {
  if (fill && stroke) doc.fillAndStroke()
  else if (fill) doc.fill()
  else doc.stroke()
}

function drawPage(doc: PDFKit.PDFDocument, p: Page, images: Map<string, Buffer>): void {
  let clipDepth = 0
  for (const o of p.ops) {
    switch (o.t) {
      case 'text': {
        // marked content (ActualText) encloses the save/restore of a rotated or translucent run, so both nest properly
        if (o.actual !== undefined) (doc as unknown as { markContent(t: string, o: unknown): void }).markContent('Span', { actual: o.actual })
        const own = !!o.rotate || o.opacity !== undefined
        if (own) doc.save()
        if (o.rotate) doc.rotate(o.rotate, { origin: [o.x, o.y] })
        doc.font(o.face).fontSize(o.size).fillColor(o.color)
        if (o.opacity !== undefined) doc.fillOpacity(o.opacity)
        doc.text(o.text, o.x, o.y, { lineBreak: false, baseline: 'alphabetic', ...(o.synthItalic ? { oblique: 12 } : {}) } as PDFKit.Mixins.TextOptions)
        if (own) doc.restore()
        if (o.endActual) (doc as unknown as { endMarkedContent(): void }).endMarkedContent()
        break
      }
      // shapes: the graphics state (colours, width, dashes, caps, opacity) is set before the path is built, then painted
      case 'rect': {
        if (!o.fill && !o.stroke) break
        doc.save()
        paint(doc, o.fill, o.stroke, o.lw ?? 0.5, o.fillOpacity, o.strokeOpacity)
        if (o.r) doc.roundedRect(o.x, o.y, o.w, o.h, o.r)
        else doc.rect(o.x, o.y, o.w, o.h)
        finish(doc, o.fill, o.stroke)
        doc.restore()
        break
      }
      case 'line':
        doc.save()
        if (o.dash) doc.dash(o.dash.length > 1 ? o.dash : [o.dash[0], o.dash[0]])
        paint(doc, undefined, o.color, o.lw, undefined, o.opacity)
        doc.moveTo(o.x1, o.y1).lineTo(o.x2, o.y2)
        doc.stroke()
        doc.restore()
        break
      case 'path':
        if (!o.fill && !o.stroke) break
        doc.save()
        doc.translate(o.x, o.y)
        if (o.cap) doc.lineCap('round').lineJoin('round')
        if (o.dash) doc.dash(o.dash.length > 1 ? o.dash : [o.dash[0], o.dash[0]])
        paint(doc, o.fill, o.stroke, o.lw ?? 1, o.fillOpacity, o.strokeOpacity)
        doc.path(o.d)
        finish(doc, o.fill, o.stroke)
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
