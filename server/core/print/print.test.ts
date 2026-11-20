/**
 * Print engine unit tests (no database): formatting, rich text, Devanagari shaping against HarfBuzz, barcodes (decoded
 * from rasterised PDFs when poppler and zxing-cpp are available), layout (wrapping, pagination, table header repeat,
 * totals, grouping, row break avoidance, widows/orphans, keepTogether, page breaks, slicing), golden text positions,
 * determinism, PDF structure and the 50-page performance budget.
 *
 * testdata/devanagari-harfbuzz.json: glyph ids and positions shaped by HarfBuzz 15.0.0 (uharfbuzz 0.57.0,
 * guess_segment_properties, no features) with the bundled Noto Sans Devanagari Regular and Bold. Regenerate it with
 * uharfbuzz when the fonts change.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { formatCurrency, formatDate, formatNumber, formatPercent, formatValue, groupDigits } from '../../../src/platform/print-format.ts'
import { docProblems, emptyDoc, normaliseDoc, parseRichText, splitTemplateText, BLOCK_CATALOGUE, newBlock } from '../../../src/platform/print.ts'
import { segments, shape, textWidth } from './text.ts'
import { code128Values, code128Modules, qrMatrix } from './barcode.ts'
import { layoutDocument, paras, PAGE_COUNT, PAGE_NUMBER, type Op, type Page, type RBlock, type RTableRow } from './layout.ts'
import { pdfBuffer } from './pdf.ts'
import { printChartSvg } from './chart.ts'
import { imageInfo } from './images.ts'
import { hasRaster, pdfText, hasPoppler, rasterise, samplePng } from './print-testkit.ts'

const style = { fontSize: 10, color: '#1e293b', accent: '#4f46e5', headingColor: '#0f172a', tableStyle: 'zebra' as const, lineHeight: 1.3 }
const A4 = { pageW: 595.28, pageH: 841.89, margins: { top: 42.52, right: 42.52, bottom: 42.52, left: 42.52 } }
const layout = (body: RBlock[], o: { footer?: boolean; header?: RBlock[] } = {}) => layoutDocument({
  ...A4, style, body, header: () => o.header ?? [], images: new Map(), maxPages: 500,
  footer: () => (o.footer ? [{ k: 'text', paras: [{ runs: [{ text: `Page ${PAGE_NUMBER} of ${PAGE_COUNT}` }] }], align: 'right', size: 8 }] : []),
})
const texts = (p: Page) => p.ops.filter((o): o is Extract<Op, { t: 'text' }> => o.t === 'text')
const textOf = (p: Page) => texts(p).map((o) => o.text).join(' ')
const table = (rows: RTableRow[], extra: Partial<Extract<RBlock, { k: 'table' }>> = {}): RBlock => ({
  k: 'table', columns: [{ header: 'Item', align: 'left' }, { header: 'Qty', width: 25, align: 'right' }], rows, repeatHeader: true, style: 'zebra', avoidRowBreak: true, emptyText: 'none', ...extra,
})
const rowsN = (n: number, label = 'Row'): RTableRow[] => Array.from({ length: n }, (_, i) => ({ kind: 'row', cells: [`${label} ${i + 1}`, String(i + 1)] }))
const PY = process.env.APPBUILDER_TEST_PYTHON || 'python3'
const hasZxing = spawnSync(PY, ['-c', 'import zxingcpp, PIL'], { encoding: 'utf8' }).status === 0

describe('formatting (Indian and international grouping, currency, dates)', () => {
  it('groups digits the Indian way (lakh, crore) and the international way', () => {
    expect(groupDigits('1234567', 'indian')).toBe('12,34,567')
    expect(groupDigits('123456789', 'indian')).toBe('12,34,56,789')
    expect(groupDigits('1000', 'indian')).toBe('1,000')
    expect(groupDigits('100', 'indian')).toBe('100')
    expect(groupDigits('1234567', 'international')).toBe('1,234,567')
    expect(formatNumber(12345678.9, 2, { grouping: 'indian' })).toBe('1,23,45,678.90')
    expect(formatNumber(-1234567, 0, { grouping: 'indian' })).toBe('-12,34,567')
    expect(formatNumber(1.005, 2, { grouping: 'indian' })).toBe('1.01')
    expect(formatNumber(-0.004, 2, { grouping: 'indian' })).toBe('0.00')
    expect(formatNumber('42', undefined, { grouping: 'indian' })).toBe('42')
    expect(formatNumber('abc', 2, { grouping: 'indian' })).toBe('abc')
    expect(formatNumber(null, 2, { grouping: 'indian' })).toBe('')
  })
  it('formats currency, percent and dates in a time zone', () => {
    const o = { grouping: 'indian' as const, currency: 'INR', dateFormat: 'dd-MM-yyyy', timeZone: 'Asia/Kolkata' }
    expect(formatCurrency(1234567.5, o)).toBe('₹12,34,567.50')
    expect(formatCurrency(-50, o, 0)).toBe('-₹50')
    expect(formatCurrency(10, o, 2, 'USD')).toBe('$10.00')
    expect(formatPercent(0.785, o)).toBe('78.5%')
    expect(formatPercent(78.5, o)).toBe('78.5%')
    // 20:00 UTC is the next day in India
    expect(formatDate(new Date('2026-11-19T20:00:00Z'), 'dd-MM-yyyy', 'Asia/Kolkata')).toBe('20-11-2026')
    expect(formatDate('2026-11-19', 'd MMM yyyy', 'America/New_York')).toBe('19 Nov 2026')
    expect(formatDate(new Date('2026-01-05T09:07:00Z'), "d MMMM yyyy 'at' hh:mm a", 'UTC')).toBe('5 January 2026 at 09:07 AM')
    expect(formatValue(new Date('2026-11-19T06:30:00Z'), 'datetime', o)).toBe('19-11-2026 12:00')
    expect(formatValue(true, 'boolean', o)).toBe('Yes')
    expect(formatValue(3.14159, 'number', o, 3)).toBe('3.142')
  })
})

describe('template model', () => {
  it('parses rich text markup: bold, italic, underline, colour, lists, paragraphs', () => {
    const p = parseRichText('Hello **bold** *it* __u__ [color=#ff0000]red[/color]\n\n- one\n- two\n1. first\n\nlast')
    expect(p[0].runs).toEqual([{ text: 'Hello ' }, { text: 'bold', bold: true }, { text: ' ' }, { text: 'it', italic: true }, { text: ' ' }, { text: 'u', underline: true }, { text: ' ' }, { text: 'red', color: '#ff0000' }])
    expect(p.slice(1, 4).map((x) => [x.list, x.number ?? null, x.runs[0].text])).toEqual([['bullet', null, 'one'], ['bullet', null, 'two'], ['number', 1, 'first']])
    expect(p[4].runs[0].text).toBe('last')
    // an unbalanced marker prints as it is
    expect(parseRichText('2 * 3 = 6')[0].runs.map((r) => r.text).join('')).toBe('2 * 3 = 6')
  })
  it('splits {formula} parts, keeping braces inside strings and {{ }} literals', () => {
    expect(splitTemplateText('No {Number} on {FormatDate(Today(), "d {x}")} {{literal}}')).toEqual([
      { lit: 'No ' }, { fx: 'Number' }, { lit: ' on ' }, { fx: 'FormatDate(Today(), "d {x}")' }, { lit: ' {literal}' },
    ])
    expect(splitTemplateText('broken {open')).toEqual([{ lit: 'broken {open' }])
  })
  it('checks documents and fills older ones', () => {
    expect(docProblems(emptyDoc())).toEqual([])
    const bad = normaliseDoc({ body: [{ id: 'a', kind: 'table', rows: '', columns: [] }, { id: 'a', kind: 'nope' }] })
    const p = docProblems(bad)
    expect(p.map((x) => x.path)).toEqual(expect.arrayContaining(['body.0.rows', 'body.0.columns', 'body.1']))
    for (const b of BLOCK_CATALOGUE) expect(docProblems({ ...emptyDoc('T'), body: [newBlock(b.kind)] }), b.kind).toEqual([])
  })
})

describe('Devanagari shaping (fontkit) against HarfBuzz', () => {
  const ref = JSON.parse(fs.readFileSync(new URL('./testdata/devanagari-harfbuzz.json', import.meta.url), 'utf8')) as { strings: string[]; faces: Record<string, number[][][]> }
  for (const face of ['deva', 'deva-bold'] as const) {
    it(`${face}: the same glyphs and positions as HarfBuzz for ${ref.strings.length} strings (conjuncts, reph, matras, nukta)`, () => {
      const mismatches: string[] = []
      ref.strings.forEach((s, i) => {
        const got = shape(s, face).map((g) => [g.id, g.xAdvance, g.xOffset, g.yOffset])
        if (JSON.stringify(got) !== JSON.stringify(ref.faces[face][i])) mismatches.push(s)
      })
      expect(mismatches).toEqual([])
    })
  }
  it('splits mixed text into Latin and Devanagari runs (joiners stay with their script)', () => {
    expect(segments('Total कुल योग ₹500', { size: 10 }).map((s) => [s.text, s.face])).toEqual([['Total ', 'sans'], ['कुल', 'deva'], [' ', 'sans'], ['योग', 'deva'], [' ₹500', 'sans']])
    expect(segments('क्‍ष', { size: 10, bold: true }).map((s) => s.face)).toEqual(['deva-bold'])
    expect(segments('हिन्दी', { size: 10, italic: true })[0].synthItalic).toBe(true)
  })
})

describe('barcodes', () => {
  it('Code 128: set B for text, set C for digit runs, checksum per ISO/IEC 15417', () => {
    // "ABC": start B (104), 33, 34, 35; checksum (104 + 33 + 68 + 105) % 103 = 1
    expect(code128Values('ABC')).toEqual([104, 33, 34, 35, 1, 106])
    // "123456": start C (105), 12, 34, 56; checksum (105 + 12 + 68 + 168) % 103 = 44
    expect(code128Values('123456')).toEqual([105, 12, 34, 56, 44, 106])
    // "INSP-000123": B for "INSP-", C for "000123"
    const v = code128Values('INSP-000123')
    expect(v.slice(0, 6)).toEqual([104, 41, 46, 51, 48, 13])
    expect(v[6]).toBe(99)
    expect(v.slice(7, 10)).toEqual([0, 1, 23])
    // every symbol is 11 modules, the stop 13: bars and spaces alternate
    const mods = code128Modules('INSP-000123')
    expect(mods.reduce((a, [, w]) => a + w, 0)).toBe(11 * (v.length - 1) + 13)
    expect(() => code128Values('नमस्ते')).toThrow(/ASCII/)
  })
  it('QR: a module grid of a valid size, UTF-8 text', () => {
    const m = qrMatrix('INSP-2026-0042')
    expect((m.size - 17) % 4).toBe(0)
    expect(qrMatrix('निरीक्षण रिपोर्ट').size).toBeGreaterThan(20)
  })
  it.skipIf(!hasRaster() || !hasZxing)('both decode from a rasterised PDF (zxing-cpp)', async () => {
    const body: RBlock[] = [
      { k: 'barcode', symbology: 'code128', text: 'DC/26-27/0315', showText: true, align: 'left', width: 70, height: 15 },
      { k: 'spacer', h: 10 },
      { k: 'barcode', symbology: 'qr', text: 'INSP:निरीक्षण-0042', showText: false, align: 'left', width: 30 },
    ]
    const pdf = await pdfBuffer({ pageW: A4.pageW, pageH: A4.pageH, pages: layout(body), images: new Map(), meta: { createdOn: new Date(0) } })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bc-'))
    const [png] = rasterise(pdf, dir, 'bc', 200)
    const out = spawnSync(PY, ['-c', 'import sys, zxingcpp; from PIL import Image\nfor r in zxingcpp.read_barcodes(Image.open(sys.argv[1])): print(str(r.format) + "|" + r.text)', png], { encoding: 'utf8' })
    fs.rmSync(dir, { recursive: true, force: true })
    const found = out.stdout.trim().split('\n').sort()
    expect(found.length).toBe(2)
    expect(found.some((x) => x.endsWith('|DC/26-27/0315'))).toBe(true)
    expect(found.some((x) => x.endsWith('|INSP:निरीक्षण-0042'))).toBe(true)
  }, 30_000)
})

describe('layout', () => {
  it('wraps text within the content width; long words are cut between grapheme clusters', () => {
    const width = A4.pageW - A4.margins.left - A4.margins.right
    const pages = layout([{ k: 'text', paras: paras('word '.repeat(300) + ' ' + 'क्षत्रिय'.repeat(40)), align: 'left' }])
    for (const o of texts(pages[0])) {
      expect(o.x).toBeGreaterThanOrEqual(A4.margins.left - 0.01)
      expect(o.x + textWidth(o.text, { size: o.size, bold: o.face.includes('bold') })).toBeLessThanOrEqual(A4.margins.left + width + 0.5)
    }
    // no cluster is broken: every Devanagari run is made of whole graphemes of the word
    const deva = texts(pages[0]).filter((o) => o.face === 'deva').map((o) => o.text).join('')
    expect(deva).toBe('क्षत्रिय'.repeat(40))
  })
  it('paginates a long table, repeats the header on every page and never splits a row', () => {
    const pages = layout([{ k: 'heading', text: 'Long table', level: 1, align: 'left' }, table(rowsN(150))], { footer: true })
    expect(pages.length).toBeGreaterThan(3)
    for (const [i, p] of pages.entries()) {
      const t = texts(p)
      expect(t.some((o) => o.text === 'Item'), `header on page ${i + 1}`).toBe(true)
      // the header is the first table text on the page
      const firstRowY = Math.min(...t.filter((o) => /^Row/.test(o.text)).map((o) => o.y))
      expect(t.find((o) => o.text === 'Item')!.y).toBeLessThan(firstRowY)
      expect(textOf(p)).toContain(`Page ${i + 1} of ${pages.length}`)
      // body text stays above the footer area
      for (const o of t.filter((x) => /^Row/.test(x.text))) expect(o.y).toBeLessThan(A4.pageH - A4.margins.bottom - 20)
    }
    const all = pages.flatMap((p) => texts(p).filter((o) => /^Row \d+$/.test(o.text)).map((o) => o.text))
    expect(all).toEqual(rowsN(150).map((r) => r.cells[0]))
  })
  it('a multi-line row stays on one page; a row taller than a page is sliced with clipping', () => {
    const tall: RTableRow = { kind: 'row', cells: ['line '.repeat(3000), '1'] }
    const pages = layout([table([...rowsN(5), { kind: 'row', cells: ['two\nlines '.repeat(3), '9'] }, ...rowsN(3, 'After')]), table([tall])])
    expect(pages.flatMap((p) => p.ops).some((o) => o.t === 'clip')).toBe(true)
    expect(pages.length).toBeGreaterThan(2)
  })
  it('groups, subtotals and totals rows keep their order; a total row never starts a page alone', () => {
    const rows: RTableRow[] = []
    for (let g = 0; g < 6; g++) { rows.push({ kind: 'group', cells: [`Group ${g}`] }); rows.push(...rowsN(9, `G${g}`)); rows.push({ kind: 'subtotal', cells: ['Subtotal', '45'] }) }
    rows.push({ kind: 'total', cells: ['Total', '270'] })
    const pages = layout([table(rows)])
    const seq = pages.flatMap((p) => texts(p).map((o) => o.text)).filter((t) => /^(Group|Subtotal|Total|G\d)/.test(t))
    expect(seq.filter((t) => t.startsWith('Group')).length).toBe(6)
    expect(seq[seq.length - 1]).toBe('Total')
    for (const p of pages) {
      const t = texts(p).filter((o) => o.text !== 'Item' && o.text !== 'Qty').sort((a, b) => a.y - b.y)
      expect(['Subtotal', 'Total']).not.toContain(t[0]?.text)
      // a group header is never the last thing on a page
      const last = t[t.length - 1]
      if (p !== pages[pages.length - 1]) expect(last.text.startsWith('Group')).toBe(false)
    }
  })
  it('widows and orphans: at least two lines of a paragraph on each side of a page break', () => {
    for (let fill = 30; fill < 90; fill += 3) {
      const pages = layout([{ k: 'spacer', h: fill * 2.5 }, { k: 'text', paras: paras('lorem ipsum dolor sit amet consectetur '.repeat(60)), align: 'left' }])
      for (const p of pages) {
        const lines = new Set(texts(p).map((o) => Math.round(o.y)))
        expect(lines.size === 0 || lines.size >= 2, `fill ${fill}`).toBe(true)
      }
    }
  })
  it('keepTogether moves a block to the next page; a page break starts a new page; headings stay with what follows', () => {
    const pages = layout([
      { k: 'spacer', h: 235 },
      { k: 'heading', text: 'Kept heading', level: 2, align: 'left' },
      { k: 'kv', items: Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, value: `V${i}` })), columns: 1, boxed: false, keepTogether: true },
      { k: 'pageBreak' },
      { k: 'text', paras: paras('After the break'), align: 'left' },
    ])
    expect(pages.length).toBe(3)
    expect(textOf(pages[1])).toContain('Kept heading')
    expect(textOf(pages[1])).toContain('L5')
    expect(textOf(pages[2])).toContain('After the break')
  })
  it('enforces the page limit', () => {
    expect(() => layoutDocument({ ...A4, style, body: [table(rowsN(2000))], header: () => [], footer: () => [], images: new Map(), maxPages: 5 })).toThrow(/more than 5 pages/)
  })
  it('golden: text and positions of a fixed document (tolerance 0.5 pt)', () => {
    const doc: RBlock[] = [
      { k: 'heading', text: 'Golden निरीक्षण', level: 1, align: 'left' },
      { k: 'text', paras: paras('Hello **world** — *italic* and [color=#dc2626]red[/color] text that wraps over the line because it is long enough to need two lines of the page.'), align: 'justify' },
      { k: 'kv', items: [{ label: 'Machine', value: 'CNC-07' }, { label: 'OEE', value: '78.5%' }], columns: 2, boxed: true },
      table([...rowsN(3), { kind: 'total', cells: ['Total', '6'] }]),
    ]
    const got = layout(doc)[0].ops.filter((o) => o.t === 'text').map((o) => { const t = o as Extract<Op, { t: 'text' }>; return [t.text, t.face, +t.x.toFixed(2), +t.y.toFixed(2), t.size] })
    const file = new URL('./testdata/golden-layout.json', import.meta.url)
    if (process.env.UPDATE_GOLDEN === '1' || !fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(got, null, 0).replace(/\],\[/g, '],\n['))
    const want = JSON.parse(fs.readFileSync(file, 'utf8')) as [string, string, number, number, number][]
    expect(got.length).toBe(want.length)
    got.forEach((g, i) => {
      expect([g[0], g[1], g[4]]).toEqual([want[i][0], want[i][1], want[i][4]])
      expect(Math.abs((g[2] as number) - want[i][2])).toBeLessThanOrEqual(0.5)
      expect(Math.abs((g[3] as number) - want[i][3])).toBeLessThanOrEqual(0.5)
    })
  })
})

describe('PDF output', () => {
  const doc: RBlock[] = [
    { k: 'heading', text: 'Determinism हिन्दी', level: 1, align: 'left' },
    { k: 'chart', spec: { type: 'pie', categories: ['A', 'B'], series: [{ name: 'x', values: [3, 1] }] }, height: 40 },
    { k: 'image', images: [{ key: 'img', width: 320, height: 220 }], align: 'center', perRow: 1, width: 60 },
  ]
  const make = () => pdfBuffer({ pageW: A4.pageW, pageH: A4.pageH, pages: layoutDocument({ ...A4, style, body: doc, header: () => [], footer: () => [], images: new Map([['img', { width: 320, height: 220 }]]), maxPages: 10 }), images: new Map([['img', samplePng(320, 220, [200, 80, 40])]]), meta: { title: 'T', author: 'Ada', createdOn: new Date('2026-11-19T00:00:00Z') } })
  it('is byte-identical for the same input and time; embeds subset fonts with a ToUnicode map and the metadata', async () => {
    const a = await make()
    const b = await make()
    expect(a.equals(b)).toBe(true)
    const s = a.toString('latin1')
    expect(s.startsWith('%PDF-1.7')).toBe(true)
    expect(s).toMatch(/\/FontFile2/)
    expect(s).toMatch(/\/ToUnicode/)
    expect(s).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSans/)
    expect(s).toMatch(/\/Title \d+ 0 R/)
    expect(s).toMatch(/\(T\)/)
    expect(s).toMatch(/\/Subtype \/Image/)
  })
  it.skipIf(!hasPoppler())('text can be extracted (pdftotext) and the image is PNG-sized', async () => {
    const t = pdfText(await make())
    expect(t).toContain('Determinism')
    expect(imageInfo(samplePng(10, 7, [0, 0, 0]))).toEqual({ type: 'png', width: 10, height: 7 })
  })
  it('renders a chart as SVG for previews', () => {
    const svg = printChartSvg({ type: 'bar', categories: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] })
    expect(svg).toMatch(/^<svg[^>]+viewBox="0 0 400 220"/)
    expect((svg.match(/<rect/g) ?? []).length).toBe(2)
  })
  it('performance: a 50-page table report in a few seconds', async () => {
    const t0 = Date.now()
    const rows: RTableRow[] = Array.from({ length: 2200 }, (_, i) => ({ kind: 'row', cells: [`Item ${i} निरीक्षण`, String(i), (i * 1.5).toFixed(2), 'Machine CNC-0' + (i % 9), '19-11-2026'] }))
    const pages = layoutDocument({ ...A4, style, body: [table(rows, { columns: [{ header: 'Item', align: 'left' }, { header: 'Qty', width: 15, align: 'right' }, { header: 'Amount', width: 25, align: 'right' }, { header: 'Machine', width: 35, align: 'left' }, { header: 'Date', width: 25, align: 'left' }] })], header: () => [], footer: () => [{ k: 'text', paras: [{ runs: [{ text: `Page ${PAGE_NUMBER} of ${PAGE_COUNT}` }] }], align: 'right' }], images: new Map(), maxPages: 500 })
    const pdf = await pdfBuffer({ pageW: A4.pageW, pageH: A4.pageH, pages, images: new Map(), meta: { createdOn: new Date(0) } })
    const ms = Date.now() - t0
    expect(pages.length).toBeGreaterThanOrEqual(50)
    expect(ms).toBeLessThan(8000)
    process.stderr.write(`print performance: ${pages.length} pages, ${rows.length} rows, ${pdf.length} bytes in ${ms} ms\n`)
  }, 30_000)
})
