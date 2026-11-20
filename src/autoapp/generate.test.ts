import { describe, expect, it } from 'vitest'
import type { AppDef, ControlNode, FxRecord, FxScope } from '../contracts.ts'
import type { TableDef } from '../platform/contracts.ts'
import { columnKind, type SchemaInfo } from '../platform/query.ts'
import { fx } from '../fx/index.ts'
import { analyze } from '../fx/query/translate.ts'
import { parse } from '../fx/parser.ts'
import { controls } from '@/controls'
import { createAppStore } from '@/runtime/store'
import { generateApp, planAutoApp, type AutoAppOptions } from './index.ts'
import { ident, Names, needsQuotes, stemOf } from './names.ts'
import { all, colorTable, customers, longName, orders, quoted, readings, staff, table, users, wide60 } from './testdata.ts'

let seq = 0
const newId = () => `n${++seq}`
const gen = (tables: string[], device: AutoAppOptions['device'] = 'desktop', extra: Partial<AutoAppOptions> = {}) => generateApp(all, { name: 'Test', device, tables, newId, ...extra })

function nodes(def: AppDef): ControlNode[] {
  const out: ControlNode[] = []
  const visit = (list: ControlNode[]) => { for (const n of list) { out.push(n); visit(n.children) } }
  visit(def.screens)
  return out
}

/** the platform's schema for the translator (as src/runtime/delegation.ts builds it), no table held in the browser */
function schemaOf(tables: TableDef[]): SchemaInfo {
  const out: SchemaInfo = { tables: {} }
  for (const t of tables) {
    const columns: Record<string, ReturnType<typeof columnKind>> = { id: 'text' }
    const lookups: Record<string, string> = {}
    for (const c of t.columns) {
      columns[c.name] = columnKind(c.type)
      if (c.type === 'lookup' && c.lookupTable) lookups[c.name] = c.lookupTable
    }
    out.tables[t.name] = { columns, lookups, fullyLoaded: false, rowCount: 1_000_000 }
  }
  return out
}

/** every name a generated formula reads from outside resolves to a record with an id and every column (a row, a UI component) */
const sample: FxRecord = { id: '0b8f1c1e-1111-4111-8111-111111111111', Selected: { id: 'x' }, Mode: 'Edit', SelectedIndex: 1, Error: '' }
for (const t of all) for (const c of t.columns) if (!(c.name in sample)) sample[c.name] = '0b8f1c1e-2222-4222-8222-222222222222'
const scope: FxScope = { resolve: (name) => (all.some((t) => t.name === name) ? undefined : sample) }

/** the top-level steps of an action formula (a; b; c) */
function steps(formula: string): string[] {
  const p = parse(formula)
  if (!p.ast || p.ast.t !== 'chain') return [formula]
  return p.ast.items.map((it) => '=' + formula.slice(it.start, it.end))
}

function readsTable(formula: string): boolean {
  const names = new Set(fx.referencedNames(formula))
  return all.some((t) => names.has(t.name))
}

/** fx.check every formula; every formula over a table must translate without an error (delegable) */
function checkFormulas(def: AppDef) {
  const schema = schemaOf(all)
  let analysed = 0
  for (const n of nodes(def)) {
    const kinds = new Map((n.type === 'Screen' ? [] : controls.propsOf(n.type)).map((p) => [p.name, p.kind]))
    for (const [prop, f] of Object.entries(n.props)) {
      expect(f.startsWith('='), `${n.name}.${prop}`).toBe(true)
      expect(fx.check(f), `${n.name}.${prop}: ${f}`).toEqual([])
      if (!readsTable(f)) continue
      for (const step of kinds.get(prop) === 'action' ? steps(f) : [f]) {
        const res = analyze(step, schema, { scope })
        const errors = res.diagnostics.filter((d) => d.severity === 'error')
        expect(errors, `${n.name}.${prop}: ${step}`).toEqual([])
        analysed++
      }
    }
  }
  return analysed
}

/** every name a formula refers to exists: a UI component, screen, variable, table or a column of the row */
function checkReferences(def: AppDef) {
  const known = new Set<string>(['ThisRecord', 'ThisItem', 'Self', 'Parent'])
  for (const n of nodes(def)) known.add(n.name)
  for (const t of all) { known.add(t.name); for (const c of t.columns) known.add(c.name) }
  const vars = new Set<string>()
  for (const n of nodes(def)) for (const f of Object.values(n.props)) for (const m of f.matchAll(/Set\((\w+),/g)) vars.add(m[1]!)
  for (const v of vars) known.add(v)
  for (const n of nodes(def)) for (const [prop, f] of Object.entries(n.props)) for (const name of fx.referencedNames(f)) expect(known.has(name), `${n.name}.${prop} reads ${name}`).toBe(true)
  return vars
}

function checkNames(def: AppDef) {
  const seen = new Set<string>()
  for (const n of nodes(def)) {
    const k = n.name.toLowerCase()
    expect(seen.has(k), `duplicate name ${n.name}`).toBe(false)
    seen.add(k)
    expect(all.some((t) => t.name.toLowerCase() === k), `${n.name} is a table name`).toBe(false)
    expect(n.name).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/)
    expect(n.name.length).toBeLessThanOrEqual(60)
    expect(needsQuotes(n.name)).toBe(false)
  }
  const ids = nodes(def).map((n) => n.id)
  expect(new Set(ids).size).toBe(ids.length)
}

/** every property exists on its UI component type, and every type is registered */
function checkProps(def: AppDef) {
  for (const n of nodes(def)) {
    if (n.type === 'Screen') continue
    const props = new Set(controls.propsOf(n.type).map((p) => p.name))
    for (const k of Object.keys(n.props)) expect(props.has(k), `${n.type} ${n.name} has no property ${k}`).toBe(true)
  }
}

const num = (f: string | undefined) => Number((f ?? '=0').slice(1))

describe('names', () => {
  it('quotes words of the formula language and odd names', () => {
    expect(ident('Orders')).toBe('Orders')
    expect(ident('In')).toBe("'In'")
    expect(ident('true')).toBe("'true'")
    expect(ident('as')).toBe("'as'")
    expect(ident("O'Brien Co")).toBe("'O''Brien Co'")
    expect(stemOf('AVeryLongTableNameThatGoesOnAndOn')).toHaveLength(24)
    expect(stemOf('9lives')).toBe('T9lives')
  })
  it('never hands out a reserved, enum or table name twice', () => {
    const n = new Names(['Orders'])
    expect(n.take('Orders')).toBe('Orders2')
    expect(n.take('Color')).toBe('Color2')
    expect(n.take('Self')).toBe('Self2')
    expect(n.take('In')).toBe('In2')
    expect(n.take('x')).toBe('x')
    expect(n.take('X')).toBe('X2')
  })
})

describe('plan', () => {
  it('orders form fields: title first, required next, then by kind; system columns left out', () => {
    const p = planAutoApp(all, { name: '', device: 'desktop', tables: ['Customers'] })
    const t = p.tables[0]!
    expect(t.formFields.map((c) => c.name)).toEqual(['Name', 'Credit', 'Code', 'Email', 'Phone', 'Website', 'Tier', 'AccountManager', 'Employees', 'Rating', 'Since', 'LastVisit', 'Active', 'Notes', 'Logo', 'Contract', 'Score'])
    expect(t.leftOut.map((x) => x.column.name)).toEqual(['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner'])
    expect(t.listColumns.map((c) => c.name)).toEqual(['Name', 'Credit', 'Code', 'Email', 'Phone', 'Website', 'Tier'])
    expect(t.listColumns.some((c) => ['multiline', 'file'].includes(c.type))).toBe(false)
    expect(t.related.map((r) => r.label)).toEqual(['Orders (Customer)', 'Orders (Bill to)', 'A very long table display name that goes on and on forever and ever more still'])
    expect(t.undo).toBe(true)
    expect(t.timeline).toBe(true)
    expect(p.name).toBe('Customers app')
    expect(p.dataSources).toEqual(expect.arrayContaining(['Customers', 'Users', 'Orders', longName.name]))
  })

  it('is honest: lists what it cannot do', () => {
    const p = planAutoApp(all, { name: 'x', device: 'phone', tables: ['Customers', 'Readings', 'Color', 'Nope', 'Staff'], readable: (t) => t.name !== longName.name })
    const msg = p.issues.map((i) => `${i.level}|${i.table}|${i.column ?? ''}|${i.message}`)
    expect(msg.some((m) => m.startsWith('blocked|Color||') && m.includes('built-in name'))).toBe(true)
    expect(msg.some((m) => m.startsWith('blocked|Nope|'))).toBe(true)
    expect(msg.some((m) => m.startsWith('skipped|Customers||') && m.includes('cannot read'))).toBe(true)
    // the lookup picker searches the server now: a note (how it works), no longer a limitation
    expect(msg.some((m) => m.startsWith('note|Customers|Account manager|') && m.includes('search box that asks the server') && m.includes('cannot be sorted'))).toBe(true)
    expect(msg.some((m) => /not a search box|2,000|row id/.test(m))).toBe(false)
    expect(msg.some((m) => m.startsWith('note|Customers|Score|') && m.includes('read-only'))).toBe(true)
    expect(msg.some((m) => m.startsWith('note|Readings||') && m.includes('no search box'))).toBe(true)
    expect(msg.some((m) => m.startsWith('note|Staff|Manager|') && m.includes('own table'))).toBe(true)
    expect(p.tables.map((t) => t.table.name)).toEqual(['Customers', 'Readings', 'Staff'])
    expect(p.tables[1]!.search).toBe(false)
  })

  it('lists show lookups (by label) when their target can be read; related lists leave out the lookup back', () => {
    const p = planAutoApp(all, { name: '', device: 'desktop', tables: ['Customers', 'Orders'] })
    const o = p.tables.find((t) => t.table.name === 'Orders')!
    expect(o.listColumns.map((c) => c.name)).toEqual(['OrderNo', 'Customer', 'BillTo', 'Status', 'Amount', 'Due'])
    const c = p.tables.find((t) => t.table.name === 'Customers')!
    // Orders (Customer): BillTo is listed, Customer (this record) is not
    expect(c.related[0]!.listColumns.map((x) => x.name)).toEqual(['OrderNo', 'BillTo', 'Status', 'Amount', 'Due'])
    expect(p.screens.find((s) => s.name === 'Orders: list')!.what).toContain('sort by any column but lookups')
    // phone: a required lookup is the card's subtitle
    const ph = planAutoApp(all, { name: '', device: 'phone', tables: ['Orders'] }).tables[0]!
    expect(ph.cardColumns.map((x) => x.name)).toEqual(['OrderNo', 'Customer', 'Amount', 'Due'])
    // a lookup to a table the maker cannot read is left out of lists (it could only show "Not available")
    const hidden = planAutoApp(all, { name: '', device: 'desktop', tables: ['Orders'], readable: (t) => t.name !== 'Customers' }).tables[0]!
    expect(hidden.listColumns.some((x) => x.type === 'lookup')).toBe(false)
    const { def } = gen(['Customers', 'Orders'])
    expect(nodes(def).find((n) => n.name === 'OrdersTable')!.props.Columns).toBe('="OrderNo:Order no, Customer:Customer, BillTo:Bill to, Status:Status, Amount:Amount, Due:Due"')
  })

  it('a read-only table gets no New, no Delete and a view form', () => {
    const { def, plan } = generateApp(all, { name: 'u', device: 'desktop', tables: ['Users'], newId })
    expect(plan.tables[0]!.readOnly).toBe(true)
    const list = nodes(def)
    expect(list.some((n) => /NewButton|DeleteButton|DeleteDialog/.test(n.name))).toBe(false)
    expect(list.find((n) => n.type === 'Form')!.props).toMatchObject({ Mode: '=FormMode.View', ShowButtons: '=false' })
    expect(list.find((n) => n.type === 'DataTable')!.props.OnSelect).toContain('ViewForm(')
    // system table: no timeline
    expect(list.some((n) => n.type === 'RecordTimeline')).toBe(false)
  })
})

const SHAPES: { label: string; tables: string[] }[] = [
  { label: 'every column type with child tables', tables: ['Customers'] },
  { label: 'a table and its child, with navigation', tables: ['Customers', 'Orders'] },
  { label: 'a table with no text column', tables: ['Readings'] },
  { label: 'names that need quoting and a lookup to itself', tables: ['In'] },
  { label: 'a lookup to itself', tables: ['Staff'] },
  { label: 'long names', tables: [longName.name, 'Customers'] },
  { label: '60 columns', tables: ['Wide'] },
  { label: 'the whole data model', tables: all.map((t) => t.name) },
]

describe.each(['desktop', 'phone'] as const)('generated app, %s', (device) => {
  it.each(SHAPES)('$label: valid names, properties, formulas (fx.check) and delegable reads', ({ tables }) => {
    const { def } = gen(tables, device)
    checkNames(def)
    checkProps(def)
    checkReferences(def)
    expect(checkFormulas(def)).toBeGreaterThan(0)
    expect(def.width).toBe(device === 'phone' ? 360 : 1920)
    expect(def.formatVersion).toBe(2)
    // an ordinary app: nothing generator-specific in it
    expect(Object.keys(def).sort()).toEqual(['appProps', 'dataSources', 'formatVersion', 'height', 'name', 'scaleMode', 'screens', 'theme', 'width'])
  })

  it('layout: nothing wider than the design; lists and forms follow the window (anchors)', () => {
    const { def } = gen(['Customers', 'Orders'], device)
    for (const n of nodes(def)) {
      if (n.type === 'Screen' || !n.props.X) continue
      const inDialog = nodes(def).some((d) => d.type === 'Dialog' && d.children.includes(n))
      if (inDialog) continue
      expect(num(n.props.X) + num(n.props.Width), `${n.name} fits`).toBeLessThanOrEqual(def.width)
      expect(num(n.props.Y) + num(n.props.Height), `${n.name} fits`).toBeLessThanOrEqual(def.height)
      if (n.type === 'DataTable' || n.type === 'Form') expect(n.props.AnchorV, n.name).toBe('=Anchor.Stretch')
    }
    const form = nodes(def).find((n) => n.name === 'CustomersForm')!
    expect(form.props.AnchorH).toBe('=Anchor.Stretch')
    expect(form.props.Columns).toBe(device === 'phone' ? '=1' : '=3')
    if (device === 'phone') {
      // the fluid rule: full-width parts stretch, right-hand buttons stick to the right edge
      const listTable = nodes(def).find((n) => n.name === 'CustomersTable')!
      expect(listTable.props).toMatchObject({ X: '=0', Width: '=360', AnchorH: '=Anchor.Stretch' })
      expect(nodes(def).find((n) => n.name === 'CustomersNewButton')!.props.AnchorH).toBe('=Anchor.End')
      expect(def.screens.map((s) => s.name)).toEqual(['Home', 'CustomersList', 'CustomersDetail', 'CustomersRelated', 'OrdersList', 'OrdersDetail', 'OrdersRelated'])
    } else {
      expect(def.screens.map((s) => s.name)).toEqual(['Home', 'CustomersList', 'CustomersDetail', 'OrdersList', 'OrdersDetail'])
      expect(nodes(def).find((n) => n.name === 'CustomersTabs')!.props.AnchorH).toBe('=Anchor.End')
    }
  })
})

describe('what the screens do', () => {
  it('list: delegable items, newest first, search, sort, phone card columns', () => {
    const { def } = gen(['Customers'], 'phone')
    const t = nodes(def).find((n) => n.name === 'CustomersTable')!
    expect(t.props.Items).toBe('=Sort(Customers, createdOn, SortOrder.Descending)')
    expect(t.props).toMatchObject({ Searchable: '=true', Sortable: '=true', CardColumns: '="Name, Tier, Credit, Employees"' })
    expect(t.props.Columns).toBe('="Name:Name, Tier:Tier, Credit:Credit, Employees:Employees"')
    // every card column is a list column (the card picks among Columns)
    for (const p of planAutoApp(all, { name: '', device: 'phone', tables: all.map((x) => x.name) }).tables) for (const c of p.cardColumns) expect(p.listColumns).toContain(c)
    for (const p of planAutoApp(all, { name: '', device: 'desktop', tables: all.map((x) => x.name) }).tables) for (const c of p.cardColumns) expect(p.listColumns).toContain(c)
    const r = analyze(t.props.Items!, schemaOf(all), { scope })
    expect(r.plan).toMatchObject({ table: 'Customers', sort: [{ col: 'createdOn', dir: 'desc' }] })
    expect(r.residual).toBeNull()
  })

  it('related lists filter the child by its lookup (a server filter) and never show rows when no record is open', () => {
    const { def } = gen(['Customers', 'Orders'])
    const rel = nodes(def).filter((n) => n.type === 'DataTable' && n.name.startsWith('CustomersRelated'))
    expect(rel.map((n) => n.props.Items)).toEqual([
      '=Filter(Orders, ThisRecord.Customer = Coalesce(varCustomers.id, "-"))',
      '=Filter(Orders, ThisRecord.BillTo = Coalesce(varCustomers.id, "-"))',
      `=Filter(${longName.name}, ThisRecord.Parent = Coalesce(varCustomers.id, "-"))`,
    ])
    const r = analyze(rel[0]!.props.Items!, schemaOf(all), { scope: { resolve: () => ({}) } })
    expect(r.plan?.filter).toEqual({ col: 'Customer', op: 'eq', value: '-' })
    // rows of a child in the app open its detail screen; "+ Add" starts a new child with the lookup filled in
    expect(rel[0]!.props.OnSelect).toBe('=Set(varOrders, CustomersRelatedOrdersCustomer.Selected); EditForm(OrdersForm); Navigate(OrdersDetail)')
    const add = nodes(def).find((n) => n.name === 'CustomersAddOrders')!
    expect(add.props.OnSelect).toBe('=Set(varOrders, {Customer: varCustomers.id}); NewForm(OrdersForm); Navigate(OrdersDetail)')
    // a child that is not in the app: a read-only list
    expect(rel[2]!.props.SelectionMode).toBe('=SelectionMode.None')
    // the child's detail opens its parent
    const open = nodes(def).find((n) => n.name === 'OrdersOpenCustomer')!
    expect(open.props.OnSelect).toBe('=Set(varCustomers, LookUp(Customers, id = varOrders.Customer)); EditForm(CustomersForm); Navigate(CustomersDetail)')
  })

  it('quoted names stay quoted in every formula', () => {
    const { def } = gen(['In'])
    const f = nodes(def).map((n) => Object.values(n.props).join('\n')).join('\n')
    expect(f).toContain("Sort('In', createdOn, SortOrder.Descending)")
    expect(f).toContain("Filter('In', ThisRecord.'As' = Coalesce(varIn.id, \"-\"))")
    expect(f).toContain('Remove(\'In\', varIn)')
    expect(nodes(def).find((n) => n.type === 'Form')!.props.Fields).toBe('="And, Parent, Self, As, Not, true"')
  })

  it('delete asks first; the dialog says whether Undo is possible', () => {
    const { def } = gen(['Customers', 'Orders'])
    const dlg = nodes(def).find((n) => n.name === 'CustomersDeleteDialog')!
    expect(dlg.props.Description).toContain('undo')
    expect(dlg.props.Description).toContain('30 days')
    expect(nodes(def).find((n) => n.name === 'OrdersDeleteDialog')!.props.Description).toContain('cannot be undone')
    expect(dlg.children.map((c) => c.props.OnSelect)).toEqual(['=Set(varDeleteCustomers, false)', '=Remove(Customers, varCustomers); Set(varDeleteCustomers, false); Back()'])
  })

  it('a 60-column table: every column is a field, the form uses three columns on desktop', () => {
    const { def, plan } = gen(['Wide'])
    expect(plan.tables[0]!.formFields).toHaveLength(60)
    expect(nodes(def).find((n) => n.type === 'Form')!.props.Columns).toBe('=3')
    expect(plan.tables[0]!.listColumns).toHaveLength(7)
  })

  it('any design size: tablet portrait is compact, 2K is wide and fills the size', () => {
    expect(planAutoApp(all, { name: '', device: 'desktop', width: 800, height: 1280, tables: ['Orders'] }).layout).toBe('compact')
    const { def } = generateApp(all, { name: '', device: 'desktop', width: 2560, height: 1440, tables: ['Orders'], newId })
    expect(nodes(def).find((n) => n.name === 'OrdersTable')!.props.Width).toBe('=2512')
  })
})

describe('the app runs (runtime store, no DOM)', () => {
  const load = (def: AppDef) => {
    const store = createAppStore({ run: true })
    store.getState().loadApp('auto', def, { runOnStart: false })
    const st = () => store.getState()
    const byName = (name: string) => nodes(def).find((n) => n.name === name)!
    const screen = () => def.screens.find((s) => s.id === st().runtime.currentScreenId)?.name
    const fire = (name: string, event = 'OnSelect') => st().fire(byName(name).id, event)
    return { st, screen, fire }
  }

  it.each(['desktop', 'phone'] as const)('%s: home, list, new, back, delete confirmation, related screen', (device) => {
    const { def } = gen(['Customers', 'Orders'], device)
    const { st, screen, fire } = load(def)
    expect(screen()).toBe('Home')
    fire('CustomersTile')
    expect(screen()).toBe('CustomersList')
    fire('CustomersNewButton')
    expect(screen()).toBe('CustomersDetail')
    fire('CustomersBackButton')
    expect(screen()).toBe('CustomersList')
    fire('CustomersHomeButton')
    expect(screen()).toBe('Home')
    fire('OrdersTile')
    fire('OrdersNewButton')
    expect(screen()).toBe('OrdersDetail')
    fire('OrdersDeleteButton')
    expect(st().runtime.vars.varDeleteOrders).toBe(true)
    fire('OrdersDeleteCancel')
    expect(st().runtime.vars.varDeleteOrders).toBe(false)
  })

  it('OnStart declares every variable the screens use (the Studio runs it, so their names are known)', () => {
    const { def } = gen(['Customers', 'Orders'])
    expect(fx.check(def.appProps.OnStart!)).toEqual([])
    const vars = checkReferences(def)
    const store = createAppStore({ run: true })
    store.getState().loadApp('auto', def, { runOnStart: true })
    expect(Object.keys(store.getState().runtime.vars).sort()).toEqual([...vars].sort())
  })

  it('phone: the More button opens the related screen and comes back', () => {
    const { def } = gen(['Customers'], 'phone')
    const { screen, fire } = load(def)
    expect(screen()).toBe('CustomersList')
    fire('CustomersNewButton')
    fire('CustomersMoreButton')
    expect(screen()).toBe('CustomersRelated')
    fire('CustomersRelatedBack')
    expect(screen()).toBe('CustomersDetail')
  })
})

describe('inputs it cannot use', () => {
  it('an empty choice or a missing table makes no screens but says why', () => {
    const p = planAutoApp([colorTable, table('Empty', [])], { name: '', device: 'desktop', tables: ['Empty'] })
    expect(p.issues.some((i) => i.level === 'blocked' && i.message.includes('no columns'))).toBe(true)
    const { def } = generateApp([], { name: 'x', device: 'phone', tables: ['Missing'], newId })
    expect(def.screens.map((s) => s.name)).toEqual(['Screen1'])
  })
  it('the test shapes cover every column type', () => {
    const types = new Set(all.flatMap((t) => t.columns.map((c) => c.type)))
    for (const t of ['text', 'multiline', 'email', 'url', 'phone', 'number', 'decimal', 'currency', 'boolean', 'date', 'datetime', 'choice', 'lookup', 'image', 'autonumber', 'file']) expect(types.has(t as never), t).toBe(true)
    void [customers, orders, staff, readings, quoted, wide60, users]
  })
})
