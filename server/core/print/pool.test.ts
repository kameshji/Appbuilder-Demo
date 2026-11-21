/**
 * The print worker pool (pool.ts, pdf-worker.ts): the same bytes as in-process for the same input, the event loop stays
 * free while a document is drawn, the queue limit, the timeout (the worker is stopped), errors mapped back, clean close.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { layoutDocument, PageLimitError, PAGE_COUNT, PAGE_NUMBER, type LayoutInput, type RBlock, type RTableRow } from './layout.ts'
import { pdfBuffer } from './pdf.ts'
import { chartFromBlock } from './chart.ts'
import { samplePng } from './print-testkit.ts'
import { toWireLayout, type PrintJob } from './pdf-worker.ts'
import { createPrintPool, PrintBusyError, PrintTimeoutError } from './pool.ts'

const style = { fontSize: 10, color: '#1e293b', accent: '#4f46e5', headingColor: '#0f172a', tableStyle: 'zebra' as const, lineHeight: 1.3 }
const A4 = { pageW: 595.28, pageH: 841.89, margins: { top: 42.52, right: 42.52, bottom: 42.52, left: 42.52 } }
const rows = (n: number): RTableRow[] => Array.from({ length: n }, (_, i) => ({ kind: 'row', cells: [`Item ${i} निरीक्षण`, String(i), (i * 1.5).toFixed(2)] }))
const table = (n: number): RBlock => ({ k: 'table', columns: [{ header: 'Item', align: 'left' }, { header: 'Qty', width: 15, align: 'right' }, { header: 'Amount', width: 25, align: 'right' }], rows: rows(n), repeatHeader: true, style: 'zebra', avoidRowBreak: true, emptyText: 'none' })
const png = samplePng(320, 220, [200, 80, 40])
const body: RBlock[] = [
  { k: 'heading', text: 'Worker हिन्दी', level: 1, align: 'left' },
  { k: 'chart', chart: chartFromBlock({ chartType: 'pie', values: [{ name: 'x', value: 'x' }] }, { rows: [{ label: 'A', values: [3] }, { label: 'B', values: [1] }], single: [], asText: String, now: new Date(0), grouping: 'indian', currency: 'INR', timeZone: 'Asia/Kolkata' }), height: 40 },
  { k: 'image', images: [{ key: 'img', width: 320, height: 220 }], align: 'center', perRow: 1, width: 60 },
  table(400),
]
const input = (n = 400, maxPages = 100): LayoutInput => ({
  ...A4, style, body: [...body.slice(0, 3), table(n)], maxPages, images: new Map([['img', { width: 320, height: 220 }]]),
  // the first page differs from the later ones (letterhead), as bind.ts makes it
  header: (p) => (p === 0 ? [{ k: 'heading', text: 'Letterhead Ltd', level: 2, align: 'center' }] : [{ k: 'text', paras: [{ runs: [{ text: 'Continued' }] }], align: 'left' }]),
  footer: () => [{ k: 'text', paras: [{ runs: [{ text: `Page ${PAGE_NUMBER} of ${PAGE_COUNT}` }] }], align: 'right', size: 8 }],
})
const meta = { title: 'T <x>', author: 'Ada', subject: 'S', keywords: 'k', createdOn: new Date('2026-11-19T00:00:00Z') }
const job = (n = 400, maxPages = 100): PrintJob => ({ kind: 'render', layout: toWireLayout(input(n, maxPages)), pdf: { pageW: A4.pageW, pageH: A4.pageH, meta }, images: [['img', png]] })
const inProcess = async (n = 400) => pdfBuffer({ pageW: A4.pageW, pageH: A4.pageH, pages: layoutDocument(input(n)), images: new Map([['img', png]]), meta })

const pools: ReturnType<typeof createPrintPool>[] = []
const pool = (o: Parameters<typeof createPrintPool>[0]) => { const p = createPrintPool(o); pools.push(p); return p }
afterAll(async () => { for (const p of pools) await p.close() })

describe('print worker pool', () => {
  it('produces the same bytes as the in-process path (render, layout + pdf, in-process pool)', async () => {
    const want = await inProcess()
    const p = pool({ size: 1, queueLimit: 4 })
    const got = await p.run(job(), 30_000)
    expect(Buffer.isBuffer(got.bytes)).toBe(true)
    expect(got.pageCount).toBe(layoutDocument(input()).length)
    expect((got.bytes as Buffer).equals(want)).toBe(true)
    // the bulk path: layout in the worker, then the PDF of the pages in the worker
    const laid = await p.run({ kind: 'layout', layout: toWireLayout(input()) }, 30_000)
    const pdf = await p.run({ kind: 'pdf', pdf: { pageW: A4.pageW, pageH: A4.pageH, meta }, pages: laid.pages!, images: [['img', png]] }, 30_000)
    expect((pdf.bytes as Buffer).equals(want)).toBe(true)
    const zero = pool({ size: 0, queueLimit: 0 })
    expect(((await zero.run(job(), 30_000)).bytes as Buffer).equals(want)).toBe(true)
  }, 60_000)

  it('keeps the event loop free while documents are drawn', async () => {
    const p = pool({ size: 2, queueLimit: 8 })
    await p.run(job(10), 30_000) // warm the worker (fonts)
    const h = monitorEventLoopDelay({ resolution: 5 })
    h.enable()
    const t0 = Date.now()
    await Promise.all([p.run(job(2000, 500), 60_000), p.run(job(2000, 500), 60_000)])
    h.disable()
    const ms = Date.now() - t0
    process.stderr.write(`print pool: 2 x 2000-row documents in ${ms} ms, loop delay max ${(h.max / 1e6).toFixed(1)} ms\n`)
    expect(h.max / 1e6).toBeLessThan(Math.max(100, ms / 4))
  }, 60_000)

  it('refuses a job when the queue is full, times out (stopping the worker) and maps errors back', async () => {
    const p = pool({ size: 1, queueLimit: 0 })
    const first = p.run(job(3000, 500), 60_000)
    await expect(p.run(job(10), 30_000)).rejects.toBeInstanceOf(PrintBusyError)
    await first
    expect(p.stats().refused).toBe(1)
    await expect(p.run(job(6000, 1000), 50)).rejects.toBeInstanceOf(PrintTimeoutError)
    expect(p.stats()).toMatchObject({ timedOut: 1, workers: 0, busy: 0 })
    // a new worker serves the next job
    await expect(p.run(job(2000, 3), 30_000)).rejects.toBeInstanceOf(PageLimitError)
    await expect(p.run(job(2000, 3), 30_000)).rejects.toThrow(/more than 3 pages/)
    expect((await p.run(job(10), 30_000)).pageCount).toBe(1)
  }, 60_000)

  it('closes: queued jobs are refused, the workers stop, a later job starts a new worker', async () => {
    const p = pool({ size: 1, queueLimit: 4 })
    const running = p.run(job(1500, 500), 60_000)
    const queued = p.run(job(10), 60_000)
    const closing = p.close(10_000)
    await expect(queued).rejects.toBeInstanceOf(PrintBusyError)
    expect((await running).pageCount).toBeGreaterThan(10)
    await closing
    expect(p.stats().workers).toBe(0)
    expect((await p.run(job(10), 30_000)).pageCount).toBe(1)
  }, 60_000)
})
