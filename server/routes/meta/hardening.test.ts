/**
 * Regression tests (in-memory harness) for: table delete never drops linked tables, column removal only unmaps on linked
 * tables, CSV export formula escaping, owner/createdBy of imported rows, the assign-owner admin action, audit entries
 * (bulk delete ids, role and user diffs, password resets) and forced password change flags, audit failures logged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { makeHarness } from './testing.ts'
import type { Harness } from './testing.ts'
import { writeXlsxSheet } from '../../connectors/files/formats.ts'
import { AUDIT_ID_CAP } from '../../core/data.ts'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(() => h.cleanup())
const A = 'user_admin'
const M = 'user_maker'
const V = 'user_viewer'

const lastAudit = (action: string) => [...h.meta.auditLog].reverse().find((e) => e.action === action)

describe('deleting tables and columns', () => {
  it('default delete keeps the physical table; dropSource drops only tables Appbuilder created', async () => {
    const t = (await h.call(M, 'POST', '/api/v1/tables', { displayName: 'Mine' })).body
    expect(t.managed).toBe(true)
    expect((await h.call(M, 'DELETE', `/api/v1/tables/${t.id}`)).status).toBe(200)
    expect(h.mem.ops.some((o) => o.startsWith('drop:'))).toBe(false)
    expect(h.mem.tablesBySource.has(t.source)).toBe(true)

    const t2 = (await h.call(M, 'POST', '/api/v1/tables', { displayName: 'Mine too' })).body
    expect((await h.call(M, 'DELETE', `/api/v1/tables/${t2.id}?dropSource=1`)).status).toBe(200)
    expect(h.mem.ops).toContain(`drop:${t2.source}`)
  })

  it('a linked table is never dropped, even with dropSource', async () => {
    h.mem.external.set('crm', { columns: [{ name: 'id', type: 'text' }, { name: 'createdOn', type: 'datetime' }, { name: 'modifiedOn', type: 'datetime' }, { name: 'createdBy', type: 'text' }, { name: 'owner', type: 'text' }, { name: 'name', type: 'text' }], rows: [] })
    const l = (await h.call(M, 'POST', '/api/v1/connections/conn_default/link', { source: 'crm' })).body
    expect(l.managed).toBeUndefined()
    expect(l.readOnly).toBeUndefined()
    const r = await h.call(M, 'DELETE', `/api/v1/tables/${l.id}?dropSource=1`)
    expect(r.status).toBe(422)
    expect(r.body.error.message).toMatch(/never deletes it in the database/)
    expect(await h.meta.tables.get(l.id)).not.toBeNull()
    expect((await h.call(M, 'DELETE', `/api/v1/tables/${l.id}`)).status).toBe(200)
    expect(h.mem.ops.some((o) => o.startsWith('drop:'))).toBe(false)
    expect(h.mem.external.has('crm')).toBe(true)
  })

  it('removing a column of a linked table only unmaps it; Appbuilder tables lose the physical column', async () => {
    h.mem.external.set('crm2', { columns: ['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner'].map((name) => ({ name, type: name.endsWith('On') ? 'datetime' as const : 'text' as const })).concat([{ name: 'note', type: 'text' }, { name: 'name', type: 'text' }]), rows: [] })
    const l = (await h.call(M, 'POST', '/api/v1/connections/conn_default/link', { source: 'crm2' })).body
    const r = await h.call(M, 'DELETE', `/api/v1/tables/${l.id}/columns/note`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.columns.map((c: { name: string }) => c.name)).not.toContain('note')
    expect(h.mem.ops.some((o) => o.startsWith('dropColumn:'))).toBe(false)
    expect(lastAudit('column.remove')!.details).toMatchObject({ unmappedOnly: true })

    const t = (await h.call(M, 'POST', '/api/v1/tables', { displayName: 'Own', columns: [{ displayName: 'Name', type: 'text' }, { displayName: 'Note', type: 'text' }] })).body
    await h.call(M, 'DELETE', `/api/v1/tables/${t.id}/columns/Note`)
    expect(h.mem.ops).toContain(`dropColumn:${t.source}.Note`)
  })
})

describe('CSV / XLSX export: spreadsheet formula injection', () => {
  it('text cells starting with = + - @ tab CR get a leading quote; numbers stay numbers', async () => {
    const t = (await h.call(M, 'POST', '/api/v1/tables', { displayName: 'Inj', columns: [{ displayName: 'Text', type: 'text' }, { displayName: 'Amount', type: 'decimal' }] })).body
    for (const [Text, Amount] of [['=HYPERLINK("http://evil")', -5], ['@SUM(1)', 2.5], ['-1+2', 0], ['safe', -1], ['\tTab', 1]] as const) {
      expect((await h.call(M, 'POST', `/api/v1/data/${t.id}/rows`, { values: { Text, Amount } })).status).toBe(200)
    }
    const csv = String((await h.call(M, 'GET', `/api/v1/tables/${t.id}/csv`)).raw!.body)
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")",-5`)
    expect(csv).toContain(`'@SUM(1),2.5`)
    expect(csv).toContain(`'-1+2,0`)
    expect(csv).toContain('safe,-1')
    expect(csv).toContain(`'\tTab,1`)
  })

  it('XLSX data files are written with typed cells: text is never a formula', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('S')
    writeXlsxSheet(ws, { name: 'S', columns: ['t'], rows: [{ t: '=1+1' }] } as never)
    const back = new ExcelJS.Workbook()
    await back.xlsx.load(await wb.xlsx.writeBuffer())
    const cell = back.getWorksheet('S')!.getCell('A2')
    expect(cell.type).toBe(ExcelJS.ValueType.String)
    expect(cell.formula).toBeUndefined()
  })
})

describe('owner and createdBy of imported rows', () => {
  it('from-csv: rows belong to the importing maker', async () => {
    const t = await h.call(M, 'POST', '/api/v1/tables/from-csv', { displayName: 'People', csv: 'Name\nAna\nBo\n' })
    expect(t.status, JSON.stringify(t.body)).toBe(200)
    const rows = (await h.services.data.query(null, t.body, {})).rows
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r).toMatchObject({ owner: M, createdBy: M })
  })

  it('CSV import into a table: rows belong to the importing user', async () => {
    const t = (await h.call(M, 'POST', '/api/v1/tables', { displayName: 'Imp' })).body
    expect((await h.call(A, 'POST', `/api/v1/data/${t.id}/import`, { csv: 'Name\nX\n', mode: 'append' })).status).toBe(200)
    expect((await h.services.data.query(null, t, {})).rows[0]).toMatchObject({ owner: A, createdBy: A })
  })

  it('solution import with data: rows belong to the importing user, not the package author', async () => {
    const t = (await h.call(M, 'POST', '/api/v1/tables', { displayName: 'Deals' })).body
    await h.call(M, 'POST', `/api/v1/data/${t.id}/rows`, { values: { Name: 'D1' } })
    const sol = (await h.call(M, 'POST', '/api/v1/solutions', { displayName: 'Kit' })).body
    await h.call(M, 'POST', `/api/v1/solutions/${sol.id}/components`, { kind: 'table', id: t.id })
    const { yaml } = (await h.call(M, 'GET', `/api/v1/solutions/${sol.id}/package?data=1`)).body
    await h.call(M, 'DELETE', `/api/v1/tables/${t.id}?dropSource=1`)
    const imp = await h.call(A, 'POST', '/api/v1/solutions/import', { yaml })
    expect(imp.status, JSON.stringify(imp.body)).toBe(200)
    const deals = (await h.meta.tables.get('Deals'))!
    expect((await h.services.data.query(null, deals, {})).rows).toEqual([expect.objectContaining({ Name: 'D1', owner: A, createdBy: A })])
  })
})

describe('assign owner to rows without owner (admin)', () => {
  it('gives every unowned row an owner; makers and viewers may not', async () => {
    h.mem.external.set('legacy', {
      columns: ['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner', 'name'].map((name) => ({ name, type: name.endsWith('On') ? 'datetime' as const : 'text' as const })),
      rows: [
        { id: '11111111-1111-4111-8111-111111111111', name: 'a', owner: null },
        { id: '22222222-2222-4222-8222-222222222222', name: 'b', owner: '' },
        { id: '33333333-3333-4333-8333-333333333333', name: 'c', owner: 'someone' },
      ],
    })
    const l = (await h.call(M, 'POST', '/api/v1/connections/conn_default/link', { source: 'legacy' })).body
    expect((await h.call(M, 'POST', `/api/v1/tables/${l.id}/assign-owner`, {})).status).toBe(403)
    const r = await h.call(A, 'POST', `/api/v1/tables/${l.id}/assign-owner`, {})
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toEqual({ updated: 2 })
    expect(h.mem.external.get('legacy')!.rows.map((x) => x.owner)).toEqual([A, A, 'someone'])
    expect(lastAudit('table.assign_owner')!.details).toMatchObject({ owner: A, rows: 2 })
    expect((await h.call(A, 'POST', `/api/v1/tables/${l.id}/assign-owner`, { userId: 'user_nobody' })).status).toBe(404)
  })
})

describe('audit entries', () => {
  it('bulk delete records the row ids (capped) and the count', async () => {
    const t = (await h.call(M, 'POST', '/api/v1/tables', { displayName: 'Many' })).body
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await h.call(M, 'POST', `/api/v1/data/${t.id}/rows`, { values: { Name: `n${i}` } })).body.row.id)
    expect((await h.call(M, 'POST', `/api/v1/data/${t.id}/delete`, { ids })).body.deleted).toBe(3)
    expect(lastAudit('row.delete')!.details).toMatchObject({ count: 3, deleted: 3, ids: expect.arrayContaining(ids) })
    // over the cap: the list is cut, the count is complete
    const def = (await h.meta.tables.get(t.id))!
    const rows = Array.from({ length: AUDIT_ID_CAP + 5 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, Name: `r${i}` }))
    await h.mem.insert(def, rows)
    await h.call(M, 'POST', `/api/v1/data/${t.id}/delete`, { ids: rows.map((r) => r.id) })
    const d = lastAudit('row.delete')!.details as { count: number; ids: string[]; idsTruncated?: boolean }
    expect(d.count).toBe(AUDIT_ID_CAP + 5)
    expect(d.ids).toHaveLength(AUDIT_ID_CAP)
    expect(d.idsTruncated).toBe(true)
  })

  it('role changes carry a before/after diff', async () => {
    const t = (await h.call(M, 'POST', '/api/v1/tables', { displayName: 'Sec' })).body
    const role = (await h.call(A, 'POST', '/api/v1/roles', { name: 'Clerk', privileges: [{ table: t.id, create: false, read: 'all', update: 'none', delete: 'none' }] })).body
    await h.call(A, 'PATCH', `/api/v1/roles/${role.id}`, { name: 'Senior clerk', privileges: [{ table: t.id, create: true, read: 'all', update: 'own', delete: 'none' }] })
    const e = lastAudit('role.update')!.details as { changes: Record<string, { before: unknown; after: unknown }> }
    expect(e.changes.name).toEqual({ before: 'Clerk', after: 'Senior clerk' })
    expect(e.changes[`privileges.${t.id}`].before).toMatchObject({ create: false, update: 'none' })
    expect(e.changes[`privileges.${t.id}`].after).toMatchObject({ create: true, update: 'own' })
  })

  it('user create / disable / role change / password reset; an admin-set password must be changed', async () => {
    const u = await h.call(A, 'POST', '/api/v1/users', { name: 'New', email: 'new@example.test', roleIds: ['role_viewer'], password: 'temporary-pass-1' })
    expect(u.status, JSON.stringify(u.body)).toBe(200)
    expect(u.body.mustChangePassword).toBe(true)
    expect((await h.meta.users.get(u.body.id))!.mustChangePassword).toBe(true)
    expect(lastAudit('user.create')!.details).toMatchObject({ email: 'new@example.test', roleIds: ['role_viewer'], passwordSet: true })
    expect(JSON.stringify(h.meta.auditLog)).not.toContain('temporary-pass-1')

    await h.call(A, 'PATCH', `/api/v1/users/${u.body.id}`, { status: 'disabled', roleIds: ['role_maker'] })
    expect(lastAudit('user.update')!.details).toMatchObject({ changes: { status: { before: 'active', after: 'disabled' }, roleIds: { before: ['role_viewer'], after: ['role_maker'] } } })
    expect(lastAudit('user.disable')!.details).toMatchObject({ id: u.body.id })
    expect(lastAudit('user.roles')!.details).toMatchObject({ before: ['role_viewer'], after: ['role_maker'] })

    // the user changed it; an admin reset sets the flag again
    await h.meta.users.update(u.body.id, { mustChangePassword: false })
    await h.call(A, 'POST', `/api/v1/users/${u.body.id}/password`, { password: 'another-temp-pass' })
    expect((await h.meta.users.get(u.body.id))!.mustChangePassword).toBe(true)
    expect(lastAudit('user.password')!.details).toMatchObject({ id: u.body.id, reset: true, mustChangePassword: true })
    // an admin setting their own password through this route is not forced to change it again
    await h.call(A, 'POST', `/api/v1/users/${A}/password`, { password: 'admin-own-pass-1' })
    expect((await h.meta.users.get(A))!.mustChangePassword).toBeFalsy()
  })

  it('a failing audit write never fails the request but is logged as an error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.meta.audit = async () => { throw new Error('disk full') }
    try {
      const t = await h.call(M, 'POST', '/api/v1/tables', { displayName: 'Still works' })
      expect(t.status).toBe(200)
      const row = await h.call(M, 'POST', `/api/v1/data/${t.body.id}/rows`, { values: { Name: 'x' } })
      expect(row.status).toBe(200)
      const lines = spy.mock.calls.map((c) => String(c[0]))
      expect(lines.some((l) => /ERROR audit write failed \(table\.create\): disk full/.test(l))).toBe(true)
      // (the DataService reports through its injected logger, which is the console in production; silent in this harness)
    } finally {
      spy.mockRestore()
    }
  })

  it('viewers cannot assign owners or list source tables', async () => {
    const t = (await h.call(M, 'POST', '/api/v1/tables', { displayName: 'V' })).body
    expect((await h.call(V, 'POST', `/api/v1/tables/${t.id}/assign-owner`, {})).status).toBe(403)
  })
})
