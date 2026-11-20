/**
 * Core data model (P0 package N) against the sandbox PostgreSQL (APPBUILDER_TEST_DB): system tables in every environment,
 * protections, the people projections and the directory rule, the collaboration security predicate with the leak tests
 * (comments, mentions, tags, activity subjects, counts, search, CSV export, timeline, live pushes, notifications),
 * mentions and notifications, polymorphic integrity (delete cascade, table delete, orphan sweep), number sequences under
 * concurrency (gap-free), the migration of an existing environment and the environment copy with data.
 */
import { planBody } from './testquery.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from './testdb.ts'
import { Client, startHarness } from './kernel-testkit.ts'
import type { KernelHarness } from './kernel-testkit.ts'
import { setQuiet } from './util.ts'
import { runInEnvironment } from './env-context.ts'
import { hashPassword } from './password.ts'
import type { UserRecord } from './contracts.ts'
import { SYSTEM_TABLES, SYS } from '../../src/platform/system-tables.ts'
import { tableMessageFor } from './live/hub.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[core-data-model] ${SKIP_PG}\n`)

const PW = 'member-password-1'

describe.skipIf(!PG_URL)(PG_URL ? 'core data model (PostgreSQL)' : `core data model (PostgreSQL) ${SKIP_PG}`, () => {
  let h: KernelHarness
  const c: Record<string, Client> = {}
  const ids: Record<string, string> = {}
  let ordersId = ''
  const drain = () => h.app.services.kernel.drain({ timeoutMs: 60_000 })

  const login = async (email: string): Promise<Client> => {
    const cl = new Client(h.base)
    const r = await cl.post('/auth/login', { email, password: PW })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return cl
  }
  const rows = async (cl: Client, table: string, plan: Record<string, unknown> = {}) => {
    const r = await cl.post('/query', { plan: { version: 2, table, count: true, ...plan } })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return r.data as { rows: Record<string, unknown>[]; count: number }
  }

  beforeAll(async () => {
    h = await startHarness('cdm')
    c.admin = h.admin
    // Orders: Bo reads his own rows (own scope), Di reads all, Cy has no access
    const t = await h.admin.post('/tables', { displayName: 'Orders', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Amount', type: 'number' }] })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    ordersId = t.data.id
    const role = (name: string, read: string) => h.admin.post('/roles', { name, apps: 'all', privileges: [{ table: ordersId, create: true, read, update: read, delete: read }] })
    const own = await role('Sales own', 'own')
    const all = await role('Sales all', 'all')
    expect(own.status, JSON.stringify(own.data)).toBe(200)
    await runInEnvironment('default', async () => {
      for (const [k, name, roleIds] of [['bo', 'Bo Brown', [own.data.id]], ['cy', 'Cy Clark', []], ['di', 'Di Diaz', [all.data.id]], ['ex', 'Ex Former', [own.data.id]]] as const) {
        const id = `user_${k}`
        ids[k] = id
        await h.app.services.meta.users.insert({ id, name, email: `${k}@example.com`, roleIds: [...roleIds], status: 'active', passwordHash: await hashPassword(PW) } as UserRecord)
      }
    })
    await h.q(`INSERT INTO ab.environment_access (environment_id, user_id, is_env_admin, granted_on) VALUES ('default', $1, false, now()) ON CONFLICT DO NOTHING`, [ids.cy])
    await h.q(`UPDATE ab.users SET status = 'disabled' WHERE id = $1`, [ids.ex])
    h.app.services.security.invalidate('all')
    c.bo = await login('bo@example.com')
    c.cy = await login('cy@example.com')
    c.di = await login('di@example.com')
    const bo1 = await c.bo.post(`/data/${ordersId}/rows`, { values: { Title: 'Bo order', Amount: 10 } })
    expect(bo1.status, JSON.stringify(bo1.data)).toBe(200)
    ids.boOrder = bo1.data.row.id
    const di1 = await c.di.post(`/data/${ordersId}/rows`, { values: { Title: 'Di order', Amount: 20 } })
    ids.diOrder = di1.data.row.id
  }, 180_000)

  afterAll(async () => {
    await h?.close()
  }, 60_000)

  it('every system table exists, is registered with its group and is listed for makers', async () => {
    const reg = await h.q<{ id: string; name: string; def: { system?: boolean; systemGroup?: string } }>(`SELECT id, name, def FROM env_default.ab_tables WHERE id LIKE 'sys\\_%'`)
    expect(reg.length).toBe(SYSTEM_TABLES.length)
    for (const r of reg) {
      expect(r.def.system).toBe(true)
      expect(r.def.systemGroup).toBeTruthy()
    }
    const ws = await h.admin.get('/workspace')
    const users = ws.data.tables.find((t: { id: string }) => t.id === SYS.users)
    expect(users.columns.find((x: { name: string }) => x.name === 'FullName').locked).toBe(true)
    // owner / createdBy are lookups to Users on every table
    const orders = ws.data.tables.find((t: { id: string }) => t.id === ordersId)
    expect(orders.columns.find((x: { name: string }) => x.name === 'owner')).toMatchObject({ type: 'lookup', lookupTable: 'Users' })
    // seeds
    const cur = await rows(h.admin, 'Currencies', { filter: { col: 'Code', op: 'eq', value: 'INR' } })
    expect(cur.rows[0]).toMatchObject({ Code: 'INR', IsDefault: true, DecimalPlaces: 2 })
    const st = await rows(h.admin, 'States', { filter: { col: 'GstStateCode', op: 'eq', value: '27' } })
    expect(st.rows[0]).toMatchObject({ Name: 'Maharashtra' })
    const fy = await rows(c.cy, 'Settings', { filter: { col: 'Key', op: 'eq', value: 'FinancialYearStartMonth' } })
    expect(fy.rows[0].Value).toBe('4')
  })

  it('system tables cannot be deleted, renamed or have platform columns changed; extensible ones take custom columns', async () => {
    expect((await h.admin.del(`/tables/${SYS.activities}`)).status).toBe(403)
    expect((await h.admin.patch(`/tables/${SYS.activities}`, { displayName: 'Jobs' })).status).toBe(403)
    expect((await h.admin.patch(`/tables/${SYS.activities}/columns/Subject`, { displayName: 'Title' })).status).toBe(403)
    expect((await h.admin.del(`/tables/${SYS.activities}/columns/Subject`)).status).toBe(403)
    expect((await h.admin.post(`/tables/${SYS.users}/columns`, { displayName: 'Shoe size', type: 'number' })).status).toBe(403)
    const add = await h.admin.post(`/tables/${SYS.activities}/columns`, { displayName: 'Effort', type: 'number' })
    expect(add.status, JSON.stringify(add.data)).toBe(200)
    // the custom column survives a re-provisioning (every start)
    await h.app.services.meta.migrate()
    const def = (await h.q<{ def: { columns: { name: string }[] } }>(`SELECT def FROM env_default.ab_tables WHERE id = $1`, [SYS.activities]))[0].def
    expect(def.columns.some((x) => x.name === 'Effort')).toBe(true)
    // and can be removed again
    expect((await h.admin.del(`/tables/${SYS.activities}/columns/Effort`)).status).toBe(200)
  })

  it('Users follows the directory rule: environment members only, active only and name/email only for non-administrators', async () => {
    const asAdmin = await rows(h.admin, 'Users')
    expect(asAdmin.rows.map((r) => r.FullName)).toEqual(expect.arrayContaining(['Ada', 'Bo Brown', 'Cy Clark', 'Di Diaz', 'Ex Former']))
    expect(Object.keys(asAdmin.rows[0])).toEqual(expect.arrayContaining(['Status', 'JobTitle']))
    const asBo = await rows(c.bo, 'Users')
    expect(asBo.rows.map((r) => r.FullName)).not.toContain('Ex Former')
    expect(Object.keys(asBo.rows[0]).sort()).not.toContain('Status')
    expect((await c.bo.post('/query', { plan: { version: 2, table: 'Users', filter: { col: 'Status', op: 'eq', value: 'active' } } })).status).toBe(403)
    // role assignments: own rows only; audit: administrators only
    const ra = await rows(c.bo, 'RoleAssignments')
    expect(ra.rows.every((r) => r.User === ids.bo)).toBe(true)
    expect((await c.bo.post('/query', { plan: { version: 2, table: 'AuditEntries' } })).status).toBe(404)
    expect((await rows(h.admin, 'AuditEntries')).count).toBeGreaterThan(0)
    // projections are read-only
    expect((await h.admin.post('/data/Users/rows', { values: { FullName: 'X' } })).status).toBe(403)
  })

  it('comments: author mentions a reader, mentions of non-readers are refused, the mention row and notification follow', async () => {
    const bad = await c.bo.post('/data/Comments/rows', { values: { Body: `Ask <span data-mention="${ids.cy}">@Cy</span>`, regardingId: ids.boOrder } })
    expect(bad.status).toBe(422)
    expect(bad.data.error.message).toMatch(/Cy Clark cannot see this record/)
    const ok = await c.bo.post('/data/Comments/rows', { values: { Body: `Hi <span data-mention="${ids.di}">@Di</span> <script>x()</script>please check`, regardingId: ids.boOrder, Link: `#u-app1?record=${ids.boOrder}` } })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    ids.comment = ok.data.row.id
    expect(ok.data.row.regardingTable).toBe(ordersId)
    expect(ok.data.row.Body).not.toMatch(/script/)
    const m = await rows(c.di, 'Mentions')
    expect(m.rows).toHaveLength(1)
    expect(m.rows[0]).toMatchObject({ MentionedUser: ids.di, Comment: ids.comment, IsRead: false })
    await drain()
    const n = await c.di.get('/notifications')
    const item = n.data.items.find((x: { kind: string }) => x.kind === 'mention')
    expect(item.title).toBe('Bo Brown mentioned you on Orders "Bo order"')
    expect(item.link).toBe(`#u-app1?record=${ids.boOrder}`)
    // the mentioned user marks it read; nothing else on a mention can be changed
    expect((await c.di.patch(`/data/Mentions/rows/${m.rows[0].id}`, { changes: { IsRead: true } })).status).toBe(200)
    expect((await c.di.patch(`/data/Mentions/rows/${m.rows[0].id}`, { changes: { MentionedUser: ids.bo } })).status).toBe(403)
    // only the author edits a comment
    expect((await c.di.patch(`/data/Comments/rows/${ids.comment}`, { changes: { Body: 'hijack' } })).status).toBe(403)
    const ed = await c.bo.patch(`/data/Comments/rows/${ids.comment}`, { changes: { Body: `Hi <span data-mention="${ids.di}">@Di</span> edited` } })
    expect(ed.status).toBe(200)
    expect(ed.data.row.EditedOn).toBeTruthy()
  })

  it('LEAK: a user who cannot read the order learns nothing about its comments, mentions, tags, activities or files', async () => {
    // collaboration about Bo's order: a tag, a task, a follow (Di); and one comment on Di's own order
    const tag = await c.di.post('/data/Tags/rows', { values: { Name: 'Urgent-secret' } })
    expect(tag.status).toBe(200)
    expect((await c.di.post('/data/TagLinks/rows', { values: { Tag: tag.data.row.id, regardingId: ids.boOrder } })).status).toBe(200)
    const task = await c.bo.post('/data/Activities/rows', { values: { Subject: 'Secret follow-up call', regardingId: ids.boOrder, Type: 'Call' } })
    expect(task.status, JSON.stringify(task.data)).toBe(200)
    ids.task = task.data.row.id
    expect((await c.di.post('/data/Follows/rows', { values: { regardingId: ids.boOrder } })).status).toBe(200)
    expect((await c.di.post('/data/Comments/rows', { values: { Body: 'Di note', regardingId: ids.diOrder } })).status).toBe(200)
    for (const t of ['Comments', 'Mentions', 'TagLinks', 'Activities', 'Follows', 'AttachmentLinks', 'Shares']) {
      const r = await rows(c.cy, t)
      expect(r.rows, t).toHaveLength(0)
      expect(r.count, t).toBe(0)
      // aggregate and search see nothing either
      const agg = await c.cy.post('/query', { plan: { version: 2, table: t, aggregate: { groupBy: [], measures: [{ name: 'n', fn: 'count' }] } } })
      expect(agg.data.rows[0].n, t).toBe(0)
      const v1 = await c.cy.post('/query', planBody(t, { count: true }))
      expect(v1.data.count, t).toBe(0)
    }
    const search = await c.cy.post('/query', { plan: { version: 2, table: 'Activities', search: { text: 'Secret', columns: ['Subject'] } } })
    expect(search.data.rows).toHaveLength(0)
    const csv = await c.cy.get('/tables/Comments/csv')
    expect(csv.data).not.toMatch(/Hi |Di note/)
    expect((await c.cy.get(`/collab/timeline?table=${ordersId}&row=${ids.boOrder}`)).status).toBe(404)
    // writing about it is refused exactly like a missing record
    const w = await c.cy.post('/data/Comments/rows', { values: { Body: 'sneaky', regardingId: ids.boOrder } })
    expect(w.status).toBe(422)
    expect(w.data.error.message).toMatch(/no record with the id/)
    // Bo (own scope) sees the collaboration about his order, not about Di's order
    const bo = await rows(c.bo, 'Comments')
    expect(bo.rows.map((r) => r.regardingId)).toEqual([ids.boOrder])
    // live pushes: Cy gets at most a "table changed" tick, never row ids or the actor
    const cyCtx = await runInEnvironment('default', async () => h.app.services.security.forUser((await h.app.services.meta.users.get(ids.cy))!))
    const comments = (await runInEnvironment('default', () => h.app.services.meta.tables.get(SYS.comments)))!
    const msg = tableMessageFor(cyCtx, comments, 'default', { op: 'insert', rowIds: [ids.comment], changedColumns: ['Body'], actor: { id: ids.bo, name: 'Bo' } }, 1, 0, 50, new Date().toISOString())
    expect(msg?.rows ?? null).toBeNull()
    expect(msg?.by).toBeUndefined()
    // notifications: Cy received none of them
    await drain()
    expect((await c.cy.get('/notifications')).data.items).toHaveLength(0)
    expect((await rows(c.cy, 'Notifications')).count).toBe(0)
  })

  it('an activity assigned to someone who cannot read the record is visible to them, the record is not', async () => {
    const r = await c.bo.post('/data/Activities/rows', { values: { Subject: 'Ring the customer', regardingId: ids.boOrder, AssignedTo: ids.cy } })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    const mine = await rows(c.cy, 'Activities')
    expect(mine.rows.map((x) => x.Subject)).toEqual(['Ring the customer'])
    expect((await c.cy.get(`/collab/timeline?table=${ordersId}&row=${ids.boOrder}`)).status).toBe(404)
    // the assignee completes it: CompletedOn / CompletedBy are stamped
    const done = await c.cy.patch(`/data/Activities/rows/${r.data.row.id}`, { changes: { Status: 'Done' } })
    expect(done.status, JSON.stringify(done.data)).toBe(200)
    expect(done.data.row.CompletedBy).toBe(ids.cy)
    const tasks = await c.cy.get('/collab/my-tasks?status=all')
    expect(tasks.status).toBe(200)
    expect(tasks.data.items.some((x: { regardingLabel?: string }) => x.regardingLabel)).toBe(false)
  })

  it('timeline: comments, activities, files and record events, newest first, paged', async () => {
    const tl = await c.di.get(`/collab/timeline?table=${ordersId}&row=${ids.boOrder}&limit=3`)
    expect(tl.status, JSON.stringify(tl.data)).toBe(200)
    expect(tl.data.items).toHaveLength(3)
    expect(tl.data.following).toBe(true)
    expect(tl.data.tags.map((t: { name: string }) => t.name)).toEqual(['Urgent-secret'])
    const all: { kind: string; at: string }[] = [...tl.data.items]
    let cursor = tl.data.nextCursor
    while (cursor) {
      const p = await c.di.get(`/collab/timeline?table=${ordersId}&row=${ids.boOrder}&limit=3&cursor=${cursor}`)
      all.push(...p.data.items)
      cursor = p.data.nextCursor
    }
    expect(new Set(all.map((x) => x.kind))).toEqual(new Set(['comment', 'activity', 'event']))
    const times = all.map((x) => x.at)
    expect([...times].sort().reverse()).toEqual(times)
  })

  it('follow: a new comment notifies followers who can still read the record', async () => {
    await drain()
    const before = (await c.di.get('/notifications')).data.items.length
    expect((await c.bo.post('/data/Comments/rows', { values: { Body: 'Shipped today', regardingId: ids.boOrder } })).status).toBe(200)
    await drain()
    const after = (await c.di.get('/notifications')).data.items
    expect(after.length).toBe(before + 1)
    expect(after[0].title).toMatch(/Bo Brown commented on Orders/)
  })

  it('polymorphic integrity: deleting a record removes its comments, mentions, tags, follows and activities', async () => {
    const count = async () => (await h.q<{ n: number }>(`SELECT
      (SELECT count(*) FROM env_default.sys_comments WHERE "regardingId" = $1) + (SELECT count(*) FROM env_default.sys_mentions WHERE "regardingId" = $1) +
      (SELECT count(*) FROM env_default.sys_tag_links WHERE "regardingId" = $1) + (SELECT count(*) FROM env_default.sys_follows WHERE "regardingId" = $1) +
      (SELECT count(*) FROM env_default.sys_activities WHERE "regardingId" = $1) AS n`, [ids.boOrder]))[0].n
    expect(Number(await count())).toBeGreaterThan(4)
    expect((await c.bo.post(`/data/${ordersId}/delete`, { ids: [ids.boOrder] })).status).toBe(200)
    expect(Number(await count())).toBe(0)
  })

  it('orphan sweep removes rows about records deleted outside the API and about deleted tables', async () => {
    const r = await c.di.post('/data/Comments/rows', { values: { Body: 'orphan soon', regardingId: ids.diOrder } })
    expect(r.status).toBe(200)
    const src = (await h.q<{ source: string }>(`SELECT source FROM env_default.ab_tables WHERE id = $1`, [ordersId]))[0].source
    const gone = await h.q(`DELETE FROM env_default.${src} WHERE id = $1 RETURNING id`, [ids.diOrder])
    expect(gone).toHaveLength(1)
    const res = await runInEnvironment('default', () => h.app.services.collab.sweepOrphans())
    expect(res.removed).toBeGreaterThanOrEqual(2)
    expect((await h.q(`SELECT 1 FROM env_default.sys_comments WHERE id = $1`, [r.data.row.id])).length).toBe(0)
  })

  it('NextNumber: gap-free and unique under parallel writers; a failed write gives its number back', async () => {
    const seq = await h.admin.post('/data/NumberSequences/rows', { values: { Name: 'Invoices', Prefix: 'INV/{FY}/', Padding: 4, ResetRule: 'financialYear' } })
    expect(seq.status, JSON.stringify(seq.data)).toBe(200)
    const t = await h.admin.post('/tables', { displayName: 'Invoices', columns: [{ displayName: 'Customer', type: 'text', required: true }, { displayName: 'Number', type: 'text', default: '=NextNumber("Invoices")' }] })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    const writers = Array.from({ length: 24 }, (_, i) => h.admin.post(`/data/${t.data.id}/rows`, { values: i % 6 === 5 ? {} : { Customer: `C${i}` } }))
    const res = await Promise.all(writers)
    const ok = res.filter((x) => x.status === 200).map((x) => String(x.data.row.Number))
    expect(res.filter((x) => x.status === 422)).toHaveLength(4)
    expect(ok).toHaveLength(20)
    const nums = ok.map((s) => Number(s.slice(-4))).sort((a, b) => a - b)
    expect(nums).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(ok[0]).toMatch(/^INV\/\d{4}-\d{2}\/\d{4}$/)
    const next = await rows(h.admin, 'NumberSequences', { filter: { col: 'Name', op: 'eq', value: 'Invoices' } })
    expect(next.rows[0].NextValue).toBe(21)
  }, 60_000)

  it('NextNumber in a before-event; Setting and lookup paths (createdBy.FullName) through Query v2', async () => {
    const t = await h.admin.post('/tables', { displayName: 'Quotes', columns: [{ displayName: 'Title', type: 'text' }, { displayName: 'Ref', type: 'text' }] })
    expect((await h.admin.post('/data/NumberSequences/rows', { values: { Name: 'Quotes', Prefix: 'Q-', Padding: 3 } })).status).toBe(200)
    const ev = await h.admin.post(`/tables/${t.data.id}/events`, { name: 'Number it', timing: 'before', operations: ['create'], actions: 'SetField({Ref: NextNumber("Quotes")})' })
    expect(ev.status, JSON.stringify(ev.data)).toBe(200)
    const a = await h.admin.post(`/data/${t.data.id}/rows`, { values: { Title: 'one' } })
    const b = await h.admin.post(`/data/${t.data.id}/rows`, { values: { Title: 'two' } })
    expect([a.data.row.Ref, b.data.row.Ref]).toEqual(['Q-001', 'Q-002'])
    // lookup path: the orders Bo created, seen by Di (reads all orders) and by Bo (own scope)
    const plan = { version: 2, table: ordersId, filter: { via: { col: 'createdBy', table: 'Users', where: { col: 'FullName', op: 'eq', value: 'bo brown' } } }, count: true }
    const asDi = await c.di.post('/query', { plan })
    expect(asDi.status, JSON.stringify(asDi.data)).toBe(200)
    expect(asDi.data.rows.every((r: { createdBy: string }) => r.createdBy === ids.bo)).toBe(true)
    // a hidden column of the lookup target is refused (Status of Users is administrators only)
    const hidden = await c.bo.post('/query', { plan: { ...plan, filter: { via: { col: 'createdBy', table: 'Users', where: { col: 'Status', op: 'eq', value: 'active' } } } } })
    expect(hidden.status).toBe(403)
    // only through a lookup column of that table
    expect((await c.di.post('/query', { plan: { ...plan, filter: { via: { col: 'Title', table: 'Users', where: { const: true } } } } })).status).toBe(422)
  })

  it('solutions: a custom column on a system table travels and is added on import; the system table itself is not exported', async () => {
    const add = await h.admin.post(`/tables/${SYS.activities}/columns`, { displayName: 'Site', type: 'text' })
    expect(add.status, JSON.stringify(add.data)).toBe(200)
    const sol = await h.admin.post('/solutions', { displayName: 'Field kit' })
    expect((await h.admin.post(`/solutions/${sol.data.id}/components`, { kind: 'table', id: SYS.activities })).status).toBe(200)
    const yaml = (await h.admin.get(`/solutions/${sol.data.id}/package`)).data.yaml as string
    expect(yaml).toMatch(/system: true/)
    expect(yaml).toMatch(/name: Site/)
    expect(yaml).not.toMatch(/name: Subject/)
    const env = await h.admin.post('/environments', { name: 'Kit target', type: 'sandbox' })
    expect(env.status).toBe(200)
    const T = new Client(h.base)
    T.cookie = h.admin.cookie
    T.env = env.data.id
    const plan = (await T.post('/solutions/import/plan', { yaml })).data
    expect(plan.problems).toEqual([])
    expect(plan.items.find((i: { id: string }) => i.id === SYS.activities)).toMatchObject({ change: 'changed', columns: [{ name: 'Site', change: 'added' }] })
    const ok = await T.post('/solutions/import', { yaml, confirm: plan.token })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    const def = (await h.q<{ def: { columns: { name: string }[] } }>(`SELECT def FROM env_${env.data.id}.ab_tables WHERE id = $1`, [SYS.activities]))[0].def
    expect(def.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['Site', 'Subject']))
    expect((await h.q(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'sys_activities' AND column_name = 'Site'`, [`env_${env.data.id}`])).length).toBe(1)
  }, 120_000)

  it('the common business model is not installed by default and installs as a solution package', async () => {
    const env = await h.admin.post('/environments', { name: 'Biz model', type: 'sandbox' })
    expect(env.status).toBe(200)
    const T = new Client(h.base)
    T.cookie = h.admin.cookie
    T.env = env.data.id
    const before = (await T.get('/workspace')).data.tables.map((t: { name: string }) => t.name)
    expect(before).not.toContain('Accounts')
    const pkg = (await T.get('/templates/business-model')).data
    const plan = (await T.post('/solutions/import/plan', { yaml: pkg.yaml })).data
    expect(plan.problems).toEqual([])
    expect(plan.mode).toBe('install')
    const ok = await T.post('/solutions/import', { yaml: pkg.yaml, confirm: plan.token })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    const names = (await T.get('/workspace')).data.tables.filter((t: { system?: boolean }) => !t.system).map((t: { name: string }) => t.name).sort()
    expect(names).toEqual(['Accounts', 'Addresses', 'Contacts', 'PriceListItems', 'PriceLists', 'Products', 'TaxCodes'])
    // lookups into the reference data work, and the regarding rule covers the new tables
    const inr = (await T.post('/query', { plan: { version: 2, table: 'Currencies', filter: { col: 'Code', op: 'eq', value: 'INR' } } })).data.rows[0].id
    const acc = await T.post('/data/Accounts/rows', { values: { Name: 'Acme Tools', Currency: inr } })
    expect(acc.status, JSON.stringify(acc.data)).toBe(200)
    expect(acc.data.row.AccountNumber).toBe('ACC-0001')
    expect((await T.post('/data/Comments/rows', { values: { Body: 'first call', regardingId: acc.data.row.id } })).status).toBe(200)
    // a second import of the same version is an in-place upgrade with nothing to do
    const again = (await T.post('/solutions/import/plan', { yaml: pkg.yaml })).data
    expect(again.mode).toBe('upgrade')
  }, 120_000)

  it('deleting a table removes the collaboration rows about it', async () => {
    const t = await h.admin.post('/tables', { displayName: 'Temp', columns: [{ displayName: 'Name', type: 'text' }] })
    const row = await h.admin.post(`/data/${t.data.id}/rows`, { values: { Name: 'x' } })
    expect((await h.admin.post('/data/Comments/rows', { values: { Body: 'about temp', regardingTable: 'Temp', regardingId: row.data.row.id } })).status).toBe(200)
    expect((await h.admin.del(`/tables/${t.data.id}?dropSource=1`)).status).toBe(200)
    expect((await h.q(`SELECT 1 FROM env_default.sys_comments WHERE "regardingTable" = $1`, [t.data.id])).length).toBe(0)
  })

  it('migration of an existing (version 6) environment creates the system tables and links existing attachments', async () => {
    // simulate a version 6 schema: no system tables, owner/createdBy as text, an attachment without a link
    await h.q(`INSERT INTO env_default.ab_attachments (id, table_id, col, row_id, file_name, mime, size_bytes, sha256, storage_key, created_on) VALUES ('att_legacy', $1, 'File', $2, 'a.pdf', 'application/pdf', 3, 'x', 'k', now())`, [ordersId, ids.diOrder])
    for (const s of SYSTEM_TABLES) await h.q(`DROP ${s.kind === 'projection' ? 'VIEW' : 'TABLE'} IF EXISTS env_default.${s.source}`)
    await h.q(`DELETE FROM env_default.ab_tables WHERE id LIKE 'sys\\_%'`)
    await h.q(`DELETE FROM env_default.ab_counters WHERE k LIKE 'sys.%'`)
    await h.q(`UPDATE env_default.ab_tables SET def = jsonb_set(def, '{columns}', (SELECT jsonb_agg(CASE WHEN c->>'name' IN ('owner','createdBy') THEN (c - 'lookupTable') || '{"type":"text"}' ELSE c END) FROM jsonb_array_elements(def->'columns') c))`)
    await h.q(`UPDATE ab.environments SET schema_version = 6 WHERE id = 'default'`)
    const sum = await h.app.services.meta.migrate()
    expect((sum as { environments?: { id: string }[] }).environments?.find((e) => e.id === 'default')).toMatchObject({ from: 6, to: (await import('./meta-store.ts')).SCHEMA_VERSION, ok: true })
    expect((await h.q(`SELECT count(*)::int AS n FROM env_default.ab_tables WHERE id LIKE 'sys\\_%'`))[0].n).toBe(SYSTEM_TABLES.length)
    expect((await h.q(`SELECT "regardingTable" AS t FROM env_default.sys_attachment_links WHERE "Attachment" = 'att_legacy'`))[0]).toMatchObject({ t: ordersId })
    const owner = (await h.q<{ def: { columns: { name: string; type: string }[] } }>(`SELECT def FROM env_default.ab_tables WHERE id = $1`, [ordersId]))[0].def.columns.find((x) => x.name === 'owner')
    expect(owner?.type).toBe('lookup')
    h.app.services.security.invalidate('all')
  }, 120_000)

  it('an environment copied with data carries the collaboration rows; a schema copy only the reference data', async () => {
    expect((await h.admin.post('/data/Comments/rows', { values: { Body: 'copy me', regardingTable: ordersId, regardingId: ids.boOrder2 ?? (await h.admin.post(`/data/${ordersId}/rows`, { values: { Title: 'Kept' } })).data.row.id } })).status).toBe(200)
    const d = await h.admin.post('/environments', { name: 'Copy data', type: 'sandbox', copyFrom: 'default', copy: 'data' })
    expect(d.status, JSON.stringify(d.data)).toBe(200)
    const s = await h.admin.post('/environments', { name: 'Copy schema', type: 'sandbox', copyFrom: 'default', copy: 'schema' })
    expect(s.status, JSON.stringify(s.data)).toBe(200)
    const n = async (schema: string, t: string) => (await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM ${schema}.${t}`))[0].n
    expect(await n(`env_${d.data.id}`, 'sys_comments')).toBe(await n('env_default', 'sys_comments'))
    expect(await n(`env_${s.data.id}`, 'sys_comments')).toBe(0)
    expect(await n(`env_${s.data.id}`, 'sys_currencies')).toBeGreaterThan(100)
    expect((await h.q(`SELECT count(*)::int AS n FROM env_${s.data.id}.ab_tables WHERE id LIKE 'sys\\_%'`))[0]).toMatchObject({ n: SYSTEM_TABLES.length })
  }, 120_000)
})
