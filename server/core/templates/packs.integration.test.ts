/**
 * Solution templates (P3 package M1; docs/dev/solution-templates.md) over HTTP against the sandbox PostgreSQL
 * (APPBUILDER_TEST_DB; creates and drops its own database). The built-in Visitor log pack (every component kind) and the
 * common business model it depends on:
 *  - the plan: an administrator only; the dependency planned first; the Visitors clash with the pack's prefixed name; a
 *    number sequence of the same name with another format renamed; the plan grouped by kind;
 *  - the Linked install in one transaction: the business model installed first (its Accounts mapped to the table that
 *    exists), tables, relationships, validation rule, formula column, two apps (desktop, phone with offline tables),
 *    flow (arrives off), approval policy, dashboard, print template, two roles (own rows, a hidden column), a number
 *    sequence, reference rows and SAMPLE rows recorded by id; NextNumber numbering; a restricted role end to end; a
 *    pass printed; "Switch on these flows" (administrators);
 *  - dependencies respected (the business model cannot go while the pack is here);
 *  - upgrade 1.0.0 -> 2.0.0 with local changes (an app kept, a dashboard replaced, a changed reference row kept), new
 *    column added, dropped column kept and listed, sequence format changed with its next value kept, reference rows
 *    added and updated, the flow stays on; 2.0.0 -> 2.1.0 replacing the kept app;
 *  - "Remove sample data" removes exactly the SAMPLE rows (one still used by a row people added is kept);
 *  - uninstall keeping the tables with data, a Copy install, uninstall deleting tables with the typed confirmation;
 *  - NOTHING that existed changed (byte-equal snapshot, dashboards, print templates, policies and sequences included);
 *  - schema 13 -> 14.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { Client, startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { setQuiet } from '../util.ts'
import { hashPassword } from '../password.ts'
import { registerTestTemplates } from './catalogue.ts'
import { visitorLogNext } from './testdata/visitor-log-next.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[solution templates integration] ${SKIP_PG}\n`)

const S = 'env_default'
type Any = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!PG_URL)(PG_URL ? 'solution templates (PostgreSQL)' : `solution templates ${SKIP_PG}`, { timeout: 600_000 }, () => {
  let h: KernelHarness
  let host: Client
  let before: Map<string, string>
  let accountsId = ''
  let pack: Any
  let bm: Any
  const unregister: (() => void)[] = []

  async function snapshot(): Promise<Map<string, string>> {
    const m = new Map<string, string>()
    const put = (k: string, v: unknown) => m.set(k, typeof v === 'string' ? v : JSON.stringify(v))
    for (const r of await h.q<Any>(`SELECT id, name, description, definition::text AS definition, width, height FROM ${S}.ab_apps`)) put(`app:${r.id}`, r)
    for (const t of await h.q<Any>(`SELECT id, name, def::text AS def, source, connection_id FROM ${S}.ab_tables`)) {
      put(`table:${t.id}`, t)
      const def = JSON.parse(t.def)
      if (t.source && def.managed && !def.system && !def.reporting && (t.connection_id ?? 'conn_default') === 'conn_default') {
        put(`rows:${t.id}`, (await h.q<Any>(`SELECT coalesce(json_agg(x ORDER BY x.id)::text, '[]') AS j FROM ${S}."${t.source}" x`))[0].j)
        put(`columns:${t.id}`, await h.q(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name`, [S, t.source]))
      }
    }
    for (const r of await h.q<Any>(`SELECT id, name, description, is_admin, is_maker, apps::text AS apps FROM ${S}.ab_roles`)) put(`role:${r.id}`, r)
    for (const r of await h.q<Any>(`SELECT role_id, table_id, can_create, read_scope, update_scope, delete_scope, columns::text AS columns, row_filter::text AS row_filter FROM ${S}.ab_role_tables`)) put(`privilege:${r.role_id}:${r.table_id}`, r)
    for (const r of await h.q<Any>(`SELECT user_id, role_id FROM ${S}.ab_user_roles`)) put(`userrole:${r.user_id}:${r.role_id}`, r)
    for (const r of await h.q<Any>(`SELECT * FROM ${S}.ab_flows`)) put(`flow:${r.id}`, r)
    for (const r of await h.q<Any>(`SELECT * FROM ${S}.ab_relationships`)) put(`relationship:${r.id}`, r)
    for (const r of await h.q<Any>(`SELECT * FROM ${S}.ab_table_events`)) put(`event:${r.id}`, r)
    for (const r of await h.q<Any>(`SELECT id, name, display_name, version, components::text AS components FROM ${S}.ab_solutions`)) put(`solution:${r.id}`, r)
    for (const r of await h.q<Any>(`SELECT id, name, roles::text AS roles, def::text AS def FROM ${S}.ab_dashboards`)) put(`dashboard:${r.id}`, r)
    for (const r of await h.q<Any>(`SELECT id, name, version, doc::text AS doc, published::text AS published FROM ${S}.ab_print_templates`)) put(`print:${r.id}`, r)
    for (const r of await h.q<Any>(`SELECT id, name, definition::text AS definition FROM ${S}.ab_approval_policies`)) put(`policy:${r.id}`, r)
    for (const r of await h.q<Any>(`SELECT * FROM ${S}.sys_number_sequences`)) put(`sequence:${r.id}`, r)
    return m
  }
  const changedSince = async (base: Map<string, string>) => { const now = await snapshot(); return [...base.entries()].filter(([k, v]) => now.get(k) !== v).map(([k]) => k) }
  const plan = (body: Record<string, unknown>, c: Client = h.admin) => c.post('/templates/builtin.visitor-log/plan', body)
  const installs = async () => (await h.admin.get('/templates/installed')).data.items as Any[]
  const tableByName = async (name: string) => (await h.q<Any>(`SELECT id, source, def FROM ${S}.ab_tables WHERE lower(name) = lower($1)`, [name]))[0]
  const appDef = async (id: string) => (await h.q<Any>(`SELECT definition FROM ${S}.ab_apps WHERE id = $1`, [id]))[0]?.definition
  const bindings = { Visitors: { mode: 'create', name: 'VisVisitors', displayName: 'Visitors (reception)' } }

  beforeAll(async () => {
    h = await startHarness('tplpk')
    const A = h.admin
    // what exists before: an Accounts table with rows (the business model maps to it), a Visitors table (a clash), a
    // number sequence called "Visitor passes" with another format, a role called "Reception", a dashboard, a print
    // template, an approval policy
    const acc = await A.post('/tables', { displayName: 'Accounts', name: 'Accounts', columns: [{ name: 'Name', displayName: 'Name', type: 'text', required: true }, { name: 'Industry', displayName: 'Industry', type: 'text' }] })
    expect(acc.status, JSON.stringify(acc.data)).toBe(200)
    accountsId = acc.data.id
    expect((await A.post('/data/Accounts/rows', { values: { Name: 'Existing Pvt Ltd', Industry: 'Steel' } })).status).toBe(200)
    expect((await A.post('/tables', { displayName: 'Visitors', name: 'Visitors', columns: [{ name: 'Who', displayName: 'Who', type: 'text' }] })).status).toBe(200)
    expect((await A.post('/data/Visitors/rows', { values: { Who: 'Someone from before' } })).status).toBe(200)
    expect((await A.post('/data/NumberSequences/rows', { values: { Name: 'Visitor passes', Prefix: 'V-', Padding: 3, NextValue: 41 } })).status).toBe(200)
    expect((await A.post('/roles', { name: 'Reception', apps: 'all', privileges: [] })).status).toBe(200)
    expect((await A.post('/dashboards', { name: 'Existing board', def: { version: 1, title: 'Existing board', range: 'thisMonth', tiles: [] } })).status).toBe(200)
    expect((await A.post('/approvals/policies', { name: 'Existing policy', definition: { type: 'single', approvers: ['manager'] } })).status).toBe(200)
    // a person who will get the pack's restricted role
    const u = await A.post('/users', { name: 'Hari Host', email: 'hari@example.com', password: 'host-password-1', roleIds: [] })
    expect(u.status, JSON.stringify(u.data)).toBe(200)
    await h.q('UPDATE ab.users SET must_change_password = false, password_hash = $1 WHERE email = $2', [await hashPassword('host-password-1'), 'hari@example.com'])
    before = await snapshot()
  }, 180_000)

  afterAll(async () => {
    for (const f of unregister) f()
    await h?.close()
  }, 60_000)

  it('the catalogue lists the solution templates; the detail names the dependency', async () => {
    const r = await h.admin.get('/templates')
    expect(r.status).toBe(200)
    const sol = r.data.items.filter((x: Any) => x.kind === 'solution').map((x: Any) => x.id).sort()
    expect(sol).toEqual(['builtin.business-model', 'builtin.crm', 'builtin.erp-lite', 'builtin.manufacturing', 'builtin.visitor-log'])
    for (const t of r.data.items) expect(t.integrity, t.id).toBe('builtin')
    const d = (await h.admin.get('/templates/builtin.visitor-log')).data
    expect(d.dependencies).toEqual([{ id: 'builtin.business-model', name: 'Common business model', minVersion: '1.0.0' }])
    expect(d.contains.join(' | ')).toMatch(/2 apps .*phone/)
    expect(d.contains.join(' | ')).toMatch(/1 flow \(they arrive turned off\)/)
    expect(d.sampleRows).toBe(4)
  })

  it('the plan: administrators only; the dependency planned first; clashes resolved by the prefixed name', async () => {
    // a person without the administrator flag cannot install a pack
    const hu = new Client(h.base)
    expect((await hu.post('/auth/login', { email: 'hari@example.com', password: 'host-password-1' })).status).toBe(200)
    host = hu
    const p0 = await plan({ mode: 'linked' })
    expect(p0.status, JSON.stringify(p0.data)).toBe(200)
    const dep = p0.data.dependencies[0]
    expect(dep).toMatchObject({ id: 'builtin.business-model', action: 'install' })
    expect(dep.plan.items.find((i: Any) => i.kind === 'table' && i.name === 'Accounts').change).toBe('unchanged')
    const visitors = p0.data.slots.find((s: Any) => s.slot === 'Visitors')
    expect(visitors.clash).toMatchObject({ name: 'Visitors', suggestion: 'VisVisitors' })
    expect(p0.data.slots.find((s: Any) => s.slot === 'Companies').shared).toMatchObject({ template: 'builtin.business-model', slot: 'Accounts', table: 'Accounts' })
    expect(p0.data.sequences).toEqual([expect.objectContaining({ key: 'Passes', name: 'Visitor log Visitor passes', action: 'renamed' })])
    const p = await plan({ mode: 'linked', bindings, sample: true })
    expect(p.data.plan.problems, JSON.stringify(p.data.plan.problems)).toEqual([])
    const kinds = new Set(p.data.plan.items.filter((i: Any) => i.change === 'new').map((i: Any) => i.kind))
    for (const k of ['table', 'app', 'flow', 'approvalPolicy', 'dashboard', 'printTemplate', 'role', 'numberSequence', 'event']) expect(kinds.has(k), k).toBe(true)
    expect(p.data.plan.items.find((i: Any) => i.kind === 'flow').note).toMatch(/arrives turned off/)
    expect(p.data.plan.items.find((i: Any) => i.kind === 'table' && i.name === 'Visit purposes').note).toMatch(/3 reference rows/)
    expect(p.data.plan.items.find((i: Any) => i.kind === 'role' && i.change === 'new' && /Reception/.test(i.name)).name).toBe('Reception (2)')
    expect(p.data.plan.backup.message).toBeTruthy()
    // a maker without the administrator flag gets the reason; a person who is not a maker gets no plan at all
    expect((await plan({ mode: 'linked', bindings }, host)).status).toBe(403)
    const hari = (await h.q<Any>(`SELECT id FROM ab.users WHERE email = 'hari@example.com'`))[0]
    expect((await h.admin.patch(`/users/${hari.id}`, { roleIds: ['role_maker'] })).status).toBe(200)
    expect((await plan({ mode: 'linked', bindings }, host)).data.plan.problems.join(' ')).toMatch(/Only an administrator of this environment can install a solution template/)
    expect((await h.admin.patch(`/users/${hari.id}`, { roleIds: [] })).status).toBe(200)
    // a locked environment refuses (install in a sandbox, then Deploy)
    expect((await h.admin.patch('/environments/default', { locked: true })).status).toBe(200)
    try {
      const lp = await plan({ mode: 'linked', bindings })
      expect(lp.data.plan.problems.join(' ')).toMatch(/locked/)
      expect((await h.admin.post('/templates/builtin.visitor-log/install', { mode: 'linked', bindings, confirm: lp.data.plan.token })).status).toBe(403)
    } finally {
      expect((await h.admin.patch('/environments/default', { locked: false })).status).toBe(200)
    }
  })

  it('install (Linked): the dependency first, every component, in one transaction', async () => {
    const p = await plan({ mode: 'linked', bindings, sample: true })
    const r = await h.admin.post('/templates/builtin.visitor-log/install', { mode: 'linked', bindings: p.data.bindings, sample: true, confirm: p.data.plan.token })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    pack = r.data.install
    const all = await installs()
    bm = all.find((x) => x.templateId === 'builtin.business-model')!
    expect(bm.mode).toBe('linked')
    expect(pack.dependsOn).toEqual([{ template: 'builtin.business-model', install: bm.id, name: 'Common business model' }])
    expect(bm.usedBy).toEqual([{ template: 'builtin.visitor-log', install: pack.id, name: 'Visitor log' }])
    expect(bm.created.mapped.find((m: Any) => m.slot === 'Accounts').table).toBe(accountsId)
    // the environment has a Contacts table that does not fit (the sample app's): the model's gets its prefix instead
    expect(bm.created.tables.map((t: Any) => t.name).sort()).toEqual(['Addresses', 'CbmContacts', 'PriceListItems', 'PriceLists', 'Products', 'TaxCodes'])
    expect(pack.created.tables.map((t: Any) => t.name).sort()).toEqual(['VisVisitors', 'VisitPurposes', 'Visits'])
    expect(pack.created.mapped.find((m: Any) => m.slot === 'Companies').table).toBe(accountsId)
    expect(pack.created.apps.map((a: Any) => a.name).sort()).toEqual(['Reception desk', 'Visitor check-in'])
    expect(pack.created.flows.map((f: Any) => f.name)).toEqual(['Visitor log: Approve visits'])
    expect(pack.created.approvalPolicies.map((f: Any) => f.name)).toEqual(['Visitor log: Visit approval'])
    expect(pack.created.dashboards.map((f: Any) => f.name)).toEqual(['Visitor log: Visitors'])
    expect(pack.created.printTemplates.map((f: Any) => f.name)).toEqual(['Visitor log: Visitor pass'])
    expect(pack.created.sequences).toEqual([expect.objectContaining({ name: 'Visitor log Visitor passes' })])
    expect(pack.created.referenceRows).toBe(3)
    expect(pack.created.sampleRows).toBe(4)
    expect(pack.sampleRemaining).toBe(4)
    expect(pack.flowsOff).toEqual([{ id: pack.created.flows[0].id, name: 'Visitor log: Approve visits' }])
    // formulas bound: no token anywhere; the phone app's offline table; the default numbering with the renamed sequence
    for (const a of pack.created.apps) expect(JSON.stringify(await appDef(a.id))).not.toMatch(/Slot_/)
    const phone = await appDef(pack.created.apps.find((a: Any) => a.phone).id)
    expect(phone.offline).toEqual({ entry: true, tables: [{ table: 'VisitPurposes' }] })
    const visits = await tableByName('Visits')
    expect(visits.def.columns.find((c: Any) => c.name === 'PassNumber').default).toBe('=NextNumber("Visitor log Visitor passes")')
    expect(visits.def.columns.find((c: Any) => c.name === 'Host').lookupTable).toBe('Users')
    expect(JSON.stringify(await h.q(`SELECT definition FROM ${S}.ab_flows`))).not.toMatch(/Slot_/)
    const fl = (await h.q<Any>(`SELECT enabled, definition FROM ${S}.ab_flows WHERE id = $1`, [pack.created.flows[0].id]))[0]
    expect(fl.enabled).toBe(false)
    expect(fl.definition.steps[0].policy).toBe(pack.created.approvalPolicies[0].id)
    expect(fl.definition.trigger.table).toBe('Visits')
    const pol = (await h.q<Any>(`SELECT definition FROM ${S}.ab_approval_policies WHERE id = $1`, [pack.created.approvalPolicies[0].id]))[0]
    const reception = pack.created.roles.find((x: Any) => x.key === 'Reception')
    expect(pol.definition.approvers).toEqual([`role:${reception.id}`])
    const dash = (await h.q<Any>(`SELECT roles, def FROM ${S}.ab_dashboards WHERE id = $1`, [pack.created.dashboards[0].id]))[0]
    expect(dash.roles).toEqual([reception.id])
    expect(dash.def.tiles[1].query.groupBy).toEqual(['Status'])
    expect(JSON.stringify(dash.def)).not.toMatch(/Slot_/)
    // the existing sequence of the same name is untouched; the pack's starts at 1
    const seqs = await h.q<Any>(`SELECT "Name", "Prefix", "Padding", "NextValue" FROM ${S}.sys_number_sequences ORDER BY "Name"`)
    expect(seqs.find((x) => x.Name === 'Visitor passes')).toMatchObject({ Prefix: 'V-', NextValue: 41 })
    expect(seqs.find((x) => x.Name === 'Visitor log Visitor passes')).toMatchObject({ Prefix: 'VIS-', NextValue: 1 })
    // reference and SAMPLE rows
    const purposes = await h.q<Any>(`SELECT "Name" FROM ${S}."${(await tableByName('VisitPurposes')).source}" ORDER BY "Name"`)
    expect(purposes.map((x) => x.Name)).toEqual(['Delivery', 'Interview', 'Meeting'])
    const sv = await h.q<Any>(`SELECT "PassNumber", "Minutes" FROM ${S}."${visits.source}" ORDER BY "PassNumber"`)
    expect(sv.map((x) => x.PassNumber)).toEqual(['SAMPLE-0001', 'SAMPLE-0002'])
    expect(Number(sv[0].Minutes)).toBe(90)
    // one solution record, with its number sequence component
    const sol = (await h.q<Any>(`SELECT components FROM ${S}.ab_solutions WHERE id = $1`, [pack.solutionId]))[0]
    expect(sol.components.some((c: Any) => c.kind === 'numberSequence')).toBe(true)
    expect((await h.q<Any>(`SELECT count(*)::int AS n FROM ${S}.ab_audit WHERE action = 'template.install'`))[0].n).toBe(2)
  })

  it('use: numbering, a restricted role end to end, a printed pass, "Switch on these flows"', async () => {
    const A = h.admin
    const visitor = await A.post('/data/VisVisitors/rows', { values: { FullName: 'Neha Shah', Phone: '+91 90000 11111' } })
    expect(visitor.status, JSON.stringify(visitor.data)).toBe(200)
    const v1 = await A.post('/data/Visits/rows', { values: { Visitor: visitor.data.row.id, Status: 'Checked in', Arrival: '2026-11-20T09:00:00.000Z' } })
    expect(v1.status, JSON.stringify(v1.data)).toBe(200)
    expect(v1.data.row.PassNumber).toBe('VIS-0001')
    // the validation rule of the pack
    const bad = await A.post('/data/Visits/rows', { values: { Visitor: visitor.data.row.id, Arrival: '2026-11-20T10:00:00.000Z', Departure: '2026-11-20T09:00:00.000Z' } })
    expect(bad.status).toBe(422)
    expect(JSON.stringify(bad.data)).toMatch(/departure cannot be before the arrival/)
    // Hari gets the pack's Host role (assigning people stays a manual step)
    const hostRole = pack.created.roles.find((x: Any) => x.key === 'Host')
    const hari = (await h.q<Any>(`SELECT id FROM ab.users WHERE email = 'hari@example.com'`))[0]
    expect((await A.patch(`/users/${hari.id}`, { roleIds: [hostRole.id] })).status).toBe(200)
    const mine = await host.post('/data/Visits/rows', { values: { Visitor: visitor.data.row.id, Status: 'Expected', Arrival: '2026-11-21T09:00:00.000Z' } })
    expect(mine.status, JSON.stringify(mine.data)).toBe(200)
    const seen = await host.post('/query', { plan: { version: 2, table: 'Visits', select: ['id'] } })
    expect(seen.status, JSON.stringify(seen.data)).toBe(200)
    expect(seen.data.rows.map((x: Any) => x.id)).toEqual([mine.data.row.id])
    const people = await host.post('/query', { plan: { version: 2, table: 'VisVisitors', select: ['id', 'FullName'] } })
    expect(people.status, JSON.stringify(people.data)).toBe(200)
    expect(people.data.rows.length).toBeGreaterThan(0)
    // the hidden column: refused, or never in the answer
    const phones = await host.post('/query', { plan: { version: 2, table: 'VisVisitors', select: ['id', 'Phone'] } })
    expect(phones.status !== 200 || phones.data.rows.every((x: Any) => !('Phone' in x) || x.Phone === null), JSON.stringify(phones.data).slice(0, 300)).toBe(true)
    expect(JSON.stringify(phones.data)).not.toContain('90000 11111')
    // the pass prints
    const g = await A.post('/print/generate', { template: pack.created.printTemplates[0].id, recordId: v1.data.row.id })
    expect(g.status, JSON.stringify(g.data)).toBe(200)
    expect(g.data.file.fileName ?? g.data.file.name).toMatch(/VIS-0001/)
    // flows: administrators switch them on, only this install's
    expect((await host.post(`/templates/installed/${pack.id}/flows`, { enable: [pack.created.flows[0].id] })).status).toBe(403)
    expect((await A.post(`/templates/installed/${pack.id}/flows`, { enable: ['flow_other'] })).status).toBe(422)
    const on = await A.post(`/templates/installed/${pack.id}/flows`, { enable: [pack.created.flows[0].id] })
    expect(on.status, JSON.stringify(on.data)).toBe(200)
    expect(on.data.install.flowsOff).toBeUndefined()
    expect((await h.q<Any>(`SELECT action FROM ${S}.ab_audit WHERE action = 'template.flows.enable'`)).length).toBe(1)
  })

  it('dependencies are respected: the business model cannot be uninstalled while the pack needs it', async () => {
    const p = await h.admin.post(`/templates/installed/${bm.id}/uninstall/plan`, {})
    expect(p.data.problems.join(' ')).toMatch(/Visitor log needs this template: uninstall it first/)
    expect((await h.admin.post(`/templates/installed/${bm.id}/uninstall`, { confirm: p.data.token })).status).toBe(422)
  })

  it('upgrade 1.0.0 -> 2.0.0: local changes listed, kept or replaced by choice; data never changed', async () => {
    const A = h.admin
    // local changes: the desk app's title, the dashboard, a reference row
    const desk = pack.created.apps.find((a: Any) => !a.phone)
    const def = await appDef(desk.id)
    def.screens[0].children.find((c: Any) => c.name === 'DeskTitle').props.Text = '="Our front desk"'
    expect((await A.req('PUT', `/apps/${desk.id}`, { definition: def })).status).toBe(200)
    const dashId = pack.created.dashboards[0].id
    const dd = (await h.q<Any>(`SELECT def FROM ${S}.ab_dashboards WHERE id = $1`, [dashId]))[0]
    const ch = await A.patch(`/dashboards/${dashId}`, { def: { ...dd.def, description: 'Changed here' } })
    expect(ch.status, JSON.stringify(ch.data)).toBe(200)
    const purposes = await tableByName('VisitPurposes')
    await h.q(`UPDATE ${S}."${purposes.source}" SET "Name" = 'Job interview' WHERE "Name" = 'Interview'`)
    unregister.push(registerTestTemplates([visitorLogNext('2.0.0')]))
    const rec = (await installs()).find((x) => x.id === pack.id)!
    expect(rec.upgradeTo).toBe('2.0.0')
    const up = await A.post(`/templates/installed/${pack.id}/upgrade/plan`, {})
    expect(up.status, JSON.stringify(up.data)).toBe(200)
    const keys = up.data.localChanges.map((l: Any) => `${l.kind}:${l.choice}`).sort()
    expect(keys).toEqual(['app:keep', 'dashboard:keep', 'referenceRow:keep'])
    expect(up.data.noLongerUsed.join(' ')).toMatch(/Visits\.Minutes on site: no longer used/)
    const choices = { [`dashboard:${dashId}`]: 'replace' }
    const up2 = await A.post(`/templates/installed/${pack.id}/upgrade/plan`, { choices })
    expect(up2.data.plan.problems, JSON.stringify(up2.data.plan.problems)).toEqual([])
    const done = await A.post(`/templates/installed/${pack.id}/upgrade`, { confirm: up2.data.plan.token, choices })
    expect(done.status, JSON.stringify(done.data)).toBe(200)
    // kept: the app; replaced: the dashboard (three tiles, the local description gone)
    expect(JSON.stringify(await appDef(desk.id))).toContain('Our front desk')
    const dash = (await h.q<Any>(`SELECT def FROM ${S}.ab_dashboards WHERE id = $1`, [dashId]))[0]
    expect(dash.def.tiles.length).toBe(3)
    expect(dash.def.description).toBeUndefined()
    // tables: the new column added, the dropped one kept with its values
    const visitors = await tableByName('VisVisitors')
    expect(visitors.def.columns.some((c: Any) => c.name === 'Badge')).toBe(true)
    const visits = await tableByName('Visits')
    expect(visits.def.columns.some((c: Any) => c.name === 'Minutes')).toBe(true)
    // the sequence: five digits now, its next value unchanged
    const seq = (await h.q<Any>(`SELECT "Padding", "NextValue" FROM ${S}.sys_number_sequences WHERE "Name" = 'Visitor log Visitor passes'`))[0]
    expect(seq).toMatchObject({ Padding: 5, NextValue: 3 })
    // reference rows: one new, one updated, the changed one kept
    const names = (await h.q<Any>(`SELECT "Name" FROM ${S}."${purposes.source}" ORDER BY "Name"`)).map((x) => x.Name)
    expect(names).toEqual(['Contractor work', 'Deliveries', 'Job interview', 'Meeting'])
    // the flow stays on (it was on); its definition is the new version's
    const fl = (await h.q<Any>(`SELECT enabled, description FROM ${S}.ab_flows WHERE id = $1`, [pack.created.flows[0].id]))[0]
    expect(fl).toMatchObject({ enabled: true, description: expect.stringMatching(/version 2/) })
    // data rows were not changed
    const rows = await h.q<Any>(`SELECT "PassNumber" FROM ${S}."${visits.source}" ORDER BY "PassNumber"`)
    expect(rows.map((x) => x.PassNumber)).toEqual(['SAMPLE-0001', 'SAMPLE-0002', 'VIS-0001', 'VIS-0002'])
    // next time the kept app is listed again: replaced by 2.1.0
    unregister.push(registerTestTemplates([visitorLogNext('2.1.0')]))
    const up3 = await A.post(`/templates/installed/${pack.id}/upgrade/plan`, { choices: { [`app:${desk.id}`]: 'replace' } })
    expect(up3.data.localChanges.map((l: Any) => l.kind).sort()).toEqual(['app', 'referenceRow'])
    const done3 = await A.post(`/templates/installed/${pack.id}/upgrade`, { confirm: up3.data.plan.token, choices: { [`app:${desk.id}`]: 'replace' } })
    expect(done3.status, JSON.stringify(done3.data)).toBe(200)
    const after = JSON.stringify(await appDef(desk.id))
    expect(after).toContain('Front desk')
    expect(after).not.toContain('Our front desk')
    expect((await installs()).find((x) => x.id === pack.id)!.templateVersion).toBe('2.1.0')
  })

  it('"Remove sample data" removes exactly the SAMPLE rows; one still used by your row is kept', async () => {
    const visitors = await tableByName('VisVisitors')
    const ravi = (await h.q<Any>(`SELECT id FROM ${S}."${visitors.source}" WHERE "FullName" = 'SAMPLE Ravi Kumar'`))[0]
    // a row people added points at a SAMPLE visitor (restrict): that visitor stays
    const mine = await h.admin.post('/data/Visits/rows', { values: { Visitor: ravi.id, Status: 'Expected' } })
    expect(mine.status, JSON.stringify(mine.data)).toBe(200)
    const r = await h.admin.post(`/templates/installed/${pack.id}/sample/remove`, {})
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data.removed, JSON.stringify(r.data.kept)).toBe(3)
    expect(r.data.kept.length).toBe(1)
    expect(r.data.install.sampleRemaining).toBe(1)
    const visits = await tableByName('Visits')
    const left = (await h.q<Any>(`SELECT "PassNumber" FROM ${S}."${visits.source}" ORDER BY "PassNumber"`)).map((x) => x.PassNumber)
    expect(left.some((x) => x.startsWith('SAMPLE'))).toBe(false)
    expect(left.length).toBe(3)
    expect((await h.q<Any>(`SELECT "FullName" FROM ${S}."${visitors.source}" ORDER BY "FullName"`)).map((x) => x.FullName)).toEqual(['Neha Shah', 'SAMPLE Ravi Kumar'])
  })

  it('uninstall: keeps tables with data; a used number sequence is kept; then the dependency can go', async () => {
    const A = h.admin
    const p = await A.post(`/templates/installed/${pack.id}/uninstall/plan`, {})
    expect(p.status, JSON.stringify(p.data)).toBe(200)
    const by = (k: string) => p.data.items.filter((i: Any) => i.kind === k)
    for (const k of ['app', 'flow', 'role', 'approvalPolicy', 'dashboard', 'printTemplate']) expect(by(k).every((i: Any) => i.action === 'removed') && by(k).length > 0, k).toBe(true)
    expect(by('numberSequence')[0]).toMatchObject({ action: 'kept' })
    expect(by('table').filter((i: Any) => i.action === 'kept').length).toBeGreaterThanOrEqual(3)
    const u = await A.post(`/templates/installed/${pack.id}/uninstall`, { confirm: p.data.token })
    expect(u.status, JSON.stringify(u.data)).toBe(200)
    expect((await h.q(`SELECT 1 FROM ${S}.ab_flows WHERE id = $1`, [pack.created.flows[0].id])).length).toBe(0)
    expect((await h.q(`SELECT 1 FROM ${S}.ab_dashboards WHERE id = $1`, [pack.created.dashboards[0].id])).length).toBe(0)
    expect(await tableByName('Visits')).toBeTruthy()
    // now the business model may go: its own tables (empty) are dropped, the Accounts table it mapped is never touched
    const bp = await A.post(`/templates/installed/${bm.id}/uninstall/plan`, {})
    expect(bp.data.problems).toEqual([])
    expect(bp.data.items.find((i: Any) => i.id === accountsId)).toMatchObject({ action: 'kept' })
    expect((await A.post(`/templates/installed/${bm.id}/uninstall`, { confirm: bp.data.token })).status).toBe(200)
    expect(await tableByName('Products')).toBeUndefined()
    expect(await tableByName('Accounts')).toBeTruthy()
  })

  it('a Copy (not linked) installs without a solution record; uninstall deletes tables with data after the typed confirmation', async () => {
    const A = h.admin
    const b = { Visitors: { mode: 'create', name: 'CopyVisitors' }, Visits: { mode: 'create', name: 'CopyVisits' }, VisitPurposes: { mode: 'create', name: 'CopyPurposes' } }
    const p = await plan({ mode: 'copy', bindings: b, sample: true })
    expect(p.data.plan.problems, JSON.stringify(p.data.plan.problems)).toEqual([])
    const r = await A.post('/templates/builtin.visitor-log/install', { mode: 'copy', bindings: p.data.bindings, sample: true, confirm: p.data.plan.token })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    const rec = r.data.install
    expect(rec.mode).toBe('copy')
    expect(rec.solutionId).toBeUndefined()
    expect(rec.upgradeTo).toBeUndefined()
    expect(rec.created.flows[0].name).toBe('Visitor log: Approve visits')
    expect((await h.q<Any>(`SELECT solution_id FROM ${S}.ab_flows WHERE id = $1`, [rec.created.flows[0].id]))[0].solution_id).toBeNull()
    const dp = await A.post(`/templates/installed/${rec.id}/uninstall/plan`, { deleteTables: true })
    expect(dp.data.tablesWithData.length).toBeGreaterThan(0)
    expect((await A.post(`/templates/installed/${rec.id}/uninstall`, { confirm: dp.data.token, deleteTables: true, confirmText: 'wrong' })).status).toBe(422)
    const ok = await A.post(`/templates/installed/${rec.id}/uninstall`, { confirm: dp.data.token, deleteTables: true, confirmText: dp.data.confirmText })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    for (const t of rec.created.tables) expect((await h.q(`SELECT 1 FROM ${S}.ab_tables WHERE id = $1`, [t.id])).length).toBe(0)
    // the dependency it installed again stays (another pack may use it); its own uninstall is separate
    expect((await installs()).filter((x) => x.templateId === 'builtin.business-model' && x.status === 'installed').length).toBe(1)
  })

  it('NOTHING that existed before changed (dashboards, print templates, policies and number sequences included)', async () => {
    expect(await changedSince(before)).toEqual([])
  })

  it('schema 13 -> 14: the register columns appear, nothing else changes; the step refuses a schema without them', async () => {
    const n = (await h.q<Any>(`SELECT count(*)::int AS n FROM ${S}.ab_template_installs`))[0].n
    expect(n).toBeGreaterThan(0)
    for (const c of ['sample_rows', 'reference_rows', 'depends_on']) await h.q(`ALTER TABLE ${S}.ab_template_installs DROP COLUMN ${c}`)
    await h.q(`UPDATE ab.environments SET schema_version = 13 WHERE id = 'default'`)
    const { migrateEnvironmentSchema, SCHEMA_VERSION } = await import('../meta-store.ts')
    const db = h.app.services.state.db!
    expect(await migrateEnvironmentSchema(db, { id: 'default', schema: S })).toEqual({ from: 13, to: SCHEMA_VERSION })
    const cols = (await h.q<Any>(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'ab_template_installs'`, [S])).map((r) => r.column_name)
    for (const c of ['sample_rows', 'reference_rows', 'depends_on']) expect(cols).toContain(c)
    expect((await h.q<Any>(`SELECT count(*)::int AS n FROM ${S}.ab_template_installs`))[0].n).toBe(n)
    const { upgradeEnvironmentTo14Templates, templatesEnvironmentDdl } = await import('./ddl.ts')
    await h.q(`ALTER TABLE ${S}.ab_template_installs DROP COLUMN depends_on`)
    await expect(upgradeEnvironmentTo14Templates(db, S)).rejects.toThrow(/missing/)
    for (const sql of templatesEnvironmentDdl(S)) await db.exec(sql)
  })
})
