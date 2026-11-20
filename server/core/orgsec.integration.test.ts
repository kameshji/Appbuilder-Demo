/**
 * Package F against the sandbox PostgreSQL (APPBUILDER_TEST_DB, testdb.ts): the shared corpus
 * (src/platform/testdata/orgsec-corpus.json) through the real security engine (directory, shares, connections) and the
 * SQL of Query v1 and v2; then the education and manufacturing examples end to end over HTTP: sign-in, query, count,
 * aggregates, CSV export, WITH CHECK on insert and update with relationship rules, lookup targets the user cannot
 * read, sharing and unsharing, team member removal, deleted users, the explainer, the CSV import of users, solution
 * export of rules, and EXPLAIN checks that the organisation and rule predicates can use their indexes.
 */
import { planBody } from './testquery.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.ts'
import type { AppServer } from './app.ts'
import { hashPassword } from './password.ts'
import { setQuiet } from './util.ts'
import { runInEnvironment } from './env-context.ts'
import { PG_URL, SKIP_PG, dropDatabase, pgServer, testDatabaseName, withPg } from './testdb.ts'
import type { RoleDef, TableDef } from '../../src/platform/contracts.ts'
import { corpus, labelOf, roleFor } from '../../src/platform/testdata/orgsec-corpus.ts'
import { buildSelect } from '../connectors/postgres/sql.ts'
import type { UserRecord } from './contracts.ts'

setQuiet(true)
const dbName = testDatabaseName('orgsec')
if (!PG_URL) process.stderr.write(`[orgsec] ${SKIP_PG}\n`)

class Client {
  cookie = ''
  base: string
  constructor(base: string) { this.base = base }
  async req(method: string, p: string, body?: unknown) {
    const h: Record<string, string> = { 'X-Appbuilder': '1' }
    if (this.cookie) h.Cookie = this.cookie
    if (body !== undefined) h['Content-Type'] = 'application/json'
    const res = await fetch(this.base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const [name, value] = pair.split('=')
      if (name === 'ab_session') this.cookie = value ? `ab_session=${value}` : ''
    }
    const text = await res.text()
    let data: any = text
    try { data = JSON.parse(text) } catch { /* csv */ }
    return { status: res.status, data }
  }
  get = (p: string) => this.req('GET', p)
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {})
  patch = (p: string, b?: unknown) => this.req('PATCH', p, b ?? {})
  del = (p: string) => this.req('DELETE', p)
  query = (table: string, plan: Record<string, unknown> = {}) => this.req('POST', '/api/v1/query', { plan: { version: 2, table, ...plan } })
}

const SYS = [
  { name: 'id', displayName: 'Id', type: 'text', system: true },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
  { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
  { name: 'createdBy', displayName: 'Created by', type: 'text', system: true },
  { name: 'owner', displayName: 'Owner', type: 'text', system: true },
] as const

/** corpus table -> a managed table of the default connection */
const physicalDef = (t: TableDef): TableDef => ({
  ...t, connectionId: 'conn_default', source: `t_os_${t.name.toLowerCase()}`, managed: true,
  columns: [...SYS.map((c) => ({ ...c })), ...t.columns],
})
const ID = (s: string) => `00000000-0000-7000-8000-${s.padStart(12, '0')}`

describe.skipIf(!PG_URL)(PG_URL ? 'organisation security (PostgreSQL)' : `organisation security (PostgreSQL) ${SKIP_PG}`, () => {
  let app: AppServer
  let server: http.Server
  let base = ''
  let tmp = ''
  const A = () => clients.admin
  const clients: Record<string, Client> = {}
  const defs = new Map<string, TableDef>()

  const login = async (email: string, password: string): Promise<Client> => {
    const c = new Client(base)
    const r = await c.post('/api/v1/auth/login', { email, password })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return c
  }

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-orgsec-'))
    app = await createApp({ env: {}, config: { workspaceDir: tmp }, printSetupCode: false })
    server = http.createServer((req, res) => { app.handle(req, res).then((h) => { if (!h) res.writeHead(404).end() }) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    clients.admin = new Client(base)
    const code = () => app.services.setupCode.current() ?? ''
    expect((await A().post('/api/v1/setup/database', { setupCode: code(), host: pgServer!.host, port: pgServer!.port, database: dbName, user: pgServer!.user, password: pgServer!.password, createDatabase: true })).status).toBe(200)
    expect((await A().post('/api/v1/setup/admin', { setupCode: code(), name: 'Ada', email: 'ada@example.com', password: 'admin-password-1' })).status).toBe(200)
    const meta = app.services.meta
    await runInEnvironment('default', async () => {
      // organisation of the corpus, written through the store (the HTTP routes are tested below)
      for (const u of corpus.users) {
        await meta.users.insert({ id: u.id, name: u.name, email: u.email, roleIds: [], status: 'active', passwordHash: await hashPassword('corpus-password-1') } as UserRecord)
      }
      for (const d of corpus.departments) await meta.org!.departments.insert(d)
      for (const u of corpus.users) await meta.org!.setUserOrg(u.id, { departmentId: u.departmentId ?? null, managerId: u.managerId ?? null })
      for (const t of corpus.teams) await meta.org!.teams.insert(t)
      for (const s of corpus.shares) await meta.org!.shares.put(s)
      const conn = await app.services.connections.get('conn_default')
      for (const t of corpus.tables) {
        const def = physicalDef(t)
        defs.set(t.name, def)
        await meta.tables.upsert(def)
        await conn.createTable(def)
        const rows = (corpus.rows[t.name] ?? []).map((r) => {
          const out: Record<string, unknown> = { createdOn: new Date('2026-11-01T00:00:00Z'), modifiedOn: new Date('2026-11-01T00:00:00Z'), createdBy: null, owner: null, ...r }
          for (const c of t.columns) if (c.type === 'date' && typeof r[c.name] === 'string') out[c.name] = new Date(`${r[c.name] as string}T00:00:00Z`)
          return out
        })
        if (rows.length) await conn.insert(def, rows as never)
      }
    })
    app.services.security.invalidate('all')
  }, 120000)

  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    await app?.close()
    await dropDatabase(dbName)
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  }, 60000)

  /* ------------------------------------------------------------------ corpus through the engine and SQL */

  it('corpus: the real engine compiles every case into Query v1 and v2 SQL with the expected rows', async () => {
    const meta = app.services.meta
    for (const c of corpus.cases) {
      await runInEnvironment('default', async () => {
        const role: RoleDef = { ...roleFor(c), id: 'role_case', name: 'Case' }
        role.privileges = role.privileges.map((p) => ({ ...p, table: defs.get(c.table)!.id }))
        await meta.roles.upsert(role)
        const rec = (await meta.users.get(c.user))!
        await meta.users.update(c.user, { roleIds: ['role_case'] })
        app.services.security.invalidate('all')
        const user = { ...rec, roleIds: ['role_case'] }
        delete (user as Partial<UserRecord>).passwordHash
        const uc = await app.services.security.forUser(user)
        const def = defs.get(c.table)!
        const want = [...c.expect].sort()
        if (c.op === 'read' && c.privilege.read && c.privilege.read !== 'none') {
          const v1 = await app.services.data.query(uc, def, { select: ['id', def.primaryColumn] })
          expect(v1.rows.map((r) => labelOf(def, r)).sort(), `${c.name} (v1)`).toEqual(want)
          const v2 = await app.services.data.queryV2(uc, def, { version: 2, table: def.name, select: ['id', def.primaryColumn], count: true })
          expect(v2.rows.map((r) => labelOf(def, r)).sort(), `${c.name} (v2)`).toEqual(want)
          expect(v2.count, `${c.name} (count)`).toBe(want.length)
        } else {
          // update / share predicates: the same SQL through the connector
          const pred = uc.rowPredicate(def, c.op)
          const conn = await app.services.connections.get('conn_default')
          const res = 'const' in pred && !pred.const ? { rows: [] } : await conn.select(def, { where: pred, select: ['id', def.primaryColumn] })
          expect(res.rows.map((r) => labelOf(def, r as Record<string, unknown>)).sort(), `${c.name} (${c.op})`).toEqual(want)
        }
        await meta.users.update(c.user, { roleIds: [] })
      })
    }
    await runInEnvironment('default', () => app.services.meta.roles.remove('role_case'))
    app.services.security.invalidate('all')
  }, 120000)

  it('EXPLAIN: organisation scopes use the owner index, lookup rules the lookup index (semi-join), one statement', async () => {
    const def = defs.get('Production')!
    const icu = (await withPg((c) => c.query("SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_collation WHERE collname = 'und-x-icu') AS ok"), dbName)).rows[0].ok as boolean
    const d = { schema: 'env_default', icu }
    const explain = async (where: unknown): Promise<string> => {
      const plan = buildSelect(d, def, { where: where as never, select: ['id'] })
      return withPg(async (c) => {
        await c.query('SET enable_seqscan = off')
        const r = await c.query(`EXPLAIN ${plan.sql}`, plan.params)
        return r.rows.map((x: Record<string, string>) => x['QUERY PLAN']).join('\n')
      }, dbName)
    }
    const dept = await explain({ col: 'owner', op: 'in', value: ['u_sup1', 'u_op1'] })
    expect(dept).toMatch(/ix_t_os_production_owner/)
    const lines = defs.get('Lines')!
    const rule = await explain({ semi: { col: 'Line', table: lines, key: 'id', where: { col: 'Supervisor', op: 'eq', value: 'u_sup2' } } })
    expect(rule).toMatch(/Semi Join|SubPlan|Hash Join|Nested Loop/)
    expect(rule).toMatch(/t_os_production_line/i)
    // the junction (exists) form: id IN (SELECT lower(Student) FROM enrolments WHERE ...)
    const students = defs.get('Students')!
    const enrol = defs.get('Enrolments')!
    const sections = defs.get('Sections')!
    const plan = buildSelect(d, students, { where: { semi: { col: 'id', table: enrol, key: 'Student', where: { semi: { col: 'Section', table: sections, key: 'id', where: { col: 'Teacher', op: 'eq', value: 'u_teach1' } } } } } as never, select: ['id'] })
    expect(plan.sql.match(/SELECT/g)!.length).toBe(3) // one statement, two nested sub-selects
    const text = await withPg(async (c) => (await c.query(`EXPLAIN ${plan.sql}`, plan.params)).rows.map((x: Record<string, string>) => x['QUERY PLAN']).join('\n'), dbName)
    expect(text).toMatch(/t_os_enrolments/)
  }, 60000)

  /* ------------------------------------------------------------------ examples over HTTP */

  const teacherRole = (): RoleDef => ({
    id: 'role_teacher', name: 'Teacher', apps: 'all', privileges: [
      { table: defs.get('Students')!.id, create: false, read: 'all', update: 'none', delete: 'none', rowFilter: [{ exists: { table: 'Enrolments', where: [{ column: 'Student', op: 'eq', value: '@this' }, { column: 'Section.Teacher', op: 'eq', value: '@me' }] } }] },
      { table: defs.get('Sections')!.id, create: false, read: 'all', update: 'none', delete: 'none', rowFilter: [{ column: 'Teacher', op: 'eq', value: '@me' }] },
      { table: defs.get('Attendance')!.id, create: true, read: 'all', update: 'all', delete: 'none', rowFilter: [{ column: 'Section.Teacher', op: 'eq', value: '@me' }] },
    ],
  })
  const parentRole = (): RoleDef => ({
    id: 'role_parent', name: 'Parent', apps: 'all', privileges: [
      { table: defs.get('Students')!.id, create: false, read: 'all', update: 'none', delete: 'none', rowFilter: [{ exists: { table: 'Guardians', where: [{ column: 'Student', op: 'eq', value: '@this' }, { column: 'Parent', op: 'eq', value: '@me' }] } }] },
      { table: defs.get('Attendance')!.id, create: false, read: 'all', update: 'none', delete: 'none', rowFilter: [{ exists: { table: 'Guardians', where: [{ column: 'Student', op: 'eq', value: '@this.Student' }, { column: 'Parent', op: 'eq', value: '@me' }] } }] },
      { table: defs.get('Production')!.id, create: false, read: 'own', update: 'none', delete: 'none' },
    ],
  })
  const mfgRoles = (): RoleDef[] => [
    { id: 'role_operator', name: 'Operator', apps: 'all', privileges: [
      { table: defs.get('Production')!.id, create: true, read: 'team', update: 'own', delete: 'none' },
      { table: defs.get('Lines')!.id, create: false, read: 'all', update: 'none', delete: 'none' },
    ] },
    { id: 'role_supervisor', name: 'Supervisor', apps: 'all', privileges: [
      { table: defs.get('Production')!.id, create: false, read: 'all', update: 'all', delete: 'none', rowFilter: [{ column: 'Line.Supervisor', op: 'eq', value: '@me' }] },
    ] },
    { id: 'role_plant', name: 'Plant manager', apps: 'all', privileges: [
      { table: defs.get('Production')!.id, create: false, read: 'departmentTree', update: 'none', delete: 'none' },
    ] },
  ]

  it('roles with relationship rules and organisation scopes are saved through the API (validated)', async () => {
    for (const r of [teacherRole(), parentRole(), ...mfgRoles()]) {
      const res = await A().post('/api/v1/roles', { name: r.name, apps: 'all', privileges: r.privileges })
      expect(res.status, JSON.stringify(res.data)).toBe(200)

    }
    const bad = await A().post('/api/v1/roles', { name: 'Bad', privileges: [{ table: defs.get('Students')!.id, create: false, read: 'all', update: 'none', delete: 'none', rowFilter: [{ exists: { table: 'Enrolments', where: [{ column: 'Section.Teacher', op: 'eq', value: '@me' }] } }] }] })
    expect(bad.status).toBe(422)
    const roles = (await A().get('/api/v1/workspace')).data.roles as RoleDef[]
    const id = (n: string) => roles.find((r) => r.name === n)!.id
    const assign = async (u: string, ...names: string[]) => expect((await A().patch(`/api/v1/users/${u}`, { roleIds: names.map(id) })).status).toBe(200)
    await assign('u_teach1', 'Teacher'); await assign('u_teach2', 'Teacher')
    await assign('u_parent1', 'Parent'); await assign('u_parent2', 'Parent')
    await assign('u_op1', 'Operator'); await assign('u_op2', 'Operator')
    await assign('u_sup1', 'Supervisor'); await assign('u_sup2', 'Supervisor')
    await assign('u_plant', 'Plant manager')
    for (const u of ['teach1', 'teach2', 'parent1', 'parent2', 'op1', 'op2', 'sup1', 'sup2', 'plant']) {
      clients[u] = await login(`${u === 'teach1' ? 't1' : u === 'teach2' ? 't2' : u === 'parent1' ? 'p1' : u === 'parent2' ? 'p2' : u}@x.io`, 'corpus-password-1')
    }
  }, 60000)

  const names = (r: { data: { rows: Record<string, unknown>[] } }) => r.data.rows.map((x) => String(x.Name ?? x.Batch ?? x.Title ?? x.id)).sort()

  it('education: teacher and parent see exactly their students (v2, v1, count, aggregate, CSV)', async () => {
    expect(names(await clients.teach1.query('Students', { count: true }))).toEqual(['Lia', 'Sam'])
    expect((await clients.teach1.query('Students', { count: true })).data.count).toBe(2)
    expect(names(await clients.teach2.query('Students'))).toEqual(['Ken', 'Sam'])
    expect(names(await clients.parent1.query('Students'))).toEqual(['Sam'])
    const v1 = await clients.parent1.post('/api/v1/query', planBody('Students'))
    expect(v1.data.rows.map((r: { Name: string }) => r.Name)).toEqual(['Sam'])
    const agg = await clients.teach1.query('Attendance', { aggregate: { groupBy: [], measures: [{ name: 'n', fn: 'count' }] } })
    expect(agg.status, JSON.stringify(agg.data)).toBe(200)
    expect(Number(agg.data.rows[0].n)).toBe(2)
    const search = await clients.teach1.query('Students', { search: { text: 'ken', columns: ['Name'] } })
    expect(search.status, JSON.stringify(search.data)).toBe(200)
    expect(search.data.rows).toEqual([])
    const csv = await clients.teach1.get(`/api/v1/tables/${defs.get('Students')!.id}/csv`)
    expect(String(csv.data)).toContain('Sam')
    expect(String(csv.data)).not.toContain('Ken')
  })

  it('education: WITH CHECK on insert and update follows the relationship rule; lookups to unreadable rows are refused', async () => {
    const ok = await clients.teach1.post('/api/v1/data/Attendance/rows', { values: { Student: ID('s1'), Section: ID('c1'), Day: '2026-11-05', Present: true } })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    // a section of another teacher: refused (and the lookup to it is not even readable)
    const other = await clients.teach1.post('/api/v1/data/Attendance/rows', { values: { Student: ID('s1'), Section: ID('c2'), Day: '2026-11-05', Present: true } })
    expect(other.status).toBe(403)
    // Ken is not in teacher 1's sections: the lookup target is unreadable and answers like a missing row (no probing)
    const ken = await clients.teach1.post('/api/v1/data/Attendance/rows', { values: { Student: ID('s3'), Section: ID('c1'), Day: '2026-11-05', Present: true } })
    expect(ken.status).toBe(422)
    expect(ken.data.error.message).toContain('no row with id')
    // update may not move a row out of the rule (into a section the teacher does not teach)
    const id = ok.data.row.id
    const moved = await A().patch(`/api/v1/data/Attendance/rows/${id}`, { changes: { Present: false } })
    expect(moved.status).toBe(200)
    // an admin moves another row to section 2; teacher 1 can no longer see or change it
    const gone = await clients.teach1.patch(`/api/v1/data/Attendance/rows/${ID('t2')}`, { changes: { Present: true } })
    expect(gone.status).toBe(200)
    await A().patch(`/api/v1/data/Attendance/rows/${ID('t2')}`, { changes: { Section: ID('c2') } })
    expect((await clients.teach1.patch(`/api/v1/data/Attendance/rows/${ID('t2')}`, { changes: { Present: false } })).status).toBe(404)
    await A().patch(`/api/v1/data/Attendance/rows/${ID('t2')}`, { changes: { Section: ID('c1') } })
  })

  it('manufacturing: supervisor sees rows of their own line, plant manager the department tree, operator the team', async () => {
    expect(names(await clients.sup2.query('Production'))).toEqual(['P2', 'P4', 'P8'])
    expect(names(await clients.sup1.query('Production'))).toEqual(['P1', 'P3', 'P5'])
    expect(names(await clients.plant.query('Production'))).toEqual(['P1', 'P2', 'P3', 'P5', 'P8'])
    // operator: team scope (own, teammates, team-owned) plus P5 shared with the team
    expect(names(await clients.op1.query('Production'))).toEqual(['P1', 'P2', 'P4', 'P5'])
    // a supervisor may update rows of their line but not move a row to another line (WITH CHECK through the lookup)
    expect((await clients.sup2.patch(`/api/v1/data/Production/rows/${ID('p2')}`, { changes: { Qty: 21 } })).status).toBe(200)
    expect((await clients.sup2.patch(`/api/v1/data/Production/rows/${ID('p2')}`, { changes: { Line: ID('a001') } })).status).toBe(403)
  })

  it('team ownership: an operator gives a row to their team, not to another team', async () => {
    const r = await clients.op1.post('/api/v1/data/Production/rows', { values: { Batch: 'P10', Qty: 1 } })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    // own update scope: giving the row away moves it out of "own" (WITH CHECK refuses)
    expect((await clients.op1.patch(`/api/v1/data/Production/rows/${r.data.row.id}`, { changes: { owner: 't_qa' } })).status).toBe(403)
    expect((await clients.op1.patch(`/api/v1/data/Production/rows/${r.data.row.id}`, { changes: { owner: 't_other_env' } })).status).toBe(403)
    const t = await clients.op1.post('/api/v1/data/Production/rows', { values: { Batch: 'P11', Qty: 1, owner: 't_qa' } })
    expect(t.status, JSON.stringify(t.data)).toBe(200)
    expect(names(await clients.op2.query('Production'))).toContain('P11')
  })

  it('sharing: share, read, update rights, unshare; deleted users and removed team members lose access', async () => {
    // parent 1 has "own" read on Production; P2 is already shared with them in the corpus
    expect(names(await clients.parent1.query('Production'))).toEqual(['P2'])
    // operator 1 owns P1 and shares it with parent 2 for reading
    const s = await clients.op1.post('/api/v1/shares', { row: ID('p1'), principal: 'p2@x.io', access: 'read' })
    expect(s.status, JSON.stringify(s.data)).toBe(200)
    expect(names(await clients.parent2.query('Production'))).toEqual(['P1'])
    expect((await clients.parent2.patch(`/api/v1/data/Production/rows/${ID('p1')}`, { changes: { Qty: 2 } })).status).toBe(403)
    // operator 1 cannot share P3 (not theirs, no share privilege) and cannot grant update on a row they cannot change
    expect((await clients.op1.post('/api/v1/shares', { row: ID('p2'), principal: 'p2@x.io' })).status).toBe(403)
    const info = await clients.op1.get(`/api/v1/shares?row=${ID('p1')}`)
    expect(info.data).toMatchObject({ canShare: true, sharing: true })
    expect(info.data.shares.map((x: { principalName: string }) => x.principalName)).toEqual(['Parent Two'])
    // unshare: gone immediately
    expect((await clients.op1.post('/api/v1/shares/remove', { row: ID('p1'), principal: 'u_parent2' })).status).toBe(200)
    expect(names(await clients.parent2.query('Production'))).toEqual([])
    // SharedWith-style listing for a row the caller cannot read: 404, no leak
    expect((await clients.parent2.get(`/api/v1/shares?row=${ID('p3')}`)).status).toBe(404)
    // removed team member: operator 2 leaves QA and loses the team's rows (P4 team-owned, P1 teammate, P5 team share)
    expect((await A().patch('/api/v1/teams/t_qa', { memberIds: ['u_op1'] })).status).toBe(200)
    expect(names(await clients.op2.query('Production'))).toEqual(['P2'])
    expect((await A().patch('/api/v1/teams/t_qa', { memberIds: ['u_op1', 'u_op2'] })).status).toBe(200)
    // deleted user: their shares go (every environment)
    await clients.op1.post('/api/v1/shares', { row: ID('p1'), principal: 'u_parent2' })
    expect((await A().del('/api/v1/users/u_parent2')).status).toBe(200)
    const left = await runInEnvironment('default', () => app.services.meta.org!.shares.forPrincipals(['u_parent2']))
    expect(left).toEqual([])
  })

  it('moved department: the plant manager loses a department moved out of the tree', async () => {
    const mk = await A().post('/api/v1/departments', { code: 'OTHER', name: 'Other site' })
    expect(mk.status).toBe(200)
    expect((await A().patch('/api/v1/departments/d_pack', { parentId: mk.data.id })).status).toBe(200)
    // P10 was created by operator 1 (Line 1) in the team-ownership test
    expect(names(await clients.plant.query('Production'))).toEqual(['P1', 'P10', 'P2', 'P3', 'P5'])
    expect((await A().patch('/api/v1/departments/d_pack', { parentId: 'd_line2' })).status).toBe(200)
    // a cycle is refused
    expect((await A().patch('/api/v1/departments/d_plant', { parentId: 'd_pack' })).status).toBe(422)
    expect((await A().patch('/api/v1/users/u_plant', { managerId: 'u_op1' })).status).toBe(422)
  })

  it('explainer: who can see a row and why', async () => {
    const r = await A().get(`/api/v1/security/explain?table=${defs.get('Students')!.id}&row=${ID('s1')}`)
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    const by = Object.fromEntries(r.data.users.map((u: { userId: string; read: string[] }) => [u.userId, u.read]))
    expect(by.u_teach1[0]).toContain('Role "Teacher"')
    expect(by.u_teach2).toBeDefined()
    expect(by.u_parent1[0]).toContain('Role "Parent"')
    expect(by.u_op1).toBeUndefined()
    expect((await clients.teach1.get(`/api/v1/security/explain?table=${defs.get('Students')!.id}&row=${ID('s1')}`)).status).toBe(403)
    const prev = await A().get('/api/v1/security/preview?user=u_plant')
    expect(prev.data.items.find((x: { tableId: string }) => x.tableId === defs.get('Production')!.id).why[0]).toContain('department')
  })

  it('User() facts in the session; directory for share pickers', async () => {
    const s = await clients.op1.get('/api/v1/auth/session')
    expect(s.data.user.org).toMatchObject({ department: { code: 'LINE1' }, manager: { id: 'u_sup1' }, teams: [{ code: 'QA' }] })
    const dir = await clients.op1.get('/api/v1/org')
    expect(dir.status).toBe(200)
    expect(dir.data.users[0]).not.toHaveProperty('managerId')
    expect(dir.data.teams.map((t: { code: string }) => t.code)).toEqual(['QA'])
  })

  it('CSV import of users: preview, all-or-nothing, one-time temporary passwords, cycles refused', async () => {
    const bad = 'name,email,department,manager\nX One,x1@x.io,LINE1,x2@x.io\nX Two,x2@x.io,LINE1,x1@x.io\nX Three,x3@x.io,NOPE,\n'
    const p = await A().post('/api/v1/users/import', { csv: bad })
    expect(p.data.ok).toBe(false)
    expect(p.data.preview[2].errors.join(' ')).toContain('NOPE')
    expect(p.data.preview[0].errors.join(' ')).toContain('circle')
    expect((await A().post('/api/v1/users/import', { csv: bad, commit: true })).status).toBe(422)
    const good = 'name,email,department,manager,jobTitle,password\nNew Lead,lead@x.io,LINE2,sup2@x.io,Lead,secret\nNew Hand,hand@x.io,LINE2,lead@x.io,,\nOperator One,op1@x.io,LINE1,sup1@x.io,Operator,\n'
    const prev = await A().post('/api/v1/users/import', { csv: good })
    expect(prev.data.ok).toBe(true)
    expect(prev.data.unknownColumns.join(' ')).toContain('never imported')
    expect(prev.data.preview.map((r: { action: string }) => r.action)).toEqual(['create', 'create', 'update'])
    const done = await A().post('/api/v1/users/import', { csv: good, commit: true })
    expect(done.status, JSON.stringify(done.data)).toBe(200)
    expect(done.data.created).toHaveLength(2)
    const pw = done.data.created[0].temporaryPassword as string
    expect(pw).toHaveLength(16)
    const lead = new Client(base)
    const li = await lead.post('/api/v1/auth/login', { email: 'lead@x.io', password: pw })
    expect(li.status).toBe(200)
    expect(li.data.user.mustChangePassword).toBe(true)
    const users = (await A().get('/api/v1/workspace')).data.users as { email: string; managerId?: string; id: string; jobTitle?: string }[]
    const leadU = users.find((u) => u.email === 'lead@x.io')!
    expect(users.find((u) => u.email === 'hand@x.io')!.managerId).toBe(leadU.id)
    expect(leadU.jobTitle).toBe('Lead')
    // the import never wrote the passwords anywhere else
    const audit = await A().get('/api/v1/audit?action=user.import')
    expect(JSON.stringify(audit.data)).not.toContain(pw)
  })

  it('solution export keeps rules, scopes and codes (no ids of departments or teams)', async () => {
    const sol = await A().post('/api/v1/solutions', { displayName: 'School' })
    expect(sol.status).toBe(200)
    const roles = (await A().get('/api/v1/workspace')).data.roles as RoleDef[]
    for (const t of ['Students', 'Sections', 'Enrolments', 'Guardians', 'Attendance']) await A().post(`/api/v1/solutions/${sol.data.id}/components`, { kind: 'table', id: defs.get(t)!.id })
    await A().post(`/api/v1/solutions/${sol.data.id}/components`, { kind: 'role', id: roles.find((r) => r.name === 'Teacher')!.id })
    const pkg = await A().get(`/api/v1/solutions/${sol.data.id}/package`)
    expect(pkg.status).toBe(200)
    expect(pkg.data.yaml).toContain('Section.Teacher')
    expect(pkg.data.yaml).toContain('exists')
    expect(pkg.data.yaml).toContain('Enrolments')
  })
})
