/**
 * Security re-check of Phase 2, unit level (no database): the router reads a request body only after the sign-in check
 * (P2-1); the print engine refuses PNG pixel bombs (P2-4) and Word zip bombs (P2-5); hostile chart labels through the
 * SVG path, PDF metadata and slot-token rewriting stay data; WhatsApp number forms and the reserved Meta hosts
 * (P2-9, P2-11); dashboard choice validation; the offline key and idempotency hashes; the service worker's cache rule.
 * Findings and residual risks: docs/internal/security-review-p2.md.
 */
import http from 'node:http'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import PizZip from 'pizzip'
import { createRouter } from './router.ts'
import type { Services, UserContext } from './contracts.ts'
import { bindTemplate, type BindData } from './print/bind.ts'
import { docxTags, fillDocx } from './print/docx.ts'
import { MAX_PNG_PIXELS } from './print/images.ts'
import { pdfBuffer } from './print/pdf.ts'
import { samplePng } from './print/print-testkit.ts'
import { chartFromBlock } from './print/chart.ts'
import { svgToOps, type TextLine } from './print/svgops.ts'
import { segments } from './print/text.ts'
import { renderChartSvg } from '../../src/charts/svg.ts'
import { normaliseDoc } from '../../src/platform/print.ts'
import { rewriteFormula } from '../../src/templates/rewrite.ts'
import { parse } from '../../src/fx/parser.ts'
import { freeIdentifiers } from '../../src/fx/ast.ts'
import { normalizePhone } from './whatsapp/phone.ts'
import { isReservedGraphHost } from './whatsapp/graph.ts'
import { checkChoices, DEFAULT_SETTINGS } from './dashboards/compute.ts'
import { deriveOfflineKey, idempotencyHash } from './offline.ts'
import { serviceWorkerSource } from './pwa.ts'

/* ------------------------------------------------------------------ P2-1 router */

describe('FINDING P2-1: a request body is read only after the session and the sign-in level are checked', () => {
  let server: http.Server
  let base = ''
  const ctxOf = (isMaker: boolean) => ({
    user: { id: isMaker ? 'u_maker' : 'u_viewer', name: 'U', email: 'u@example.com', roleIds: [] },
    privileges: { isAdmin: false, isMaker, tables: {}, apps: 'all' }, environmentId: 'default',
  }) as unknown as UserContext
  beforeAll(async () => {
    const router = createRouter({ ready: () => true } as unknown as Services)
    router.setSessionResolver(async (ctx) => {
      const c = String(ctx.req.headers.cookie ?? '')
      return c.includes('maker') ? ctxOf(true) : c.includes('viewer') ? ctxOf(false) : null
    })
    router.add('POST', '/big', (ctx) => ({ size: JSON.stringify(ctx.body ?? null).length }), { auth: 'maker', maxBodyMB: 40 })
    server = http.createServer((req, res) => void router.handle(req, res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  /** declares a 30 MB JSON body, sends 64 KB of it and waits up to `ms` for an answer (null: none came) */
  const partial = (cookie: string | null, ms = 3000) => new Promise<number | null>((resolve) => {
    const u = new URL(base + '/api/v1/big')
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(30 * 1024 * 1024), 'X-Appbuilder': '1', ...(cookie ? { Cookie: cookie } : {}) } })
    const t = setTimeout(() => { req.destroy(); resolve(null) }, ms)
    req.on('response', (res) => { clearTimeout(t); res.resume(); req.destroy(); resolve(res.statusCode ?? 0) })
    req.on('error', () => { clearTimeout(t); resolve(null) })
    req.write(Buffer.alloc(64 * 1024, 32))
  })

  it('no session: 401 while the client is still sending (the 30 MB body is never buffered)', async () => {
    expect(await partial(null)).toBe(401)
  })
  it('a signed-in person who is not a maker: 403 before the body of a maker route is read', async () => {
    expect(await partial('ab_session=viewer')).toBe(403)
  })
  it('a maker still sends bodies as before', async () => {
    const r = await fetch(base + '/api/v1/big', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Appbuilder': '1', Cookie: 'ab_session=maker' }, body: JSON.stringify({ a: 'x'.repeat(3 * 1024 * 1024) }) })
    expect(r.status).toBe(200)
    expect((await r.json()).size).toBeGreaterThan(3 * 1024 * 1024)
  })
})

/* ------------------------------------------------------------------ print engine */

const fmt = { grouping: 'indian' as const, dateFormat: 'dd-MM-yyyy', currency: 'INR', timeZone: 'Asia/Kolkata' }
const stubData: BindData = {
  tables: [], visible: (t) => t, query: async () => ({ rows: [] }), attachment: async () => null,
  evalEnv: {} as BindData['evalEnv'], user: { id: 'u1', name: 'Una', email: 'una@example.com' },
}
const pngHeaderOnly = (w: number, h: number): Buffer => {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6 // RGBA: pdfkit decodes it into memory
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(64))), chunk('IEND', Buffer.alloc(0))])
}
const dataUrl = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`

describe('print engine: resource limits and hostile data', () => {
  it('FINDING P2-4: a PNG that declares more than 40 megapixels is left out (it would be decoded in the server process)', async () => {
    const bomb = pngHeaderOnly(20_000, 20_000)
    expect(bomb.length).toBeLessThan(1024)
    expect(20_000 * 20_000).toBeGreaterThan(MAX_PNG_PIXELS)
    const doc = normaliseDoc({ source: { kind: 'none' }, body: [{ id: 'big', kind: 'image', source: 'static', data: dataUrl(bomb) }, { id: 'ok', kind: 'image', source: 'static', data: dataUrl(samplePng(40, 30, [200, 50, 50])) }] })
    const bound = await bindTemplate({ doc, fmt, letterhead: { companyName: 'Acme' }, now: new Date('2026-11-20T10:00:00Z'), templateName: 'T', maxRows: 100, maxImageBytes: 10 * 1048576 }, stubData)
    expect([...bound.images.values()].map((i) => `${i.width}x${i.height}`)).toEqual(['40x30'])
    expect(bound.warnings.join(' ')).toMatch(/20000 x 20000 pixels is larger than the 40 megapixels/)
  })

  it('FINDING P2-5: a Word template that unpacks far beyond its size is refused before PizZip unpacks it', () => {
    const z = new PizZip()
    z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    z.file('word/document.xml', 'a'.repeat(20 * 1024 * 1024))
    const bomb = z.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer
    expect(bomb.length).toBeLessThan(200 * 1024)
    expect(() => docxTags(bomb)).toThrow(/compressed more than 100 times/)
    expect(() => fillDocx(bomb, { resolve: () => undefined }, {} as never, fmt, () => {})).toThrow(/compressed more than 100 times/)
    expect(() => docxTags(Buffer.from('not a zip at all'))).toThrow(/not a ZIP-based file/)
  })

  it('chart labels from data are text in the PDF, never SVG markup (escaped by renderChartSvg, decoded by the closed converter)', () => {
    const hostile = ['<b>"x"', '&amp;', "a'b", '</text>']
    const c = chartFromBlock({ chartType: 'bar', values: [{ name: 'N', value: 'N' }] }, { asText: (v) => String(v ?? ''), now: new Date('2026-11-20T10:00:00Z'), grouping: 'indian', currency: 'INR', timeZone: 'Asia/Kolkata', title: 'T', rows: hostile.map((label, k) => ({ label, values: [k + 1] })), single: [] })
    const svg = renderChartSvg({ ...c.spec, width: 640, height: 226 }, c.rows, { background: false })
    const plain: TextLine = (text, x, y, st, color) => segments(text, st).map((s) => ({ t: 'text' as const, x, y, text: s.text, face: s.face, size: st.size, color }))
    const ops = svgToOps(svg, { width: 640, text: plain }).ops
    const texts = ops.filter((o) => o.t === 'text').map((o) => (o as { text: string }).text).join('|')
    for (const h of hostile) expect(texts).toContain(h)
    expect(ops.filter((o) => o.t === 'image')).toHaveLength(0)
  })

  it('PDF metadata from data cannot add PDF objects (the title is an escaped string)', async () => {
    const title = 'x) /OpenAction /S /JavaScript /JS (app.alert(1)) ('
    const pdf = (await pdfBuffer({ pageW: 100, pageH: 100, pages: [], images: new Map(), meta: { title, createdOn: new Date(0) } })).toString('latin1')
    // every bracket of the value is escaped in the Info dictionary, so the value stays inside one string object
    expect(pdf).toContain('(x\\) /OpenAction /S /JavaScript /JS \\(app.alert\\(1\\)\\) \\()')
    expect(pdf).not.toMatch(/\/Title \(x\) /)
  })

  it('FINDING P2-12: a title or author name cannot add elements to the XMP metadata (pdfkit writes it unescaped)', async () => {
    const title = 'Order</rdf:li></rdf:Alt></dc:title><dc:rights>forged</dc:rights><dc:title><rdf:Alt><rdf:li> & Co'
    const pdf = (await pdfBuffer({ pageW: 100, pageH: 100, pages: [], images: new Map(), meta: { title, author: 'Eve <script>', createdOn: new Date(0) } })).toString('utf8')
    expect(pdf).not.toContain('<dc:rights>')
    expect(pdf).not.toContain('<script>')
    expect(pdf).toContain('Order‹/rdf:li›')
  })
})

/* ------------------------------------------------------------------ templates */

describe('templates: slot tokens are rewritten through the parser, so names stay names', () => {
  it('a hostile table or column name becomes one quoted identifier, never formula text', () => {
    const evil = "Items' & Patch(Users, Defaults(Users), {Name: \"x\"}) & '"
    const r = rewriteFormula('=Filter(Slot_Items, Slot_Items_Status = "Open")', new Map([['Slot_Items', evil], ['Slot_Items_Status', 'Status']]))
    expect(r.problems).toEqual([])
    const p = parse(r.out)
    expect(p.ast).toBeTruthy()
    const free = freeIdentifiers(p.ast!).map((n) => n.name)
    expect(free).toContain(evil)
    expect(free).not.toContain('Users')
    expect(free).not.toContain('Patch')
  })
})

/* ------------------------------------------------------------------ WhatsApp */

describe('WhatsApp: number forms and reserved hosts', () => {
  it('FINDING P2-9: "(0)" after the country code is the trunk prefix and is dropped (one number, one opt-in record)', () => {
    expect(normalizePhone('+44 (0)20 7946 0000', '91')).toBe('+442079460000')
    expect(normalizePhone('+91 (0) 98765 43210', '91')).toBe('+919876543210')
    expect(normalizePhone('0091 (0)98765-43210', undefined)).toBe('+919876543210')
    // the same phone in the usual forms
    for (const f of ['+91 98765 43210', '098765 43210', '98765 43210', '0091 9876543210', 'tel:+91-98765-43210', '+91(98765)43210']) expect(normalizePhone(f, '91'), f).toBe('+919876543210')
    // a national number in brackets is not touched; Italian numbers keep their 0
    expect(normalizePhone('(020) 7946 0000', '44')).toBe('+442079460000')
    expect(normalizePhone('+39 06 1234 5678', '91')).toBe('+390612345678')
    // look-alike digits and letters are refused, not converted
    for (const f of ['+９１ 98765 43210', '+91 98765 4321O', '+91 98765 43210 ext 5']) expect(() => normalizePhone(f, '91'), f).toThrow()
  })

  it('FINDING P2-11: every host of Meta\'s domains is reserved for the WhatsApp connector, not only graph.facebook.com', () => {
    for (const h of ['graph.facebook.com', 'b-graph.facebook.com', 'graph.facebook.net', 'GRAPH.FB.COM.', '*.facebook.com', 'facebook.com', 'graph.whatsapp.net', 'www.whatsapp.com', 'lookaside.fbsbx.com']) expect(isReservedGraphHost(h), h).toBe(true)
    for (const h of ['api.example.com', 'notfacebook.com', 'facebook.com.evil.test', 'whatsapp.example.com', 'fb.company.test']) expect(isReservedGraphHost(h), h).toBe(false)
  })
})

/* ------------------------------------------------------------------ dashboards */

describe('dashboards: a view token or snapshot may only choose what the definition allows (checkChoices)', () => {
  const def = {
    version: 1, title: 'D', range: 'all',
    filters: [{ id: 'region', label: 'Region', column: 'Region', options: ['North', 'South'] }],
    tiles: [
      { id: 't', title: 'By region', kind: 'bar', layout: { x: 0, y: 0, w: 6, h: 3 }, query: { table: 'Orders', groupBy: ['Region'], measures: [{ id: 'N', fn: 'count' }] } },
      { id: 'x', title: 'Cross', kind: 'bar', crossFilter: true, layout: { x: 6, y: 0, w: 6, h: 3 }, query: { table: 'Orders', groupBy: ['Region'], measures: [{ id: 'N', fn: 'count' }] } },
    ],
  } as never
  it('refuses unknown filters, values outside a filter\'s options, cross-filters from other tiles or columns, bad ranges', () => {
    expect(() => checkChoices(def, { filters: { region: 'East' } }, DEFAULT_SETTINGS)).toThrow(/not one of the values/)
    expect(() => checkChoices(def, { filters: { secret: 'x' } }, DEFAULT_SETTINGS)).toThrow(/no filter/)
    expect(() => checkChoices(def, { cross: { tileId: 't', column: 'Region', value: 'North' } }, DEFAULT_SETTINGS)).toThrow(/allows it/)
    expect(() => checkChoices(def, { cross: { tileId: 'x', column: 'Salary', value: 1 } }, DEFAULT_SETTINGS)).toThrow(/group column/)
    expect(() => checkChoices(def, { cross: { tileId: 'x', column: 'Region', value: { $gt: '' } } }, DEFAULT_SETTINGS)).toThrow(/text, a number/)
    expect(() => checkChoices(def, { range: { from: '2026-02-01T00:00', to: '2026-01-01T00:00' } }, DEFAULT_SETTINGS)).toThrow(/from before to/)
    expect(() => checkChoices(def, { range: 'everything; DROP TABLE' }, DEFAULT_SETTINGS)).toThrow(/Unknown date range/)
    expect(checkChoices(def, { filters: { region: 'North' }, cross: { tileId: 'x', column: 'Region', value: 'South' } }, DEFAULT_SETTINGS)).toMatchObject({ filters: { region: 'North' }, cross: { table: 'Orders', column: 'Region', value: 'South' } })
  })
})

/* ------------------------------------------------------------------ offline and PWA */

describe('offline keys, idempotency keys and the service worker', () => {
  it('the offline key depends on the user, the device and the epoch (a wipe changes it); idempotency is per user and environment', () => {
    const secret = Buffer.alloc(32, 7)
    const k = deriveOfflineKey(secret, 'u1', 'device-aaaa', 0)
    expect(Buffer.from(k, 'base64url')).toHaveLength(32)
    expect(new Set([k, deriveOfflineKey(secret, 'u2', 'device-aaaa', 0), deriveOfflineKey(secret, 'u1', 'device-bbbb', 0), deriveOfflineKey(secret, 'u1', 'device-aaaa', 1)]).size).toBe(4)
    // no field can be shifted into another (separators)
    expect(deriveOfflineKey(secret, 'u1', 'device-aaaa', 10)).not.toBe(deriveOfflineKey(secret, 'u1', 'device-aaaa1', 0))
    expect(new Set([idempotencyHash('default', 'u1', 'k-12345678'), idempotencyHash('default', 'u2', 'k-12345678'), idempotencyHash('sales', 'u1', 'k-12345678')]).size).toBe(3)
  })
  it('the service worker answers only the shell, the icons and the manifests from its cache: never data', () => {
    const src = serviceWorkerSource('v1')
    const m = /const STATIC_API = \/(.*)\/;/.exec(src)
    expect(m).toBeTruthy()
    const re = new RegExp(m![1]!)
    for (const p of ['/api/v1/pwa/icon.png', '/api/v1/pwa/manifest.webmanifest', '/api/v1/pwa/apps/app_1/manifest.webmanifest']) expect(re.test(p), p).toBe(true)
    for (const p of ['/api/v1/data/Orders/rows', '/api/v1/query', '/api/v1/offline/key', '/api/v1/print/files/gen_x', '/api/v1/pwa/apps/a/b/manifest.webmanifest', '/api/v1/pwa/icon.png/../../data']) expect(re.test(p), p).toBe(false)
    expect(src).toContain("if (req.method !== 'GET') return;")
    expect(src).toContain("if (url.origin !== self.location.origin) return;")
    // icons are the only API answers it stores
    expect(src).toMatch(/res\.ok && url\.pathname\.endsWith\('icon\.png'\)/)
  })
})
