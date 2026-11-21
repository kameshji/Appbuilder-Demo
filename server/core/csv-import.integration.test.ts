/**
 * CSV import off the event loop's back (load test, November 2026): a large import parses, checks and inserts in slices
 * that give other requests their turn, with the same rows, the same all-or-nothing result and the same error report.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Papa from 'papaparse'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { PG_URL, SKIP_PG } from './testdb.ts'
import { startHarness, type KernelHarness } from './kernel-testkit.ts'
import { parseCsvYielding } from './data.ts'

if (!PG_URL) process.stderr.write(`[csv import integration] ${SKIP_PG}\n`)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function bigCsv(n: number, bad?: number): string {
  const rows = Array.from({ length: n }, (_, i) => [`Item ${i}`, i % 7 === 0 ? `multi\nline, "quoted" ${i}` : `note ${i} ü€ हिन्दी`, bad === i ? 'not a number' : String(i)])
  return Papa.unparse({ fields: ['Title', 'Notes', 'Qty'], data: rows }) + '\r\n\r\n , , \r\n'
}

describe('CSV parsing in slices', () => {
  it('gives the same fields and rows as one Papa.parse, also across chunk boundaries inside quotes', async () => {
    for (const n of [10, 9000, 20000]) {
      const csv = bigCsv(n)
      const one = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: 'greedy' })
      const got = await parseCsvYielding(csv)
      expect(got.fields).toEqual(one.meta.fields)
      expect(got.data.length).toBe(one.data.length)
      expect(JSON.stringify(got.data)).toBe(JSON.stringify(one.data))
    }
    expect(await parseCsvYielding('')).toEqual({ fields: [], data: [] })
  }, 30_000)
})

describe.skipIf(!PG_URL)('CSV import (PostgreSQL)', () => {
  let h: KernelHarness
  beforeAll(async () => {
    h = await startHarness('csvimp')
    const t = await h.admin.post('/tables', { displayName: 'Imp Rows', columns: [{ displayName: 'Title', type: 'text', unique: true }, { displayName: 'Notes', type: 'multiline' }, { displayName: 'Qty', type: 'number' }] })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
  }, 60_000)
  afterAll(async () => { await h?.close() }, 60_000)

  const count = async () => Number((await h.q<Any>('SELECT count(*)::int AS n FROM env_default.t_improws WHERE "deletedOn" IS NULL'))[0].n)

  /** the import while another request is timed; the longest the event loop of this process (the server) was held */
  async function timedImport(csv: string, mode = 'append'): Promise<{ status: number; data: Any; loopMaxMs: number; pings: number; pingMaxMs: number }> {
    const eld = monitorEventLoopDelay({ resolution: 5 })
    eld.enable()
    let done = false
    let pings = 0
    let pingMaxMs = 0
    const pinger = (async () => {
      while (!done) {
        const t0 = performance.now()
        await h.admin.get('/auth/me')
        pingMaxMs = Math.max(pingMaxMs, performance.now() - t0)
        pings++
        await new Promise((r) => setTimeout(r, 20))
      }
    })()
    const r = await h.admin.post('/data/ImpRows/import', { csv, mode })
    done = true
    await pinger
    eld.disable()
    return { ...r, loopMaxMs: eld.max / 1e6, pings, pingMaxMs }
  }

  it('a large import does not hold the event loop; the rows are those of the file', async () => {
    const csv = bigCsv(8000)
    process.env.APPBUILDER_IMPORT_YIELD = 'off'
    let before: Awaited<ReturnType<typeof timedImport>>
    try { before = await timedImport(csv, 'replace') } finally { delete process.env.APPBUILDER_IMPORT_YIELD }
    expect(before.status, JSON.stringify(before.data)).toBe(200)
    const after = await timedImport(csv, 'replace')
    expect(after.status, JSON.stringify(after.data)).toBe(200)
    expect(after.data.imported).toBe(8000)
    expect(await count()).toBe(8000)
    process.stderr.write(`csv import 8000 rows: event loop max ${before.loopMaxMs.toFixed(0)} ms without slices, ${after.loopMaxMs.toFixed(0)} ms with; other requests answered ${before.pings} / ${after.pings} times (slowest ${before.pingMaxMs.toFixed(0)} / ${after.pingMaxMs.toFixed(0)} ms)\n`)
    expect(after.loopMaxMs).toBeLessThan(150)
    const one = (await h.q<Any>(`SELECT "Notes", "Qty" FROM env_default.t_improws WHERE "Title" = 'Item 7' AND "deletedOn" IS NULL`))[0]
    expect(one).toMatchObject({ Notes: 'multi\nline, "quoted" 7' })
    expect(Number(one.Qty)).toBe(7)
  }, 180_000)

  it('all or nothing, with the same error report: a bad row late in a large file changes nothing', async () => {
    const before = await count()
    const r = await h.admin.post('/data/ImpRows/import', { csv: bigCsv(6000, 5500), mode: 'replace' })
    expect(r.status).toBe(422)
    expect(r.data.error.message).toMatch(/^Row 5501: /)
    expect(await count()).toBe(before)
    // a duplicate of a unique value inside the file: refused while the rows are built (nothing imported)
    const dup = bigCsv(3000).replace('Item 2999,', 'Item 1,')
    const d = await h.admin.post('/data/ImpRows/import', { csv: dup, mode: 'append' })
    expect(d.status).toBe(409)
    expect(d.data.error.message).toMatch(/^Row \d+: .*\(nothing was imported\)$/)
    expect(await count()).toBe(before)
  }, 180_000)
})
