/**
 * THE TEST EVERY SOLUTION TEMPLATE MUST PASS (docs/dev/solution-templates.md "The pack test"). For every built-in
 * template of kind `solution` (found in the catalogue, so a new pack is covered as soon as it is listed in
 * builtin/index.ts), in a fresh environment against the sandbox PostgreSQL:
 *   1. the plan with the default bindings has no problem (dependencies planned first);
 *   2. the Linked install with SAMPLE rows succeeds in one transaction;
 *   3. nothing the install created still holds a slot or component token (apps, flows, policies, dashboards, print
 *      templates, table definitions, events, role rules);
 *   4. every flow arrived turned off and can be switched on (it validates against the environment);
 *   5. every print template generates a PDF for a SAMPLE row of its table (when it has a record source with SAMPLE rows);
 *   6. every SAMPLE row's display value starts with SAMPLE; "Remove sample data" removes all of them;
 *   7. the upgrade plan to the same version says it is the newest (no accidental changes);
 *   8. uninstall with "Delete tables with data" leaves no table, app, flow, role, policy, dashboard or print template of
 *      the pack behind, and nothing that existed before changed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PG_URL, SKIP_PG } from '../testdb.ts'
import { startHarness, type KernelHarness } from '../kernel-testkit.ts'
import { setQuiet } from '../util.ts'
import { catalogue } from './catalogue.ts'

setQuiet(true)
if (!PG_URL) process.stderr.write(`[built-in packs integration] ${SKIP_PG}\n`)
const S = 'env_default'
type Any = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const packs = catalogue().filter((e) => e.pkg.kind === 'solution' && e.source.endsWith('.json')).map((e) => e.pkg)

describe.skipIf(!PG_URL)(PG_URL ? 'every built-in solution template (PostgreSQL)' : `built-in packs ${SKIP_PG}`, { timeout: 600_000 }, () => {
  let h: KernelHarness
  beforeAll(async () => { h = await startHarness('tplbi') }, 120_000)
  afterAll(async () => { await h?.close() }, 60_000)

  it.each(packs.map((p) => [p.id, p] as const))('%s installs, works, removes its sample data and uninstalls cleanly', async (id) => {
    const A = h.admin
    const tablesBefore = (await h.q<Any>(`SELECT id FROM ${S}.ab_tables`)).map((r) => r.id).sort()
    const p = await A.post(`/templates/${id}/plan`, { mode: 'linked', sample: true })
    expect(p.status, JSON.stringify(p.data).slice(0, 500)).toBe(200)
    expect(p.data.plan.problems, `${id}: ${JSON.stringify(p.data.plan.problems)}`).toEqual([])
    const r = await A.post(`/templates/${id}/install`, { mode: 'linked', bindings: p.data.bindings, sample: true, confirm: p.data.plan.token, ...(p.data.plan.systemEvents?.length ? { approveSystem: true } : {}) })
    expect(r.status, JSON.stringify(r.data).slice(0, 800)).toBe(200)
    const rec = r.data.install
    const c = rec.created
    // 3. no token left anywhere
    const texts: string[] = []
    for (const a of c.apps) texts.push(JSON.stringify((await h.q<Any>(`SELECT definition FROM ${S}.ab_apps WHERE id = $1`, [a.id]))[0]))
    for (const t of c.tables) texts.push(JSON.stringify((await h.q<Any>(`SELECT def FROM ${S}.ab_tables WHERE id = $1`, [t.id]))[0]))
    for (const e of c.events) texts.push(JSON.stringify(await h.q<Any>(`SELECT * FROM ${S}.ab_table_events WHERE id = $1`, [e.id])))
    for (const f of c.flows) texts.push(JSON.stringify(await h.q<Any>(`SELECT definition FROM ${S}.ab_flows WHERE id = $1`, [f.id])))
    for (const x of c.approvalPolicies ?? []) texts.push(JSON.stringify(await h.q<Any>(`SELECT definition FROM ${S}.ab_approval_policies WHERE id = $1`, [x.id])))
    for (const x of c.dashboards ?? []) texts.push(JSON.stringify(await h.q<Any>(`SELECT def FROM ${S}.ab_dashboards WHERE id = $1`, [x.id])))
    for (const x of c.printTemplates ?? []) texts.push(JSON.stringify(await h.q<Any>(`SELECT doc, published FROM ${S}.ab_print_templates WHERE id = $1`, [x.id])))
    for (const x of c.roles) texts.push(JSON.stringify(await h.q<Any>(`SELECT row_filter, columns FROM ${S}.ab_role_tables WHERE role_id = $1`, [x.id])))
    for (const t of texts) expect(t, `${id}: a token is left after binding`).not.toMatch(/Slot_/)
    // 4. flows arrive off and can be switched on
    for (const f of c.flows) expect((await h.q<Any>(`SELECT enabled FROM ${S}.ab_flows WHERE id = $1`, [f.id]))[0].enabled, f.name).toBe(false)
    if (c.flows.length) {
      const on = await A.post(`/templates/installed/${rec.id}/flows`, { enable: c.flows.map((f: Any) => f.id) })
      expect(on.status, JSON.stringify(on.data)).toBe(200)
    }
    // 5. print templates generate for a SAMPLE row of their table
    const sampleRows: Record<string, string[]> = (await h.q<Any>(`SELECT sample_rows FROM ${S}.ab_template_installs WHERE id = $1`, [rec.id]))[0].sample_rows
    for (const x of c.printTemplates ?? []) {
      const t = (await h.q<Any>(`SELECT table_name FROM ${S}.ab_print_templates WHERE id = $1`, [x.id]))[0].table_name
      const def = t ? (await h.q<Any>(`SELECT id FROM ${S}.ab_tables WHERE lower(name) = lower($1)`, [t]))[0] : null
      const row = def ? sampleRows[def.id]?.[0] : undefined
      if (!row) continue
      const g = await A.post('/print/generate', { template: x.id, recordId: row })
      expect(g.status, `${x.name}: ${JSON.stringify(g.data).slice(0, 300)}`).toBe(200)
    }
    // 6. SAMPLE rows: labelled, and removed exactly
    for (const [tid, ids] of Object.entries(sampleRows)) {
      const t = (await h.q<Any>(`SELECT source, def FROM ${S}.ab_tables WHERE id = $1`, [tid]))[0]
      const prim = t.def.primaryColumn
      const vals = await h.q<Any>(`SELECT "${prim}" AS v FROM ${S}."${t.source}" WHERE id::text = ANY($1::text[])`, [ids])
      for (const v of vals) expect(String(v.v ?? ''), `${id}: a SAMPLE row of ${t.def.name}`).toMatch(/^SAMPLE/)
    }
    if (Object.keys(sampleRows).length) {
      const rm = await A.post(`/templates/installed/${rec.id}/sample/remove`, {})
      expect(rm.status, JSON.stringify(rm.data)).toBe(200)
      expect(rm.data.kept, `${id}: SAMPLE rows that could not be removed`).toEqual([])
    }
    // 7. no upgrade to the same version
    const up = await A.post(`/templates/installed/${rec.id}/upgrade/plan`, {})
    expect(up.data.plan.problems.join(' ')).toMatch(/is the newest/)
    // 8. uninstall everything (dependencies last), deleting tables
    const all = (await A.get('/templates/installed')).data.items.filter((x: Any) => x.status === 'installed')
    const order = [rec, ...all.filter((x: Any) => x.id !== rec.id && (rec.dependsOn ?? []).some((d: Any) => d.install === x.id))]
    for (const x of order) {
      const u = await A.post(`/templates/installed/${x.id}/uninstall/plan`, { deleteTables: true })
      expect(u.data.problems, `${x.templateId}: ${JSON.stringify(u.data.problems)}`).toEqual([])
      const done = await A.post(`/templates/installed/${x.id}/uninstall`, { confirm: u.data.token, deleteTables: true, confirmText: u.data.confirmText })
      expect(done.status, JSON.stringify(done.data).slice(0, 500)).toBe(200)
    }
    for (const a of c.apps) expect((await h.q(`SELECT 1 FROM ${S}.ab_apps WHERE id = $1`, [a.id])).length).toBe(0)
    for (const f of c.flows) expect((await h.q(`SELECT 1 FROM ${S}.ab_flows WHERE id = $1`, [f.id])).length).toBe(0)
    for (const r0 of c.roles) expect((await h.q(`SELECT 1 FROM ${S}.ab_roles WHERE id = $1`, [r0.id])).length).toBe(0)
    for (const x of c.dashboards ?? []) expect((await h.q(`SELECT 1 FROM ${S}.ab_dashboards WHERE id = $1`, [x.id])).length).toBe(0)
    for (const x of c.printTemplates ?? []) expect((await h.q(`SELECT 1 FROM ${S}.ab_print_templates WHERE id = $1`, [x.id])).length).toBe(0)
    for (const x of c.approvalPolicies ?? []) expect((await h.q(`SELECT 1 FROM ${S}.ab_approval_policies WHERE id = $1`, [x.id])).length).toBe(0)
    expect((await h.q<Any>(`SELECT id FROM ${S}.ab_tables`)).map((x) => x.id).sort()).toEqual(tablesBefore)
  })
})
