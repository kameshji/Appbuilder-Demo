/**
 * Phase 0 close (package M) against the sandbox PostgreSQL (APPBUILDER_TEST_DB): sign-in and email log retention, who
 * may create and change schedules, directory visibility, the environment data export, and the grouped aggregate over
 * a collaboration table by a non-administrator.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import zlib from 'node:zlib'
import { PG_URL, SKIP_PG } from './testdb.ts'
import { Client, startHarness } from './kernel-testkit.ts'
import type { KernelHarness } from './kernel-testkit.ts'
import { setQuiet } from './util.ts'
import { runInEnvironment } from './env-context.ts'
import { hashPassword } from './password.ts'
import type { UserRecord } from './contracts.ts'
import { ROLE_ADMIN } from './auth.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[phase-close] ${SKIP_PG}\n`)

const PW = 'member-password-1'

/** entries of a ZIP (central directory; deflate or store) */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('not a zip')
  const n = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory')
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extra = buf.readUInt16LE(p + 30)
    const comment = buf.readUInt16LE(p + 32)
    const off = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    const lname = buf.readUInt16LE(off + 26)
    const lextra = buf.readUInt16LE(off + 28)
    const data = buf.subarray(off + 30 + lname + lextra, off + 30 + lname + lextra + csize)
    const content = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data)
    if ((zlib.crc32(content) >>> 0) !== crc) throw new Error(`crc mismatch in ${name}`)
    out.set(name, content)
    p += 46 + nameLen + extra + comment
  }
  return out
}

describe.skipIf(!PG_URL)(PG_URL ? 'phase 0 close (PostgreSQL)' : `phase 0 close ${SKIP_PG}`, { timeout: 120_000 }, () => {
  let h: KernelHarness
  let envAdmin: Client
  let ann: Client
  let ben: Client
  const drain = () => h.app.services.kernel.drain({ timeoutMs: 60_000 })

  const addUser = async (id: string, email: string, roleIds: string[]): Promise<Client> => {
    await runInEnvironment('default', () => h.app.services.meta.users.insert({ id, name: id.replace('user_', '').replace(/^./, (c) => c.toUpperCase()), email, roleIds, status: 'active', passwordHash: '' } as UserRecord))
    await h.q('UPDATE ab.users SET password_hash = $1 WHERE id = $2', [await hashPassword(PW), id])
    await h.q('INSERT INTO ab.environment_access (environment_id, user_id, is_env_admin, granted_on) VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING', ['default', id, roleIds.includes(ROLE_ADMIN)]).catch(() => undefined)
    h.app.services.security.invalidate('all')
    const c = new Client(h.base)
    const r = await c.post('/auth/login', { email, password: PW })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return c
  }

  beforeAll(async () => {
    h = await startHarness('phaseclose', { env: { APPBUILDER_MIGRATION_BACKUP: 'skip' } })
    // built-in schedules are created by the worker's first tick (not started here)
    await runInEnvironment('default', () => h.app.services.kernel.ensureBuiltins({ id: 'default', schema: 'env_default' } as never))
    envAdmin = await addUser('user_eve', 'eve@example.com', [ROLE_ADMIN])
    const t = await h.admin.post('/tables', { displayName: 'Thing', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Note', type: 'text' }] })
    expect(t.status).toBe(200)
    const role = await h.admin.post('/roles', { name: 'Own things', apps: 'all', privileges: [{ table: t.data.id, create: true, read: 'own', update: 'own', delete: 'own' }] })
    ann = await addUser('user_ann', 'ann@example.com', [role.data.id])
    ben = await addUser('user_ben', 'ben@example.com', [role.data.id])
    await addUser('user_cid', 'cid@example.com', [role.data.id])
    // Ann and Ben in Sales, Cid in Plant
    await h.q(`INSERT INTO ab.departments (id, code, name, created_on) VALUES ('dep_sales', 'SALES', 'Sales', now()), ('dep_plant', 'PLANT', 'Plant', now())`)
    await h.q(`UPDATE ab.users SET department_id = 'dep_sales' WHERE id IN ('user_ann', 'user_ben')`)
    await h.q(`UPDATE ab.users SET department_id = 'dep_plant' WHERE id = 'user_cid'`)
    h.app.services.security.invalidate('all')
  }, 180_000)

  afterAll(async () => {
    await h?.close()
  }, 60_000)

  it('sign-in and email delivery logs: built-in retention schedules in Default (180 / 90 days) delete old entries only', async () => {
    const sch = (await h.admin.get('/admin/schedules')).data.items as { id: string; payload: { days: number }; enabled: boolean }[]
    expect(sch.find((x) => x.id === 'sched_signin_log_retention')).toMatchObject({ enabled: true, payload: { days: 180 } })
    expect(sch.find((x) => x.id === 'sched_mail_log_retention')).toMatchObject({ enabled: true, payload: { days: 90 } })
    await h.q(`INSERT INTO ab.signin_log (at, email, outcome, reason, method) VALUES (now() - interval '200 days', 'old@example.com', 'failure', 'password', 'password'), (now() - interval '10 days', 'new@example.com', 'failure', 'password', 'password')`)
    await h.q(`INSERT INTO ab.mail_log (id, created_on, status, to_address, subject, template) VALUES ('ml_old', now() - interval '100 days', 'sent', 'a@example.com', 'Old', 'test'), ('ml_new', now() - interval '5 days', 'sent', 'a@example.com', 'New', 'test')`)
    for (const id of ['sched_signin_log_retention', 'sched_mail_log_retention']) expect((await h.admin.post(`/admin/schedules/${id}/run`)).status).toBe(200)
    await drain()
    expect((await h.q<{ email: string }>(`SELECT email FROM ab.signin_log WHERE email IN ('old@example.com', 'new@example.com')`)).map((r) => r.email)).toEqual(['new@example.com'])
    expect((await h.q<{ id: string }>(`SELECT id FROM ab.mail_log WHERE id IN ('ml_old', 'ml_new')`)).map((r) => r.id)).toEqual(['ml_new'])
    // an environment administrator who is not an install administrator cannot change, run or delete them
    expect((await envAdmin.patch('/admin/schedules/sched_signin_log_retention', { payload: { days: 7 } })).status).toBe(403)
    expect((await envAdmin.post('/admin/schedules/sched_mail_log_retention/run')).status).toBe(403)
    expect((await envAdmin.req('DELETE', '/admin/schedules/sched_signin_log_retention')).status).toBe(403)
    // audit retention stays an environment setting
    expect((await envAdmin.patch('/admin/schedules/sched_audit_retention', { enabled: true, payload: { days: 365 } })).status).toBe(200)
  })

  it('custom schedules: environment administrators create, change and delete them for allowed job types only', async () => {
    const types = (await envAdmin.get('/admin/jobs/metrics')).data.types as { type: string; schedule?: string }[]
    expect(types.filter((t) => t.schedule === 'custom').map((t) => t.type)).toEqual(expect.arrayContaining(['model.summary.refresh', 'outbox.retention']))
    for (const jobType of ['backup.run', 'mail.send', 'identity.signin-log.retention', 'audit.retention', 'event.run']) {
      const r = await envAdmin.post('/admin/schedules', { name: 'x', jobType, cron: '0 2 * * *', payload: {} })
      expect(r.status, `${jobType}: ${JSON.stringify(r.data)}`).toBe(422)
    }
    const c = await envAdmin.post('/admin/schedules', { name: 'Nightly retention', jobType: 'outbox.retention', cron: '0 2 * * *', timeZone: 'Asia/Kolkata', payload: { days: 7, eventRunDays: 7, jobDays: 7 } })
    expect(c.status, JSON.stringify(c.data)).toBe(200)
    expect((await envAdmin.patch(`/admin/schedules/${c.data.id}`, { cron: '30 1 * * *' })).data.cron).toBe('30 1 * * *')
    // a custom schedule cannot be turned into install-wide work
    expect((await envAdmin.patch(`/admin/schedules/${c.data.id}`, { jobType: 'backup.run' })).status).toBe(403)
    expect((await envAdmin.patch(`/admin/schedules/${c.data.id}`, { jobType: 'event.run' })).status).toBe(422)
    expect((await envAdmin.post('/admin/schedules', { name: 'bad', jobType: 'outbox.retention', cron: 'nope', payload: {} })).status).toBe(422)
    expect((await envAdmin.req('DELETE', `/admin/schedules/${c.data.id}`)).status).toBe(200)
    expect((await envAdmin.req('DELETE', '/admin/schedules/sched_outbox_retention')).status).toBe(422)
    expect((await ann.post('/admin/schedules', { name: 'x', jobType: 'outbox.retention', cron: '0 2 * * *' })).status).toBe(403)
  })

  it('directory visibility: everyone (default), same department, administrators only; self always; admins see all', async () => {
    const names = async (c: Client) => {
      const r = await c.post('/query', { plan: { version: 2, table: 'Users', select: ['FullName'], sort: [{ col: 'FullName', dir: 'asc' }] } })
      expect(r.status, JSON.stringify(r.data)).toBe(200)
      return (r.data.rows as { FullName: string }[]).map((x) => x.FullName)
    }
    const orgUsers = async (c: Client) => ((await c.get('/org')).data.users as { name: string }[]).map((u) => u.name).sort()
    expect(await names(ann)).toEqual(expect.arrayContaining(['Ada', 'Ann', 'Ben', 'Cid', 'Eve']))
    expect((await ann.get('/environment/directory')).status).toBe(403)
    expect((await ann.req('PUT', '/environment/directory', { visibility: 'admins' })).status).toBe(403)
    expect((await envAdmin.req('PUT', '/environment/directory', { visibility: 'nobody' })).status).toBe(422)

    expect((await envAdmin.req('PUT', '/environment/directory', { visibility: 'department' })).data).toEqual({ visibility: 'department' })
    expect(await names(ann)).toEqual(['Ann', 'Ben'])
    expect(await orgUsers(ann)).toEqual(['Ann', 'Ben'])
    expect((await names(h.admin)).length).toBeGreaterThanOrEqual(5)

    expect((await envAdmin.req('PUT', '/environment/directory', { visibility: 'admins' })).status).toBe(200)
    expect(await names(ben)).toEqual(['Ben'])
    expect(await orgUsers(ben)).toEqual(['Ben'])
    // pickers built on the Users table follow: an @mention search for Ann finds nobody else
    const thing = (await h.admin.get('/workspace')).data.tables.find((t: { name: string }) => t.name === 'Thing')
    const row = await ben.post(`/data/${thing.id}/rows`, { values: { Title: 'mine' } })
    const m = await ben.get(`/collab/mentionable?table=${thing.id}&row=${row.data.row.id}&q=a`)
    expect(m.status, JSON.stringify(m.data)).toBe(200)
    expect(m.data.users.map((u: { name: string }) => u.name)).toEqual([])
    const audit = await h.q<{ action: string }>(`SELECT action FROM env_default.ab_audit WHERE action = 'environment.directory_visibility'`)
    expect(audit.length).toBe(2)

    expect((await envAdmin.req('PUT', '/environment/directory', { visibility: 'everyone' })).status).toBe(200)
    expect(await names(ben)).toEqual(expect.arrayContaining(['Ann', 'Cid']))
  })

  it('a grouped aggregate over a collaboration table works for a non-administrator (regarding rule inside GROUP BY)', async () => {
    const thing = (await h.admin.get('/workspace')).data.tables.find((t: { name: string }) => t.name === 'Thing')
    const row = await ann.post(`/data/${thing.id}/rows`, { values: { Title: 'commented' } })
    const cm = await ann.post('/data/Comments/rows', { values: { Body: 'hello', regardingTable: thing.id, regardingId: row.data.row.id } })
    expect(cm.status, JSON.stringify(cm.data)).toBe(200)
    for (const plan of [
      { version: 2, table: 'Comments', aggregate: { groupBy: ['regardingTable'], measures: [{ name: 'n', fn: 'count' }] } },
      { version: 2, table: 'Activities', aggregate: { groupBy: ['Status'], measures: [{ name: 'n', fn: 'count' }] } },
    ]) {
      const r = await ann.post('/query', { plan })
      expect(r.status, JSON.stringify(r.data)).toBe(200)
    }
    const g = await ann.post('/query', { plan: { version: 2, table: 'Comments', aggregate: { groupBy: ['regardingTable'], measures: [{ name: 'n', fn: 'count' }] } } })
    expect(g.data.rows).toEqual([{ regardingTable: thing.id, n: 1 }])
    // Ben cannot read Ann's thing: no comment groups for him
    expect((await ben.post('/query', { plan: { version: 2, table: 'Comments', aggregate: { groupBy: ['regardingTable'], measures: [{ name: 'n', fn: 'count' }] } } })).data.rows).toEqual([])
  })

  it('export environment data: administrators only, recent sign-in or a one-use ticket, a ZIP of CSVs with a manifest, audited', async () => {
    const thing = (await h.admin.get('/workspace')).data.tables.find((t: { name: string }) => t.name === 'Thing')
    await h.q(`INSERT INTO env_default.${thing.source} (id, "createdOn", "modifiedOn", owner, "Title", "Note")
      SELECT gen_random_uuid()::text, now(), now(), 'user_ann', 'row ' || g, CASE WHEN g = 0 THEN '=HYPERLINK("http://x")' ELSE 'ok' END FROM generate_series(0, 2499) g`)
    expect((await ann.get('/admin/export-data')).status).toBe(403)
    expect((await ann.post('/admin/export-data/ticket')).status).toBe(403)
    const res = await fetch(`${h.base}/api/v1/admin/export-data`, { headers: { Cookie: h.admin.cookie, 'X-Appbuilder': '1' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    const zip = readZip(Buffer.from(await res.arrayBuffer()))
    const manifest = JSON.parse(zip.get('manifest.json')!.toString('utf8'))
    expect(manifest.kind).toBe('appbuilder/environment-data')
    const entry = manifest.tables.find((t: { name: string }) => t.name === 'Thing')
    expect(entry.rows).toBeGreaterThanOrEqual(2500)
    const csv = zip.get(entry.file)!.toString('utf8')
    expect(csv.split('\r\n')[0]).toContain('Title')
    expect(csv).toContain(`'=HYPERLINK`)
    expect(zip.has('attachments.csv')).toBe(true)
    // no projections or reporting views, but the collaboration tables with rows
    expect(manifest.tables.some((t: { name: string }) => t.name === 'Users')).toBe(false)
    expect(manifest.tables.some((t: { name: string }) => t.name === 'Comments')).toBe(true)
    expect((await h.q(`SELECT 1 FROM env_default.ab_audit WHERE action = 'environment.export_data'`)).length).toBe(1)
    // an old sign-in needs re-authentication; a ticket works once
    await h.q(`UPDATE ab.sessions SET auth_on = now() - interval '2 days' WHERE user_id = 'user_eve'`)
    expect((await envAdmin.get('/admin/export-data')).status).toBe(403)
    expect((await envAdmin.post('/admin/export-data/ticket')).data.error?.code).toBe('reauth_required')
    const t = await h.admin.post('/admin/export-data/ticket')
    expect(t.status).toBe(200)
    await h.q(`UPDATE ab.sessions SET auth_on = now() - interval '2 days' WHERE user_id = (SELECT id FROM ab.users WHERE email = 'ada@example.com')`)
    const viaTicket = await fetch(`${h.base}${t.data.url}`, { headers: { Cookie: h.admin.cookie } })
    expect(viaTicket.status).toBe(200)
    await viaTicket.arrayBuffer()
    expect((await fetch(`${h.base}${t.data.url}`, { headers: { Cookie: h.admin.cookie } })).status).toBe(403)
  })
})
