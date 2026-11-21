/**
 * P3-16: an upgrade that WIDENS a pack role's access says so, role by role, and runs only with the administrator's
 * explicit tick (`acceptWidening`), enforced by the server. A role kept local is not widened and not listed.
 *   APPBUILDER_TEST_DB=postgres://... npx vitest run server/core/templates/upgrade-widening
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { setQuiet } from '../util.ts'
import { registerTestTemplates } from './catalogue.ts'
import { visitorLogWider } from './testdata/visitor-log-next.ts'
import { roleWidening } from './packs.ts'
import type { TablePrivilege } from '../../../src/platform/contracts.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[upgrade widening integration] ${SKIP_PG}\n`)
const S = 'env_default'
type Any = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe('roleWidening (pure)', () => {
  const T = (id: string) => ({ T1: 'Visits', T2: 'Visitors' } as Record<string, string>)[id] ?? id
  const p = (table: string, more: Any = {}) => ({ table, create: false, read: 'none', update: 'none', delete: 'none', ...more }) as TablePrivilege
  it('lists new table access, wider scopes, create, shown columns, removed row rules, maker and apps', () => {
    const before = { apps: ['a1'], privileges: [p('T1', { read: 'own', update: 'own', rowFilter: [{ col: 'x', op: 'eq', value: 1 }] }), p('T2', { read: 'all', columns: { Phone: 'none' } })] }
    const after = { isMaker: true, apps: ['a1', 'a2'], privileges: [p('T1', { read: 'all', update: 'own', create: true }), p('T2', { read: 'all', delete: 'own' }), p('T3', { read: 'own' })] }
    const w = roleWidening(before, after, T, (a) => `App ${a}`)
    expect(w).toEqual(expect.arrayContaining([
      expect.stringMatching(/maker/), 'may run the app App a2', 'may create rows in Visits', expect.stringMatching(/reads all rows of Visits \(was their own rows\)/),
      expect.stringMatching(/Visits: its row rule is removed/), expect.stringMatching(/deletes their own rows of Visitors/), 'Visitors.Phone: hidden before, editable after', expect.stringMatching(/gets access to T3/),
    ]))
    expect(w.length).toBe(8)
  })
  it('narrower or equal access lists nothing', () => {
    const before = { isMaker: true, apps: 'all' as const, privileges: [p('T1', { read: 'all', update: 'all', create: true }), p('T2', { read: 'departmentTree' })] }
    const after = { apps: ['a1'], privileges: [p('T1', { read: 'own', update: 'none', columns: { A: 'read' }, rowFilter: [{ col: 'x', op: 'eq', value: 1 }] }), p('T2', { read: 'department' })] }
    expect(roleWidening(before, after, T)).toEqual([])
  })
})

describe.skipIf(!PG_URL)(PG_URL ? 'upgrades that widen role access (PostgreSQL)' : `upgrade widening ${SKIP_PG}`, { timeout: 300_000 }, () => {
  let h: KernelHarness
  let rec: Any
  let unregister: (() => void) | undefined
  beforeAll(async () => {
    h = await startHarness('tplwide')
    const A = h.admin
    const p = await A.post('/templates/builtin.visitor-log/plan', { mode: 'linked', sample: false })
    expect(p.status, JSON.stringify(p.data).slice(0, 500)).toBe(200)
    const r = await A.post('/templates/builtin.visitor-log/install', { mode: 'linked', bindings: p.data.bindings, sample: false, confirm: p.data.plan.token, ...(p.data.plan.systemEvents?.length ? { approveSystem: true } : {}) })
    expect(r.status, JSON.stringify(r.data).slice(0, 800)).toBe(200)
    rec = r.data.install
    unregister = registerTestTemplates([visitorLogWider()])
  }, 180_000)
  afterAll(async () => {
    unregister?.()
    await h?.close()
  }, 60_000)

  const hostRole = () => rec.created.roles.find((x: Any) => x.name === 'Visit host')
  const visits = () => rec.created.tables.find((t: Any) => t.slot === 'Visits')

  it('the plan names the widened role and what grows; Reception (unchanged) is not listed', async () => {
    const up = await h.admin.post(`/templates/installed/${rec.id}/upgrade/plan`, {})
    expect(up.status, JSON.stringify(up.data).slice(0, 500)).toBe(200)
    expect(up.data.plan.problems).toEqual([])
    expect(up.data.widens.map((w: Any) => w.name)).toEqual(['Visit host'])
    const ch = up.data.widens[0].changes.join(' | ')
    expect(ch).toMatch(/reads all rows of .*Visits.* \(was their own rows\)/)
    expect(ch).toMatch(/deletes their own rows of/)
    expect(ch).toMatch(/Phone: hidden before/)
    expect(up.data.plan.warnings.join(' ')).toMatch(/gives the role Visit host more access/)
  })

  it('the server refuses the upgrade without the tick (nothing changes), runs it with the tick, and audits it', async () => {
    const A = h.admin
    const up = (await A.post(`/templates/installed/${rec.id}/upgrade/plan`, {})).data
    const no = await A.post(`/templates/installed/${rec.id}/upgrade`, { confirm: up.plan.token })
    expect(no.status).toBe(422)
    expect(no.data.error.message).toMatch(/more access/)
    const before = await h.q<Any>(`SELECT read_scope AS read FROM ${S}.ab_role_tables WHERE role_id = $1 AND table_id = $2`, [hostRole().id, visits().id])
    expect(before[0].read).toBe('own')
    expect((await h.q<Any>(`SELECT template_version FROM ${S}.ab_template_installs WHERE id = $1`, [rec.id]))[0].template_version).toBe('1.0.0')
    const ok = await A.post(`/templates/installed/${rec.id}/upgrade`, { confirm: up.plan.token, acceptWidening: true })
    expect(ok.status, JSON.stringify(ok.data).slice(0, 500)).toBe(200)
    const after = await h.q<Any>(`SELECT read_scope AS read FROM ${S}.ab_role_tables WHERE role_id = $1 AND table_id = $2`, [hostRole().id, visits().id])
    expect(after[0].read).toBe('all')
    const audit = await h.q<Any>(`SELECT details FROM ${S}.ab_audit WHERE action = 'template.upgrade' ORDER BY at DESC LIMIT 1`)
    expect(audit[0].details.widenedRoles[0].name).toBe('Visit host')
  })
})
