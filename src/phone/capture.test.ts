/**
 * Pure logic of the phone offline and capture package: signature pad maths, the Back-gesture stack of bottom sheets,
 * "available offline" tables (normalising, filter compiling, download plans, answers from kept rows) and form drafts.
 * The browser parts are checked in scripts/exit-check/p2-phone.mjs (Chrome phone emulation).
 */
import { describe, expect, it } from 'vitest'
import { EXPORT_MAX_H, EXPORT_MAX_W, EXPORT_MIN_W, exportSize, hasSignature, inkLength, padRect, penWidthFor, simplify, strokeBounds, strokePath, toPad, type Stroke } from './signature'
import { BackStack, type HistoryLike } from './back'
import { DEFAULT_OFFLINE_ROWS, DOWNLOAD_PAGE, MAX_OFFLINE_ROWS, capMessage, clampRows, compileOfflineTable, downloadPlan, normalizeOfflineTables, progressText, specKey } from './offline/tables'
import { answerFromSnapshot } from '@/platform/offline-hook'
import { draftKeyOf, draftNote, draftRecordKey, restoreDecision } from './drafts'
import { registerFiles, splitFileTokens } from '@/runtime/attachments'
import type { SchemaInfo } from '@/platform/query'
import type { ColumnDef, TableDef } from '@/platform/contracts'
import { controls } from '@/controls'
import { TOUCH_MATRIX } from './touch'

const line = (n: number, y = 0.5): Stroke => Array.from({ length: n }, (_, i) => ({ x: i / (n - 1), y, t: i }))

describe('signature pad', () => {
  it('the pad is the largest 3:1 area of the box, centred', () => {
    expect(padRect(360, 168)).toEqual({ x: 0, y: 24, w: 360, h: 120 })
    expect(padRect(600, 100)).toEqual({ x: 150, y: 0, w: 300, h: 100 })
    expect(padRect(0, 0)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
  it('simplify keeps the ends and the corners, drops points on a straight line', () => {
    expect(simplify(line(100), 360, 120)).toHaveLength(2)
    const zig: Stroke = [{ x: 0, y: 0, t: 0 }, { x: 0.25, y: 0.5, t: 1 }, { x: 0.5, y: 0, t: 2 }, { x: 0.75, y: 0.5, t: 3 }, { x: 1, y: 0, t: 4 }]
    expect(simplify(zig, 360, 120)).toHaveLength(5)
    // a wobble smaller than the tolerance goes
    const wobble: Stroke = line(50).map((p, i) => ({ ...p, y: 0.5 + (i % 2 ? 0.001 : -0.001) }))
    expect(simplify(wobble, 360, 120).length).toBeLessThan(5)
    expect(simplify([{ x: 0.1, y: 0.1, t: 0 }], 360, 120)).toHaveLength(1)
  })
  it('strokes are drawn smoothed: quadratic curves through the midpoints; a tap is a dot', () => {
    expect(strokePath([{ x: 0.5, y: 0.5, t: 0 }], 100, 50)).toEqual([{ t: 'dot', x: 50, y: 25 }])
    expect(strokePath(line(2), 100, 50).map((c) => c.t)).toEqual(['M', 'L'])
    const p = strokePath(line(5), 100, 50, 10, 0)
    expect(p.map((c) => c.t)).toEqual(['M', 'Q', 'Q', 'Q', 'L'])
    expect(p[1]).toEqual({ t: 'Q', cx: 35, cy: 25, x: 47.5, y: 25 })
  })
  it('a stray tap is not a signature; a short line is', () => {
    expect(hasSignature([], 360, 120)).toBe(false)
    expect(hasSignature([[{ x: 0.5, y: 0.5, t: 0 }]], 360, 120)).toBe(false)
    expect(inkLength([line(10)], 360, 120)).toBeCloseTo(360)
    expect(hasSignature([[{ x: 0.1, y: 0.5, t: 0 }, { x: 0.15, y: 0.5, t: 1 }]], 360, 120)).toBe(true)
  })
  it('the exported PNG is bounded, keeps the aspect, and is never tiny', () => {
    expect(exportSize(360, 120)).toEqual({ w: 1080, h: 360, scale: 3 })
    expect(exportSize(2000, 2000 / 3)).toMatchObject({ w: 1200, h: 400 })
    expect(exportSize(60, 20)).toMatchObject({ w: 300, h: 100 })
    for (let i = 0; i < 300; i++) {
      const w = 20 + ((i * 7919) % 3000)
      const h = w / 3
      const s = exportSize(w, h)
      expect(s.w).toBeLessThanOrEqual(EXPORT_MAX_W)
      expect(s.h).toBeLessThanOrEqual(EXPORT_MAX_H)
      expect(s.w).toBeGreaterThanOrEqual(Math.min(EXPORT_MIN_W, EXPORT_MAX_W))
      expect(Math.abs(s.w / s.h - 3)).toBeLessThan(0.05)
    }
    expect(exportSize(0, 0).w).toBe(EXPORT_MIN_W)
  })
  it('pointer positions become pad units, clamped; bounds; pen width follows the pad', () => {
    const r = { left: 10, top: 20, width: 300, height: 100 }
    expect(toPad(160, 70, r, 5)).toEqual({ x: 0.5, y: 0.5, t: 5 })
    expect(toPad(-50, 500, r, 0)).toMatchObject({ x: 0, y: 1 })
    expect(strokeBounds([])).toBeNull()
    expect(strokeBounds([line(3, 0.2), [{ x: 0.4, y: 0.9, t: 0 }]])).toEqual({ minX: 0, minY: 0.2, maxX: 1, maxY: 0.9 })
    expect(penWidthFor(2.5, 360)).toBeCloseTo(2.5)
    expect(penWidthFor(2.5, 1080)).toBeCloseTo(6.25)
    expect(penWidthFor(NaN, 360)).toBeCloseTo(2.5)
  })
  it('is a registered UI component with a touch matrix entry', () => {
    expect(controls.get('SignaturePad').outputs.map((o) => o.name)).toEqual(['Image', 'FileToken', 'HasSignature', 'IsEmpty'])
    expect(TOUCH_MATRIX.SignaturePad?.status).toBe('fixed')
    expect(controls.propsOf('Form').some((p) => p.name === 'SignatureFields')).toBe(true)
  })
})

/* ------------------------------------------------------------------ Back gesture */

/** a browser history: entries with depths, an index; back() is asynchronous like the real one (pop() delivers it) */
class FakeHistory implements HistoryLike {
  entries = [0]
  idx = 0
  queued = 0
  depth() {
    return this.entries[this.idx]!
  }
  push(d: number) {
    this.entries = this.entries.slice(0, this.idx + 1)
    this.entries.push(d)
    this.idx++
  }
  back() {
    this.queued++
  }
  /** the browser moves back (our back() or the user's gesture) and fires popstate */
  pop(stack: BackStack, user = false) {
    if (user) this.queued++
    while (this.queued > 0) {
      this.queued--
      if (this.idx > 0) this.idx--
      stack.popped()
    }
  }
}

describe('Android Back closes bottom sheets', () => {
  it('opening pushes one entry; a normal close takes it off again (no stray entries)', () => {
    const h = new FakeHistory()
    const s = new BackStack(h)
    let closed = 0
    const id = s.open(() => closed++)
    expect(h.entries).toEqual([0, 1])
    expect(h.idx).toBe(1)
    s.close(id)
    h.pop(s)
    expect(h.idx).toBe(0)
    expect(h.depth()).toBe(0)
    expect(closed).toBe(0)
    expect(s.size).toBe(0)
  })
  it('the Back gesture closes the sheet instead of leaving the page, once', () => {
    const h = new FakeHistory()
    const s = new BackStack(h)
    let closed = 0
    const id = s.open(() => closed++)
    h.pop(s, true)
    expect(closed).toBe(1)
    expect(h.idx).toBe(0) // still on the app's own entry
    s.close(id) // the sheet unmounts after its onClose: no second back()
    expect(h.queued).toBe(0)
  })
  it('nested sheets close one per Back, innermost first', () => {
    const h = new FakeHistory()
    const s = new BackStack(h)
    const log: string[] = []
    const a = s.open(() => log.push('dialog'))
    const b = s.open(() => log.push('picker'))
    expect(h.entries).toEqual([0, 1, 2])
    h.pop(s, true)
    expect(log).toEqual(['picker'])
    s.close(b)
    h.pop(s, true)
    expect(log).toEqual(['picker', 'dialog'])
    s.close(a)
    expect(h.idx).toBe(0)
  })
  it('a sheet the app keeps open after Back gets a new entry (the next Back still closes it)', () => {
    const h = new FakeHistory()
    const s = new BackStack(h)
    let asked = 0
    const id = s.open(() => asked++)
    h.pop(s, true)
    s.stillOpen(id)
    expect(h.depth()).toBe(1)
    h.pop(s, true)
    expect(asked).toBe(2)
  })
  it('a navigation while open leaves history alone when the sheet closes', () => {
    const h = new FakeHistory()
    const s = new BackStack(h)
    const id = s.open(() => {})
    h.push(0) // the app navigated (a new entry without our marker)
    s.close(id)
    expect(h.queued).toBe(0)
  })
})

/* ------------------------------------------------------------------ available offline tables */

const col = (name: string, type: ColumnDef['type'], extra: Partial<ColumnDef> = {}): ColumnDef => ({ name, displayName: name, type, ...extra }) as ColumnDef
const PARTS: TableDef = {
  id: 'tbl_p', name: 'Parts', displayName: 'Parts', primaryColumn: 'Name', createdOn: '', modifiedOn: '',
  columns: [col('id', 'text', { system: true }), col('createdOn', 'datetime', { system: true }), col('owner', 'text', { system: true }), col('Name', 'text'), col('Status', 'text'), col('Qty', 'number'), col('Due', 'date'), col('Seen', 'datetime')],
}
const SCHEMA: SchemaInfo = { tables: { Parts: { columns: { id: 'text', createdOn: 'datetime', owner: 'text', Name: 'text', Status: 'text', Qty: 'number', Due: 'date', Seen: 'datetime' } } } }

describe('available offline tables', () => {
  it('only data sources count, once each; the row cap has a default and a hard maximum', () => {
    expect(normalizeOfflineTables([{ table: 'parts' }, { table: 'Parts', maxRows: 5 }, { table: 'Nope' }, { table: 'Users', maxRows: 50000, filter: '  ' }], ['Parts', 'Users'])).toEqual([
      { table: 'Parts', maxRows: DEFAULT_OFFLINE_ROWS },
      { table: 'Users', maxRows: MAX_OFFLINE_ROWS },
    ])
    expect(clampRows(0)).toBe(1)
    expect(clampRows(-5)).toBe(1)
    expect(clampRows('12' as unknown)).toBe(DEFAULT_OFFLINE_ROWS)
    expect(clampRows(1234.9)).toBe(1234)
  })
  it('a filter is compiled to a server condition; one that cannot run on the server keeps the table off the device', () => {
    const ok = compileOfflineTable({ table: 'Parts', filter: 'Status <> "Closed"', maxRows: 100 }, SCHEMA)
    expect(ok.error).toBeUndefined()
    expect(ok.filter).toBeTruthy()
    expect(JSON.stringify(ok.filter)).toContain('Closed')
    const mine = compileOfflineTable({ table: 'Parts', filter: 'owner = User().Id' }, SCHEMA, { resolve: (n) => (n === 'User()' ? { Id: 'u_7', FullName: 'Sam', Email: 's@x' } : undefined) })
    expect(mine.error).toBeUndefined()
    expect(JSON.stringify(mine.filter)).toContain('u_7')
    const bad = compileOfflineTable({ table: 'Parts', filter: 'NoSuchColumn = 1' }, SCHEMA)
    expect(bad.error).toMatch(/not kept on this device/)
    expect(bad.filter).toBeUndefined()
    expect(compileOfflineTable({ table: 'Ghost' }, SCHEMA).error).toMatch(/not found/)
    expect(compileOfflineTable({ table: 'Parts' }, SCHEMA)).toEqual({ table: 'Parts', maxRows: DEFAULT_OFFLINE_ROWS })
  })
  it('downloads page by page through the normal query plan, the first page with the count, never past the cap', () => {
    const spec = { table: 'Parts', maxRows: 1200 }
    expect(downloadPlan(spec, 0)).toEqual({ version: 2, table: 'Parts', count: true, page: { size: DOWNLOAD_PAGE } })
    expect(downloadPlan(spec, 1000, 'c1')).toEqual({ version: 2, table: 'Parts', page: { size: 200, cursor: 'c1' } })
    expect(specKey(spec)).not.toBe(specKey({ ...spec, maxRows: 10 }))
  })
  it('a plain message when the cap cut the data; progress text', () => {
    expect(capMessage('Parts', 2000, 2000)).toBeNull()
    expect(capMessage('Parts', 2000, undefined)).toBeNull()
    expect(capMessage('Parts', 2000, 5130)).toBe('Only 2,000 of 5,130 rows of Parts are kept on this device for offline use (the app\'s limit). Without a connection, lists and lookups of Parts show only those.')
    expect(progressText('Parts', 1000, 2000)).toBe('Getting Parts ready for offline use: 1,000 of 2,000')
  })

  const wire = [
    { id: 'p3', createdOn: '2026-01-03T00:00:00.000Z', owner: 'u1', Name: 'Bolt M8', Status: 'Open', Qty: 5, Due: '2026-03-01', Seen: '2026-03-01T08:30:00.000Z' },
    { id: 'p1', createdOn: '2026-01-01T00:00:00.000Z', owner: 'u1', Name: 'Nut M8', Status: 'Closed', Qty: 50, Due: '2026-02-01', Seen: null },
    { id: 'p2', createdOn: '2026-01-02T00:00:00.000Z', owner: 'u2', Name: 'Bolt M10', Status: 'Open', Qty: 7, Due: null, Seen: null },
  ]
  it('offline, the kept rows answer type-ahead, lookups and list plans with the reference executor (wire format back)', () => {
    const search = answerFromSnapshot({ version: 2, table: 'Parts', search: { text: 'bolt', columns: ['Name'] }, sort: [{ col: 'Name', dir: 'asc' }], count: true }, { rows: wire, partial: false }, PARTS)!
    expect(search.rows.map((r) => r.Name)).toEqual(['Bolt M10', 'Bolt M8'])
    expect(search.count).toBe(2)
    expect(search.truncated).toBeUndefined()
    // dates go back as YYYY-MM-DD, datetimes as instants, the id as id
    const one = answerFromSnapshot({ version: 2, table: 'Parts', filter: { col: 'id', op: 'eq', value: 'p3' }, single: true }, { rows: wire, partial: false }, PARTS)!
    expect(one.rows).toEqual([{ ...wire[0] }])
    // natural order (createdOn, id) and pages with a cursor
    const p1 = answerFromSnapshot({ version: 2, table: 'Parts', page: { size: 2 } }, { rows: wire, partial: true }, PARTS)!
    expect(p1.rows.map((r) => r.id)).toEqual(['p1', 'p2'])
    expect(p1.truncated).toBe(true)
    expect(typeof p1.nextCursor).toBe('string')
    const p2 = answerFromSnapshot({ version: 2, table: 'Parts', page: { size: 2, cursor: p1.nextCursor! } }, { rows: wire, partial: true }, PARTS)!
    expect(p2.rows.map((r) => r.id)).toEqual(['p3'])
    expect(p2.nextCursor).toBeNull()
    // a count plan (sizes) and a malformed plan (the caller then says "Could not reach the server")
    expect(answerFromSnapshot({ version: 2, table: 'Parts', count: true, page: { size: 0 } }, { rows: wire, partial: false }, PARTS)!.count).toBe(3)
    expect(answerFromSnapshot({ version: 2, table: 'Parts', filter: { col: 'Nope', op: 'eq', value: 1 } }, { rows: wire, partial: false }, PARTS)).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ form drafts */

describe('form drafts', () => {
  it('keys: app, screen, form, table and record; New and Edit never share one', () => {
    expect(draftRecordKey('Edit', 'r1')).toBe('id:r1')
    expect(draftRecordKey('Edit', '')).toBe('edit:new')
    expect(draftRecordKey('New', 'r1')).toBe('new:new')
    expect(draftKeyOf('app1', 'scr1', 'Form 1', 'Visits', 'id:r|1')).toBe('app1|scr1|Form%201|visits|id%3Ar%7C1')
    expect(draftKeyOf('a', '', 'F', 'T', 'new:new')).toBe('a|-|F|t|new%3Anew')
  })
  it('restores only into an untouched form of the same mode, and says so when the record changed since', () => {
    const at = new Date('2026-03-01T10:00:00.000Z')
    expect(restoreDecision({ draft: null, mode: 'New', currentBase: null, untouched: true })).toBe('ignore')
    expect(restoreDecision({ draft: { mode: 'New', base: null }, mode: 'New', currentBase: null, untouched: false })).toBe('ignore')
    expect(restoreDecision({ draft: { mode: 'New', base: null }, mode: 'Edit', currentBase: at, untouched: true })).toBe('ignore')
    expect(restoreDecision({ draft: { mode: 'New', base: null }, mode: 'New', currentBase: null, untouched: true })).toBe('restore')
    expect(restoreDecision({ draft: { mode: 'Edit', base: at.toISOString() }, mode: 'Edit', currentBase: at, untouched: true })).toBe('restore')
    expect(restoreDecision({ draft: { mode: 'Edit', base: at.toISOString() }, mode: 'Edit', currentBase: new Date('2026-03-01T10:05:00Z'), untouched: true })).toBe('restore-changed')
  })
  it('the note says when it was kept, and what changed', () => {
    const now = new Date(2026, 2, 1, 12, 0).getTime()
    expect(draftNote(new Date(2026, 2, 1, 10, 42).getTime(), false, false, now)).toBe('Draft restored (kept on this device at 10:42).')
    expect(draftNote(new Date(2026, 1, 27, 9, 5).getTime(), true, true, now)).toMatch(/^Draft restored \(kept on this device at 2026-02-27 09:05\)\. The record was changed by someone else since: .* Large photos were not kept/)
  })
})

/* ------------------------------------------------------------------ Patch with file tokens */

describe('Patch with a signature (file token)', () => {
  const cols = [col('Signature', 'image'), col('Photos', 'image', { multiple: true }), col('Note', 'text')]
  it('token values of image columns are uploaded after the row; other values are written', () => {
    const f = new File([new Uint8Array([137, 80, 78, 71])], 'signature.png', { type: 'image/png' })
    const t = registerFiles([f])
    const t2 = registerFiles([f, f])
    const r = splitFileTokens({ signature: t, Photos: t2, Note: 'files_x_y' }, cols, true)
    expect(r.rest).toEqual({ Signature: null, Note: 'files_x_y' })
    expect(r.files).toEqual([{ column: 'Signature', files: [f] }, { column: 'Photos', files: [f, f] }])
    expect(splitFileTokens({ Signature: t }, cols, false).rest).toEqual({})
    expect(splitFileTokens({ Signature: 'files_gone_1' }, cols, false).missing).toBe('Signature')
  })
})
