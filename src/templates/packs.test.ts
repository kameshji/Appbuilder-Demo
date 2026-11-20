/**
 * Format 2 (solution templates, P3 package M1; docs/dev/solution-templates.md): validation of packs, component tokens,
 * binding of the JSON parts (flows, policies, dashboards, print documents), shared slots and system lookups, the
 * defaults for shared tables, and rule 8 for packs (no people in approvals, no service accounts, no connections).
 * Pure: no server, no DOM.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import type { TableDef } from '../platform/contracts.ts'
import { componentToken, declaredTokens, validateTemplate, type TemplatePackage } from './format.ts'
import { bindJson, checkTemplateFormulas, createdTable, defaultBindings, resolveBindings } from './bind.ts'
import { checkSafety } from './safety.ts'

const builtin = (f: string): TemplatePackage => JSON.parse(fs.readFileSync(new URL(`../../server/core/templates/builtin/${f}.json`, import.meta.url), 'utf8')) as TemplatePackage
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const sys = [{ name: 'id', displayName: 'Id', type: 'text', system: true }] as TableDef['columns']
const T = (id: string, name: string, cols: TableDef['columns']): TableDef => ({ id, name, displayName: name, primaryColumn: cols[0]?.name ?? 'id', columns: [...sys, ...cols], createdOn: '', modifiedOn: '' })

describe('format 2: solution packs', () => {
  it('every built-in pack is valid, its formulas and JSON parts bind, and the safety check strips nothing', () => {
    const dir = new URL('../../server/core/templates/builtin/', import.meta.url)
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'manifest.json').map((f) => f.replace(/\.json$/, ''))
    const packs = files.map((f) => [f, builtin(f)] as const).filter(([, p]) => p.kind === 'solution')
    expect(packs.length).toBeGreaterThanOrEqual(2)
    for (const [f, p] of packs) {
      expect(validateTemplate(p), f).toEqual([])
      expect(checkTemplateFormulas(p), f).toEqual([])
      expect(checkSafety(p).stripped, f).toEqual([])
    }
  })
  it('explains what is wrong with a pack', () => {
    const p = clone(builtin('visitor-log')) as unknown as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    p.formatVersion = 1
    expect(validateTemplate(p).join(' ')).toMatch(/Solution templates need "formatVersion" 2/)
    p.formatVersion = 2
    delete p.shortName
    p.payload.sequences[0].nextValue = 7
    p.payload.flows.push({ ...p.payload.flows[0] })
    p.payload.roles[1].key = undefined
    p.payload.sample.Visits[0].PassNumber = 'P-1'
    p.slots[0].from.template = 'builtin.other'
    p.slots.push({ id: 'Seq', label: 'x', required: false, columns: [] })
    const why = validateTemplate(p).join(' | ')
    expect(why).toMatch(/has a "shortName"/)
    expect(why).toMatch(/never sets the next value/)
    expect(why).toMatch(/the key "ApproveVisits" is used twice/)
    expect(why).toMatch(/solution packs give every role a "key"/)
    expect(why).toMatch(/PassNumber of every SAMPLE row starts with SAMPLE/)
    expect(why).toMatch(/not one of the dependencies/)
    expect(why).toMatch(/reserved for component tokens/)
  })
  it('declares component tokens, refuses undeclared ones and formulas in JSON that do not parse', () => {
    const p = builtin('visitor-log')
    const tokens = declaredTokens(p)
    for (const t of ['Slot_App_Desk', 'Slot_Role_Reception', 'Slot_Flow_ApproveVisits', 'Slot_Policy_VisitApproval', 'Slot_Dashboard_Overview', 'Slot_Print_Pass', 'Slot_Seq_Passes']) expect(tokens.has(t), t).toBe(true)
    expect(componentToken('sequence', 'Passes')).toBe('Slot_Seq_Passes')
    const bad = clone(p)
    ;(bad.payload.flows![0].definition.steps as { title?: string }[])[0].title = '"x" & Trigger.Record.Slot_Visits_Nope'
    ;(bad.payload.dashboards![0].def.tiles as { query: { table: string } }[])[0].query.table = 'Slot_Nowhere'
    bad.payload.printTemplates![0].doc.fileName = 'Pass {Slot_Visits_PassNumber &}'
    const problems = checkTemplateFormulas(bad).join(' | ')
    expect(problems).toMatch(/flow ApproveVisits: .*Slot_Visits_Nope is not declared/)
    expect(problems).toMatch(/dashboard Overview: .*Slot_Nowhere is not declared/)
    expect(problems).toMatch(/print template Pass: .*does not parse/)
  })
})

describe('bindJson', () => {
  const tokens = new Map<string, string | null>([['Slot_Visits', 'Visits'], ['Slot_Visits_Status', 'State'], ['Slot_Visits_PassNumber', 'Pass'], ['Slot_Role_Reception', 'role_9'], ['Slot_Visits_Notes', null]])
  it('rewrites whole tokens, comma lists, word:token, object keys, {formulas} in text and formulas', () => {
    const b = bindJson({
      table: 'Slot_Visits', cols: 'Slot_Visits_Status, Slot_Visits_PassNumber', approver: 'role:Slot_Role_Reception',
      values: { Slot_Visits_Status: '"Done"' }, text: 'Pass **{Slot_Visits_PassNumber}** at {Now()}',
      cond: 'Trigger.Record.Slot_Visits_Status = "Pending"', withEq: '=Patch(Slot_Visits, x, {Slot_Visits_Status: "A"})', plain: 'No tokens here',
    }, tokens)
    expect(b.problems).toEqual([])
    expect(b.value).toEqual({
      table: 'Visits', cols: 'State, Pass', approver: 'role:role_9', values: { State: '"Done"' }, text: 'Pass **{Pass}** at {Now()}',
      cond: 'Trigger.Record.State = "Pending"', withEq: '=Patch(Visits, x, {State: "A"})', plain: 'No tokens here',
    })
  })
  it('reports tokens that are left out or unknown', () => {
    expect(bindJson({ c: 'Slot_Visits_Notes' }, tokens).problems.join(' ')).toMatch(/left out/)
    expect(bindJson({ c: 'Slot_Other' }, tokens).problems.join(' ')).toMatch(/not declared/)
  })
})

describe('binding a pack', () => {
  const p = builtin('visitor-log')
  it('shared tables: the same-named table when its columns fit, else a new one under the prefix', () => {
    const bm = builtin('business-model')
    const fits = T('tbl_acc', 'Accounts', [{ name: 'Name', displayName: 'Name', type: 'text' }])
    const misfit = T('tbl_c', 'Contacts', [{ name: 'Who', displayName: 'Who', type: 'number' }])
    const d = defaultBindings(bm, [fits, misfit])
    expect(d.Accounts).toEqual({ mode: 'map', table: 'tbl_acc', columns: expect.objectContaining({ Name: 'Name' }) })
    expect(d.Contacts).toMatchObject({ mode: 'create', name: 'CbmContacts' })
    expect(d.Products).toMatchObject({ mode: 'create', name: 'Products' })
  })
  it('a pack table that clashes proposes the pack prefix', () => {
    const r = resolveBindings(p, { Companies: { mode: 'map', table: 'tbl_acc', columns: { Name: 'Name' } } }, [T('tbl_acc', 'Accounts', [{ name: 'Name', displayName: 'Name', type: 'text' }]), T('tbl_v', 'Visitors', [])])
    expect(r.slots.find((s) => s.slot === 'Visitors')!.clash).toMatchObject({ name: 'Visitors', suggestion: 'VisVisitors' })
  })
  it('system lookups and formula defaults with a sequence token', () => {
    const r = resolveBindings(p, { Companies: { mode: 'map', table: 'tbl_acc', columns: { Name: 'Name' } } }, [T('tbl_acc', 'Accounts', [{ name: 'Name', displayName: 'Name', type: 'text' }])])
    const tokens = new Map(r.tokens)
    tokens.set('Slot_Seq_Passes', 'Gate passes')
    const visits = createdTable(r.resolved.find((x) => x.slot.id === 'Visits')!, { ...r, tokens }, '2000-01-01T00:00:00.000Z')
    expect(visits.problems).toEqual([])
    expect(visits.def.columns.find((c) => c.name === 'Host')).toMatchObject({ type: 'lookup', lookupTable: 'Users' })
    expect(visits.def.columns.find((c) => c.name === 'PassNumber')!.default).toBe('=NextNumber("Gate passes")')
    expect(visits.lookups.map((l) => l.toSlot).sort()).toEqual(['VisitPurposes', 'Visitors'])
  })
})

describe('rule 8 for packs', () => {
  it('no people in approval policies, flows never as a service account, no connection references; slot keys are not people', () => {
    const p = clone(builtin('visitor-log'))
    const def = p.payload.approvalPolicies![0].definition as { approvers: string[] }
    def.approvers = ['role:Slot_Role_Reception', 'user:boss@example.com', 'boss2@example.com']
    Object.assign(p.payload.flows![0], { runAs: { serviceAccount: 'svc_1' }, connections: [{ ref: 'mail', connectionId: 'conn_1' }] })
    p.payload.roles![0].tables.Accounts = { read: 'all' }
    const r = checkSafety(p)
    expect((r.pkg.payload.approvalPolicies![0].definition as { approvers: string[] }).approvers).toEqual(['role:Slot_Role_Reception'])
    expect((r.pkg.payload.flows![0] as unknown as Record<string, unknown>).runAs).toBeUndefined()
    expect((r.pkg.payload.flows![0] as unknown as Record<string, unknown>).connections).toBeUndefined()
    expect(r.stripped.join(' ')).toMatch(/never named people/)
    expect(r.stripped.join(' ')).toMatch(/service account/)
    // a slot called Accounts in sample rows and role privileges is not "people"
    expect(r.pkg.payload.roles![0].tables.Accounts).toEqual({ read: 'all' })
    expect(Object.keys(r.pkg.payload.sample!)).toEqual(['Visitors', 'Visits'])
  })
})
