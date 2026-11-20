/**
 * The template package format, the binding step, the formula rewrite (through the parser), the safety check (rule 8)
 * and the Studio's insert helpers. Pure: no server, no DOM.
 */
import { describe, expect, it } from 'vitest'
import type { AppDef, ControlNode } from '../contracts.ts'
import type { TableDef } from '../platform/contracts.ts'
import { columnToken, tableToken, validateTemplate, type TemplatePackage } from './format.ts'
import { rewriteFormula, tokensIn } from './rewrite.ts'
import { bindApp, bindNodes, checkTemplateFormulas, createdTable, defaultBindings, resolveBindings } from './bind.ts'
import { checkSafety } from './safety.ts'
import { appendScreen, freeName, insertIntoScreen, prepareNodes } from './insert.ts'

const sys = [{ name: 'id', displayName: 'Id', type: 'text', system: true }] as TableDef['columns']
const T = (id: string, name: string, cols: TableDef['columns']): TableDef => ({ id, name, displayName: name, primaryColumn: cols[0]?.name ?? 'id', columns: [...sys, ...cols], createdOn: '', modifiedOn: '' })
const tickets = T('tbl_t', 'Tickets', [
  { name: 'Title', displayName: 'Title', type: 'text' }, { name: 'State', displayName: 'State', type: 'choice', choices: ['a'] },
  { name: 'Points', displayName: 'Points', type: 'number' }, { name: 'Body', displayName: 'Body', type: 'multiline' },
])

const pkg = (over: Partial<TemplatePackage> = {}): TemplatePackage => ({
  format: 'appbuilder/template', formatVersion: 1, id: 'test.x', version: '1.0.0', kind: 'component', name: 'X', description: 'd', minPlatformVersion: '0.1.0', modes: ['copy'],
  slots: [{ id: 'Items', label: 'Items', required: true, create: { name: 'Items', displayName: 'Items' }, columns: [
    { id: 'Title', label: 'Title', types: ['text'], required: true }, { id: 'Status', label: 'Status', types: ['choice', 'text'], required: false },
  ] }],
  payload: { controls: [{ id: 'a', name: 'L', type: 'Label', props: { Text: '=CountRows(Slot_Items)' }, children: [] }] },
  ...over,
})

describe('format', () => {
  it('accepts a sound package and explains what is wrong with a broken one', () => {
    expect(validateTemplate(pkg())).toEqual([])
    const bad = validateTemplate({ ...pkg(), kind: 'screen', modes: ['linked'], slots: [{ id: '1x', label: '', required: 'yes', columns: [] }] })
    expect(bad.join(' ')).toMatch(/must include copy/)
    expect(bad.join(' ')).toMatch(/Linked use is not available for Screen templates/)
    expect(bad.join(' ')).toMatch(/A slot needs an identifier/)
    expect(bad.join(' ')).toMatch(/payload.screen/)
  })
  it('refuses ambiguous slot tokens', () => {
    const p = pkg({ slots: [
      { id: 'A', label: 'A', required: true, columns: [{ id: 'B_C', label: 'x', types: ['text'], required: true }] },
      { id: 'A_B', label: 'AB', required: true, columns: [{ id: 'C', label: 'y', types: ['text'], required: true }] },
    ] })
    expect(validateTemplate(p).join(' ')).toMatch(/Slot_A_B_C is ambiguous/)
  })
})

describe('rewrite (through the parser, never text replacement)', () => {
  const map = new Map<string, string | null>([[tableToken('Items'), 'Tickets'], [columnToken('Items', 'Title'), 'Title'], [columnToken('Items', 'Status'), 'State'], [columnToken('Items', 'Notes'), null]])
  it('identifiers, members, record fields and text values', () => {
    expect(rewriteFormula('=Filter(Slot_Items, Slot_Items_Status = "Open")', map).out).toBe('=Filter(Tickets, State = "Open")')
    expect(rewriteFormula('=ThisItem.Slot_Items_Title & Gallery1.Selected.Slot_Items_Status', map).out).toBe('=ThisItem.Title & Gallery1.Selected.State')
    expect(rewriteFormula('=Patch(Slot_Items, Defaults(Slot_Items), {Slot_Items_Status: "x"})', map).out).toBe('=Patch(Tickets, Defaults(Tickets), {State: "x"})')
    expect(rewriteFormula('="Slot_Items"', map).out).toBe('="Tickets"')
    expect(rewriteFormula('="Slot_Items_Title, Slot_Items_Status, Slot_Items_Notes"', map).out).toBe('="Title, State"')
  })
  it('leaves strings, look-alike names and bound names alone', () => {
    expect(rewriteFormula('="Text mentioning Slot_Items in a sentence"', map).problems.join(' ')).toMatch(/mixes slot tokens/)
    // a name that only contains a token is not one
    expect(rewriteFormula('=MySlot_Items + 1', map).out).toBe('=MySlot_Items + 1')
    // As binds a name; the bound name is not a free identifier
    expect(rewriteFormula('=ForAll(Slot_Items As Slot_Items_Title, Slot_Items_Title.Slot_Items_Status)', map).out).toBe('=ForAll(Tickets As Slot_Items_Title, Slot_Items_Title.State)')
  })
  it('an optional column left out reads Blank(); written, it is reported', () => {
    expect(rewriteFormula('=Coalesce(ThisItem.Slot_Items_Notes, "")', map).out).toBe('=Coalesce(Blank(), "")')
    expect(rewriteFormula('=Patch(Slot_Items, x, {Slot_Items_Notes: 1})', map).problems.join(' ')).toMatch(/must be mapped/)
  })
  it('undeclared tokens and formulas that do not parse are reported; formulas without = (conditions) work', () => {
    expect(rewriteFormula('=Slot_Other', map).problems.join(' ')).toMatch(/not declared/)
    expect(rewriteFormula('=Filter(Slot_Items,', map).problems.join(' ')).toMatch(/does not parse/)
    expect(rewriteFormula('Slot_Items_Status <> "Done"', map, { noEq: true }).out).toBe('State <> "Done"')
    expect(tokensIn('=Filter(Slot_Items, Slot_Items_Title = "x"); "Slot_Items_Status"').sort()).toEqual(['Slot_Items', 'Slot_Items_Status', 'Slot_Items_Title'])
  })
})

describe('binding', () => {
  it('maps, explains type mismatches in words, blocks unmapped required columns', () => {
    const r = resolveBindings(pkg(), { Items: { mode: 'map', table: 'tbl_t', columns: { Title: 'Title', Status: 'Points' } } }, [tickets])
    const st = r.slots[0].columns.find((c) => c.id === 'Status')!
    expect(st.problem).toBe('"Points" is a whole number column; Status needs a choice or text column.')
    expect(st.candidates.find((c) => c.name === 'State')!.ok).toBe(true)
    const missing = resolveBindings(pkg(), { Items: { mode: 'map', table: 'tbl_t', columns: { Title: null } } }, [tickets])
    expect(missing.problems.join(' ')).toMatch(/Choose the column of Tickets for Title \(required\)/)
    const ok = resolveBindings(pkg(), { Items: { mode: 'map', table: 'Tickets', columns: { Title: 'Title', Status: 'State' } } }, [tickets])
    expect(ok.problems).toEqual([])
    expect(ok.tokens.get('Slot_Items_Status')).toBe('State')
  })
  it('a create that clashes names the two ways out; defaults map a same-named table', () => {
    const r = resolveBindings(pkg(), { Items: { mode: 'create', name: 'tickets' } }, [tickets])
    expect(r.slots[0].clash).toMatchObject({ name: 'Tickets', suggestion: 'tickets2' })
    expect(r.problems[0]).toMatch(/Use it \(map the slot to it\) or install under another name/)
    const d = defaultBindings(pkg({ slots: [{ ...pkg().slots[0], create: { name: 'Tickets', displayName: 'T' } }] }), [tickets])
    expect(d.Items).toMatchObject({ mode: 'map', table: 'tbl_t', columns: { Title: 'Title', Status: null } })
  })
  it('lookup columns must point at the table chosen for their slot', () => {
    const p = pkg({ kind: 'dataModel', payload: {}, slots: [
      { id: 'C', label: 'Customers', required: true, create: { name: 'Customers', displayName: 'Customers' }, columns: [{ id: 'Name', label: 'Name', types: ['text'], required: true }] },
      { id: 'P', label: 'People', required: true, create: { name: 'People', displayName: 'People' }, columns: [{ id: 'Customer', label: 'Customer', types: ['lookup'], lookupSlot: 'C', required: true, create: { onDelete: 'cascade' } }] },
    ] })
    const people = T('tbl_p', 'Persons', [{ name: 'Org', displayName: 'Org', type: 'lookup', lookupTable: 'Elsewhere' }])
    const r = resolveBindings(p, { C: { mode: 'create', name: 'Customers' }, P: { mode: 'map', table: 'tbl_p', columns: { Customer: 'Org' } } }, [people])
    expect(r.problems.join(' ')).toMatch(/points at Elsewhere; Customer must point at Customers/)
    const c = createdTable(r.resolved[0], r, 'now')
    expect(c.def.columns.filter((x) => !x.system).map((x) => x.name)).toEqual(['Name'])
    const r2 = resolveBindings(p, {}, [])
    const people2 = createdTable(r2.resolved[1], r2, 'now')
    expect(people2.def.columns.find((x) => x.name === 'Customer')).toMatchObject({ type: 'lookup', lookupTable: 'Customers', required: true })
    expect(people2.lookups).toEqual([{ column: 'Customer', toSlot: 'C', onDelete: 'cascade' }])
  })
  it('binds a whole app: screens, App props, data sources, offline tables', () => {
    const app: AppDef = { formatVersion: 2, name: 'A', width: 100, height: 100, dataSources: ['Slot_Items'], appProps: { OnStart: '=ClearCollect(c, Slot_Items)', Formulas: 'Open = Filter(Slot_Items, Slot_Items_Status = "Open");' }, offline: { tables: [{ table: 'Slot_Items', filter: 'Slot_Items_Status <> "x"' }] }, screens: [{ id: 's', name: 'S', type: 'Screen', props: {}, children: [] }] }
    const tok = new Map<string, string | null>([['Slot_Items', 'Tickets'], ['Slot_Items_Title', 'Title'], ['Slot_Items_Status', 'State']])
    const b = bindApp(app, tok)
    expect(b.problems).toEqual([])
    expect(b.value.dataSources).toEqual(['Tickets'])
    expect(b.value.appProps.OnStart).toBe('=ClearCollect(c, Tickets)')
    expect(b.value.appProps.Formulas).toBe('Open = Filter(Tickets, State = "Open");')
    expect(b.value.offline!.tables![0]).toEqual({ table: 'Tickets', filter: 'State <> "x"' })
    expect(app.dataSources).toEqual(['Slot_Items'])
    const n = bindNodes(pkg().payload.controls!, tok)
    expect(n.value[0].props.Text).toBe('=CountRows(Tickets)')
  })
  it('a package whose formulas name undeclared tokens is refused', () => {
    expect(checkTemplateFormulas(pkg())).toEqual([])
    const p = pkg({ payload: { controls: [{ id: 'a', name: 'L', type: 'Label', props: { Text: '=Slot_Nope' }, children: [] }] } })
    expect(checkTemplateFormulas(p).join(' ')).toMatch(/Slot_Nope is not declared/)
  })
})

describe('safety (rule 8)', () => {
  it('strips secrets, people and foreign payload parts with a warning; lists what runs as the system', () => {
    const p = pkg({
      slots: [{ ...pkg().slots[0], events: [{ name: 'Sys', kind: 'event', timing: 'before', operations: ['create'], runAs: 'system', actions: 'x' }] }],
      payload: {
        controls: [{ id: 'a', name: 'P', type: 'PasswordInput', props: { Password: '=""', Text: '="x"' }, children: [] }],
        connections: [{ name: 'c', password: 'hunter2' }], users: [{ email: 'a@example.com' }],
        extra: { nested: true },
      },
    })
    // a secret and people hidden inside a part the kind does use
    Object.assign(p.slots[0], { apiKey: 'k-123', members: ['m@example.com'] })
    const r = checkSafety(p)
    expect(r.stripped.join(' ')).toMatch(/"extra"/)
    expect(r.stripped.join(' ')).toMatch(/template\.slots\[0\]\.apiKey/)
    const all = JSON.stringify(r.pkg)
    expect(all).not.toContain('hunter2')
    expect(all).not.toContain('k-123')
    expect(all).not.toContain('a@example.com')
    expect(r.stripped.join(' ')).toMatch(/connections/)
    expect(r.stripped.join(' ')).toMatch(/users and people/)
    expect(r.systemItems).toEqual(['Items: Sys'])
    // a formula property called Password is code, not a secret
    expect(r.pkg.payload.controls![0].props.Password).toBe('=""')
  })
  it('never the administrator flag of a role', () => {
    const p = pkg({ kind: 'app', payload: { app: { formatVersion: 2, name: 'A', width: 1, height: 1, appProps: {}, screens: [] }, roles: [{ name: 'R', tables: {}, ...({ isAdmin: true } as object) }] } })
    const r = checkSafety(p)
    expect((r.pkg.payload.roles![0] as unknown as { isAdmin?: boolean }).isAdmin).toBeUndefined()
    expect(r.stripped.join(' ')).toMatch(/administrator flag/)
  })
})

describe('insert (Studio use actions)', () => {
  let n = 0
  const id = () => `id${++n}`
  const app = (): AppDef => ({ formatVersion: 2, name: 'A', width: 100, height: 100, dataSources: ['Tickets'], appProps: {}, screens: [{ id: 's1', name: 'Screen1', type: 'Screen', props: {}, children: [{ id: 'e1', name: 'ApprovalBar', type: 'Label', props: { Text: '="mine"' }, children: [] }] }] })
  const part: ControlNode[] = [{ id: 'x', name: 'ApprovalBar', type: 'Container', props: { X: '=1' }, children: [{ id: 'y', name: 'Pick', type: 'Dropdown', props: {}, children: [] }, { id: 'z', name: 'Go', type: 'Button', props: { OnSelect: '=Patch(Tickets, Pick.Selected, {State: ApprovalBar.X})' }, children: [] }] }]
  it('names already used get a number; formulas inside follow; nothing that was there changes', () => {
    const a = app()
    const before = JSON.stringify(a)
    const r = insertIntoScreen(a, 's1', part, id, ['Tickets', 'Decisions'])
    expect(JSON.stringify(a)).toBe(before)
    expect(r.renamed).toEqual({ ApprovalBar: 'ApprovalBar2' })
    const s = r.app.screens[0]
    expect(s.children[0]).toEqual(a.screens[0].children[0])
    expect(s.children[1].name).toBe('ApprovalBar2')
    expect(s.children[1].children[1].props.OnSelect).toBe('=Patch(Tickets, Pick.Selected, {State: ApprovalBar2.X})')
    expect(r.app.dataSources).toEqual(['Tickets', 'Decisions'])
    expect(new Set(r.ids).size).toBe(1)
    expect(s.children[1].id).not.toBe('x')
  })
  it('a screen is added last; inserting twice never reuses names', () => {
    const a = appendScreen(app(), { id: 'S', name: 'Screen1', type: 'Screen', props: {}, children: [{ id: 'q', name: 'Pick', type: 'Label', props: {}, children: [] }] }, id).app
    expect(a.screens.map((x) => x.name)).toEqual(['Screen1', 'Screen2'])
    const b = prepareNodes(part, ['ApprovalBar', 'ApprovalBar2', 'Pick', 'Go'], id)
    expect(b.nodes[0].name).toBe('ApprovalBar3')
    expect(freeName('Gallery7', new Set(['gallery7', 'gallery8']))).toBe('Gallery9')
  })
})
