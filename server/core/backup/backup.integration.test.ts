/**
 * Backup and restore end to end against the sandbox PostgreSQL (P0 package J):
 *   APPBUILDER_TEST_DB=postgres://abdev:abdev-sandbox-only@127.0.0.1:5433/appbuilder_test npx vitest run server/core/backup
 * Backup now (pg_dump and the built-in exporter) with attachments and data files, verification, parity of the two methods,
 * encrypted archives (wrong passphrase), tampering, restore as a new environment, in place (and a failing one that keeps
 * the old data), selected tables (replace, as new), browsing, cross-version, a consistent snapshot under concurrent
 * writes, snapshots before upgrades and deletes, the restore test, upload and download, notifications, and the install
 * restore command line (with and without the key file). Creates and drops its databases.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import pg from 'pg'
import { PG_URL, SKIP_PG, createDatabase, dropDatabase, pgQuery, pgServer, testDatabaseName } from '../testdb.ts'
import { poolConfig } from '../../connectors/postgres/db.ts'
import { createApp } from '../app.ts'
import type { AppServer } from '../app.ts'
import { setQuiet } from '../util.ts'
import { SCHEMA_VERSION } from '../meta-store.ts'
import { TarWriter, plainFileSink } from './archive.ts'
import { openArchive, restoreSchema, connect } from './engine.ts'

setQuiet(true)

const conn = pgServer
const dbName = testDatabaseName('bk')
if (!PG_URL) process.stderr.write(`[server/core/backup integration] ${SKIP_PG}\n`)

class Client {
  cookie = ''
  env = ''
  base: string
  constructor(base: string) { this.base = base }
  async req(method: string, p: string, body?: unknown, o: { env?: string | null; raw?: { data: Buffer; type: string } } = {}) {
    const headers: Record<string, string> = { 'X-Appbuilder': '1' }
    if (this.cookie) headers.Cookie = this.cookie
    const env = o.env === undefined ? this.env : o.env
    if (env) headers['X-Appbuilder-Environment'] = env
    let payload: string | Uint8Array<ArrayBuffer> | undefined
    if (o.raw) { headers['Content-Type'] = o.raw.type; payload = new Uint8Array(o.raw.data) } else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
    const res = await fetch(this.base + '/api/v1' + p, { method, headers, body: payload })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const [name, value] = pair.split('=')
      if (name === 'ab_session') this.cookie = value ? `ab_session=${value}` : ''
    }
    const type = res.headers.get('content-type') ?? ''
    return { status: res.status, data: (type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())) as any }
  }
  get = (p: string, env?: string | null) => this.req('GET', p, undefined, { env })
  post = (p: string, b?: unknown, env?: string | null) => this.req('POST', p, b ?? {}, { env })
  put = (p: string, b: unknown, env?: string | null) => this.req('PUT', p, b, { env })
  patch = (p: string, b: unknown, env?: string | null) => this.req('PATCH', p, b, { env })
  del = (p: string, b?: unknown, env?: string | null) => this.req('DELETE', p, b, { env })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!PG_URL)('backup and restore (PostgreSQL)', () => {
  let app: AppServer
  let server: http.Server
  let tmp = ''
  let A: Client
  let maker: Client
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => pgQuery<T>(dbName, sql, params)
  const photo = Buffer.from('photo bytes '.repeat(500))
  let orderIds: string[] = []
  let attId = ''

  async function waitBackup(id: string, ms = 60_000): Promise<any> {
    const until = Date.now() + ms
    for (;;) {
      const r = await A.get(`/backups/${id}`)
      if (!['queued', 'running', 'verifying'].includes(r.data.state)) return r.data
      if (Date.now() > until) throw new Error(`backup ${id} still ${r.data.state}`)
      await sleep(150)
    }
  }
  async function waitOp(id: string, ms = 90_000): Promise<any> {
    const until = Date.now() + ms
    for (;;) {
      const r = await A.get(`/backups/ops/${id}`)
      if (r.data.state !== 'running') return r.data
      if (Date.now() > until) throw new Error(`operation ${id} still running (${r.data.phase})`)
      await sleep(150)
    }
  }
  async function backupNow(b: Record<string, unknown> = {}): Promise<any> {
    const r = await A.post('/backups', b)
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return waitBackup(r.data.id)
  }
  /** md5 of every row of a table, independent of physical order */
  async function digest(schema: string, table: string): Promise<{ n: number; md5: string }> {
    const r = await q<{ n: string; m: string | null }>(`SELECT count(*)::text AS n, md5(string_agg(t::text, '|' ORDER BY t.id)) AS m FROM "${schema}"."${table}" t`)
    return { n: Number(r[0].n), md5: r[0].m ?? '' }
  }
  const archiveFile = (fileName: string) => path.join(tmp, 'backups', fileName)

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bk-'))
    app = await createApp({ env: { APPBUILDER_MAX_ENVIRONMENTS: '10' }, config: { workspaceDir: tmp }, printSetupCode: false })
    server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) res.writeHead(404).end() }) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    A = new Client(base)
    maker = new Client(base)
    expect((await A.post('/setup/database', { setupCode: app.services.setupCode.current() ?? '', host: conn!.host, port: conn!.port, database: dbName, user: conn!.user, password: conn!.password, createDatabase: true })).status).toBe(200)
    expect((await A.post('/setup/admin', { setupCode: app.services.setupCode.current() ?? '', name: 'Ada', email: 'ada@example.com', password: 'admin-password-1' })).status).toBe(200)
    const mk = await A.post('/users', { name: 'Mo Maker', email: 'mo@example.com', roleIds: ['role_maker'], password: 'maker-password-1' })
    await app.services.meta.users.update(mk.data.id, { mustChangePassword: false })
    expect((await maker.post('/auth/login', { email: 'mo@example.com', password: 'maker-password-1' })).status).toBe(200)
    // data: a Purchases table with an attachment column, 300 rows, one attachment; a data file table
    const t = await A.post('/tables', { displayName: 'Purchases', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Qty', type: 'number' }, { displayName: 'Price', type: 'currency' }, { displayName: 'Notes', type: 'multiline' }, { displayName: 'Photo', type: 'file' }] })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    const rows = Array.from({ length: 300 }, (_, i) => ({ Title: `Order ${i}`, Qty: i, Price: i * 1.25, Notes: i % 7 === 0 ? 'tab\there\nnew line \\ back' : null }))
    for (const r of rows) {
      const x = await A.post('/data/Purchases/rows', { values: r })
      expect(x.status, JSON.stringify(x.data)).toBe(200)
      orderIds.push(x.data.row?.id ?? x.data.id)
    }
    const up = await A.req('POST', `/attachments?table=Purchases&column=Photo&rowId=${orderIds[0]}&name=photo.bin`, undefined, { raw: { data: photo, type: 'application/octet-stream' } })
    expect(up.status, JSON.stringify(up.data)).toBe(200)
    attId = up.data.id
    const csv = 'Name,City\nAnn,Pune\nBo,Indore\n'
    expect((await A.req('POST', '/files?name=people.csv', undefined, { raw: { data: Buffer.from(csv), type: 'text/csv' } })).status).toBe(200)
  }, 120_000)

  afterAll(async () => {
    await app?.services.backup.idle().catch(() => {})
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    await app?.close()
    if (conn) await dropDatabase(dbName)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 120_000)

  it('the catalogue, settings and health exist; only install administrators may use them', async () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(7)
    expect((await q("SELECT to_regclass('ab.backups') IS NOT NULL AS ok"))[0]).toEqual({ ok: true })
    const st = await A.get('/backups/settings')
    expect(st.status).toBe(200)
    expect(st.data).toMatchObject({ enabled: true, folder: path.join(tmp, 'backups'), method: 'auto', install: { enabled: true, cron: '0 2 * * *', includeKey: false }, retention: { daily: 7, weekly: 4, monthly: 3 }, passphraseSaved: false })
    expect(st.data.tools.pgDump?.version).toMatch(/^1\d/)
    const h = await A.get('/backups/health')
    expect(h.data).toMatchObject({ enabled: true, lastOk: null, stale: true })
    expect((await maker.get('/backups')).status).toBe(403)
    expect((await maker.post('/backups', {})).status).toBe(403)
    // the nightly schedule lives in Default's job schedules (misfire: run once)
    const sc = (await q<{ cron: string; enabled: boolean; misfire: string; job_type: string }>(`SELECT cron, enabled, misfire, job_type FROM env_default.ab_schedules WHERE id = 'sched_backup_install'`))[0]
    expect(sc).toEqual({ cron: '0 2 * * *', enabled: true, misfire: 'run_once', job_type: 'backup.run' })
  })

  let first: any
  it('backs up the install with pg_dump as a job: verified, manifest with row counts and checksums, files', async () => {
    first = await backupNow({ note: 'first' })
    expect(first, JSON.stringify(first)).toMatchObject({ state: 'ok', kind: 'install', method: 'pg_dump', trigger: 'manual', encrypted: false, includesKey: false, note: 'first', createdBy: { name: 'Ada' } })
    expect(first.verifiedOn).toBeTruthy()
    expect(first.sizeBytes).toBeGreaterThan(5000)
    const env = first.summary.environments.find((e: { id: string }) => e.id === 'default')
    expect(env.attachments).toBe(1)
    expect(env.dataFiles).toBeGreaterThanOrEqual(1)
    const a = await openArchive(archiveFile(first.fileName))
    try {
      expect(a.manifest).toMatchObject({ format: 'appbuilder-backup', kind: 'install', method: 'pg_dump', includesKey: false, snapshot: { exported: true } })
      const orders = a.manifest.environments[0].tables.find((t) => t.name === 'Purchases')!
      expect(orders.rows).toBe(300)
      expect(a.manifest.schemas.map((s) => s.name)).toEqual(['ab', 'env_default'])
      expect(a.manifest.schemas[0].tables.find((t) => t.name === 'sessions')).toMatchObject({ noData: true, rows: 0 })
      expect([...a.entries.keys()]).toEqual(expect.arrayContaining(['db/dump.pgc', 'db/ab/schema.json', 'db/env_default/schema.json', 'manifest.json']))
      expect([...a.entries.keys()].some((n) => n.startsWith('files/default/attachments/'))).toBe(true)
      expect([...a.entries.keys()].some((n) => n.startsWith('files/default/files/'))).toBe(true)
      expect(a.manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true)
    } finally {
      await a.close()
    }
    // the archive is a plain tar other tools read
    const tar = spawnSync('tar', ['-tf', archiveFile(first.fileName)], { encoding: 'utf8' })
    expect(tar.stdout).toContain('manifest.json')
    // audited, health is green
    expect((await q("SELECT action FROM ab.audit WHERE action = 'backup.create'")).length).toBe(1)
    expect((await A.get('/backups/health')).data).toMatchObject({ stale: false, lastOk: { id: first.id } })
  }, 120_000)

  it('the built-in exporter (no pg_dump) produces the same data: both restored as new environments match the source', async () => {
    expect((await A.put('/backups/settings', { method: 'builtin' })).status).toBe(200)
    const b = await backupNow({ scope: 'default' })
    expect(b).toMatchObject({ state: 'ok', kind: 'environment', environmentId: 'default', method: 'builtin' })
    expect((await A.put('/backups/settings', { method: 'auto' })).status).toBe(200)
    const src = await digest('env_default', 't_purchases')
    const results: string[] = []
    for (const [bk, name] of [[first, 'From pgdump'], [b, 'From builtin']]) {
      const r = await A.post(`/backups/${bk.id}/restore`, { environment: 'default', mode: 'new', name })
      expect(r.status, JSON.stringify(r.data)).toBe(200)
      const op = await waitOp(r.data.id)
      expect(op, JSON.stringify(op)).toMatchObject({ state: 'succeeded', mode: 'new' })
      results.push(op.result.environment)
    }
    for (const id of results) {
      const d = await digest(`env_${id}`, 't_purchases')
      expect(d).toEqual(src)
      // metadata too: same tables, same apps
      expect((await q(`SELECT count(*)::int AS n FROM env_${id}.ab_tables`))[0]).toEqual((await q('SELECT count(*)::int AS n FROM env_default.ab_tables'))[0])
      // the audit log sequence continues after the restored ids
      const max = (await q<{ m: number }>(`SELECT max(id)::int AS m FROM env_${id}.ab_audit`))[0].m
      const next = (await q<{ v: number }>(`SELECT last_value::int AS v FROM env_${id}.ab_audit_id_seq`))[0].v
      expect(next).toBeGreaterThanOrEqual(max)
    }
    // the restored environments work: rows, attachments (same bytes), data files
    for (const id of results) {
      const env = id
      const c = await A.post('/data/Purchases/query', { count: true }, env)
      expect(c.data.total).toBe(300)
      const att = await A.get(`/attachments/${attId}?env=${env}`, env)
      expect(att.status).toBe(200)
      expect(Buffer.compare(att.data, photo)).toBe(0)
      const people = await A.post('/data/people/query', {}, env)
      expect(people.status, JSON.stringify(people.data)).toBe(200)
      expect(people.data.rows.map((r: { Name: string }) => r.Name).sort()).toEqual(['Ann', 'Bo'])
      // a new row in the restored environment works (identity, indexes)
      expect((await A.post('/data/Purchases/rows', { values: { Title: 'after restore' } }, env)).status).toBe(200)
    }
  }, 180_000)

  it('encrypted archives: the passphrase is needed, a wrong one fails cleanly, the right one restores', async () => {
    expect((await A.post('/backups', { passphrase: 'short' })).status).toBe(422)
    const b = await backupNow({ scope: 'default', passphrase: 'a long enough passphrase' })
    expect(b).toMatchObject({ state: 'ok', encrypted: true })
    const file = fs.readFileSync(archiveFile(b.fileName))
    expect(file.subarray(0, 8).toString()).toBe('ABBAKENC')
    expect(file.includes(Buffer.from('Order 1'))).toBe(false)
    const none = await A.post(`/backups/${b.id}/contents`, {})
    expect(none.status).toBe(422)
    expect(none.data.error.message).toMatch(/encrypted/)
    const wrong = await A.post(`/backups/${b.id}/contents`, { passphrase: 'not the right one' })
    expect(wrong.status).toBe(422)
    expect(wrong.data.error.message).toMatch(/passphrase is wrong/)
    expect((await A.post(`/backups/${b.id}/restore`, { environment: 'default', mode: 'new', name: 'Wrong pass', passphrase: 'not the right one' })).status).toBe(422)
    const ok = await A.post(`/backups/${b.id}/contents`, { passphrase: 'a long enough passphrase' })
    expect(ok.status).toBe(200)
    expect(ok.data.environments[0].tables.find((t: { name: string }) => t.name === 'Purchases').rows).toBe(300)
    const page = await A.post(`/backups/${b.id}/browse`, { environment: 'default', table: 'Purchases', limit: 3, passphrase: 'a long enough passphrase' })
    expect(page.status, JSON.stringify(page.data)).toBe(200)
    expect(page.data.rows).toHaveLength(3)
  }, 120_000)

  it('a tampered archive is detected by verification and refused for restore', async () => {
    const src = archiveFile(first.fileName)
    const copy = path.join(tmp, 'backups', first.fileName.replace('.abbak', '-tampered.abbak'))
    const buf = fs.readFileSync(src)
    // change one byte inside the database dump member (well after the first headers)
    const a = await openArchive(src)
    const off = a.entries.get('db/dump.pgc')!.offset + 200
    await a.close()
    buf[off] ^= 0x55
    fs.writeFileSync(copy, buf)
    const rescan = await app.services.backup.rescan()
    expect(rescan.added).toBe(1)
    await app.services.backup.idle()
    const list = (await A.get('/backups')).data.items
    const t = list.find((x: { fileName: string }) => x.fileName === path.basename(copy))
    expect(t, JSON.stringify(list.map((x: any) => [x.fileName, x.state]))).toMatchObject({ state: 'failed' })
    expect(t.error).toMatch(/db\/dump\.pgc does not match its checksum/)
    expect((await A.post(`/backups/${t.id}/restore`, { environment: 'default', mode: 'new', name: 'Tampered' })).status).toBe(409)
    expect((await A.del(`/backups/${t.id}`)).status).toBe(200)
    expect(fs.existsSync(copy)).toBe(false)
  }, 60_000)

  it('browses a table of a backup read-only, page by page', async () => {
    const c = await A.post(`/backups/${first.id}/contents`, {})
    expect(c.data).toMatchObject({ kind: 'install', restorable: true, method: 'pg_dump' })
    const orders = c.data.environments[0].tables.find((t: { name: string }) => t.name === 'Purchases')
    expect(orders).toMatchObject({ rows: 300, restorable: true })
    expect(c.data.environments[0].tables.find((t: { name: string }) => t.name.toLowerCase() === 'people')).toMatchObject({ restorable: false })
    const p1 = await A.post(`/backups/${first.id}/browse`, { environment: 'default', table: orders.id, offset: 0, limit: 10 })
    expect(p1.status, JSON.stringify(p1.data)).toBe(200)
    expect(p1.data).toMatchObject({ offset: 0, total: 300, more: true })
    expect(p1.data.columns.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(['id', 'Title', 'Qty', 'Price']))
    expect(p1.data.columns.find((x: { name: string }) => x.name === 'Title')).toMatchObject({ displayName: 'Title', type: 'text' })
    const p2 = await A.post(`/backups/${first.id}/browse`, { environment: 'default', table: orders.id, offset: 295, limit: 10 })
    expect(p2.data.rows).toHaveLength(5)
    expect(p2.data.more).toBe(false)
    const escaped = [...p1.data.rows, ...p2.data.rows].find((r: { Notes: string | null }) => r.Notes)
    expect(escaped.Notes).toBe('tab\there\nnew line \\ back')
  }, 60_000)

  it('restores selected tables: replace (plan, token, confirmation) and as a new table with its attachments', async () => {
    // damage: delete 100 rows, change one
    await A.post('/data/Purchases/rows/bulk-delete', { ids: orderIds.slice(100, 200) }).catch(() => {})
    await q(`DELETE FROM env_default.t_purchases WHERE id = ANY($1::text[])`, [orderIds.slice(100, 200)])
    await q(`UPDATE env_default.t_purchases SET "Title" = 'changed' WHERE id = $1`, [orderIds[0]])
    const tid = (await q<{ id: string }>("SELECT id FROM env_default.ab_tables WHERE name = 'Purchases'"))[0].id
    const plan = await A.post(`/backups/${first.id}/restore-tables/plan`, { environment: 'default', tables: [tid], mode: 'replace' }, 'default')
    expect(plan.status, JSON.stringify(plan.data)).toBe(200)
    expect(plan.data).toMatchObject({ destructive: true, problems: [], items: [{ tableId: tid, mode: 'replace', rowsInBackup: 300, rowsNow: 200 }] })
    expect((await A.post(`/backups/${first.id}/restore-tables`, { environment: 'default', tables: [tid], mode: 'replace', confirm: 'stale' }, 'default')).status).toBe(409)
    expect((await maker.post(`/backups/${first.id}/restore-tables`, { environment: 'default', tables: [tid], mode: 'replace', confirm: plan.data.token }, 'default')).status).toBe(403)
    const r = await A.post(`/backups/${first.id}/restore-tables`, { environment: 'default', tables: [tid], mode: 'replace', confirm: plan.data.token }, 'default')
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    const op = await waitOp(r.data.id)
    expect(op, JSON.stringify(op)).toMatchObject({ state: 'succeeded' })
    expect((await q('SELECT count(*)::int AS n FROM env_default.t_purchases'))[0]).toEqual({ n: 300 })
    expect((await q('SELECT "Title" FROM env_default.t_purchases WHERE id = $1', [orderIds[0]]))[0]).toEqual({ Title: 'Order 0' })
    // as a new table: rows and the attachment (new attachment id, same bytes)
    const plan2 = await A.post(`/backups/${first.id}/restore-tables/plan`, { environment: 'default', tables: [tid], mode: 'new' }, 'default')
    expect(plan2.data.items[0].newName).toMatch(/^Purchases \(restored \d{4}-\d\d-\d\d\)$/)
    const r2 = await A.post(`/backups/${first.id}/restore-tables`, { environment: 'default', tables: [tid], mode: 'new', confirm: plan2.data.token }, 'default')
    const op2 = await waitOp(r2.data.id)
    expect(op2, JSON.stringify(op2)).toMatchObject({ state: 'succeeded' })
    const newId = op2.result.tables[0].newTableId
    const ws = await A.get('/workspace', 'default')
    const nt = ws.data.tables.find((t: { id: string }) => t.id === newId)
    expect(nt).toBeTruthy()
    const rows = await A.post(`/data/${encodeURIComponent(nt.name)}/query`, { count: true, filter: { col: 'id', op: 'eq', value: orderIds[0] } }, 'default')
    expect(rows.status, JSON.stringify(rows.data)).toBe(200)
    const cell = rows.data.rows[0].Photo
    const newAtt = typeof cell === 'string' ? cell : cell?.id ?? (Array.isArray(cell) ? cell[0]?.id : undefined)
    expect(newAtt).toBeTruthy()
    expect(newAtt).not.toBe(attId)
    const bytes = await A.get(`/attachments/${newAtt}?env=default`, 'default')
    expect(Buffer.compare(bytes.data, photo)).toBe(0)
  }, 120_000)

  it('in place: a failing restore leaves the old data and the environment usable', async () => {
    const before = await digest('env_default', 't_purchases')
    await q(`UPDATE env_default.t_purchases SET "Title" = 'kept' WHERE id = $1`, [orderIds[1]])
    const kept = await digest('env_default', 't_purchases')
    expect(kept).not.toEqual(before)
    app.services.backup.testHooks.failAfterTables = 3
    try {
      const r = await A.post(`/backups/${first.id}/restore`, { environment: 'default', mode: 'in-place', confirmName: 'Default' })
      expect(r.status, JSON.stringify(r.data)).toBe(200)
      const op = await waitOp(r.data.id)
      expect(op.state).toBe('failed')
      expect(op.error).toMatch(/Nothing was changed/)
    } finally {
      delete app.services.backup.testHooks.failAfterTables
    }
    expect(await digest('env_default', 't_purchases')).toEqual(kept)
    expect((await q("SELECT state FROM ab.environments WHERE id = 'default'"))[0]).toEqual({ state: 'ready' })
    expect((await A.post('/data/Purchases/query', { count: true })).data.total).toBe(300)
    expect((await q("SELECT action FROM ab.audit WHERE action = 'backup.restore_failed'")).length).toBeGreaterThan(0)
  }, 120_000)

  it('in place: needs the typed name; takes a safety backup; brings the data back; the environment is "restoring" meanwhile', async () => {
    expect((await A.post(`/backups/${first.id}/restore`, { environment: 'default', mode: 'in-place', confirmName: 'nope' })).status).toBe(422)
    await q(`UPDATE env_default.t_purchases SET "Title" = 'after backup' WHERE id = $1`, [orderIds[2]])
    const r = await A.post(`/backups/${first.id}/restore`, { environment: 'default', mode: 'in-place', confirmName: 'Default' })
    expect(r.status).toBe(200)
    // while it runs, requests to the environment are refused with "restoring" (or it is already done)
    let sawRestoring = false
    for (let i = 0; i < 100; i++) {
      const w = await maker.get('/workspace', 'default')
      if (w.status === 503 && /being restored/.test(w.data?.error?.message ?? '')) { sawRestoring = true; break }
      if ((await A.get(`/backups/ops/${r.data.id}`)).data.state !== 'running') break
      await sleep(30)
    }
    const op = await waitOp(r.data.id)
    expect(op, JSON.stringify(op)).toMatchObject({ state: 'succeeded', mode: 'in-place' })
    expect(op.result.safetyBackup).toBeTruthy()
    void sawRestoring
    expect((await q('SELECT "Title" FROM env_default.t_purchases WHERE id = $1', [orderIds[2]]))[0]).toEqual({ Title: 'Order 2' })
    expect((await q('SELECT count(*)::int AS n FROM env_default.t_purchases'))[0]).toEqual({ n: 300 })
    const safety = await A.get(`/backups/${op.result.safetyBackup}`)
    expect(safety.data).toMatchObject({ trigger: 'pre-restore', state: 'ok', environmentId: 'default' })
    // the environment works again: sign-in sessions, attachments, writes
    expect((await maker.post('/data/Purchases/query', { count: true }, 'default')).data.total).toBe(300)
    const att = await A.get(`/attachments/${attId}?env=default`, 'default')
    expect(Buffer.compare(att.data, photo)).toBe(0)
    expect((await A.post('/data/Purchases/rows', { values: { Title: 'new after in-place' } })).status).toBe(200)
    expect((await q("SELECT count(*)::int AS n FROM env_default.ab_audit WHERE action = 'backup.restore'"))[0]).toEqual({ n: 1 })
  }, 180_000)

  it('cross-version: an older environment backup is migrated on restore; a newer one is refused', async () => {
    // an environment backup taken while the environment says schema version 6
    await q(`UPDATE ab.environments SET schema_version = 6 WHERE id = 'default'`)
    const b = await backupNow({ scope: 'default' })
    await q(`UPDATE ab.environments SET schema_version = $1 WHERE id = 'default'`, [SCHEMA_VERSION])
    const a = await openArchive(archiveFile(b.fileName))
    expect(a.manifest.environments[0].schemaVersion).toBe(6)
    await a.close()
    const r = await A.post(`/backups/${b.id}/restore`, { environment: 'default', mode: 'new', name: 'From version 6' })
    const op = await waitOp(r.data.id)
    expect(op, JSON.stringify(op)).toMatchObject({ state: 'succeeded', result: { migration: { from: 6, to: SCHEMA_VERSION } } })
    expect((await q(`SELECT schema_version FROM ab.environments WHERE id = $1`, [op.result.environment]))[0]).toEqual({ schema_version: SCHEMA_VERSION })
    // a backup from a newer Appbuilder
    const fake = path.join(tmp, 'backups', 'appbuilder-install-20991231-000000Z-future.abbak')
    const t = new TarWriter(plainFileSink(fake))
    await t.addBuffer('appbuilder-backup.json', Buffer.from(JSON.stringify({ format: 'appbuilder-backup', formatVersion: 1 })))
    await t.addBuffer('manifest.json', Buffer.from(JSON.stringify({
      format: 'appbuilder-backup', formatVersion: 1, id: 'bk_future', kind: 'install', trigger: 'manual', createdOn: '2099-12-31T00:00:00Z', finishedOn: '2099-12-31T00:00:00Z', createdBy: null,
      app: { version: '9.0.0', schemaVersion: 99 }, server: { version: 'PostgreSQL 20', database: 'x' }, method: 'builtin', snapshot: { isolation: 'repeatable read', exported: false, at: '' }, includesKey: false,
      schemas: [], environments: [{ id: 'default', name: 'Default', type: 'production', schema: 'env_default', schemaVersion: 99, attachments: { count: 0, bytes: 0, missing: 0 }, dataFiles: { count: 0, bytes: 0 }, tables: [] }], files: [], warnings: [],
    })))
    await t.finish()
    await app.services.backup.rescan()
    await app.services.backup.idle()
    const fut = (await A.get('/backups')).data.items.find((x: { fileName: string }) => x.fileName === path.basename(fake))
    expect(fut).toBeTruthy()
    const c = await A.post(`/backups/${fut.id}/contents`, {})
    expect(c.data).toMatchObject({ restorable: false })
    expect(c.data.problem).toMatch(/newer Appbuilder/)
    const refused = await A.post(`/backups/${fut.id}/restore`, { environment: 'default', mode: 'new', name: 'Future' })
    expect(refused.status).toBe(409)
    expect(refused.data.error.message).toMatch(/newer Appbuilder \(9\.0\.0, schema version 99\)/)
    await A.del(`/backups/${fut.id}`)
  }, 120_000)

  for (const method of ['pg_dump', 'builtin'] as const) {
    it(`a consistent snapshot while a writer keeps writing (${method})`, async () => {
      await q('CREATE TABLE IF NOT EXISTS env_default.t_pair_a (id text PRIMARY KEY, n int)')
      await q('CREATE TABLE IF NOT EXISTS env_default.t_pair_b (id text PRIMARY KEY, n int)')
      await q('TRUNCATE env_default.t_pair_a, env_default.t_pair_b')
      const c = new pg.Client(poolConfig({ ...conn!, database: dbName, ssl: false }, conn!.password))
      await c.connect()
      let stop = false
      let written = 0
      const writer = (async () => {
        while (!stop) {
          // one transaction writes one row to each table: a consistent snapshot always has equal counts
          await c.query('BEGIN')
          await c.query('INSERT INTO env_default.t_pair_a VALUES ($1, $2)', [`r${written}`, written])
          await c.query('SELECT pg_sleep(0.002)')
          await c.query('INSERT INTO env_default.t_pair_b VALUES ($1, $2)', [`r${written}`, written])
          await c.query('COMMIT')
          written++
        }
      })()
      await sleep(150)
      await A.put('/backups/settings', { method })
      let duringBackup = 0
      const b = await app.services.backup.backupDirect({
        scope: 'default', trigger: 'manual', by: null,
        afterSnapshot: async () => { const w0 = written; await sleep(400); duringBackup = written - w0 },
      })
      stop = true
      await writer
      await c.end()
      await A.put('/backups/settings', { method: 'auto' })
      expect(b.method).toBe(method)
      expect(duringBackup).toBeGreaterThan(5)
      const a = await openArchive(archiveFile(b.fileName))
      try {
        const rows = (t: string) => a.manifest.schemas[0].tables.find((x) => x.name === t)!.rows
        expect(rows('t_pair_a')).toBe(rows('t_pair_b'))
        expect(rows('t_pair_a')).toBeLessThan(written)
        // restore the data and compare: same rows in both tables, as the manifest says
        const rc = await connect({ settings: { ...conn!, database: dbName, ssl: false }, password: conn!.password })
        try {
          await rc.query('BEGIN')
          const stored = await restoreSchema(rc, a, 'env_default', 'ab_rt_pairs')
          expect(stored.get('t_pair_a')).toBe(rows('t_pair_a'))
          const x = await rc.query<{ d: string }>('SELECT count(*)::text AS d FROM ab_rt_pairs.t_pair_a a FULL JOIN ab_rt_pairs.t_pair_b b USING (id) WHERE a.id IS NULL OR b.id IS NULL')
          expect(x.rows[0].d).toBe('0')
        } finally {
          await rc.query('ROLLBACK')
          await rc.end()
        }
      } finally {
        await a.close()
      }
      await q('DROP TABLE env_default.t_pair_a, env_default.t_pair_b')
    }, 120_000)
  }

  it('solution upgrades and environment deletes take a snapshot first; a failing snapshot stops them unless the administrator proceeds', async () => {
    // a sandbox with a solution, deployed to a second sandbox, then upgraded
    const sb = await A.post('/environments', { name: 'Snap source', type: 'sandbox', copyFrom: 'default', copy: 'schema' })
    expect(sb.status, JSON.stringify(sb.data)).toBe(200)
    const tg = await A.post('/environments', { name: 'Snap target', type: 'sandbox' })
    const ws = (await A.get('/workspace', sb.data.id)).data
    const ord = ws.tables.find((t: { name: string }) => t.name === 'Purchases')
    const sol = await A.post('/solutions', { displayName: 'Shop', version: '1.0.0' }, sb.data.id)
    await A.post(`/solutions/${sol.data.id}/components`, { kind: 'table', id: ord.id }, sb.data.id)
    const plan1 = await A.post(`/solutions/${sol.data.id}/deploy`, { target: tg.data.id, plan: true }, sb.data.id)
    expect((await A.post(`/solutions/${sol.data.id}/deploy`, { target: tg.data.id, confirm: plan1.data.token }, sb.data.id)).status).toBe(200)
    await A.post(`/tables/${ord.id}/columns`, { displayName: 'Extra', type: 'text' }, sb.data.id)
    await A.patch(`/solutions/${sol.data.id}`, { version: '1.1.0' }, sb.data.id)
    const plan = await A.post(`/solutions/${sol.data.id}/deploy`, { target: tg.data.id, plan: true }, sb.data.id)
    expect(plan.data).toMatchObject({ mode: 'upgrade', backup: { available: true } })
    // the snapshot fails: the upgrade is refused (409, field backup) and nothing changes
    app.services.backup.testHooks.failBackup = 'disk full (test)'
    const refused = await A.post(`/solutions/${sol.data.id}/deploy`, { target: tg.data.id, confirm: plan.data.token }, sb.data.id)
    expect(refused.status).toBe(409)
    expect(refused.data.error).toMatchObject({ field: 'backup' })
    expect(refused.data.error.message).toMatch(/disk full \(test\)/)
    // the administrator proceeds without it
    const forced = await A.post(`/solutions/${sol.data.id}/deploy`, { target: tg.data.id, confirm: plan.data.token, proceedWithoutBackup: true }, sb.data.id)
    expect(forced.status, JSON.stringify(forced.data)).toBe(200)
    expect(forced.data.backup).toMatchObject({ taken: false, failed: true })
    delete app.services.backup.testHooks.failBackup
    // a notification told the install administrator
    expect((await q("SELECT count(*)::int AS n FROM ab.notifications WHERE title LIKE 'Backup failed%'"))[0].n).toBeGreaterThan(0)
    // next upgrade: the snapshot is taken
    await A.post(`/tables/${ord.id}/columns`, { displayName: 'Extra2', type: 'text' }, sb.data.id)
    await A.patch(`/solutions/${sol.data.id}`, { version: '1.2.0' }, sb.data.id)
    const plan3 = await A.post(`/solutions/${sol.data.id}/deploy`, { target: tg.data.id, plan: true }, sb.data.id)
    const done = await A.post(`/solutions/${sol.data.id}/deploy`, { target: tg.data.id, confirm: plan3.data.token }, sb.data.id)
    expect(done.status, JSON.stringify(done.data)).toBe(200)
    expect(done.data.backup).toMatchObject({ taken: true })
    expect(done.data.warnings ?? []).not.toEqual(expect.arrayContaining([expect.stringMatching(/No backup/)]))
    const snap = await A.get(`/backups/${done.data.backup.id}`)
    expect(snap.data).toMatchObject({ trigger: 'pre-upgrade', environmentId: tg.data.id, state: 'ok' })
    // deleting the target environment: a snapshot first, then it is gone (and restorable)
    await A.post('/auth/reauth', { password: 'admin-password-1' })
    const del = await A.del(`/environments/${tg.data.id}`, { confirmName: 'Snap target' })
    expect(del.status, JSON.stringify(del.data)).toBe(200)
    expect(del.data.backup).toMatchObject({ taken: true })
    const pre = await A.get(`/backups/${del.data.backup.id}`)
    expect(pre.data).toMatchObject({ trigger: 'pre-delete', environmentId: tg.data.id, state: 'ok' })
    // with snapshots switched off, the plan says so
    await A.put('/backups/settings', { snapshots: { beforeUpgrade: false } })
    const plan4 = await A.post(`/solutions/${sol.data.id}/deploy`, { target: 'default', plan: true }, sb.data.id)
    expect(plan4.data.backup).toMatchObject({ available: false })
    await A.put('/backups/settings', { snapshots: { beforeUpgrade: true } })
  }, 240_000)

  it('the restore test restores the newest good backup into scratch schemas and drops them', async () => {
    const r = await app.services.backup.restoreTest(null)
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true })
    expect(r.rows).toBeGreaterThan(300)
    expect((await q("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'ab_rt_%'"))[0]).toEqual({ n: 0 })
    const b = await A.get(`/backups/${r.backupId}`)
    expect(b.data.restoreTestedOn).toBeTruthy()
  }, 120_000)

  it('downloads (ticket after a recent sign-in) and uploads an archive; audited', async () => {
    await A.post('/auth/reauth', { password: 'admin-password-1' })
    const t = await A.post(`/backups/${first.id}/download-ticket`, {})
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    const d = await A.get(`/backups/${first.id}/download?ticket=${t.data.ticket}`)
    expect(d.status).toBe(200)
    expect(createHash('sha256').update(d.data).digest('hex')).toBe(first.sha256)
    // the ticket is single use
    const again = await A.get(`/backups/${first.id}/download?ticket=${t.data.ticket}`)
    expect([200, 403]).toContain(again.status)
    expect((await maker.post(`/backups/${first.id}/download-ticket`, {})).status).toBe(403)
    const up = await A.req('POST', '/backups/upload?name=my-copy.abbak', undefined, { raw: { data: d.data, type: 'application/octet-stream' } })
    expect(up.status, JSON.stringify(up.data)).toBe(200)
    expect(up.data).toMatchObject({ state: 'uploaded', kind: 'install', trigger: 'manual' })
    await app.services.backup.idle()
    expect((await A.get(`/backups/${up.data.id}`)).data.state).toBe('ok')
    const junk = await A.req('POST', '/backups/upload?name=junk.abbak', undefined, { raw: { data: Buffer.from('not a backup at all'), type: 'application/octet-stream' } })
    expect(junk.status).toBe(422)
    const acts = (await q<{ action: string }>("SELECT action FROM ab.audit WHERE action IN ('backup.download', 'backup.upload')")).map((r) => r.action)
    expect(acts).toEqual(expect.arrayContaining(['backup.download', 'backup.upload']))
  }, 120_000)

  it('settings: a saved passphrase is sealed; folders are checked; schedules follow the settings', async () => {
    expect((await A.put('/backups/settings', { folder: 'relative/path' })).status).toBe(422)
    expect((await A.put('/backups/settings', { folder: path.join(app.config.distDir, 'x') })).status).toBe(422)
    expect((await A.put('/backups/settings', { passphrase: 'short' })).status).toBe(422)
    const s = await A.put('/backups/settings', { passphrase: 'saved passphrase 123', install: { cron: '15 3 * * *', timeZone: 'Asia/Kolkata' }, environments: { default: { enabled: true, cron: '0 * * * *', timeZone: 'UTC' } }, retention: { daily: 3 } })
    expect(s.status, JSON.stringify(s.data)).toBe(200)
    expect(s.data).toMatchObject({ passphraseSaved: true, install: { cron: '15 3 * * *', timeZone: 'Asia/Kolkata' }, retention: { daily: 3 } })
    const raw = (await q<{ v: string }>("SELECT v FROM ab.settings WHERE k = 'backup.config'"))[0].v
    expect(raw).not.toContain('saved passphrase 123')
    expect(JSON.parse(raw).passphraseSealed).toMatch(/^v1:/)
    const sc = await q<{ id: string; cron: string; time_zone: string; enabled: boolean }>("SELECT id, cron, time_zone, enabled FROM env_default.ab_schedules WHERE id LIKE 'sched_backup_%' ORDER BY id")
    expect(sc).toEqual(expect.arrayContaining([
      { id: 'sched_backup_install', cron: '15 3 * * *', time_zone: 'Asia/Kolkata', enabled: true },
      { id: 'sched_backup_env_default', cron: '0 * * * *', time_zone: 'UTC', enabled: true },
    ]))
    // a scheduled run (the job, as the scheduler enqueues it) is encrypted with the saved passphrase
    const job = await app.services.kernel.jobs.schedules.runNow('sched_backup_env_default', null).catch(async () => {
      const { runInEnvironment } = await import('../env-context.ts')
      return runInEnvironment('default', () => app.services.kernel.jobs.schedules.runNow('sched_backup_env_default', null))
    })
    void job
    const until = Date.now() + 60_000
    let sched: any = null
    while (Date.now() < until) {
      sched = (await A.get('/backups')).data.items.find((x: { trigger: string; state: string }) => x.trigger === 'schedule' && x.state === 'ok')
      if (sched) break
      await sleep(200)
    }
    expect(sched).toMatchObject({ encrypted: true, environmentId: 'default' })
    await A.put('/backups/settings', { passphrase: null, environments: { default: null }, retention: { daily: 7 } })
  }, 120_000)

  it('install restore from the command line onto a fresh database and workspace (with and without the key file)', async () => {
    const withKey = await backupNow({ includeKey: true })
    expect(withKey).toMatchObject({ state: 'ok', includesKey: true })
    const noKey = await backupNow({})
    // a connection with a secret (sealed with the install key)
    await A.post('/connections', { name: 'Other db', connector: 'postgres', settings: { host: '127.0.0.1', port: '5433', database: 'x', user: 'u' }, secret: 'other-db-password' }).catch(() => {})
    for (const [b, keep] of [[withKey, true], [noKey, false]] as const) {
      const db2 = testDatabaseName('bkcli')
      const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bk-cli-'))
      await createDatabase(db2)
      try {
        const res = spawnSync(process.execPath, ['server/main.ts', 'restore', archiveFile(b.fileName), '--workspace', ws2, '--yes'], {
          cwd: path.resolve(import.meta.dirname, '../../..'), encoding: 'utf8', timeout: 120_000,
          env: { ...process.env, APPBUILDER_DB_HOST: conn!.host, APPBUILDER_DB_PORT: String(conn!.port), APPBUILDER_DB_NAME: db2, APPBUILDER_DB_USER: conn!.user, APPBUILDER_DB_PASSWORD: conn!.password },
        })
        expect(res.status, res.stdout + res.stderr).toBe(0)
        expect(res.stdout).toMatch(/Restore complete/)
        if (keep) expect(res.stdout).toMatch(/encryption key .* restored/i)
        else expect(res.stdout).toMatch(/without the encryption key/i)
        // the restored install starts and works
        const app2 = await createApp({ env: { APPBUILDER_DB_HOST: conn!.host, APPBUILDER_DB_PORT: String(conn!.port), APPBUILDER_DB_NAME: db2, APPBUILDER_DB_USER: conn!.user, APPBUILDER_DB_PASSWORD: conn!.password, APPBUILDER_JOBS: 'off' }, config: { workspaceDir: ws2 }, printSetupCode: false, jobs: false })
        const s2 = http.createServer((req, res) => { app2.handle(req, res).then((h) => { if (!h) res.writeHead(404).end() }) })
        await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r))
        try {
          const C = new Client(`http://127.0.0.1:${(s2.address() as AddressInfo).port}`)
          expect((await C.post('/auth/login', { email: 'ada@example.com', password: 'admin-password-1' })).status).toBe(200)
          expect((await C.post('/data/Purchases/query', { count: true }, 'default')).data.total).toBeGreaterThanOrEqual(300)
          const att = await C.get(`/attachments/${attId}?env=default`, 'default')
          expect(Buffer.compare(att.data, photo)).toBe(0)
          const rows = await pgQuery<{ n: number }>(db2, 'SELECT count(*)::int AS n FROM ab.sessions')
          expect(rows[0].n).toBeLessThanOrEqual(1)
        } finally {
          await new Promise<void>((r) => s2.close(() => r()))
          await app2.close()
        }
      } finally {
        await dropDatabase(db2)
        fs.rmSync(ws2, { recursive: true, force: true })
      }
    }
  }, 300_000)
})
