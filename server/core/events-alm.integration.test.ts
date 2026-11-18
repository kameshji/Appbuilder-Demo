/**
 * Table events, validation rules, formula columns and rollups (and F's table sharing settings) travel with solutions:
 * export, install and upgrade-in-place plans (new / changed / removed events), run-as-system events need the
 * administrator's confirmation and are audited, copies import them disabled, environment copies keep them.
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/events-alm
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from './testdb.ts'
import { setQuiet } from './util.ts'
import { startHarness, Client, type KernelHarness } from './kernel-testkit.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[server/core events-alm integration] ${SKIP_PG}\n`)

describe.skipIf(!PG_URL)('events in solutions and environment copies (PostgreSQL)', () => {
  let h: KernelHarness
  let A: Client
  let T: Client
  let target = ''
  let partsId = ''
  let binsId = ''
  let solId = ''
  const drain = () => h.app.services.kernel.drain({ timeoutMs: 60_000 })
  const exportPkg = async (data = false) => (await A.get(`/solutions/${solId}/package${data ? '?data=1' : ''}`)).data.yaml as string

  beforeAll(async () => {
    h = await startHarness('evalm')
    A = h.admin
    const bins = await A.post('/tables', { displayName: 'Bins', name: 'Bins', columns: [{ displayName: 'Code', type: 'text' }] })
    binsId = bins.data.id
    const parts = await A.post('/tables', { displayName: 'Parts', name: 'Parts', columns: [{ displayName: 'Qty', type: 'number' }, { displayName: 'Price', type: 'decimal' }, { displayName: 'Bin', name: 'Bin', type: 'lookup', lookupTable: 'Bins' }] })
    partsId = parts.data.id
    expect((await A.post(`/tables/${partsId}/columns`, { displayName: 'Value', name: 'Value', type: 'decimal', computed: { kind: 'formula', formula: 'Qty * Price' } })).status).toBe(200)
    expect((await A.post(`/tables/${binsId}/columns`, { displayName: 'Stock', name: 'Stock', type: 'decimal', computed: { kind: 'rollup', table: 'Parts', via: 'Bin', fn: 'sum', column: 'Value' } })).status).toBe(200)
    expect((await A.post(`/tables/${partsId}/events`, { kind: 'validation', name: 'No negatives', condition: 'Qty >= 0', message: 'Qty cannot be negative', field: 'Qty' })).status).toBe(200)
    expect((await A.post(`/tables/${partsId}/events`, { name: 'Default price', timing: 'before', operations: ['create'], actions: 'If(IsBlank(New.Price), SetField({Price: 1}))' })).status).toBe(200)
    const sys = await A.post(`/tables/${partsId}/events`, { name: 'Count bins', timing: 'after', operations: ['create'], runAs: 'system', actions: 'Trace(Text(CountRows(Bins)))' })
    expect(sys.status, JSON.stringify(sys.data)).toBe(200)
    expect((await A.patch(`/tables/${partsId}`, { sharing: true })).status).toBe(200)
    const bin = (await A.post('/data/Bins/rows', { values: { Code: 'B1' } })).data.row.id
    await A.post('/data/Parts/rows', { values: { Qty: 2, Price: 5, Bin: bin } })
    await drain()
    const sol = await A.post('/solutions', { displayName: 'Stores' })
    solId = sol.data.id
    for (const id of [binsId, partsId]) expect((await A.post(`/solutions/${solId}/components`, { kind: 'table', id })).status).toBe(200)
    const env = await A.post('/environments', { name: 'Stores test', type: 'sandbox' })
    expect(env.status, JSON.stringify(env.data)).toBe(200)
    target = env.data.id
    T = new Client(h.base)
    T.cookie = A.cookie
    T.env = target
  }, 120000)

  afterAll(async () => { await h?.close() }, 60000)

  it('exports events and computed columns; install needs confirmation for run-as-system events and audits them', async () => {
    const yaml = await exportPkg(true)
    expect(yaml).toMatch(/events:/)
    expect(yaml).toMatch(/No negatives/)
    expect(yaml).toMatch(/kind: formula/)
    const plan = (await T.post('/solutions/import/plan', { yaml })).data
    expect(plan.mode).toBe('install')
    const evItems = plan.items.filter((i: any) => i.kind === 'event')
    expect(evItems.map((i: any) => [i.name, i.change]).sort()).toEqual([['Parts: Count bins', 'new'], ['Parts: Default price', 'new'], ['Parts: No negatives', 'new']])
    expect(plan.systemEvents).toEqual(['Parts: Count bins'])
    const noConfirm = await T.post('/solutions/import', { yaml })
    expect(noConfirm.status).toBe(409)
    expect(noConfirm.data.error.message).toMatch(/run as the system/)
    const ok = await T.post('/solutions/import', { yaml, confirm: plan.token })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    const events = (await T.get(`/tables/${partsId}/events`)).data.items
    expect(events.map((e: any) => e.name).sort()).toEqual(['Count bins', 'Default price', 'No negatives'])
    expect(events.find((e: any) => e.name === 'Count bins')).toMatchObject({ runAs: 'system', enabled: true })
    const audit = await h.q<{ action: string }>(`SELECT action FROM env_${target}.ab_audit WHERE action = 'event.run_as_system'`)
    expect(audit.length).toBe(1)
    // the rules work there: validation, before-event, formula column, rollup, F's sharing setting
    const bin = (await T.post('/data/Bins/rows', { values: { Code: 'T1' } })).data.row.id
    expect((await T.post('/data/Parts/rows', { values: { Qty: -1, Bin: bin } })).status).toBe(422)
    const p = await T.post('/data/Parts/rows', { values: { Qty: 3, Bin: bin } })
    expect(p.data.row).toMatchObject({ Price: 1, Value: 3 })
    await drain()
    const stock = (await T.post('/data/Bins/query', { where: { col: 'id', op: 'eq', value: bin } })).data.rows[0].Stock
    expect(stock).toBe(3)
    const imported = (await T.post('/data/Parts/query', { where: { col: 'Qty', op: 'eq', value: 2 } })).data.rows[0]
    expect(imported.Value).toBe(10)
    const def = (await h.q<{ def: any }>(`SELECT def FROM env_${target}.ab_tables WHERE id = $1`, [partsId]))[0].def
    expect(def.sharing).toBe(true)
  }, 120000)

  it('an upgrade shows changed and removed events, and a changed formula or sharing setting', async () => {
    const events = (await A.get(`/tables/${partsId}/events`)).data.items
    const rule = events.find((e: any) => e.name === 'No negatives')
    const before = events.find((e: any) => e.name === 'Default price')
    expect((await A.patch(`/tables/${partsId}/events/${rule.id}`, { message: 'Quantity cannot be negative' })).status).toBe(200)
    expect((await A.del(`/tables/${partsId}/events/${before.id}`)).status).toBe(200)
    expect((await A.patch(`/tables/${partsId}/columns/Value`, { computed: { kind: 'formula', formula: 'Qty * Price * 2' } })).status).toBe(200)
    expect((await A.patch(`/tables/${partsId}`, { sharing: false })).status).toBe(200)
    const yaml = await exportPkg()
    const plan = (await T.post('/solutions/import/plan', { yaml })).data
    expect(plan.mode).toBe('upgrade')
    const ev = Object.fromEntries(plan.items.filter((i: any) => i.kind === 'event').map((i: any) => [i.name, i.change]))
    expect(ev).toEqual({ 'Parts: No negatives': 'changed', 'Parts: Count bins': 'unchanged', 'Parts: Default price': 'removed' })
    expect(plan.systemEvents).toBeUndefined()
    const table = plan.items.find((i: any) => i.kind === 'table' && i.id === partsId)
    expect(table.change).toBe('changed')
    expect(table.columns).toEqual([{ name: 'Value', change: 'changed' }])
    const ok = await T.post('/solutions/import', { yaml, confirm: plan.token })
    expect(ok.status, JSON.stringify(ok.data)).toBe(200)
    await drain()
    const after = (await T.get(`/tables/${partsId}/events`)).data.items
    expect(after.map((e: any) => e.name).sort()).toEqual(['Count bins', 'No negatives'])
    expect(after.find((e: any) => e.name === 'No negatives').message).toBe('Quantity cannot be negative')
    const rows = (await T.post('/data/Parts/query', {})).data.rows
    for (const r of rows) expect(r.Value).toBe(r.Qty * r.Price * 2)
    const def = (await h.q<{ def: any }>(`SELECT def FROM env_${target}.ab_tables WHERE id = $1`, [partsId]))[0].def
    expect(def.sharing).toBeUndefined()
  }, 120000)

  it('a maker who is not an administrator cannot import run-as-system events', async () => {
    // a plan computed for a non-administrator lists the problem
    const yaml = (await exportPkg()).replace('runAs: caller', 'runAs: caller').replace(/name: Count bins/, 'name: Count bins 2')
    const services = h.app.services
    const { planSolution, readSolutionPkg } = await import('../routes/meta/alm.ts')
    const pkg = readSolutionPkg(yaml, services)!
    const user = await services.security.forUser((await services.meta.users.byEmail('ada@example.com'))!)
    const maker = { ...user, privileges: { ...user.privileges, isAdmin: false } }
    const { runInEnvironment } = await import('./env-context.ts')
    const plan = await runInEnvironment(target, () => planSolution(services, maker, pkg))
    expect(plan.plan.problems.join(' ')).toMatch(/only an administrator/)
  }, 60000)

  it('schema version 6: a version 5 database is upgraded (kernel tables created, version stamped); a newer one is refused', async () => {
    const { SCHEMA_VERSION } = await import('./meta-store.ts')
    expect(SCHEMA_VERSION).toBe(6)
    await h.q("UPDATE ab.settings SET v = '5' WHERE k = 'schemaVersion'")
    await h.q(`UPDATE ab.environments SET schema_version = 5 WHERE id = $1`, [target])
    await h.q(`DROP TABLE env_${target}.ab_event_runs`)
    const sum = await h.app.services.meta.migrate()
    expect(sum).toMatchObject({ from: 5, to: 6 })
    expect((sum as { steps: string[] }).steps.join(' ')).toMatch(/version 6/)
    expect((await h.q(`SELECT to_regclass('env_${target}.ab_event_runs') IS NOT NULL AS ok`))[0]).toEqual({ ok: true })
    expect((await h.q(`SELECT schema_version FROM ab.environments WHERE id = $1`, [target]))[0]).toEqual({ schema_version: 6 })
  }, 60000)

  it('an import as a copy brings events, run-as-system ones disabled; an environment copy keeps them', async () => {
    const yaml = await exportPkg()
    const env2 = await A.post('/environments', { name: 'Stores copy', type: 'sandbox' })
    const C = new Client(h.base)
    C.cookie = A.cookie
    C.env = env2.data.id
    const r = await C.post('/solutions/import', { yaml, asCopy: true })
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data.warnings.join(' ')).toMatch(/imported disabled/)
    const parts = (await C.get('/workspace')).data.tables.find((t: any) => t.name === 'Parts')
    const ev = (await C.get(`/tables/${parts.id}/events`)).data.items
    expect(ev.find((e: any) => e.name === 'Count bins')).toMatchObject({ enabled: false, runAs: 'system' })
    const copy = await A.post('/environments', { name: 'Stores clone', type: 'sandbox', copyFrom: 'default', copy: 'schema' })
    expect(copy.status, JSON.stringify(copy.data)).toBe(200)
    const n = await h.q<{ n: number }>(`SELECT count(*)::int AS n FROM env_${copy.data.id}.ab_table_events WHERE table_id = $1`, [partsId])
    expect(n[0].n).toBe(2)
  }, 120000)
})
