/**
 * Backup and restore with large-ish data (P0 package J): 1,000,000 rows and 500 MB of attachments generated on the
 * fly; reports time and peak memory of backup (pg_dump and built-in exporter), verification and restore as a new
 * environment. Slow (minutes) and disk-hungry (about 2.5 GB in the temp folder), so opt-in:
 *   APPBUILDER_TEST_LARGE=1 APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/backup/backup.large
 * Sizes: APPBUILDER_TEST_LARGE_ROWS (1000000), APPBUILDER_TEST_LARGE_MB (500).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { PG_URL, dropDatabase, pgQuery, pgServer, testDatabaseName } from '../testdb.ts'
import { createApp } from '../app.ts'
import type { AppServer } from '../app.ts'
import { setQuiet } from '../util.ts'

setQuiet(true)
const LARGE = process.env.APPBUILDER_TEST_LARGE === '1'
const ROWS = Number(process.env.APPBUILDER_TEST_LARGE_ROWS) || 1_000_000
const MB = Number(process.env.APPBUILDER_TEST_LARGE_MB) || 500
const conn = pgServer
const dbName = testDatabaseName('bklarge')

/** peak resident memory while fn runs (sampled every 50 ms) */
async function measure<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number; peakRssMb: number; baseRssMb: number }> {
  const base = process.memoryUsage().rss
  let peak = base
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 50)
  const t0 = Date.now()
  try {
    const value = await fn()
    return { value, ms: Date.now() - t0, peakRssMb: Math.round(peak / 1048576), baseRssMb: Math.round(base / 1048576) }
  } finally {
    clearInterval(timer)
  }
}

describe.skipIf(!PG_URL || !LARGE)('backup and restore with 1M rows and 500 MB of attachments', () => {
  let app: AppServer
  let server: http.Server
  let tmp = ''
  const report: string[] = []
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => pgQuery<T>(dbName, sql, params)
  let cookie = ''
  let base = ''
  const api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(base + '/api/v1' + p, { method, headers: { 'X-Appbuilder': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of res.headers.getSetCookie()) if (c.startsWith('ab_session=')) cookie = c.split(';')[0]
    return { status: res.status, data: await res.json() as any }
  }

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bk-large-'))
    app = await createApp({ config: { workspaceDir: tmp }, printSetupCode: false, jobs: false })
    server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) res.writeHead(404).end() }) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect((await api('POST', '/setup/database', { setupCode: app.services.setupCode.current() ?? '', host: conn!.host, port: conn!.port, database: dbName, user: conn!.user, password: conn!.password, createDatabase: true })).status).toBe(200)
    expect((await api('POST', '/setup/admin', { setupCode: app.services.setupCode.current() ?? '', name: 'Ada', email: 'ada@example.com', password: 'admin-password-1' })).status).toBe(200)
    expect((await api('POST', '/tables', { displayName: 'Big', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Qty', type: 'number' }, { displayName: 'Amount', type: 'currency' }, { displayName: 'Notes', type: 'multiline' }, { displayName: 'Doc', type: 'file' }] })).status).toBe(200)
    const t0 = Date.now()
    await q(`INSERT INTO env_default.t_big (id, "createdOn", "modifiedOn", "createdBy", owner, "Title", "Qty", "Amount", "Notes")
             SELECT lpad(to_hex(g), 32, '0'), now(), now(), 'u', 'u', 'Row ' || g, g, g * 1.5, CASE WHEN g % 10 = 0 THEN repeat('note ', 20) END FROM generate_series(1, $1) g`, [ROWS])
    await q('ANALYZE env_default.t_big')
    // attachments: 5 MB random (incompressible) files, written in 1 MB pieces, with their records
    const dir = path.join(tmp, 'env', 'default', 'attachments')
    const tableId = (await q<{ id: string }>("SELECT id FROM env_default.ab_tables WHERE name = 'Big'"))[0].id
    const files = Math.ceil(MB / 5)
    for (let i = 0; i < files; i++) {
      const key = randomBytes(16).toString('hex')
      const f = path.join(dir, key.slice(0, 2), key)
      fs.mkdirSync(path.dirname(f), { recursive: true })
      const fd = fs.openSync(f, 'w')
      const h = createHash('sha256')
      for (let k = 0; k < 5; k++) { const b = randomBytes(1048576); h.update(b); fs.writeSync(fd, b) }
      fs.closeSync(fd)
      await q(`INSERT INTO env_default.ab_attachments (id, table_id, col, row_id, file_name, mime, sha256, storage_key, size_bytes, created_on) VALUES ($1, $2, 'Doc', $3, 'f.bin', 'application/octet-stream', $4, $5, $6, now())`,
        [`att_big_${i}`, tableId, ''.padStart(32, '0').slice(0, 31) + String(i % 10), h.digest('hex'), key, 5 * 1048576])
    }
    report.push(`setup: ${ROWS.toLocaleString('en')} rows and ${files} x 5 MB attachments generated in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  }, 1_800_000)

  afterAll(async () => {
    process.stdout.write(`\n[backup large-data report]\n${report.map((l) => `  ${l}`).join('\n')}\n\n`)
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    await app?.close()
    if (conn) await dropDatabase(dbName)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 600_000)

  let pgDumpBackup: any
  for (const method of ['pg_dump', 'builtin'] as const) {
    it(`backs up with ${method} and verifies, in bounded memory`, async () => {
      await app.services.backup.saveSettings({ method }, (await app.services.security.forUser((await app.services.meta.users.list())[0])))
      const m = await measure(() => app.services.backup.backupDirect({ scope: 'default', trigger: 'manual', by: null }))
      const b = m.value
      expect(b.state).toBe('ok')
      expect(b.method).toBe(method)
      report.push(`${method}: backup + verification ${(m.ms / 1000).toFixed(1)} s, archive ${(b.sizeBytes! / 1048576).toFixed(0)} MB, process RSS ${m.baseRssMb} -> peak ${m.peakRssMb} MB`)
      expect(m.peakRssMb - m.baseRssMb).toBeLessThan(400)
      if (method === 'pg_dump') pgDumpBackup = b
    }, 1_800_000)
  }

  it('restores the pg_dump backup as a new environment: 1M rows, every attachment', async () => {
    const admin = await app.services.security.forUser((await app.services.meta.users.list())[0])
    const m = await measure(async () => {
      const op = await app.services.backup.restoreEnvironment(pgDumpBackup.id, { environment: 'default', mode: 'new', name: 'Big restored' }, admin)
      for (;;) {
        const o = await app.services.backup.getOp(op.id)
        if (o.state !== 'running') return o
        await new Promise((r) => setTimeout(r, 250))
      }
    })
    expect(m.value, JSON.stringify(m.value)).toMatchObject({ state: 'succeeded' })
    const envId = (m.value.result as { environment: string }).environment
    expect((await q(`SELECT count(*)::int AS n FROM env_${envId}.t_big`))[0]).toEqual({ n: ROWS })
    const att = path.join(tmp, 'env', envId, 'attachments')
    let bytes = 0
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else bytes += fs.statSync(p).size } }
    walk(att)
    expect(bytes).toBeGreaterThanOrEqual(Math.ceil(MB / 5) * 5 * 1048576)
    report.push(`restore as new environment (check + files + database + indexes): ${(m.ms / 1000).toFixed(1)} s, process RSS ${m.baseRssMb} -> peak ${m.peakRssMb} MB`)
  }, 1_800_000)
})
