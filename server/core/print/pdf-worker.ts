/**
 * The CPU part of a print (layout and PDF writing) in a worker thread, so a print no longer holds the request's event
 * loop for its 150-300 ms (load test, November 2026). Runs the same functions as before (layout.ts, pdf.ts) on the same
 * input, so the bytes are the same as in-process for the same input (print.test.ts compares them).
 *
 * The module is imported by pool.ts (so the release build follows its imports) and started as a worker by
 * `new URL('./pdf-worker.ts', import.meta.url)`; it only listens for jobs when it runs as that worker.
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { layoutDocument, PageLimitError, type LayoutInput, type Page, type RBlock } from './layout.ts'
import { pdfBuffer, type PdfMeta } from './pdf.ts'

/** a LayoutInput that can cross a thread: the header and footer per page kind (first page, later pages) */
export interface WireLayout extends Omit<LayoutInput, 'header' | 'footer' | 'images'> {
  header: [RBlock[], RBlock[]]
  footer: [RBlock[], RBlock[]]
  images: [string, { width: number; height: number }][]
}
export interface WirePdf { pageW: number; pageH: number; meta: PdfMeta }

export type PrintJob =
  | { kind: 'render'; layout: WireLayout; pdf: WirePdf; images: [string, Uint8Array][] }
  | { kind: 'layout'; layout: WireLayout }
  | { kind: 'pdf'; pdf: WirePdf; pages: Page[]; images: [string, Uint8Array][] }

export type PrintJobResult = { bytes?: Uint8Array; pages?: Page[]; pageCount: number }

/** header and footer of a bound template depend only on the page kind (bind.ts), as layout.ts measures them */
export function toWireLayout(inp: LayoutInput): WireLayout {
  const { header, footer, images, ...rest } = inp
  return { ...rest, header: [header(0), header(1)], footer: [footer(0), footer(1)], images: [...images] }
}
export function fromWireLayout(w: WireLayout): LayoutInput {
  return { ...w, header: (p) => (p === 0 ? w.header[0] : w.header[1]), footer: (p) => (p === 0 ? w.footer[0] : w.footer[1]), images: new Map(w.images) }
}
const asBuffer = (u: Uint8Array): Buffer => Buffer.from(u.buffer, u.byteOffset, u.byteLength)

/** runs one job (in the worker, or in-process when workers are switched off) */
export async function runPrintJob(job: PrintJob): Promise<PrintJobResult> {
  const imgs = (list: [string, Uint8Array][]) => new Map(list.map(([k, v]) => [k, asBuffer(v)]))
  switch (job.kind) {
    case 'layout': {
      const pages = layoutDocument(fromWireLayout(job.layout))
      return { pages, pageCount: pages.length }
    }
    case 'pdf': {
      const bytes = await pdfBuffer({ pageW: job.pdf.pageW, pageH: job.pdf.pageH, pages: job.pages, images: imgs(job.images), meta: job.pdf.meta })
      return { bytes, pageCount: job.pages.length }
    }
    case 'render': {
      const pages = layoutDocument(fromWireLayout(job.layout))
      const bytes = await pdfBuffer({ pageW: job.pdf.pageW, pageH: job.pdf.pageH, pages, images: imgs(job.images), meta: job.pdf.meta })
      return { bytes, pageCount: pages.length }
    }
  }
}

export const WORKER_TAG = 'appbuilder-print-worker'

if (!isMainThread && parentPort && (workerData as { tag?: string } | null)?.tag === WORKER_TAG) {
  const port = parentPort
  port.on('message', (m: { id: number; job: PrintJob }) => {
    runPrintJob(m.job).then(
      (r) => {
        // a fresh copy (Buffer.concat may hand out a slice of Node's shared pool, which must not be transferred)
        const bytes = r.bytes ? new Uint8Array(r.bytes) : undefined
        port.postMessage({ id: m.id, ok: true, result: { ...r, bytes } }, bytes ? [bytes.buffer] : [])
      },
      (e: unknown) => port.postMessage({ id: m.id, ok: false, error: { pageLimit: e instanceof PageLimitError, message: e instanceof Error ? e.message : String(e) } }),
    )
  })
}
