/**
 * Phase 0 security re-check, the parts without a database (package M; docs/internal/security-review-p0.md): the
 * outbound host policy, crafted backup archives, the DBML parser on hostile input, escaping in the diagram SVG export,
 * the rich-text sanitiser and the export CSV guard.
 */
import { describe, expect, it } from 'vitest'
import { assertOutboundHost, classifyAddress, hostProblem } from './net-policy.ts'
import { ArchiveError, listTar, memberBuffer } from './backup/archive.ts'
import type { RandomReader } from './backup/archive.ts'
import { MAX_LINE, parseDbml } from '../../src/model/dbml.ts'
import { renderModelSvg } from '../../src/model/svg.ts'
import { addTable } from '../../src/model/ops.ts'
import { sanitizeRichText } from '../../src/platform/system-tables.ts'
import { csvExportText } from './values.ts'
import { checkZip } from './zip-guard.ts'
import { ZipStream } from './export-data.ts'
import { parseXlsx } from '../connectors/files/formats.ts'
import ExcelJS from 'exceljs'
import { bearerAllowed } from './identity/api-keys.ts'

function memReader(buf: Buffer): RandomReader {
  return { size: buf.length, encrypted: false, read: async (pos, len) => buf.subarray(pos, pos + len), close: async () => {} }
}
/** one ustar header block */
function header(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, 'utf8')
  h.write('0000644\0', 100)
  h.write('0000000\0', 108)
  h.write('0000000\0', 116)
  h.write(size.toString(8).padStart(11, '0') + '\0', 124)
  h.write('00000000000\0', 136)
  h.write('        ', 148)
  h.write(type, 156)
  h.write('ustar\0', 257)
  h.write('00', 263)
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return h
}

describe('outbound host policy', () => {
  it('classifies addresses', () => {
    expect(classifyAddress('169.254.169.254')).toBe('link-local')
    expect(classifyAddress('::ffff:169.254.169.254')).toBe('link-local')
    expect(classifyAddress('fe80::1')).toBe('link-local')
    expect(classifyAddress('0.0.0.0')).toBe('unspecified')
    expect(classifyAddress('::')).toBe('unspecified')
    expect(classifyAddress('224.0.0.1')).toBe('multicast')
    expect(classifyAddress('127.0.0.1')).toBe('loopback')
    expect(classifyAddress('10.1.2.3')).toBe('private')
    expect(classifyAddress('172.20.0.1')).toBe('private')
    expect(classifyAddress('192.168.1.10')).toBe('private')
    expect(classifyAddress('fd00::1')).toBe('private')
    expect(classifyAddress('8.8.8.8')).toBe('public')
  })
  it('refuses link-local, metadata and unspecified targets; private ones only when the install says so', async () => {
    expect(hostProblem('169.254.169.254')).toMatch(/link-local/)
    expect(hostProblem('Metadata.Google.Internal.')).toMatch(/metadata/)
    expect(hostProblem('[fe80::1]')).toMatch(/link-local/)
    expect(hostProblem('db.local')).toBeNull()
    expect(hostProblem('10.0.0.5')).toBeNull()
    expect(hostProblem('10.0.0.5', { APPBUILDER_OUTBOUND_PRIVATE: 'deny' })).toMatch(/private/)
    expect(hostProblem('localhost')).toBeNull()
    // a name that resolves to the metadata address is refused (checked after DNS)
    await expect(assertOutboundHost('evil.example.com', 'Connection', { lookup: async () => [{ address: '169.254.169.254' }] })).rejects.toThrow(/link-local/)
    await expect(assertOutboundHost('db.example.com', 'Connection', { lookup: async () => [{ address: '10.0.0.7' }, { address: '0.0.0.0' }] })).rejects.toThrow(/unspecified/)
    expect(await assertOutboundHost('db.example.com', 'Connection', { lookup: async () => [{ address: '10.0.0.7' }] })).toEqual(['10.0.0.7'])
    await expect(assertOutboundHost('db.example.com', 'Connection', { env: { APPBUILDER_OUTBOUND_PRIVATE: 'deny' }, lookup: async () => [{ address: '127.0.0.1' }] })).rejects.toThrow(/loopback/)
  })
})

describe('crafted backup archives', () => {
  it('an oversized pax header is refused before it is read', async () => {
    const tar = Buffer.concat([header('PaxHeader', 50 * 1024 * 1024, 'x'), Buffer.alloc(512 * 4)])
    await expect(listTar(memReader(tar))).rejects.toThrow(/oversized extended header/)
  })
  it('links, directories and devices are never members (only regular files are listed)', async () => {
    const tar = Buffer.concat([header('../../etc/passwd', 0, '2'), header('dir/', 0, '5'), header('a.txt', 3, '0'), Buffer.from('abc'.padEnd(512, '\0')), Buffer.alloc(1024)])
    const list = await listTar(memReader(tar))
    expect(list.map((e) => e.name)).toEqual(['a.txt'])
  })
  it('a member read whole into memory has a size cap', async () => {
    await expect(memberBuffer(memReader(Buffer.alloc(10)), { name: 'manifest.json', size: 10, offset: 0 }, 5)).rejects.toBeInstanceOf(ArchiveError)
  })
})

describe('DBML import on hostile text', () => {
  it('long lines are skipped, huge texts refused, both quickly', () => {
    const t0 = performance.now()
    const r = parseDbml('Table t {\n  a varchar(' + '('.repeat(200_000) + '\n  b int\n}')
    expect(r.warnings.join(' ')).toMatch(/was skipped/)
    expect(r.model.tables[0]?.columns.some((c) => c.name === 'b')).toBe(true)
    const big = parseDbml('/*'.repeat(1_100_000))
    expect(big.warnings.join(' ')).toMatch(/at most 2 MB/)
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(MAX_LINE).toBe(4000)
  })
})

describe('escaping in exports', () => {
  it('the diagram SVG escapes table and column names', () => {
    const m = addTable({ tables: [], relationships: [] }, { displayName: '<script>alert(1)</script>', columns: [{ displayName: '"><img src=x onerror=alert(1)>', type: 'text' }] }).model
    const svg = renderModelSvg(m, { positions: { [m.tables[0]!.id]: { x: 0, y: 0 } }, areas: [{ id: 'a', name: '</text><script>x</script>', color: 'red" onload="alert(1)', tables: [m.tables[0]!.id] }] }, { title: '<b>t</b>' })
    // names arrive as escaped text only: no element or attribute an attacker chose
    expect(svg).not.toMatch(/<script|<img|<b>|<[^>]*\son(load|error)=/)
    expect(svg).toContain('&lt;script&gt;')
  })
  it('rich text keeps only the allowed tags and safe links', () => {
    const out = sanitizeRichText('<p onclick="x">a</p><a href="javascript:alert(1)">j</a><a href="https://e.com" onclick="y">ok</a><svg onload=1><iframe src=x><span data-mention="u1" style="x">@u</span>')
    expect(out).toBe('<p>a</p><a>j</a><a href="https://e.com" rel="noopener noreferrer" target="_blank">ok</a><span data-mention="u1">@u</span>')
  })
  it('export CSV cells that a spreadsheet would run as formulas start with a quote', () => {
    expect(csvExportText('=HYPERLINK("http://x")')).toBe(`'=HYPERLINK("http://x")`)
    expect(csvExportText('@SUM(A1)')).toBe(`'@SUM(A1)`)
    expect(csvExportText('-5')).toBe('-5')
    expect(csvExportText(12)).toBe('12')
  })
})

describe('zip bombs in uploaded workbooks', () => {
  const zipOf = async (members: [string, Buffer][]): Promise<Buffer> => {
    const z = new ZipStream()
    const parts: Buffer[] = []
    for (const [name, data] of members) for await (const b of z.entry(name, (async function* () { yield data })())) parts.push(b)
    for (const b of z.finish()) parts.push(b)
    return Buffer.concat(parts)
  }
  it('a highly compressed member is refused before it is unpacked', async () => {
    const bomb = await zipOf([['xl/worksheets/sheet1.xml', Buffer.alloc(40 * 1024 * 1024, 0x41)]])
    expect(bomb.length).toBeLessThan(1024 * 1024)
    expect(() => checkZip(bomb, 'Workbook')).toThrow(/compressed more than 200 times/)
    await expect(parseXlsx(bomb)).rejects.toThrow(/compressed more than/)
  })
  it('a real workbook passes', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Data')
    ws.addRow(['Name', 'Qty'])
    for (let i = 0; i < 200; i++) ws.addRow([`Item ${i}`, i])
    const buf = Buffer.from(await wb.xlsx.writeBuffer())
    expect(checkZip(buf, 'Workbook').entries).toBeGreaterThan(3)
    const sheets = await parseXlsx(buf)
    expect(sheets[0]!.rows.length).toBe(200)
  })
})

describe('API keys reach the Data API only', () => {
  it('admin, export, directory, schedule and environment routes are out of reach of a bearer key', () => {
    for (const [m, p] of [['GET', '/api/v1/admin/export-data'], ['POST', '/api/v1/admin/export-data/ticket'], ['PUT', '/api/v1/environment/directory'], ['GET', '/api/v1/org'],
      ['POST', '/api/v1/admin/schedules'], ['GET', '/api/v1/backups'], ['POST', '/api/v1/solutions/import'], ['GET', '/api/v1/database'], ['POST', '/api/v1/dataX']] as const) {
      expect(bearerAllowed(m, p), `${m} ${p}`).toBe(false)
    }
    expect(bearerAllowed('POST', '/api/v1/query')).toBe(true)
    expect(bearerAllowed('GET', '/api/v1/data/Orders/rows')).toBe(true)
  })
})
