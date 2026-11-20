/**
 * Test helpers of the print templates suites (not used at run time): the manufacturing pilot's tables with sample rows
 * (inspections with defects and photos, production logs, purchase requests with lines, delivery challans) created
 * through the HTTP API, a PNG encoder for sample photos, and PDF text extraction with poppler when it is installed.
 */
import zlib from 'node:zlib'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Client, KernelHarness } from '../kernel-testkit.ts'

/** a w x h RGB PNG with a simple pattern (stripes of the colour, a frame) */
export function samplePng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const edge = x < 4 || y < 4 || x >= w - 4 || y >= h - 4
      const stripe = Math.floor((x + y) / 16) % 2 === 0
      const k = y * (w * 3 + 1) + 1 + x * 3
      const f = edge ? 0.3 : stripe ? 1 : 0.75
      raw[k] = Math.round(rgb[0] * f); raw[k + 1] = Math.round(rgb[1] * f); raw[k + 2] = Math.round(rgb[2] * f)
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

export const hasPoppler = (): boolean => spawnSync('pdftotext', ['-v']).status === 0
export const hasRaster = (): boolean => spawnSync('pdftoppm', ['-v']).status === 0

/** the text of a PDF (poppler's pdftotext, layout mode) */
export function pdfText(pdf: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-pdftext-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.pdf'), pdf)
    execFileSync('pdftotext', ['-layout', path.join(dir, 'a.pdf'), path.join(dir, 'a.txt')])
    return fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** page count from the PDF's page tree (no tools needed) */
export const pdfPageCount = (pdf: Buffer): number => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length

/** PNG renders of a PDF's pages into dir (prefix-1.png ...); returns the files */
export function rasterise(pdf: Buffer, dir: string, prefix: string, dpi = 70): string[] {
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(os.tmpdir(), `ab-r-${process.pid}-${Date.now()}.pdf`)
  fs.writeFileSync(tmp, pdf)
  try {
    for (const f of fs.readdirSync(dir)) if (f.startsWith(prefix + '-') && f.endsWith('.png')) fs.rmSync(path.join(dir, f))
    execFileSync('pdftoppm', ['-r', String(dpi), '-png', tmp, path.join(dir, prefix)])
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  return fs.readdirSync(dir).filter((f) => f.startsWith(prefix + '-') && f.endsWith('.png')).sort().map((f) => path.join(dir, f))
}

export interface Pilot {
  inspections: string
  defects: string
  logs: string
  requests: string
  requestLines: string
  challans: string
  challanLines: string
  inspection1: string
  inspection2: string
  request1: string
  challan1: string
}

const ok = (r: { status: number; data: unknown }, what: string) => {
  if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data)}`)
  return r.data as Record<string, unknown> & { id: string; row: { id: string } }
}

export async function uploadImage(base: string, c: Client, table: string, column: string, rowId: string, name: string, bytes: Buffer): Promise<string> {
  const res = await fetch(`${base}/api/v1/attachments?table=${encodeURIComponent(table)}&column=${column}&rowId=${rowId}&name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'X-Appbuilder': '1', Cookie: c.cookie, 'Content-Type': 'image/png' }, body: new Uint8Array(bytes),
  })
  const b = await res.json() as { id: string }
  if (res.status !== 200) throw new Error(`upload: ${res.status} ${JSON.stringify(b)}`)
  return b.id
}

/** the pilot's tables and sample data; `day` is the production date (yyyy-MM-dd) */
export async function createPilot(h: KernelHarness, day: string, o: { logs?: number } = {}): Promise<Pilot> {
  const A = h.admin
  const t = async (displayName: string, name: string, columns: unknown[]) => ok(await A.post('/tables', { displayName, name, columns }), `table ${name}`).id
  const inspections = await t('Inspections', 'Inspections', [
    { displayName: 'Number', type: 'text' }, { displayName: 'Product', type: 'text' }, { displayName: 'Machine', type: 'text' }, { displayName: 'Batch', type: 'text' },
    { displayName: 'Inspector', type: 'text' }, { displayName: 'InspectedOn', type: 'date' }, { displayName: 'Result', type: 'text' }, { displayName: 'Notes', type: 'text' },
    { displayName: 'Photos', name: 'Photos', type: 'image', multiple: true }, { displayName: 'Report', name: 'Report', type: 'file' },
  ])
  await A.patch(`/tables/${inspections}`, { primaryColumn: 'Number' })
  const defects = await t('Inspection defects', 'InspectionDefects', [
    { displayName: 'Inspection', name: 'Inspection', type: 'lookup', lookupTable: 'Inspections' }, { displayName: 'Defect', type: 'text' }, { displayName: 'Severity', type: 'text' },
    { displayName: 'Qty', type: 'number' }, { displayName: 'Action', type: 'text' },
  ])
  const logs = await t('Production logs', 'ProductionLogs', [
    { displayName: 'LogDate', type: 'date' }, { displayName: 'Machine', type: 'text' }, { displayName: 'Shift', type: 'text' }, { displayName: 'PlannedMinutes', type: 'number' },
    { displayName: 'RunMinutes', type: 'number' }, { displayName: 'IdealRatePerMinute', type: 'decimal' }, { displayName: 'TotalCount', type: 'number' }, { displayName: 'GoodCount', type: 'number' },
  ])
  const requests = await t('Purchase requests', 'PurchaseRequests', [
    { displayName: 'Number', type: 'text' }, { displayName: 'Title', type: 'text' }, { displayName: 'Requester', type: 'text' }, { displayName: 'Department', type: 'text' },
    { displayName: 'NeededBy', type: 'date' }, { displayName: 'Status', type: 'text' }, { displayName: 'Justification', type: 'text' },
  ])
  await A.patch(`/tables/${requests}`, { primaryColumn: 'Number' })
  const requestLines = await t('Purchase request lines', 'PurchaseRequestLines', [
    { displayName: 'Request', name: 'Request', type: 'lookup', lookupTable: 'PurchaseRequests' }, { displayName: 'Item', type: 'text' }, { displayName: 'Qty', type: 'number' },
    { displayName: 'Unit', type: 'text' }, { displayName: 'Rate', type: 'decimal' },
  ])
  const challans = await t('Delivery challans', 'DeliveryChallans', [
    { displayName: 'Number', type: 'text' }, { displayName: 'ChallanDate', type: 'date' }, { displayName: 'Customer', type: 'text' }, { displayName: 'ShipTo', type: 'text' },
    { displayName: 'VehicleNo', type: 'text' }, { displayName: 'Transporter', type: 'text' }, { displayName: 'Reference', type: 'text' },
  ])
  await A.patch(`/tables/${challans}`, { primaryColumn: 'Number' })
  const challanLines = await t('Challan lines', 'ChallanLines', [
    { displayName: 'Challan', name: 'Challan', type: 'lookup', lookupTable: 'DeliveryChallans' }, { displayName: 'Item', type: 'text' }, { displayName: 'HSN', type: 'text' },
    { displayName: 'Qty', type: 'number' }, { displayName: 'Unit', type: 'text' }, { displayName: 'Remarks', type: 'text' },
  ])
  const add = async (table: string, values: Record<string, unknown>) => ok(await A.post(`/data/${table}/rows`, { values }), `row of ${table}`).row.id
  const inspection1 = await add('Inspections', { Number: 'INSP-2026-0042', Product: 'Gear housing GH-220 (गियर हाउसिंग)', Machine: 'CNC-07', Batch: 'B-1123', Inspector: 'Asha Verma', InspectedOn: day, Result: 'Fail', Notes: 'Burr on the inner bore; two parts reworked. सतह की जाँच दोबारा करें।' })
  const inspection2 = await add('Inspections', { Number: 'INSP-2026-0043', Product: 'Shaft S-14', Machine: 'Lathe-02', Batch: 'B-1124', Inspector: 'Ravi Kumar', InspectedOn: day, Result: 'Pass' })
  const defectsList: [string, string, number, string][] = [
    ['Burr on inner bore', 'Major', 2, 'Deburr and re-inspect'], ['Surface scratch', 'Minor', 5, 'Accept with deviation'], ['Thread pitch out of tolerance', 'Critical', 1, 'Scrap'],
    ['आयाम में अंतर (dimension mismatch)', 'Major', 3, 'पुनः कार्य करें'],
  ]
  for (const [Defect, Severity, Qty, Action] of defectsList) await add('InspectionDefects', { Inspection: inspection1, Defect, Severity, Qty, Action })
  for (const [i, c] of ([[220, 120, 60], [60, 140, 220], [90, 180, 90]] as [number, number, number][]).entries()) await uploadImage(h.base, A, inspections, 'Photos', inspection1, `photo-${i + 1}.png`, samplePng(320, 220, c))
  const machines = ['CNC-07', 'CNC-08', 'Lathe-02', 'Press-03', 'Mill-05']
  const shifts = ['A', 'B', 'C']
  const n = o.logs ?? machines.length * shifts.length
  const lines = ['LogDate,Machine,Shift,PlannedMinutes,RunMinutes,IdealRatePerMinute,TotalCount,GoodCount']
  for (let i = 0; i < n; i++) {
    const m = machines[i % machines.length]
    const s = shifts[Math.floor(i / machines.length) % shifts.length]
    const run = 380 + ((i * 37) % 80)
    const rate = 2 + (i % 3) * 0.5
    const total = Math.round(run * rate * (0.78 + ((i * 13) % 17) / 100))
    lines.push(`${day},${m},${s},480,${run},${rate},${total},${total - ((i * 7) % 23)}`)
  }
  ok(await A.post('/data/ProductionLogs/import', { csv: lines.join('\n'), mode: 'append' }), 'production logs')
  const request1 = await add('PurchaseRequests', { Number: 'PR-0107', Title: 'Spare bearings for CNC line', Requester: 'Asha Verma', Department: 'Maintenance', NeededBy: day, Status: 'Approved', Justification: 'Bearings of CNC-07 and CNC-08 are due for replacement.' })
  for (const [Item, Qty, Unit, Rate] of [['Bearing 6205-2RS', 12, 'NOS', 245.5], ['Bearing 6306-ZZ', 8, 'NOS', 410], ['Grease EP2 (1 kg)', 3, 'KG', 520]] as [string, number, string, number][]) await add('PurchaseRequestLines', { Request: request1, Item, Qty, Unit, Rate })
  const challan1 = await add('DeliveryChallans', { Number: 'DC/26-27/0315', ChallanDate: day, Customer: 'Shakti Auto Components Pvt Ltd', ShipTo: 'Plot 14, MIDC Bhosari, Pune 411026', VehicleNo: 'MH 14 AB 1234', Transporter: 'Sai Logistics', Reference: 'PO 4500012345' })
  for (const [Item, HSN, Qty, Unit, Remarks] of [['Gear housing GH-220', '8483', 120, 'NOS', 'Packed in 6 crates'], ['Shaft S-14', '8483', 300, 'NOS', ''], ['Spacer ring SR-9', '7318', 1500, 'NOS', 'Returnable crates']] as [string, string, number, string, string][]) await add('ChallanLines', { Challan: challan1, Item, HSN, Qty, Unit, Remarks })
  return { inspections, defects, logs, requests, requestLines, challans, challanLines, inspection1, inspection2, request1, challan1 }
}
