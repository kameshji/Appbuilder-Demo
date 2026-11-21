/**
 * The table registry cache (table-cache.ts) against PostgreSQL: after every kind of model change the cached list equals
 * the database (no stale result): table create / rename / delete, column create / alter / delete, a solution import, a
 * deploy to another environment, a solution template install and uninstall, environment create (copy) / delete /
 * re-create, restore as a new environment, restore of tables, restore in place, a rolled-back transaction and a read
 * during an open one. One environment never sees another's list, and a person sees only the tables their role grants
 * (permissions are applied per request, after the cache).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { TableDef } from '../../src/platform/contracts.ts'
import { PG_URL, SKIP_PG } from './testdb.ts'
import { Client, startHarness, type KernelHarness } from './kernel-testkit.ts'
import { runInEnvironment } from './env-context.ts'
import { tableCacheStats } from './table-cache.ts'

if (!PG_URL) process.stderr.write(`[table-cache integration] ${SKIP_PG}\n`)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!PG_URL)('table registry cache (PostgreSQL)', () => {
  let h: KernelHarness
  const list = (env: string): Promise<TableDef[]> => runInEnvironment(env, () => h.app.services.meta.tables.list())
  /** the list without the cache (what the database holds now) */
  const truth = async (env: string): Promise<TableDef[]> => {
    process.env.APPBUILDER_TABLE_CACHE = 'off'
    try { return await list(env) } finally { delete process.env.APPBUILDER_TABLE_CACHE }
  }
  const names = (ts: TableDef[]) => ts.map((t) => t.name)
  /** fills the cache (a second read is a hit) */
  const prime = async (env: string) => {
    await list(env)
    const before = tableCacheStats().hits
    await list(env)
    expect(tableCacheStats().hits).toBe(before + 1)
  }
  /** the cached list equals the database's, definitions included */
  const fresh = async (env: string): Promise<TableDef[]> => {
    const cached = await list(env)
    const again = await list(env)
    const db = await truth(env)
    expect(JSON.stringify(cached)).toBe(JSON.stringify(db))
    expect(JSON.stringify(again)).toBe(JSON.stringify(db))
    return cached
  }
  const ok = (r: { status: number; data: Any }) => { expect(r.status, JSON.stringify(r.data).slice(0, 600)).toBe(200); return r.data }
  async function waitBackup(id: string): Promise<Any> {
    for (let i = 0; i < 600; i++) {
      const r = await h.admin.get(`/backups/${id}`)
      if (!['queued', 'running', 'verifying'].includes(r.data.state)) return r.data
      await sleep(100)
    }
    throw new Error('backup did not finish')
  }
  async function waitOp(id: string): Promise<Any> {
    for (let i = 0; i < 900; i++) {
      const r = await h.admin.get(`/backups/ops/${id}`)
      if (r.data.state !== 'running') return r.data
      await sleep(100)
    }
    throw new Error('restore did not finish')
  }

  beforeAll(async () => {
    h = await startHarness('tcache', { env: { APPBUILDER_MAX_ENVIRONMENTS: '12' } })
  }, 60_000)
  afterAll(async () => { await h?.app.services.backup.idle().catch(() => {}); await h?.close() }, 60_000)

  it('tables and columns: create, rename, add, alter, delete a column, delete the table', async () => {
    await prime('default')
    const t = ok(await h.admin.post('/tables', { displayName: 'Cache Orders', columns: [{ displayName: 'Title', type: 'text' }] }))
    expect(names(await fresh('default'))).toContain(t.name)
    await prime('default')
    ok(await h.admin.patch(`/tables/${t.id}`, { displayName: 'Cache Orders Renamed' }))
    expect((await fresh('default')).find((x) => x.id === t.id)?.displayName).toBe('Cache Orders Renamed')
    await prime('default')
    ok(await h.admin.post(`/tables/${t.id}/columns`, { displayName: 'Qty', type: 'number' }))
    expect((await fresh('default')).find((x) => x.id === t.id)?.columns.map((c) => c.name)).toContain('Qty')
    await prime('default')
    ok(await h.admin.patch(`/tables/${t.id}/columns/Qty`, { displayName: 'Quantity', required: true }))
    expect((await fresh('default')).find((x) => x.id === t.id)?.columns.find((c) => c.name === 'Qty')).toMatchObject({ displayName: 'Quantity', required: true })
    await prime('default')
    ok(await h.admin.del(`/tables/${t.id}/columns/Qty`))
    expect((await fresh('default')).find((x) => x.id === t.id)?.columns.map((c) => c.name)).not.toContain('Qty')
    await prime('default')
    ok(await h.admin.del(`/tables/${t.id}`))
    expect(names(await fresh('default'))).not.toContain(t.name)
  }, 60_000)

  it('a caller that changes its copy does not change the cache', async () => {
    await prime('default')
    const a = await list('default')
    a[0].displayName = 'changed by a caller'
    a[0].columns.push({ name: 'x', displayName: 'x', type: 'text' } as never)
    a.pop()
    await fresh('default')
  })

  it('transactions: a rolled-back write leaves no trace; a reader during an open write does not keep the old list', async () => {
    await prime('default')
    const sv = h.app.services
    const def = { ...(await list('default'))[0], id: 'tbl_tx_probe', name: 'TxProbe', displayName: 'Tx probe' }
    // a transaction that has not written the registry reads the cache (the committed list), and does not fill it
    const hits0 = tableCacheStats().hits
    const clean = await runInEnvironment('default', () => sv.transaction(async () => names(await sv.meta.tables.list())))
    expect(tableCacheStats().hits).toBe(hits0 + 1)
    expect(clean).toEqual(names(await truth('default')))
    let insideSaw = false
    let outsideDuring: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const tx = runInEnvironment('default', () => sv.transaction(async () => {
      await sv.meta.tables.upsert(def)
      insideSaw = names(await sv.meta.tables.list()).includes('TxProbe') // inside: its own write
      await gate
      throw new Error('roll back')
    })).catch(() => 'rolled back')
    await sleep(100)
    outsideDuring = names(await list('default')) // outside: the committed list, not stored
    outsideDuring = names(await list('default'))
    release()
    expect(await tx).toBe('rolled back')
    expect(insideSaw).toBe(true)
    expect(outsideDuring).not.toContain('TxProbe')
    expect(names(await fresh('default'))).not.toContain('TxProbe')
    // committed: visible at once after COMMIT
    await prime('default')
    let gate2!: () => void
    const g2 = new Promise<void>((r) => { gate2 = r })
    const tx2 = runInEnvironment('default', () => sv.transaction(async () => { await sv.meta.tables.upsert(def); await g2 }))
    await sleep(100)
    expect(names(await list('default'))).not.toContain('TxProbe')
    expect(names(await list('default'))).not.toContain('TxProbe')
    gate2()
    await tx2
    expect(names(await fresh('default'))).toContain('TxProbe')
    await runInEnvironment('default', () => sv.meta.tables.remove(def.id))
    expect(names(await fresh('default'))).not.toContain('TxProbe')
  })

  it('environments are separate; a person sees only what their role grants (after the cache)', async () => {
    const env = ok(await h.admin.post('/environments', { name: 'Cache other', type: 'sandbox' }))
    const other = env.id as string
    const a = ok(await h.admin.post('/tables', { displayName: 'Only Default', columns: [{ displayName: 'Title', type: 'text' }] }))
    const b = ok(await h.admin.post('/tables', { displayName: 'Secret Pay', columns: [{ displayName: 'Title', type: 'text' }] }))
    const o = h.admin
    o.env = other
    const c = ok(await o.post('/tables', { displayName: 'Only Other', columns: [{ displayName: 'Title', type: 'text' }] }))
    o.env = undefined
    await prime('default')
    await prime(other)
    expect(names(await fresh('default'))).toEqual(expect.arrayContaining([a.name, b.name]))
    expect(names(await list('default'))).not.toContain(c.name)
    expect(names(await fresh(other))).toContain(c.name)
    expect(names(await list(other))).not.toContain(a.name)
    // a role with access to one table only
    const role = ok(await h.admin.post('/roles', { name: 'Cache readers', apps: 'all', privileges: [{ table: a.id, create: false, read: 'all', update: 'none', delete: 'none' }] }))
    ok(await h.admin.post('/users', { name: 'Ravi Reader', email: 'ravi@example.com', roleIds: [role.id], password: 'reader-password-1' }))
    const ravi = (await h.q<Any>(`SELECT id FROM ab.users WHERE email = 'ravi@example.com'`))[0]
    await h.app.services.meta.users.update(ravi.id, { mustChangePassword: false })
    const r = new Client(h.base)
    ok(await r.post('/auth/login', { email: 'ravi@example.com', password: 'reader-password-1' }))
    const adminWs = names(ok(await h.admin.get('/workspace')).tables)
    const raviWs = names(ok(await r.get('/workspace')).tables)
    expect(adminWs).toEqual(expect.arrayContaining([a.name, b.name]))
    expect(raviWs).toContain(a.name)
    expect(raviWs).not.toContain(b.name)
    expect(raviWs).not.toContain(c.name)
    // a request for the other environment: Ravi has no access there
    r.env = other
    expect((await r.get('/workspace')).status).not.toBe(200)
    // delete and re-create the environment under the same name (same schema): no list of the old one survives
    await prime(other)
    ok(await h.admin.req('DELETE', `/environments/${other}`, { confirmName: 'Cache other', proceedWithoutBackup: true }))
    const again = ok(await h.admin.post('/environments', { name: 'Cache other', type: 'sandbox' }))
    expect(again.id).toBe(other)
    expect(names(await fresh(other))).not.toContain(c.name)
  }, 120_000)

  it('environment copy, solution import and deploy, template install and uninstall', async () => {
    await prime('default')
    const copy = ok(await h.admin.post('/environments', { name: 'Cache copy', type: 'sandbox', copyFrom: 'default', copy: 'schema' }))
    await prime(copy.id)
    // the copy takes the source's tables along (made in the test above)
    expect(names(await fresh(copy.id))).toEqual(expect.arrayContaining(names(await truth('default')).filter((n) => n === 'OnlyDefault' || n === 'SecretPay')))
    expect(names(await list(copy.id)).length).toBeGreaterThan(0)
    // a solution with a table, exported and imported into another environment, then deployed
    const t = ok(await h.admin.post('/tables', { displayName: 'Sol Items', columns: [{ displayName: 'Title', type: 'text' }] }))
    const sol = ok(await h.admin.post('/solutions', { name: 'CacheSol', displayName: 'Cache solution', publisher: 'Test', version: '1.0.0' }))
    ok(await h.admin.post(`/solutions/${sol.id}/components`, { kind: 'table', id: t.id }))
    const pkg = ok(await h.admin.get(`/solutions/${sol.id}/package`))
    const target = ok(await h.admin.post('/environments', { name: 'Cache import', type: 'sandbox' }))
    await prime(target.id)
    h.admin.env = target.id
    try {
      const plan = await h.admin.post('/solutions/import/plan', { yaml: pkg.yaml })
      ok(await h.admin.post('/solutions/import', { yaml: pkg.yaml, ...(plan.data?.token ? { confirm: plan.data.token } : {}), proceedWithoutBackup: true }))
    } finally { h.admin.env = undefined }
    expect(names(await fresh(target.id))).toContain(t.name)
    await prime(copy.id)
    const dplan = ok(await h.admin.post(`/solutions/${sol.id}/deploy`, { target: copy.id, plan: true }))
    ok(await h.admin.post(`/solutions/${sol.id}/deploy`, { target: copy.id, confirm: dplan.token, proceedWithoutBackup: true }))
    expect(names(await fresh(copy.id))).toContain(t.name)
    // a solution template: install, then uninstall deleting its tables
    await prime('default')
    const bindings = { Visitors: { mode: 'create', name: 'CacheVisitors', displayName: 'Visitors (cache)' } }
    const p = ok(await h.admin.post('/templates/builtin.visitor-log/plan', { mode: 'linked', bindings }))
    const inst = ok(await h.admin.post('/templates/builtin.visitor-log/install', { mode: 'linked', bindings: p.bindings, confirm: p.plan.token, ...(p.plan.systemEvents?.length ? { approveSystem: true } : {}) }))
    expect(names(await fresh('default'))).toContain('CacheVisitors')
    await prime('default')
    const installed = ok(await h.admin.get('/templates/installed')).items.filter((x: Any) => x.status === 'installed')
    const own = installed.find((x: Any) => x.id === inst.install.id)
    const order = [own, ...installed.filter((x: Any) => x.id !== own.id)]
    for (const x of order) {
      const u = ok(await h.admin.post(`/templates/installed/${x.id}/uninstall/plan`, { deleteTables: true }))
      ok(await h.admin.post(`/templates/installed/${x.id}/uninstall`, { confirm: u.token, deleteTables: true, confirmText: u.confirmText }))
      await fresh('default')
    }
    expect(names(await fresh('default'))).not.toContain('CacheVisitors')
  }, 180_000)

  it('restore: as a new environment, tables, in place', async () => {
    const keep = ok(await h.admin.post('/tables', { displayName: 'Kept In Backup', columns: [{ displayName: 'Title', type: 'text' }] }))
    ok(await h.admin.req('PUT', '/backups/settings', { method: 'builtin' }))
    const bk = await waitBackup(ok(await h.admin.post('/backups', { scope: 'default' })).id)
    expect(bk.state).toBe('ok')
    // as new
    const op = await waitOp(ok(await h.admin.post(`/backups/${bk.id}/restore`, { environment: 'default', mode: 'new', name: 'Cache restored' })).id)
    expect(op.state, JSON.stringify(op)).toBe('succeeded')
    const envs = ok(await h.admin.get('/environments')).items ?? ok(await h.admin.get('/environments'))
    const restored = (Array.isArray(envs) ? envs : []).find((e: Any) => e.name === 'Cache restored')
    expect(restored).toBeTruthy()
    expect(names(await fresh(restored.id))).toContain(keep.name)
    // tables: the table deleted after the backup comes back as a new table
    ok(await h.admin.del(`/tables/${keep.id}`))
    await prime('default')
    const tp = ok(await h.admin.post(`/backups/${bk.id}/restore-tables/plan`, { environment: 'default', tables: [keep.id], mode: 'new' }))
    const top = await waitOp(ok(await h.admin.post(`/backups/${bk.id}/restore-tables`, { environment: 'default', tables: [keep.id], mode: 'new', confirm: tp.token })).id)
    expect(top.state, JSON.stringify(top)).toBe('succeeded')
    const afterTables = await fresh('default')
    expect(afterTables.some((t) => t.displayName?.startsWith('Kept In Backup'))).toBe(true)
    // in place: the list is the backup's again
    const extra = ok(await h.admin.post('/tables', { displayName: 'After Backup', columns: [{ displayName: 'Title', type: 'text' }] }))
    await prime('default')
    expect(names(await list('default'))).toContain(extra.name)
    const ip = await waitOp(ok(await h.admin.post(`/backups/${bk.id}/restore`, { environment: 'default', mode: 'in-place', confirmName: 'Default' })).id)
    expect(ip.state, JSON.stringify(ip)).toBe('succeeded')
    const back = await fresh('default')
    expect(names(back)).not.toContain(extra.name)
    expect(names(back)).toContain(keep.name)
  }, 180_000)
})
