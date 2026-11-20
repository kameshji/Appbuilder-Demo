/**
 * The licence client and seat passes inside a real install (H-G, H-H), against the sandbox PostgreSQL, with the real
 * licence service in process (its own database) and an injected install clock:
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/licence
 * Licensed -> service down (warning naming the time, writable) -> past 72 h read-only (licence_read_only; export and
 * sign-in work) -> clock back stays read-only -> service back writable; suspended -> read-only with that reason; seat
 * counts reach the service; Operator passes refused from the Studio routes; over-seat warnings and the 14-day block
 * on new assignments; nobody is locked out.
 */
import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG, createDatabase, dropDatabase, pgQuery, pgServer, testDatabaseName } from '../testdb.ts'
import { Client, startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { setQuiet } from '../util.ts'
import { LICENCE_READ_ONLY_CODE, READ_ONLY_CODE, readOnlyGateFor } from '../hosting/read-only.ts'
import { GRACE_MS, generateLicenceKey, loadSigningKey } from './answer.ts'
import { OVER_SEAT_GRACE_MS } from './client.ts'
import { licenceFor, startLicence } from './index.ts'
import { runLicenceCli } from '../../licence-service/cli.ts'
import { createHandler, listen } from '../../licence-service/service.ts'
import { openDb } from '../../licence-service/store.ts'
import type { PgDb } from '../../connectors/postgres/db.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[server/core/licence integration] ${SKIP_PG}\n`)

const PASS = 'test-passphrase-only'
const H = 3600_000

describe.skipIf(!PG_URL)('licence client and seat passes in an install (H-G, H-H, PostgreSQL)', () => {
  let h: KernelHarness
  let svcDbName = ''
  let svcEnv: NodeJS.ProcessEnv = {}
  let svcDb: PgDb
  let server: http.Server | null = null
  let port = 0
  let tableId = ''
  let licId = ''
  let key = ''
  let now = Date.now()
  const clock = () => now
  const k = generateLicenceKey(PASS)
  const out: string[] = []
  const cli = async (...argv: string[]) => {
    out.length = 0
    const code = await runLicenceCli(argv, svcEnv, { out: (s) => { out.push(s) }, err: (s) => { out.push(s) } })
    expect(code, out.join('\n')).toBe(0)
    return out.join('\n')
  }
  const startService = async () => {
    server = await listen(createHandler({ db: svcDb, key: loadSigningKey(k.privatePem, PASS) }), { host: '127.0.0.1', port })
    port = (server.address() as AddressInfo).port
  }
  const stopService = async () => {
    const s = server
    server = null
    await new Promise<void>((r) => {
      if (!s) return r()
      s.close(() => r())
      s.closeAllConnections()
    })
  }
  const installEnv = () => ({ APPBUILDER_LICENCE_URL: `http://127.0.0.1:${port}`, APPBUILDER_LICENCE_ID: licId, APPBUILDER_LICENCE_KEY: key, APPBUILDER_LICENCE_PUBLIC_KEY: k.publicPem })
  const lic = () => licenceFor(h.app.services)!
  const write = () => h.admin.post(`/data/${tableId}/rows`, { values: { Title: 'x' } })
  let mo: Client
  let moId = ''

  beforeAll(async () => {
    h = await startHarness('lic')
    svcDbName = testDatabaseName('licsvc2')
    await createDatabase(svcDbName)
    const c = pgServer!
    svcEnv = { APPBUILDER_LICENCE_DB_URL: `postgres://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${svcDbName}` }
    await cli('migrate')
    svcDb = openDb(svcEnv)
    licId = /licence id (lic_[a-z0-9]+)/.exec(await cli('org', 'create', '--name', 'Install Test', '--full', '2', '--operator', '1'))![1]
    key = /^(abl_\S+)$/m.exec(await cli('key', 'issue', licId))![1]
    await startService()
    const t = await h.admin.post('/tables', { displayName: 'Lic items', name: 'LicItems', columns: [{ displayName: 'Title', type: 'text' }] })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    tableId = t.data.id
    const u = await h.admin.post('/users', { name: 'Mo Maker', email: 'mo@example.com', roleIds: ['role_maker'], password: 'maker-password-1' })
    expect(u.status, JSON.stringify(u.data)).toBe(200)
    moId = u.data.id
    await h.app.services.meta.users.update(moId, { mustChangePassword: false })
    mo = new Client(h.base)
    expect((await mo.post('/auth/login', { email: 'mo@example.com', password: 'maker-password-1' })).status).toBe(200)
    startLicence(h.app.services, { env: installEnv(), clock })
  }, 120_000)

  afterAll(async () => {
    await stopService()
    await svcDb?.close()
    await h?.close()
    if (svcDbName) await dropDatabase(svcDbName)
  }, 120_000)

  it('licensed: writable, seat counts reported, state shown to administrators', async () => {
    const v = await lic().check()
    expect(v.mode, JSON.stringify(v)).toBe('ok')
    expect((await write()).status).toBe(200)
    const st = await h.admin.get('/install/licence')
    expect(st.status).toBe(200)
    expect(st.data.licence).toMatchObject({ configured: true, mode: 'ok', keySource: 'setting', licence: { licenceId: licId, status: 'active', seats: { full: 2, operator: 1, external: 0 } } })
    expect(st.data.seats.inUse).toEqual({ full: 2, operator: 0, external: 0 })
    const rows = await pgQuery<{ seats: unknown; install_id: string }>(svcDbName, `SELECT seats, install_id FROM lic.checkins WHERE org_id = $1 ORDER BY id DESC LIMIT 1`, [licId])
    expect(rows[0].seats).toEqual({ full: 2, operator: 0, external: 0 })
    // the install id is stored with the answer in ab.licence; no person goes to the service
    const doc = await h.q<{ document: { installId: string } }>(`SELECT document FROM "ab"."licence" WHERE id = 1`)
    expect(doc[0].document.installId).toBe(rows[0].install_id)
    // only administrators see it
    expect((await mo.get('/install/licence')).status).toBe(403)
  })

  it('service unreachable: warning with the exact time, writable; past 72 h read-only (export and sign-in work); clock back stays read-only; service back writable at once', async () => {
    const last = Date.parse(lic().view().licence!.receivedAt)
    await stopService()
    now = last + 2 * H
    let v = await lic().check()
    expect(v.mode).toBe('warning')
    expect(v.readOnlyAt).toBe(new Date(last + GRACE_MS).toISOString())
    expect((await h.admin.get('/install/licence')).data.licence.warnings.join(' ')).toContain(new Date(last + GRACE_MS).toISOString().slice(0, 16).replace('T', ' '))
    expect((await write()).status).toBe(200)
    // an in-app notification to the install administrator names the time
    const n = await h.q<{ title: string }>(`SELECT title FROM "ab"."notifications" WHERE title LIKE 'Licence:%'`)
    expect(n.length).toBe(1)

    now = last + GRACE_MS + 60_000
    await lic().tick()
    readOnlyGateFor(h.app.services).invalidate()
    const w = await write()
    expect(w.status).toBe(503)
    expect(w.data.error.code).toBe(LICENCE_READ_ONLY_CODE)
    expect(w.data.readOnly.reason).toBe('licence')
    // export and backups still work; sign-out and sign-in work
    expect((await h.admin.post('/admin/export-data/ticket', {})).status).toBe(200)
    expect((await mo.post('/auth/logout')).status).toBe(200)
    expect((await mo.post('/auth/login', { email: 'mo@example.com', password: 'maker-password-1' })).status).toBe(200)
    // "check now" is allowed while read-only (it fails: the service is still away)
    expect((await h.admin.post('/install/licence/check', {})).data.licence.mode).toBe('read-only')

    // the clock moved back into the window does not restore writing
    now = last + 10 * H
    v = await lic().tick()
    expect(v.mode).toBe('read-only')
    expect(v.clockBack).toBe(true)
    expect((await write()).status).toBe(503)

    // the service answers again: writable at once
    await startService()
    const back = await h.admin.post('/install/licence/check', {})
    expect(back.data.licence.mode).toBe('ok')
    expect((await write()).status).toBe(200)
  }, 30_000)

  it('suspended by the operator: read-only with the reason suspended (install_read_only), resumed: writable', async () => {
    await cli('suspend', licId, '--message', 'Pilot paused.')
    await lic().check()
    const w = await write()
    expect(w.status).toBe(503)
    expect(w.data.error.code).toBe(READ_ONLY_CODE)
    expect(w.data.readOnly.reason).toBe('suspended')
    expect(w.data.error.message).toContain('Pilot paused.')
    await cli('resume', licId)
    await lic().check()
    expect((await write()).status).toBe(200)
  })

  it('Operator pass: no Dev mode on the server (Studio, data model, flow designer), apps and data still work', async () => {
    const before = await mo.get('/auth/session')
    expect(before.data.privileges.isMaker).toBe(true)
    const r = await h.admin.req('PUT', '/install/licence/passes', { userIds: [moId], pass: 'operator' })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data.changed).toEqual([moId])
    await new Promise((res) => setTimeout(res, 0))
    const s = await mo.get('/auth/session')
    expect(s.data.privileges.isMaker).toBe(false)
    expect((await mo.post('/tables', { displayName: 'Nope', name: 'Nope', columns: [] })).status).toBe(403)
    expect((await mo.get('/flows')).status).toBe(403)
    expect((await mo.post('/apps', { name: 'Nope' })).status).toBe(403)
    // data with the roles' rights still works
    expect((await mo.post(`/data/${tableId}/rows`, { values: { Title: 'by an operator' } })).status).toBe(200)
    // the audit records it
    expect((await h.q(`SELECT 1 FROM "ab"."audit" WHERE action = 'licence.pass_assign'`)).length).toBe(1)
    // External is not assignable yet; only install administrators assign
    expect((await h.admin.req('PUT', '/install/licence/passes', { userIds: [moId], pass: 'external' })).status).toBe(400)
    expect((await mo.req('PUT', '/install/licence/passes', { userIds: [moId], pass: 'full' })).status).toBe(403)
    const list = await h.admin.get('/install/licence/passes')
    expect(list.data.passes[moId]).toBe('operator')
  })

  it('over the licensed seats: warnings, then after 14 days no NEW assignments of that pass; nobody is locked out', async () => {
    // the licence has 1 operator seat (Mo); a second operator puts it over
    const u = await h.admin.post('/users', { name: 'Op Two', email: 'op2@example.com', roleIds: [], password: 'operator-pass-12' })
    const u3 = await h.admin.post('/users', { name: 'Op Three', email: 'op3@example.com', roleIds: [], password: 'operator-pass-13' })
    expect((await h.admin.req('PUT', '/install/licence/passes', { userIds: [u.data.id], pass: 'operator' })).status).toBe(200)
    await lic().check()
    let st = (await h.admin.get('/install/licence')).data
    expect(st.seats.inUse.operator).toBe(2)
    expect(st.seats.over.operator).toMatchObject({ blocked: false, by: 1 })
    // the Full user seats are over too (2 licensed: Ada, Op Three... ) only when more than 2 hold it
    const t0 = Date.parse(st.seats.over.operator.since)
    now = t0 + OVER_SEAT_GRACE_MS + H
    await lic().check()
    st = (await h.admin.get('/install/licence')).data
    expect(st.seats.over.operator.blocked).toBe(true)
    const refused = await h.admin.req('PUT', '/install/licence/passes', { userIds: [u3.data.id], pass: 'operator' })
    expect(refused.status).toBe(409)
    expect(refused.data.error.message).toMatch(/no new Operator passes/)
    // people who hold the pass keep it and keep working
    expect((await mo.get('/auth/session')).status).toBe(200)
    expect((await mo.post(`/data/${tableId}/rows`, { values: { Title: 'still here' } })).status).toBe(200)
    // freeing a seat lifts the block at once
    expect((await h.admin.req('PUT', '/install/licence/passes', { userIds: [u.data.id], pass: 'full' })).status).toBe(200)
    st = (await h.admin.get('/install/licence')).data
    expect(st.seats.over.operator).toBeUndefined()
    const notes = await h.q<{ title: string }>(`SELECT title FROM "ab"."notifications" WHERE title LIKE '%Operator passes%'`)
    expect(notes.map((x) => x.title)).toEqual(expect.arrayContaining(['More Operator passes than licensed seats', 'New Operator passes are blocked']))
  })
})
