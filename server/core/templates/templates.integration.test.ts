/**
 * The templates catalogue over HTTP against the sandbox PostgreSQL (APPBUILDER_TEST_DB; creates and drops its own
 * database). Master-plan 11.3, Phase 2 exit check 5:
 *  - the four built-in kinds installed through plan + install, with the binding step (create, map to your own table with
 *    other column names, an optional column left out, a type mismatch explained in words);
 *  - a name clash resolved both ways (map to the existing table / install under a new name), an app-name clash, and an
 *    install blocked by an unmapped required slot;
 *  - NOTHING THAT EXISTED CHANGES: apps, tables (definitions and rows), columns, roles and their privileges, flows,
 *    relationships, table events, solutions and connections are snapshotted before and compared byte for byte after;
 *  - rule 8 (secrets and people stripped with a warning, run-as-system events need an administrator's approval), a
 *    damaged template refused, a locked production environment refusing, a maker installing a copy (roles skipped);
 *  - Linked: install, an upgrade-in-place plan with a local change kept, the upgrade; uninstall with tables with data
 *    kept unless the typed confirmation is given; the audit log; the schema 12 -> 13 step.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { Client, startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { setQuiet } from '../util.ts'
import { hashPassword } from '../password.ts'
import { ROLE_MAKER } from '../auth.ts'
import { registerTestTemplates } from './catalogue.ts'
import { runInEnvironment } from '../env-context.ts'
import type { TemplatePackage } from '../../../src/templates/format.ts'
import builtinTracker from './builtin/request-tracker.json' with { type: 'json' }

setQuiet(true)
if (!PG_URL) process.stderr.write(`[templates integration] ${SKIP_PG}\n`)

const S = 'env_default'

describe.skipIf(!PG_URL)(PG_URL ? 'templates catalogue (PostgreSQL)' : `templates catalogue ${SKIP_PG}`, { timeout: 300_000 }, () => {
  let h: KernelHarness
  let maker: Client
  let before: Map<string, string>
  let ticketsId = ''
  let requestsId = ''
  const unregister: (() => void)[] = []

  /** everything that exists, keyed, as text (jsonb text is normalised by PostgreSQL, so equal means byte-equal) */
  async function snapshot(): Promise<Map<string, string>> {
    const m = new Map<string, string>()
    const put = (k: string, v: unknown) => m.set(k, typeof v === 'string' ? v : JSON.stringify(v))
    for (const r of await h.q<{ id: string; name: string; description: string | null; definition: string; width: number; height: number }>(`SELECT id, name, description, definition::text AS definition, width, height FROM ${S}.ab_apps`)) put(`app:${r.id}`, r)
    const tables = await h.q<{ id: string; name: string; def: string; source: string | null; connection_id: string | null }>(`SELECT id, name, def::text AS def, source, connection_id FROM ${S}.ab_tables`)
    for (const t of tables) {
      put(`table:${t.id}`, t)
      const def = JSON.parse(t.def) as { managed?: boolean; system?: boolean; reporting?: unknown }
      if (t.source && def.managed && !def.reporting && (t.connection_id ?? 'conn_default') === 'conn_default') {
        const rows = await h.q<{ j: string }>(`SELECT coalesce(json_agg(x ORDER BY x.id)::text, '[]') AS j FROM ${S}."${t.source}" x`)
        put(`rows:${t.id}`, rows[0]!.j)
        const cols = await h.q(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name`, [S, t.source])
        put(`columns:${t.id}`, cols)
      }
    }
    for (const r of await h.q(`SELECT id, name, description, is_admin, is_maker, apps::text AS apps FROM ${S}.ab_roles`)) put(`role:${(r as { id: string }).id}`, r)
    for (const r of await h.q<{ role_id: string; table_id: string }>(`SELECT role_id, table_id, can_create, read_scope, update_scope, delete_scope, columns::text AS columns, row_filter::text AS row_filter FROM ${S}.ab_role_tables`)) put(`privilege:${r.role_id}:${r.table_id}`, r)
    for (const r of await h.q<{ user_id: string; role_id: string }>(`SELECT user_id, role_id FROM ${S}.ab_user_roles`)) put(`userrole:${r.user_id}:${r.role_id}`, r)
    for (const r of await h.q<{ id: string }>(`SELECT * FROM ${S}.ab_flows`)) put(`flow:${r.id}`, r)
    for (const r of await h.q<{ id: string }>(`SELECT * FROM ${S}.ab_flow_versions`)) put(`flowversion:${JSON.stringify(r).slice(0, 0)}${(r as Record<string, unknown>).flow_id}:${(r as Record<string, unknown>).version}`, r)
    for (const r of await h.q<{ id: string }>(`SELECT * FROM ${S}.ab_relationships`)) put(`relationship:${r.id}`, r)
    for (const r of await h.q<{ id: string }>(`SELECT * FROM ${S}.ab_table_events`)) put(`event:${r.id}`, r)
    for (const r of await h.q<{ id: string }>(`SELECT id, name, display_name, version, components::text AS components FROM ${S}.ab_solutions`)) put(`solution:${r.id}`, r)
    for (const r of await h.q<{ id: string }>(`SELECT id, name, connector, settings::text AS settings, status, is_default FROM ${S}.ab_connections`)) put(`connection:${r.id}`, r)
    return m
  }
  /** what existed before and is now different or gone */
  async function changedSince(base: Map<string, string>): Promise<string[]> {
    const now = await snapshot()
    return [...base.entries()].filter(([k, v]) => now.get(k) !== v).map(([k]) => k)
  }

  const table = (id: string) => runInEnvironment('default', () => h.app.services.meta.tables.get(id)).then((t) => (t && t.id === id ? t : null))
  const plan = (c: Client, id: string, body: Record<string, unknown>) => c.post(`/templates/${id}/plan`, body)
  async function install(c: Client, id: string, body: Record<string, unknown>) {
    const p = await plan(c, id, body)
    expect(p.status, JSON.stringify(p.data)).toBe(200)
    expect(p.data.plan.problems, JSON.stringify(p.data.plan.problems)).toEqual([])
    const r = await c.post(`/templates/${id}/install`, { ...body, bindings: p.data.bindings, confirm: p.data.plan.token })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    return { plan: p.data, result: r.data }
  }

  beforeAll(async () => {
    h = await startHarness('tpl')
    const A = h.admin
    // what exists before any template is used: tables with rows, a role, an app, a flow, a user
    const tickets = await A.post('/tables', { displayName: 'Tickets', name: 'Tickets', columns: [
      { name: 'Title', displayName: 'Title', type: 'text', required: true },
      { name: 'State', displayName: 'State', type: 'choice', choices: ['Pending', 'Approved', 'Rejected', 'New', 'In progress', 'Done'] },
      { name: 'Body', displayName: 'Body', type: 'multiline' },
      { name: 'Points', displayName: 'Points', type: 'number' },
    ] })
    expect(tickets.status, JSON.stringify(tickets.data)).toBe(200)
    ticketsId = tickets.data.id
    const req = await A.post('/tables', { displayName: 'Requests', name: 'Requests', columns: [
      { name: 'Title', displayName: 'Title', type: 'text', required: true }, { name: 'Status', displayName: 'Status', type: 'text' },
    ] })
    expect(req.status, JSON.stringify(req.data)).toBe(200)
    requestsId = req.data.id
    for (let i = 0; i < 3; i++) expect((await A.post('/data/Tickets/rows', { values: { Title: `Ticket ${i}`, State: 'Pending', Body: `Body ${i}`, Points: i } })).status).toBe(200)
    expect((await A.post('/data/Requests/rows', { values: { Title: 'Old request', Status: 'New' } })).status).toBe(200)
    const role = await A.post('/roles', { name: 'Field staff', apps: 'all', privileges: [{ table: ticketsId, create: true, read: 'own', update: 'own', delete: 'none' }] })
    expect(role.status, JSON.stringify(role.data)).toBe(200)
    const app = await A.post('/apps', { name: 'Existing app', width: 1920, height: 1080 })
    expect(app.status, JSON.stringify(app.data)).toBe(200)
    const flow = await A.post('/flows', { name: 'Existing flow', trigger: { type: 'manual', inputs: [], from: 'any' }, steps: [{ id: 'f', name: 'F', kind: 'compose', value: '"x"' }] })
    expect(flow.status, JSON.stringify(flow.data)).toBe(200)
    // a maker (not an administrator)
    const u = await A.post('/users', { name: 'Mona Maker', email: 'mona@example.com', password: 'maker-password-1', roleIds: [ROLE_MAKER] })
    expect(u.status, JSON.stringify(u.data)).toBe(200)
    await h.q('UPDATE ab.users SET must_change_password = false, password_hash = $1 WHERE email = $2', [await hashPassword('maker-password-1'), 'mona@example.com'])
    maker = new Client(h.base)
    expect((await maker.post('/auth/login', { email: 'mona@example.com', password: 'maker-password-1' })).status).toBe(200)
    before = await snapshot()
  }, 120_000)

  afterAll(async () => {
    for (const f of unregister) f()
    await h?.close()
  }, 60_000)

  it('the catalogue lists the four built-in kinds, each verified against the manifest', async () => {
    const r = await h.admin.get('/templates')
    expect(r.status).toBe(200)
    const kinds = new Set(r.data.items.map((x: { kind: string }) => x.kind))
    expect([...kinds].sort()).toEqual(['app', 'component', 'dataModel', 'screen'])
    for (const t of r.data.items) expect(t.integrity, t.id).toBe('builtin')
    const d = await h.admin.get('/templates/builtin.customers-contacts')
    expect(d.status).toBe(200)
    expect(d.data.contains.join(' ')).toMatch(/3 tables/)
    expect(d.data.sampleRows).toBe(9)
    // only makers
    const anon = new Client(h.base)
    expect((await anon.get('/templates')).status).toBe(401)
  })

  it('UI component template: created table, then mapped to your own table with other column names', async () => {
    const a = await install(h.admin, 'builtin.approval-bar', { target: { appId: 'app_x', appName: 'Existing app', screenName: 'Screen1' } })
    expect(a.plan.plan.items.some((i: { kind: string; change: string }) => i.kind === 'table' && i.change === 'new')).toBe(true)
    expect(a.plan.plan.items.find((i: { kind: string }) => i.kind === 'app').note).toMatch(/nothing in the app is replaced/)
    const json = JSON.stringify(a.result.controls)
    expect(json).not.toMatch(/Slot_/)
    expect(json).toContain('Filter(Decisions, Status = \\"Pending\\")')
    expect(a.result.dataSources).toEqual(['Decisions'])
    expect(a.result.install.created.tables[0].name).toBe('Decisions')
    // mapped: Status -> State, Details -> Body (the formulas follow, through the parser)
    const m = await install(h.admin, 'builtin.approval-bar', { bindings: { Request: { mode: 'map', table: ticketsId, columns: { Title: 'Title', Status: 'State', Details: 'Body' } } } })
    const mj = JSON.stringify(m.result.controls)
    expect(mj).toContain('Patch(Tickets, ApprovalPick.Selected, {State: \\"Approved\\"})')
    expect(mj).toContain('ApprovalPick.Selected.Body')
    expect(m.result.install.created.tables).toEqual([])
    expect(m.plan.plan.items.find((i: { kind: string; change: string }) => i.kind === 'table').change).toBe('unchanged')
  })

  it('a type mismatch is explained in words, and an unmapped required column blocks the install', async () => {
    const p = await plan(h.admin, 'builtin.approval-bar', { bindings: { Request: { mode: 'map', table: ticketsId, columns: { Title: 'Title', Status: 'Points' } } } })
    expect(p.status).toBe(200)
    const status = p.data.slots[0].columns.find((c: { id: string }) => c.id === 'Status')
    expect(status.problem).toMatch(/"Points" is a whole number column; Status needs a choice or text column/)
    expect(status.candidates.find((c: { name: string }) => c.name === 'State').ok).toBe(true)
    expect(p.data.plan.problems.length).toBeGreaterThan(0)
    const blocked = await plan(h.admin, 'builtin.approval-bar', { bindings: { Request: { mode: 'map', table: ticketsId, columns: { Title: 'Title', Status: null } } } })
    expect(blocked.data.plan.problems.join(' ')).toMatch(/Choose the column of Tickets for Status \(required\)/)
    const r = await h.admin.post('/templates/builtin.approval-bar/install', { bindings: blocked.data.bindings, confirm: blocked.data.plan.token })
    expect(r.status).toBe(422)
  })

  it('screen template: mapped, an optional column left out reads nothing, comma lists rewritten piece by piece', async () => {
    const s = await install(h.admin, 'builtin.list-detail', { bindings: { Items: { mode: 'map', table: ticketsId, columns: { Title: 'Title', Status: 'State', Notes: null } } }, target: { appName: 'Existing app' } })
    const sj = JSON.stringify(s.result.screen)
    expect(sj).not.toMatch(/Slot_/)
    expect(s.result.screen.props.Fill).toBeDefined()
    const form = s.result.screen.children.find((c: { name: string }) => c.name === 'ListDetailPanel').children.find((c: { name: string }) => c.name === 'ListForm')
    expect(form.props.DataSource).toBe('="Tickets"')
    expect(form.props.Fields).toBe('="Title, State"')
  })

  it('name clashes: an app-name clash and a table clash are blocked until resolved, both ways', async () => {
    // the Requests table exists: "create" is refused with the two ways out
    const p = await plan(h.admin, 'builtin.request-tracker', {})
    expect(p.status).toBe(200)
    const slot = p.data.slots[0]
    expect(slot.clash).toMatchObject({ name: 'Requests', suggestion: 'Requests2' })
    expect(p.data.plan.problems.join(' ')).toMatch(/A table named Requests already exists here\. Use it .* or install under another name/)
    // way 1: use the existing table (map)
    const mapped = await install(h.admin, 'builtin.request-tracker', { bindings: { Requests: { mode: 'map', table: requestsId, columns: { Title: 'Title', Status: 'Status' } } } })
    expect(mapped.result.install.created.tables).toEqual([])
    expect(mapped.result.install.created.apps[0].name).toBe('Request tracker')
    const app = await h.admin.get(`/apps/${mapped.result.appId}`)
    expect(JSON.stringify(app.data)).toContain('Filter(Requests,')
    expect(JSON.stringify(app.data)).not.toMatch(/Slot_/)
    // way 2: a new name; the app name is now taken too
    const again = await plan(h.admin, 'builtin.request-tracker', { bindings: { Requests: { mode: 'create', name: 'Requests2' } } })
    expect(again.data.appName).toMatchObject({ value: 'Request tracker', clash: true, suggestion: 'Request tracker (2)' })
    expect(again.data.plan.problems.join(' ')).toMatch(/An app named "Request tracker" already exists/)
    const renamed = await install(h.admin, 'builtin.request-tracker', { bindings: { Requests: { mode: 'create', name: 'Requests2', displayName: 'Requests 2' } }, appName: 'Request tracker (2)' })
    expect(renamed.result.install.created.tables[0].name).toBe('Requests2')
    expect(renamed.result.install.created.roles.length).toBe(1)
    // the role of the template: access to its table and its app, none to the rest
    const role = (await runInEnvironment('default', () => h.app.services.meta.roles.get(renamed.result.install.created.roles[0].id)))!
    expect(role.apps).toEqual([renamed.result.appId])
    expect(role.privileges.find((x: { table: string }) => x.table === renamed.result.install.created.tables[0].id)).toMatchObject({ create: true, read: 'all' })
    expect(role.privileges.find((x: { table: string }) => x.table === ticketsId)).toMatchObject({ read: 'none' })
  })

  it('data model template: tables through the data model plan path, relationships, a validation rule, SAMPLE rows', async () => {
    const contactsExists = (await h.q(`SELECT 1 FROM ${S}.ab_tables WHERE lower(name) = 'contacts'`)).length > 0
    const bindings = contactsExists ? { Contacts: { mode: 'create', name: 'CrmContacts', displayName: 'CRM contacts' } } : {}
    const d = await install(h.admin, 'builtin.customers-contacts', { bindings, sample: true })
    expect(d.result.install.created.tables.length).toBe(3)
    expect(d.result.install.created.sampleRows).toBe(9)
    expect(d.result.install.created.events.length).toBe(1)
    const cName = d.result.install.created.tables.find((t: { slot: string }) => t.slot === 'Contacts').name
    const cDef = (await table(d.result.install.created.tables.find((t: { slot: string }) => t.slot === 'Contacts').id))!
    const items = await h.q<{ FullName: string; Customer: string }>(`SELECT * FROM ${S}."${cDef.source}"`)
    expect(items.length).toBe(3)
    expect(items.every((r: { FullName: string }) => r.FullName.startsWith('SAMPLE '))).toBe(true)
    // the relationship from Contacts.Customer and the rule that checks the email
    const rels = await h.q<{ on_delete: string }>(`SELECT on_delete FROM ${S}.ab_relationships WHERE from_table = $1 AND from_column = 'Customer'`, [d.result.install.created.tables.find((t: { slot: string }) => t.slot === 'Contacts').id])
    expect(rels.map((r) => r.on_delete)).toEqual(['restrict'])
    const aName = d.result.install.created.tables.find((t: { slot: string }) => t.slot === 'Activities').name
    const bad = await h.admin.post(`/data/${aName}/rows`, { values: { Subject: 'X', Kind: 'Meeting', Customer: items[0].Customer } })
    expect(bad.status).toBe(422)
    expect(JSON.stringify(bad.data)).toMatch(/A meeting needs a date/)
    expect(cName).toBeTruthy()
  })

  it('a data model clash mapped to a table without the needed columns is blocked (unmapped required slot)', async () => {
    const p = await plan(h.admin, 'builtin.customers-contacts', { bindings: { Customers: { mode: 'map', table: ticketsId }, Contacts: { mode: 'create', name: 'Contacts_9' }, Activities: { mode: 'create', name: 'Activities_9' } } })
    expect(p.data.plan.problems.join(' ')).toMatch(/Choose the column of Tickets for Name \(required\)/)
    const r = await h.admin.post('/templates/builtin.customers-contacts/install', { bindings: p.data.bindings, confirm: p.data.plan.token })
    expect(r.status).toBe(422)
  })

  it('a maker installs a copy: the roles of an app template are skipped (administrators only), the rest goes in', async () => {
    const r = await install(maker, 'builtin.request-tracker', { bindings: { Requests: { mode: 'create', name: 'MakerRequests' } }, appName: 'Maker tracker' })
    expect(r.result.install.created.roles).toEqual([])
    expect(r.result.warnings.join(' ')).toMatch(/roles of the template are skipped/)
  })

  it('rule 8: secrets and people are stripped with a warning; run-as-system events need an administrator who approves', async () => {
    const pkg: TemplatePackage = {
      format: 'appbuilder/template', formatVersion: 1, id: 'test.risky', version: '1.0.0', kind: 'component', name: 'Risky', description: 'test', minPlatformVersion: '0.1.0', modes: ['copy'],
      slots: [{ id: 'Log', label: 'Log', required: true, create: { name: 'RiskyLog', displayName: 'Risky log' }, columns: [{ id: 'Text', label: 'Text', types: ['text'], required: true }],
        events: [{ name: 'Stamp', kind: 'event', timing: 'before', operations: ['create'], actions: 'SetField(Slot_Log_Text, "stamped")', runAs: 'system', enabled: true }] }],
      payload: {
        controls: [{ id: 'x', name: 'RiskyLabel', type: 'Label', props: { Text: '=CountRows(Slot_Log)' }, children: [] }],
        connections: [{ name: 'Mail', connector: 'smtp', password: 'hunter2' }],
        users: [{ email: 'someone@example.com' }],
      },
    }
    unregister.push(registerTestTemplates([pkg]))
    const mp = await plan(maker, 'test.risky', {})
    expect(mp.data.stripped.join(' ')).toMatch(/connections/)
    expect(mp.data.stripped.join(' ')).toMatch(/users and people/)
    expect(JSON.stringify(mp.data)).not.toContain('hunter2')
    expect(mp.data.plan.problems.join(' ')).toMatch(/only an administrator of this environment can install it/)
    const ap = await plan(h.admin, 'test.risky', {})
    expect(ap.data.plan.problems).toEqual([])
    expect(ap.data.plan.systemEvents).toEqual(['Log: Stamp'])
    const no = await h.admin.post('/templates/test.risky/install', { bindings: ap.data.bindings, confirm: ap.data.plan.token })
    expect(no.status).toBe(409)
    expect(no.data.error?.field ?? no.data.field).toBe('approveSystem')
    const yes = await h.admin.post('/templates/test.risky/install', { bindings: ap.data.bindings, confirm: ap.data.plan.token, approveSystem: true })
    expect(yes.status, JSON.stringify(yes.data)).toBe(200)
    const audit = await h.q<{ action: string }>(`SELECT action FROM ${S}.ab_audit WHERE action IN ('event.run_as_system', 'template.install') AND details::text LIKE '%test.risky%'`)
    expect(audit.map((a) => a.action).sort()).toEqual(['event.run_as_system', 'template.install'])
  })

  it('a damaged template is refused; a locked production environment refuses installs (use Deploy)', async () => {
    const pkg = { ...(builtinTracker as unknown as TemplatePackage), id: 'test.damaged', modes: ['copy'] as const }
    unregister.push(registerTestTemplates([pkg as unknown as TemplatePackage], { damaged: true }))
    const p = await plan(h.admin, 'test.damaged', {})
    expect(p.data.plan.problems.join(' ')).toMatch(/cannot be used/)
    expect((await h.admin.patch('/environments/default', { locked: true })).status).toBe(200)
    try {
      const lp = await plan(h.admin, 'builtin.approval-bar', {})
      expect(lp.data.plan.problems.join(' ')).toMatch(/locked/)
      const r = await h.admin.post('/templates/builtin.approval-bar/install', { confirm: lp.data.plan.token })
      expect(r.status).toBe(403)
    } finally {
      expect((await h.admin.patch('/environments/default', { locked: false })).status).toBe(200)
    }
  })

  it('Linked: installed as a versioned solution; a newer version arrives as an upgrade plan, a local change is kept by choice', async () => {
    const l = await install(h.admin, 'builtin.request-tracker', { mode: 'linked', bindings: { Requests: { mode: 'create', name: 'LinkedRequests' } }, appName: 'Linked tracker' })
    expect(l.plan.plan.mode).toBe('install')
    const rec = l.result.install
    expect(rec.mode).toBe('linked')
    expect(rec.solutionId).toBeTruthy()
    expect((await h.admin.get('/templates/installed')).data.items.find((x: { id: string }) => x.id === rec.id).upgradeTo).toBeUndefined()
    // a second Linked install of the same template is refused
    expect((await plan(h.admin, 'builtin.request-tracker', { mode: 'linked', bindings: { Requests: { mode: 'create', name: 'LinkedRequests2' } }, appName: 'Linked 2' })).data.plan.problems.join(' ')).toMatch(/already installed here as Linked/)
    // a local change to the app
    const appId = rec.created.apps[0].id
    const cur = (await h.admin.get(`/apps/${appId}`)).data
    const def = cur.definition ?? cur
    def.screens[0].children[0].props.Text = '="Our requests"'
    expect((await h.admin.req('PUT', `/apps/${appId}`, { definition: def })).status).toBe(200)
    // version 1.1.0: a new column and a changed title
    const v2 = JSON.parse(JSON.stringify(builtinTracker)) as TemplatePackage
    v2.version = '1.1.0'
    v2.slots[0].columns.push({ id: 'Requester', label: 'Requester', types: ['text'], required: false, create: { type: 'text' } })
    v2.payload.app!.screens[0].children[0].props.Text = '="Requests v2"'
    unregister.push(registerTestTemplates([v2]))
    expect((await h.admin.get('/templates/installed')).data.items.find((x: { id: string }) => x.id === rec.id).upgradeTo).toBe('1.1.0')
    const up = await h.admin.post(`/templates/installed/${rec.id}/upgrade/plan`, {})
    expect(up.status, JSON.stringify(up.data)).toBe(200)
    expect(up.data.plan.mode).toBe('upgrade')
    expect(up.data.localChanges).toEqual([{ key: `app:${appId}`, kind: 'app', name: 'Linked tracker', choice: 'keep' }])
    const tItem = up.data.plan.items.find((i: { kind: string; change: string }) => i.kind === 'table' && i.change === 'changed')
    expect(tItem.columns).toEqual([{ name: 'Requester', change: 'added', to: 'text' }])
    // a maker cannot upgrade in place
    expect((await maker.post(`/templates/installed/${rec.id}/upgrade/plan`, {})).data.plan.problems.join(' ')).toMatch(/only administrators/)
    const done = await h.admin.post(`/templates/installed/${rec.id}/upgrade`, { confirm: up.data.plan.token })
    expect(done.status, JSON.stringify(done.data)).toBe(200)
    const after = (await h.admin.get(`/apps/${appId}`)).data
    expect(JSON.stringify(after)).toContain('Our requests')
    const t = (await table(rec.created.tables[0].id))!
    expect(t.columns.some((c) => c.name === 'Requester')).toBe(true)
    const row = (await h.admin.get('/templates/installed')).data.items.find((x: { id: string }) => x.id === rec.id)
    expect(row.templateVersion).toBe('1.1.0')
    // replace the local change the next time: it is listed again (kept local) and can be replaced
    const up2 = await h.admin.post(`/templates/installed/${rec.id}/upgrade/plan`, { choices: { [`app:${appId}`]: 'replace' } })
    expect(up2.data.plan.problems.join(' ')).toMatch(/newest/)
  })

  it('uninstall: apps and roles go, tables with data stay unless the typed confirmation is given', async () => {
    const list = (await h.admin.get('/templates/installed')).data.items
    const tracker = list.find((x: { templateId: string; name: string; status: string }) => x.templateId === 'builtin.request-tracker' && x.name === 'Request tracker (2)' && x.status === 'installed')
    expect((await h.admin.post('/data/Requests2/rows', { values: { Title: 'Keep me', Status: 'New' } })).status).toBe(200)
    const p = await h.admin.post(`/templates/installed/${tracker.id}/uninstall/plan`, {})
    expect(p.status, JSON.stringify(p.data)).toBe(200)
    expect(p.data.items.find((i: { kind: string }) => i.kind === 'app').action).toBe('removed')
    expect(p.data.items.find((i: { kind: string }) => i.kind === 'role').action).toBe('removed')
    expect(p.data.items.find((i: { kind: string }) => i.kind === 'table')).toMatchObject({ action: 'kept', rows: 1 })
    const u = await h.admin.post(`/templates/installed/${tracker.id}/uninstall`, { confirm: p.data.token })
    expect(u.status, JSON.stringify(u.data)).toBe(200)
    expect((await h.admin.get(`/apps/${tracker.created.apps[0].id}`)).status).toBe(404)
    expect(await table(tracker.created.tables[0].id)).not.toBeNull()
    // the data model: tables with SAMPLE rows; delete them, with the typed confirmation
    const dm = list.find((x: { templateId: string; status: string }) => x.templateId === 'builtin.customers-contacts' && x.status === 'installed')
    const dp = await h.admin.post(`/templates/installed/${dm.id}/uninstall/plan`, { deleteTables: true })
    expect(dp.data.tablesWithData.length).toBe(3)
    expect(dp.data.items.filter((i: { kind: string; action: string; destructive?: boolean }) => i.kind === 'table' && i.action === 'removed' && i.destructive).length).toBe(3)
    expect((await maker.post(`/templates/installed/${dm.id}/uninstall/plan`, { deleteTables: true })).data.problems.join(' ')).toMatch(/Only an administrator can delete tables with data/)
    const wrong = await h.admin.post(`/templates/installed/${dm.id}/uninstall`, { confirm: dp.data.token, deleteTables: true, confirmText: 'yes' })
    expect(wrong.status).toBe(422)
    expect(wrong.data.error?.field ?? wrong.data.field).toBe('confirmText')
    const ok = await h.admin.post(`/templates/installed/${dm.id}/uninstall`, { confirm: dp.data.token, deleteTables: true, confirmText: dp.data.confirmText })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    for (const t of dm.created.tables) expect(await table(t.id)).toBeNull()
    const actions = (await h.q<{ action: string }>(`SELECT DISTINCT action FROM ${S}.ab_audit WHERE action LIKE 'template.%'`)).map((r) => r.action).sort()
    expect(actions).toEqual(['template.install', 'template.uninstall', 'template.upgrade'])
  })

  it('NOTHING that existed before changed: apps, tables, rows, columns, roles, privileges, flows, relationships, events', async () => {
    expect(await changedSince(before)).toEqual([])
  })

  it('schema 12 -> 13: the installed-templates register appears, nothing else changes', async () => {
    const n = (await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM ${S}.ab_template_installs`))[0]!.n
    expect(n).toBeGreaterThan(0)
    await h.q(`DROP TABLE ${S}.ab_template_installs`)
    await h.q(`UPDATE ab.environments SET schema_version = 12 WHERE id = 'default'`)
    const { migrateEnvironmentSchema, environmentDdl } = await import('../meta-store.ts')
    const db = h.app.services.state.db!
    // the migration runs the environment DDL (which creates the table), then the step checks it is there
    expect(await migrateEnvironmentSchema(db, { id: 'default', schema: S })).toEqual({ from: 12, to: 13 })
    expect((await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'ab_template_installs'`, [S]))[0]!.n).toBe(1)
    // a schema without the table is refused by the step (downgrade guard)
    const { upgradeEnvironmentTo13Templates } = await import('./ddl.ts')
    await h.q(`DROP TABLE ${S}.ab_template_installs`)
    await expect(upgradeEnvironmentTo13Templates(db, S)).rejects.toThrow(/missing/)
    for (const sql of environmentDdl(S)) await db.exec(sql)
  })
})
