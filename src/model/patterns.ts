/**
 * Schema patterns ("selected architecture schema"): starter models generated into the draft (pure). Each pattern says
 * when to use it; generate() adds tables, columns and relationships to a model and names the area they form. Data model
 * templates (master-plan section 11.3) can reuse the same generators: they produce a model, the diff produces ops, and
 * the plan/apply path installs them.
 */
import type { ColumnDef, TableDef } from '../platform/contracts.ts'
import type { DateDimDef, Model, ModelTable, SummaryDef, ViewColumn, ViewDef } from './types.ts'
import { isSystemTable } from './types.ts'
import { addColumn, addTable, clone, createRelationship, isSystemColumn, tableById, tableByName, userColumns } from './ops.ts'
import { toIdentifier } from './names.ts'

export type PatternGroup = 'transactional' | 'reporting' | 'industry'

export interface PatternParam {
  key: string
  label: string
  kind: 'text' | 'table' | 'columns' | 'lookups' | 'dateColumn' | 'month' | 'date' | 'boolean' | 'measures' | 'cron'
  /** default value (text, month number, boolean, ...) */
  default?: string | number | boolean
  /** 'table' params: may also be a new name typed by the maker */
  allowNew?: boolean
  optional?: boolean
  hint?: string
}

export interface PatternResult {
  model: Model
  /** new tables, to group into an area and place */
  tables: string[]
  area: string
  notes: string[]
}

export interface Pattern {
  key: string
  group: PatternGroup
  label: string
  /** one line: when to use it */
  when: string
  /** two or three sentences, plain words */
  explain: string
  params: PatternParam[]
  /** needs the server (reporting views, scheduled refresh) */
  serverOnly?: boolean
  generate(m: Model, p: Record<string, unknown>): PatternResult
}

/* ------------------------------------------------------------------ helpers */

const str = (p: Record<string, unknown>, k: string, d: string): string => (typeof p[k] === 'string' && (p[k] as string).trim() ? (p[k] as string).trim() : d)
const num = (p: Record<string, unknown>, k: string, d: number): number => (Number.isFinite(Number(p[k])) && p[k] !== '' && p[k] !== undefined ? Number(p[k]) : d)
const list = (p: Record<string, unknown>, k: string): string[] => (Array.isArray(p[k]) ? (p[k] as unknown[]).map(String) : [])

/** a table the maker picked (existing id) or a new one with this display name */
function pickOrCreate(m: Model, value: string, fallback: string, columns: Partial<ColumnDef>[], made: string[]): { model: Model; table: ModelTable } {
  const existing = tableById(m, value)
  if (existing) return { model: m, table: existing }
  const res = addTable(m, { displayName: value || fallback, columns })
  made.push(res.table.id)
  return res
}

function rel(m: Model, parent: string, child: string, cardinality: 'oneToMany' | 'oneToOne' | 'manyToMany' | 'self', onDelete: 'restrict' | 'cascade' | 'setBlank', o: { required?: boolean; columnName?: string; junctionName?: string; junctionColumns?: Partial<ColumnDef>[] } = {}) {
  return createRelationship(m, { parent, child, cardinality, onDelete, ...o })
}

const T = (displayName: string, columns: Partial<ColumnDef>[]) => ({ displayName, columns })
const choice = (displayName: string, choices: string[], extra: Partial<ColumnDef> = {}): Partial<ColumnDef> => ({ displayName, type: 'choice', choices, ...extra })

/** builds several tables then links them: returns the model and the made ids in order */
function build(m: Model, specs: { key: string; displayName: string; columns: Partial<ColumnDef>[]; primary?: string }[], made: string[]): { model: Model; ids: Record<string, string> } {
  let model = m
  const ids: Record<string, string> = {}
  for (const s of specs) {
    const res = addTable(model, { displayName: s.displayName, columns: s.columns })
    model = res.model
    ids[s.key] = res.table.id
    made.push(res.table.id)
    if (s.primary) {
      const t = tableById(model, res.table.id)!
      const c = t.columns.find((x) => x.displayName === s.primary)
      if (c) t.primaryColumn = c.name
    }
  }
  return { model, ids }
}

/** the system User table (package N) when it exists */
const userTable = (m: Model): ModelTable | undefined => m.tables.find((t) => isSystemTable(t) && /^(user|users)$/i.test(t.name))

function rollupOn(m: Model, headerId: string, linesId: string, via: string, column: string, displayName: string): Model {
  const lines = tableById(m, linesId)!
  return addColumn(m, headerId, { displayName, type: 'currency', computed: { kind: 'rollup', table: lines.name, via, fn: 'sum', column } }).model
}

/* ------------------------------------------------------------------ transactional */

const masterDetail: Pattern = {
  key: 'master-detail', group: 'transactional', label: 'Master–detail (header and lines)',
  when: 'A document with several lines: orders, invoices, receipts, work orders.',
  explain: 'A header table holds what is true once per document (number, date, customer); a lines table holds one row per item, each pointing at its header. Deleting a header deletes its lines (cascade), and the header carries a rollup total of the lines.',
  params: [
    { key: 'header', label: 'Header table', kind: 'text', default: 'Order' },
    { key: 'lines', label: 'Lines table', kind: 'text', default: 'Order line' },
  ],
  generate(m, p) {
    const made: string[] = []
    const header = str(p, 'header', 'Order')
    let { model, ids } = build(m, [
      { key: 'h', displayName: header, columns: [
        { displayName: 'Number', type: 'autonumber', prefix: `${toIdentifier(header).slice(0, 3).toUpperCase()}-` },
        { displayName: 'Date', type: 'date', required: true, default: 'today' },
        { displayName: 'Customer', type: 'text' },
        choice('Status', ['Draft', 'Confirmed', 'Closed', 'Cancelled'], { default: 'Draft' }),
      ], primary: 'Number' },
      { key: 'l', displayName: str(p, 'lines', `${header} line`), columns: [
        { displayName: 'Item', type: 'text', required: true },
        { displayName: 'Quantity', type: 'decimal', required: true, default: '1' },
        { displayName: 'Unit price', type: 'currency', required: true },
        { displayName: 'Amount', type: 'currency', computed: { kind: 'formula', formula: 'Quantity * UnitPrice' } },
      ], primary: 'Item' },
    ], made)
    const r = rel(model, ids.h, ids.l, 'oneToMany', 'cascade', { required: true, columnName: header })
    model = rollupOn(r.model, ids.h, ids.l, r.relationships[0].fromColumn, 'Amount', 'Total')
    return { model, tables: made, area: header, notes: ['Total is a rollup: the server keeps it equal to the sum of the line amounts.'] }
  },
}

const lookupReference: Pattern = {
  key: 'reference-data', group: 'transactional', label: 'Lookup / reference data',
  when: 'A short list people pick from: categories, units, payment terms, regions.',
  explain: 'A small table with a code, a name and an Active flag, so a list can change without changing apps. Other tables point at it with a lookup; deleting a value that is still in use is refused (restrict).',
  params: [
    { key: 'name', label: 'Reference table', kind: 'text', default: 'Category' },
    { key: 'target', label: 'Used by (optional)', kind: 'table', optional: true },
  ],
  generate(m, p) {
    const made: string[] = []
    let { model, ids } = build(m, [{ key: 'r', displayName: str(p, 'name', 'Category'), columns: [
      { displayName: 'Code', type: 'text', required: true, unique: true },
      { displayName: 'Name', type: 'text', required: true },
      { displayName: 'Active', type: 'boolean', default: 'true' },
      { displayName: 'Sort order', type: 'number' },
    ], primary: 'Name' }], made)
    const target = typeof p.target === 'string' ? tableById(model, p.target) : undefined
    if (target) model = rel(model, ids.r, target.id, 'oneToMany', 'restrict').model
    return { model, tables: made, area: 'Reference data', notes: [] }
  },
}

const hierarchy: Pattern = {
  key: 'hierarchy', group: 'transactional', label: 'Hierarchy (self parent)',
  when: 'Things inside things of the same kind: departments, locations, account groups, product categories.',
  explain: 'A lookup from a table to itself ("Parent") makes a tree. Cycle prevention refuses a parent chain that loops back; deleting a node is refused while it has children (restrict).',
  params: [{ key: 'table', label: 'Table', kind: 'table', allowNew: true, default: 'Location' }],
  generate(m, p) {
    const made: string[] = []
    const r0 = pickOrCreate(m, str(p, 'table', 'Location'), 'Location', [{ displayName: 'Name', type: 'text', required: true }, { displayName: 'Code', type: 'text', unique: true }], made)
    const r = createRelationship(r0.model, { parent: r0.table.id, child: r0.table.id, cardinality: 'self', onDelete: 'restrict', columnName: 'Parent', preventCycles: true })
    return { model: r.model, tables: made, area: r0.table.displayName, notes: [] }
  },
}

const manyToMany: Pattern = {
  key: 'many-to-many', group: 'transactional', label: 'Many-to-many with junction',
  when: 'Both sides have many of the other: students and courses, products and suppliers, users and projects.',
  explain: 'A junction table holds one row per pair, with a lookup to each side and a unique pair so a pair cannot be added twice. Extra columns on the junction describe the pair (a supplier\'s price for a product).',
  params: [
    { key: 'left', label: 'First table', kind: 'table', allowNew: true, default: 'Product' },
    { key: 'right', label: 'Second table', kind: 'table', allowNew: true, default: 'Supplier' },
  ],
  generate(m, p) {
    const made: string[] = []
    const a = pickOrCreate(m, str(p, 'left', 'Product'), 'Product', [{ displayName: 'Name', type: 'text', required: true }], made)
    const b = pickOrCreate(a.model, str(p, 'right', 'Supplier'), 'Supplier', [{ displayName: 'Name', type: 'text', required: true }], made)
    const r = rel(b.model, b.table.id, a.table.id, 'manyToMany', 'cascade', { junctionColumns: [{ displayName: 'Notes', type: 'text' }] })
    if (r.junction) made.push(r.junction.id)
    return { model: r.model, tables: made, area: `${a.table.displayName} and ${b.table.displayName}`, notes: [] }
  },
}

const partyModel: Pattern = {
  key: 'party', group: 'transactional', label: 'Party model (organisations and people)',
  when: 'You deal with companies and the people who work there: customers, suppliers, partners.',
  explain: 'Account is an organisation (with a type: customer, supplier, partner), Contact is a person who may belong to one. One account table for every kind of business partner avoids copying the same company into "Customers" and "Suppliers".',
  params: [],
  generate(m) {
    const made: string[] = []
    let { model, ids } = build(m, [
      { key: 'a', displayName: 'Account', columns: [
        { displayName: 'Name', type: 'text', required: true },
        choice('Type', ['Customer', 'Supplier', 'Partner', 'Other'], { default: 'Customer' }),
        { displayName: 'Email', type: 'email' }, { displayName: 'Phone', type: 'phone' }, { displayName: 'Website', type: 'url' },
        { displayName: 'GSTIN', type: 'text' }, { displayName: 'City', type: 'text' },
      ], primary: 'Name' },
      { key: 'c', displayName: 'Contact', columns: [
        { displayName: 'Full name', type: 'text', required: true }, { displayName: 'Email', type: 'email' }, { displayName: 'Phone', type: 'phone' },
        { displayName: 'Job title', type: 'text' },
      ], primary: 'Full name' },
    ], made)
    model = rel(model, ids.a, ids.c, 'oneToMany', 'setBlank').model
    return { model, tables: made, area: 'Parties', notes: [] }
  },
}

const statusWorkflow: Pattern = {
  key: 'status-workflow', group: 'transactional', label: 'Status workflow (status and history)',
  when: 'Records move through stages and you need to know who moved them when: requests, tickets, jobs.',
  explain: 'The main table has a Status choice; a history child table keeps one row per change (from, to, when, by whom). Add an after-event on the main table that writes the history row when Status changes.',
  params: [{ key: 'name', label: 'Table', kind: 'text', default: 'Request' }],
  generate(m, p) {
    const made: string[] = []
    const name = str(p, 'name', 'Request')
    let { model, ids } = build(m, [
      { key: 'm', displayName: name, columns: [
        { displayName: 'Title', type: 'text', required: true },
        choice('Status', ['Draft', 'Submitted', 'In progress', 'Done', 'Cancelled'], { default: 'Draft', required: true, indexed: true }),
        { displayName: 'Status changed on', type: 'datetime' },
      ], primary: 'Title' },
      { key: 'h', displayName: `${name} status history`, columns: [
        { displayName: 'From status', type: 'text' }, { displayName: 'To status', type: 'text', required: true },
        { displayName: 'Changed on', type: 'datetime', required: true, default: 'now' }, { displayName: 'Changed by', type: 'text' },
        { displayName: 'Comment', type: 'multiline' },
      ], primary: 'To status' },
    ], made)
    model = rel(model, ids.m, ids.h, 'oneToMany', 'cascade', { required: true, columnName: name }).model
    return { model, tables: made, area: `${name} workflow`, notes: ['Add an after-event on the main table that writes a history row when Status changes (Table designer > Logic).'] }
  },
}

const documentNumbering: Pattern = {
  key: 'numbering', group: 'transactional', label: 'Document numbering (number sequence)',
  when: 'Documents need a readable, gap-tolerant running number: INV-0001, WO-0042.',
  explain: 'An autonumber column takes the next number from the environment\'s counter for that column, with a prefix. It is issued by the server when the row is saved, so two people never get the same number.',
  params: [
    { key: 'table', label: 'Table', kind: 'table', allowNew: true, default: 'Invoice' },
    { key: 'prefix', label: 'Prefix', kind: 'text', default: 'INV-' },
  ],
  generate(m, p) {
    const made: string[] = []
    const r0 = pickOrCreate(m, str(p, 'table', 'Invoice'), 'Invoice', [{ displayName: 'Date', type: 'date', default: 'today' }], made)
    const res = addColumn(r0.model, r0.table.id, { displayName: 'Number', type: 'autonumber', prefix: str(p, 'prefix', 'INV-') })
    const t = tableById(res.model, r0.table.id)!
    if (made.length && res.column) t.primaryColumn = res.column.name
    return { model: res.model, tables: made, area: r0.table.displayName, notes: [] }
  },
}

const auditTrail: Pattern = {
  key: 'audit-trail', group: 'transactional', label: 'Audit trail child table',
  when: 'Business users must see the history of one record inside the app (not just the administrator\'s audit log).',
  explain: 'A child table with one row per changed field: when, who, which field, old and new value. Fill it with an after-event; deleting the record deletes its trail (cascade).',
  params: [{ key: 'table', label: 'Table to track', kind: 'table', allowNew: true, default: 'Contract' }],
  generate(m, p) {
    const made: string[] = []
    const r0 = pickOrCreate(m, str(p, 'table', 'Contract'), 'Contract', [{ displayName: 'Title', type: 'text', required: true }], made)
    const res = addTable(r0.model, { displayName: `${r0.table.displayName} change log`, columns: [
      { displayName: 'Changed on', type: 'datetime', required: true, default: 'now' }, { displayName: 'Changed by', type: 'text' },
      { displayName: 'Field', type: 'text', required: true }, { displayName: 'Old value', type: 'multiline' }, { displayName: 'New value', type: 'multiline' },
    ] })
    made.push(res.table.id)
    const r = rel(res.model, r0.table.id, res.table.id, 'oneToMany', 'cascade', { required: true, columnName: r0.table.displayName })
    return { model: r.model, tables: made, area: r0.table.displayName, notes: ['Write the trail rows with an after-event on the tracked table.'] }
  },
}

const approvalReady: Pattern = {
  key: 'approval', group: 'transactional', label: 'Approval-ready table',
  when: 'Someone asks, someone else decides: purchase requests, leave, discounts, expense claims.',
  explain: 'Requester, approver, status (Draft, Pending, Approved, Rejected), when it was submitted and decided, and the decision comment. Approvals (P1) and flows can drive the status; apps can already show the queue.',
  params: [{ key: 'name', label: 'Table', kind: 'text', default: 'Purchase request' }],
  generate(m, p) {
    const made: string[] = []
    const users = userTable(m)
    const person = (displayName: string, required = false): Partial<ColumnDef> => (users ? { displayName, type: 'lookup', lookupTable: users.name, required } : { displayName, type: 'email', required })
    const { model, ids } = build(m, [{ key: 'a', displayName: str(p, 'name', 'Purchase request'), columns: [
      { displayName: 'Title', type: 'text', required: true }, { displayName: 'Amount', type: 'currency' },
      person('Requested by', true), person('Approver'),
      choice('Status', ['Draft', 'Pending', 'Approved', 'Rejected', 'Withdrawn'], { default: 'Draft', required: true, indexed: true }),
      { displayName: 'Submitted on', type: 'datetime' }, { displayName: 'Decided on', type: 'datetime' }, { displayName: 'Decision comment', type: 'multiline' },
    ], primary: 'Title' }], made)
    let out = model
    if (users) {
      const t = tableById(out, ids.a)!
      for (const c of t.columns.filter((x) => x.type === 'lookup')) out = { ...out, relationships: [...out.relationships, { id: `rel_${ids.a}_${c.name}`, fromTable: ids.a, fromColumn: c.name, toTable: users.id, kind: 'oneToMany', onDelete: 'restrict' }] }
    }
    return { model: out, tables: made, area: str(p, 'name', 'Purchase request'), notes: users ? [] : ['Requester and approver are email columns; with the system User table they become lookups to it.'] }
  },
}

/* ------------------------------------------------------------------ reporting */

const MEASURE_TYPES = new Set(['number', 'decimal', 'currency'])

/** columns of a dimension view: the display column and the plain descriptive columns of the base table */
function dimensionColumns(base: TableDef, includeLookups: boolean): ViewColumn[] {
  const out: ViewColumn[] = []
  for (const c of userColumns(base)) {
    if (['image', 'file', 'multiline'].includes(c.type)) continue
    if (c.type === 'lookup' && !includeLookups) continue
    out.push({ name: c.name, displayName: c.displayName, type: c.type, source: c.name })
  }
  return out
}

/** a reporting view table (draft): system columns pass through from the base */
export function viewTable(m: Model, displayName: string, def: ViewDef): { model: Model; table: ModelTable } {
  const res = addTable(m, { displayName, columns: def.columns.map((c) => ({ name: c.name, displayName: c.displayName, type: c.type, ...(c.lookupTable ? { lookupTable: c.lookupTable } : {}) })), reporting: def })
  const t = tableById(res.model, res.table.id)!
  t.readOnly = true
  // view column names must match the lineage exactly
  const user = userColumns(t)
  def.columns.forEach((c, i) => { if (user[i]) user[i].name = c.name })
  t.reporting = { ...def, columns: def.columns.map((c, i) => ({ ...c, name: user[i]?.name ?? c.name })) }
  t.primaryColumn = user[0]?.name ?? 'id'
  return { model: res.model, table: t }
}

export function dateDimensionColumns(): Partial<ColumnDef>[] {
  return [
    { displayName: 'Date', name: 'Date', type: 'date', required: true, unique: true },
    { displayName: 'Date key', name: 'DateKey', type: 'number', required: true, unique: true },
    { displayName: 'Year', name: 'Year', type: 'number', indexed: true },
    { displayName: 'Quarter', name: 'Quarter', type: 'number' },
    { displayName: 'Month', name: 'Month', type: 'number' },
    { displayName: 'Month name', name: 'MonthName', type: 'text' },
    { displayName: 'Day', name: 'Day', type: 'number' },
    { displayName: 'Weekday', name: 'Weekday', type: 'number' },
    { displayName: 'Weekday name', name: 'WeekdayName', type: 'text' },
    { displayName: 'Weekend', name: 'IsWeekend', type: 'boolean' },
    { displayName: 'Fiscal year', name: 'FiscalYear', type: 'text', indexed: true },
    { displayName: 'Fiscal quarter', name: 'FiscalQuarter', type: 'number' },
    { displayName: 'Fiscal month', name: 'FiscalMonth', type: 'number' },
  ]
}

export function addDateDimension(m: Model, p: { displayName?: string; from?: string; to?: string; fiscalYearStartMonth?: number }): { model: Model; table: ModelTable } {
  const year = new Date().getUTCFullYear()
  const def: DateDimDef = {
    kind: 'date',
    from: p.from && /^\d{4}-\d{2}-\d{2}$/.test(p.from) ? p.from : `${year - 3}-01-01`,
    to: p.to && /^\d{4}-\d{2}-\d{2}$/.test(p.to) ? p.to : `${year + 2}-12-31`,
    fiscalYearStartMonth: Math.min(12, Math.max(1, Math.trunc(p.fiscalYearStartMonth ?? 4))),
  }
  const res = addTable(m, { displayName: p.displayName ?? 'Date', name: 'DimDate', columns: dateDimensionColumns(), reporting: def })
  const t = tableById(res.model, res.table.id)!
  t.primaryColumn = 'Date'
  return { model: res.model, table: t }
}

const dateDimension: Pattern = {
  key: 'date-dimension', group: 'reporting', label: 'Date dimension (calendar table)',
  when: 'Reports by month, quarter, fiscal year or weekday, without date maths in every chart.',
  explain: 'One row per day with year, quarter, month, weekday and the fiscal year (India: April to March by default). Facts carry a DateKey (yyyymmdd) that matches it. Filled when you apply.',
  params: [
    { key: 'from', label: 'From', kind: 'date', optional: true },
    { key: 'to', label: 'To', kind: 'date', optional: true },
    { key: 'fiscal', label: 'Fiscal year starts in', kind: 'month', default: 4 },
  ],
  generate(m, p) {
    const r = addDateDimension(m, { from: str(p, 'from', ''), to: str(p, 'to', ''), fiscalYearStartMonth: num(p, 'fiscal', 4) })
    return { model: r.model, tables: [r.table.id], area: 'Reporting', notes: [] }
  },
}

/**
 * Star schema from a transactional table: a fact view (measures, dimension keys, DateKey) and one dimension view per
 * chosen lookup (snowflake: dimensions keep their own lookups as keys to sub-dimension views).
 */
export function generateStar(m: Model, p: { fact: string; measures: string[]; dimensions: string[]; dateColumn?: string; snowflake?: boolean; dateDimension?: boolean; fiscalYearStartMonth?: number }): PatternResult {
  const fact = tableById(m, p.fact)
  if (!fact) throw new Error('Pick the transactional table the facts come from.')
  if (fact.reporting) throw new Error('Pick a transactional table, not a reporting table.')
  let model = clone(m)
  const made: string[] = []
  const notes: string[] = []
  const dimViewFor = new Map<string, string>()
  const makeDim = (baseId: string, depth: number): string | undefined => {
    if (dimViewFor.has(baseId)) return dimViewFor.get(baseId)
    const base = tableById(model, baseId)
    if (!base) return undefined
    const cols = dimensionColumns(base, !!p.snowflake && depth < 3)
    for (const c of cols) {
      if (c.type !== 'lookup') continue
      const sub = tableByName(model, base.columns.find((x) => x.name === c.source)?.lookupTable)
      const subView = sub && sub.id !== base.id ? makeDim(sub.id, depth + 1) : undefined
      const sv = subView ? tableById(model, subView) : undefined
      if (sv) c.lookupTable = sv.name
      else { c.type = 'text'; delete c.lookupTable }
    }
    const res = viewTable(model, `Dim ${base.displayName}`, { kind: 'view', role: 'dimension', base: base.id, columns: cols })
    model = res.model
    made.push(res.table.id)
    dimViewFor.set(baseId, res.table.id)
    return res.table.id
  }
  const factCols: ViewColumn[] = []
  for (const d of p.dimensions) {
    const c = fact.columns.find((x) => x.name === d && x.type === 'lookup')
    if (!c) continue
    const target = tableByName(model, c.lookupTable)
    if (!target) continue
    const dv = makeDim(target.id, 1)
    const dvt = dv ? tableById(model, dv) : undefined
    factCols.push({ name: c.name, displayName: c.displayName, type: 'lookup', source: c.name, ...(dvt ? { lookupTable: dvt.name } : {}) })
  }
  for (const mname of p.measures) {
    const c = fact.columns.find((x) => x.name === mname)
    if (!c || !MEASURE_TYPES.has(c.type)) continue
    factCols.push({ name: c.name, displayName: c.displayName, type: c.type, source: c.name })
  }
  const dateCol = p.dateColumn ? fact.columns.find((x) => x.name === p.dateColumn && (x.type === 'date' || x.type === 'datetime')) : undefined
  if (dateCol) {
    factCols.push({ name: dateCol.name, displayName: dateCol.displayName, type: dateCol.type, source: dateCol.name })
    factCols.push({ name: 'DateKey', displayName: 'Date key', type: 'number', source: dateCol.name, expr: 'dateKey' })
    if (p.dateDimension && !model.tables.some((t) => t.reporting?.kind === 'date')) {
      const dd = addDateDimension(model, { fiscalYearStartMonth: p.fiscalYearStartMonth })
      model = dd.model
      made.push(dd.table.id)
    }
  }
  if (!factCols.length) throw new Error('Pick at least one measure or dimension.')
  const fv = viewTable(model, `Fact ${fact.displayName}`, { kind: 'view', role: 'fact', base: fact.id, columns: factCols })
  model = fv.model
  made.push(fv.table.id)
  notes.push('Reporting views are read-only and show each reader only the rows and columns they may see in the source tables.')
  return { model, tables: made, area: `Reporting: ${fact.displayName}`, notes }
}

const starSchema: Pattern = {
  key: 'star-schema', group: 'reporting', label: 'Star schema (fact and dimension views)', serverOnly: true,
  when: 'Dashboards and analysis over a transactional table. For reporting, not for data entry.',
  explain: 'A fact view keeps the numbers (measures) and the keys of what they are about; dimension views describe those things (customer, item, date). They are views over your tables, so they never get out of date and carry the same row and column security.',
  params: [
    { key: 'fact', label: 'Facts come from', kind: 'table' },
    { key: 'measures', label: 'Measures', kind: 'measures' },
    { key: 'dimensions', label: 'Dimensions', kind: 'lookups' },
    { key: 'dateColumn', label: 'Date column', kind: 'dateColumn', optional: true },
    { key: 'dateDimension', label: 'Add a date dimension', kind: 'boolean', default: true },
    { key: 'fiscal', label: 'Fiscal year starts in', kind: 'month', default: 4 },
  ],
  generate(m, p) {
    return generateStar(m, { fact: str(p, 'fact', ''), measures: list(p, 'measures'), dimensions: list(p, 'dimensions'), dateColumn: str(p, 'dateColumn', '') || undefined, dateDimension: p.dateDimension !== false, fiscalYearStartMonth: num(p, 'fiscal', 4) })
  },
}

const snowflake: Pattern = {
  ...starSchema, key: 'snowflake', label: 'Snowflake variant (dimension with sub-dimension)',
  when: 'A dimension has its own categories (item → item group) that you report on separately.',
  explain: 'Like the star schema, but a dimension keeps its own lookups as keys to sub-dimension views (Dim Item → Dim Item group) instead of copying their columns. Fewer repeated values, one more join for charts.',
  generate(m, p) {
    return generateStar(m, { fact: str(p, 'fact', ''), measures: list(p, 'measures'), dimensions: list(p, 'dimensions'), dateColumn: str(p, 'dateColumn', '') || undefined, dateDimension: p.dateDimension !== false, fiscalYearStartMonth: num(p, 'fiscal', 4), snowflake: true })
  },
}

export function summaryTable(m: Model, p: { source: string; groupBy: string[]; measures: { fn: SummaryDef['measures'][number]['fn']; column?: string }[]; cron?: string; displayName?: string }): { model: Model; table: ModelTable } {
  const src = tableById(m, p.source)
  if (!src) throw new Error('Pick the table to summarise.')
  const cols: Partial<ColumnDef>[] = []
  const groupBy: string[] = []
  for (const g of p.groupBy) {
    const c = src.columns.find((x) => x.name === g && !isSystemColumn(x))
    if (!c) continue
    groupBy.push(c.name)
    cols.push({ name: c.name, displayName: c.displayName, type: c.type, ...(c.type === 'lookup' ? { lookupTable: c.lookupTable } : {}), ...(c.type === 'choice' ? { choices: c.choices ?? [] } : {}), indexed: c.type !== 'lookup' ? true : undefined })
  }
  const measures: SummaryDef['measures'] = []
  for (const ms of p.measures) {
    const c = ms.column ? src.columns.find((x) => x.name === ms.column) : undefined
    if (ms.fn !== 'count' && (!c || !MEASURE_TYPES.has(c.type))) continue
    const name = ms.fn === 'count' ? 'RowCount' : `${ms.fn[0].toUpperCase()}${ms.fn.slice(1)}${c!.name}`
    measures.push({ name, fn: ms.fn, ...(c ? { column: c.name } : {}) })
    cols.push({ name, displayName: ms.fn === 'count' ? 'Row count' : `${ms.fn} of ${c!.displayName}`, type: ms.fn === 'count' ? 'number' : ms.fn === 'avg' ? 'decimal' : c!.type })
  }
  if (!measures.length) throw new Error('Pick at least one measure.')
  cols.push({ name: 'RefreshedOn', displayName: 'Refreshed on', type: 'datetime' })
  const def: SummaryDef = { kind: 'summary', source: src.id, groupBy, measures, cron: p.cron && p.cron.trim().split(/\s+/).length === 5 ? p.cron.trim() : '15 * * * *' }
  const res = addTable(m, { displayName: p.displayName ?? `${src.displayName} summary`, columns: cols, reporting: def })
  const t = tableById(res.model, res.table.id)!
  t.readOnly = true
  t.primaryColumn = userColumns(t)[0]?.name ?? 'id'
  return { model: res.model, table: t }
}

const summary: Pattern = {
  key: 'summary-table', group: 'reporting', label: 'Summary (aggregate) table', serverOnly: true,
  when: 'A big table is summarised the same way again and again (sales by month and item) and charts must be instant.',
  explain: 'A real table holding totals by the columns you choose, refreshed by a scheduled job (hourly by default). It is computed as the system, so it gets its own role access: only roles that may read every row of the source can read it.',
  params: [
    { key: 'source', label: 'Summarise', kind: 'table' },
    { key: 'groupBy', label: 'Group by', kind: 'columns' },
    { key: 'measures', label: 'Totals of', kind: 'measures' },
    { key: 'cron', label: 'Refresh (cron)', kind: 'cron', default: '15 * * * *' },
  ],
  generate(m, p) {
    const ms = list(p, 'measures').map((c) => ({ fn: 'sum' as const, column: c }))
    const r = summaryTable(m, { source: str(p, 'source', ''), groupBy: list(p, 'groupBy'), measures: [...ms, { fn: 'count' }], cron: str(p, 'cron', '15 * * * *') })
    return { model: r.model, tables: [r.table.id], area: 'Reporting', notes: ['The first refresh runs right after you apply.'] }
  },
}

/* ------------------------------------------------------------------ industry starters */

const manufacturing: Pattern = {
  key: 'manufacturing', group: 'industry', label: 'Manufacturing basics',
  when: 'A plant that makes items from components on machines: work orders, production logs, quality.',
  explain: 'Item, bill of materials (header and lines), machine, work order, production log, downtime, inspection and non-conformance report (NCR). Tables only: build the apps on top, or use the manufacturing pack later.',
  params: [],
  generate(m) {
    const made: string[] = []
    let { model, ids } = build(m, [
      { key: 'item', ...T('Item', [{ displayName: 'Code', type: 'text', required: true, unique: true }, { displayName: 'Name', type: 'text', required: true }, choice('Unit', ['pcs', 'kg', 'm', 'l', 'set'], { default: 'pcs' }), choice('Kind', ['Raw material', 'Component', 'Finished good'], { default: 'Component' })]), primary: 'Name' },
      { key: 'bom', ...T('BOM', [{ displayName: 'Version', type: 'text', required: true, default: '1' }, { displayName: 'Active', type: 'boolean', default: 'true' }]), primary: 'Version' },
      { key: 'bomline', ...T('BOM line', [{ displayName: 'Quantity', type: 'decimal', required: true, default: '1' }, { displayName: 'Scrap %', type: 'decimal' }]), primary: 'Quantity' },
      { key: 'machine', ...T('Machine', [{ displayName: 'Code', type: 'text', required: true, unique: true }, { displayName: 'Name', type: 'text', required: true }, { displayName: 'Line', type: 'text' }]), primary: 'Name' },
      { key: 'wo', ...T('Work order', [{ displayName: 'Number', type: 'autonumber', prefix: 'WO-' }, { displayName: 'Quantity', type: 'decimal', required: true }, choice('Status', ['Planned', 'Released', 'Running', 'Done', 'Cancelled'], { default: 'Planned', indexed: true }), { displayName: 'Planned start', type: 'date' }, { displayName: 'Due date', type: 'date' }]), primary: 'Number' },
      { key: 'log', ...T('Production log', [{ displayName: 'Logged on', type: 'datetime', required: true, default: 'now' }, choice('Shift', ['A', 'B', 'C']), { displayName: 'Good quantity', type: 'decimal', default: '0' }, { displayName: 'Scrap quantity', type: 'decimal', default: '0' }]), primary: 'Logged on' },
      { key: 'down', ...T('Downtime', [{ displayName: 'Started on', type: 'datetime', required: true }, { displayName: 'Ended on', type: 'datetime' }, choice('Reason', ['Breakdown', 'Changeover', 'No material', 'No operator', 'Planned maintenance', 'Other'], { required: true }), { displayName: 'Minutes', type: 'decimal' }]), primary: 'Reason' },
      { key: 'insp', ...T('Inspection', [{ displayName: 'Inspected on', type: 'datetime', required: true, default: 'now' }, choice('Result', ['Pass', 'Fail', 'Hold'], { required: true }), { displayName: 'Inspector', type: 'text' }, { displayName: 'Notes', type: 'multiline' }]), primary: 'Result' },
      { key: 'ncr', ...T('NCR', [{ displayName: 'Number', type: 'autonumber', prefix: 'NCR-' }, { displayName: 'Description', type: 'multiline', required: true }, choice('Severity', ['Minor', 'Major', 'Critical'], { default: 'Minor' }), choice('Status', ['Open', 'Containment', 'Closed'], { default: 'Open' }), { displayName: 'Corrective action', type: 'multiline' }]), primary: 'Number' },
    ], made)
    model = rel(model, ids.item, ids.bom, 'oneToMany', 'restrict', { required: true, columnName: 'Item' }).model
    model = rel(model, ids.bom, ids.bomline, 'oneToMany', 'cascade', { required: true, columnName: 'BOM' }).model
    model = rel(model, ids.item, ids.bomline, 'oneToMany', 'restrict', { required: true, columnName: 'Component' }).model
    model = rel(model, ids.item, ids.wo, 'oneToMany', 'restrict', { required: true, columnName: 'Item' }).model
    model = rel(model, ids.machine, ids.wo, 'oneToMany', 'setBlank', { columnName: 'Machine' }).model
    model = rel(model, ids.wo, ids.log, 'oneToMany', 'restrict', { required: true, columnName: 'Work order' }).model
    model = rel(model, ids.machine, ids.log, 'oneToMany', 'restrict', { required: true, columnName: 'Machine' }).model
    model = rel(model, ids.machine, ids.down, 'oneToMany', 'restrict', { required: true, columnName: 'Machine' }).model
    model = rel(model, ids.wo, ids.insp, 'oneToMany', 'restrict', { required: true, columnName: 'Work order' }).model
    model = rel(model, ids.insp, ids.ncr, 'oneToMany', 'restrict', { columnName: 'Inspection' }).model
    model = rel(model, ids.item, ids.ncr, 'oneToMany', 'setBlank', { columnName: 'Item' }).model
    return { model, tables: made, area: 'Manufacturing', notes: [] }
  },
}

const crm: Pattern = {
  key: 'crm', group: 'industry', label: 'CRM basics',
  when: 'Sales: who your customers are, who you talk to, what you might sell them.',
  explain: 'Account and contact (the party model), lead (not yet qualified), opportunity (a possible sale with stage and amount) and activity (calls, meetings, tasks). Tables only.',
  params: [],
  generate(m) {
    const made: string[] = []
    const sysActivity = m.tables.find((t) => isSystemTable(t) && /^activit(y|ies)$/i.test(t.name))
    const specs = [
      { key: 'acc', ...T('Account', [{ displayName: 'Name', type: 'text', required: true }, choice('Type', ['Customer', 'Prospect', 'Partner'], { default: 'Prospect' }), { displayName: 'Phone', type: 'phone' }, { displayName: 'Website', type: 'url' }, { displayName: 'City', type: 'text' }]), primary: 'Name' },
      { key: 'con', ...T('Contact', [{ displayName: 'Full name', type: 'text', required: true }, { displayName: 'Email', type: 'email' }, { displayName: 'Phone', type: 'phone' }, { displayName: 'Job title', type: 'text' }]), primary: 'Full name' },
      { key: 'lead', ...T('Lead', [{ displayName: 'Name', type: 'text', required: true }, { displayName: 'Company', type: 'text' }, { displayName: 'Email', type: 'email' }, { displayName: 'Phone', type: 'phone' }, choice('Source', ['Website', 'Referral', 'Event', 'Cold call', 'Other']), choice('Status', ['New', 'Contacted', 'Qualified', 'Disqualified'], { default: 'New', indexed: true })]), primary: 'Name' },
      { key: 'opp', ...T('Opportunity', [{ displayName: 'Name', type: 'text', required: true }, choice('Stage', ['Qualify', 'Propose', 'Negotiate', 'Won', 'Lost'], { default: 'Qualify', indexed: true }), { displayName: 'Amount', type: 'currency' }, { displayName: 'Close date', type: 'date' }, { displayName: 'Probability %', type: 'number' }]), primary: 'Name' },
      ...(sysActivity ? [] : [{ key: 'act', ...T('Activity', [{ displayName: 'Subject', type: 'text', required: true }, choice('Type', ['Call', 'Meeting', 'Email', 'Task'], { default: 'Task' }), { displayName: 'Due on', type: 'datetime' }, { displayName: 'Done', type: 'boolean', default: 'false' }]), primary: 'Subject' }]),
    ]
    let { model, ids } = build(m, specs, made)
    model = rel(model, ids.acc, ids.con, 'oneToMany', 'setBlank', { columnName: 'Account' }).model
    model = rel(model, ids.acc, ids.lead, 'oneToMany', 'setBlank', { columnName: 'Converted to account' }).model
    model = rel(model, ids.acc, ids.opp, 'oneToMany', 'restrict', { required: true, columnName: 'Account' }).model
    model = rel(model, ids.con, ids.opp, 'oneToMany', 'setBlank', { columnName: 'Main contact' }).model
    if (ids.act) {
      model = rel(model, ids.acc, ids.act, 'oneToMany', 'setBlank', { columnName: 'Account' }).model
      model = rel(model, ids.con, ids.act, 'oneToMany', 'setBlank', { columnName: 'Contact' }).model
      model = rel(model, ids.opp, ids.act, 'oneToMany', 'setBlank', { columnName: 'Opportunity' }).model
    }
    return { model, tables: made, area: 'CRM', notes: sysActivity ? ['Activities use the system Activity table (its "regarding" link points at any row).'] : [] }
  },
}

const inventory: Pattern = {
  key: 'inventory', group: 'industry', label: 'Inventory basics',
  when: 'Stock of items in one or more warehouses, moved in and out.',
  explain: 'Item, warehouse and stock movement (every receipt, issue, transfer and adjustment as a signed quantity). The stock balance is a summary table (item by warehouse) refreshed by a job: never typed, always derived from the movements.',
  params: [],
  serverOnly: false,
  generate(m) {
    const made: string[] = []
    let { model, ids } = build(m, [
      { key: 'item', ...T('Item', [{ displayName: 'SKU', type: 'text', required: true, unique: true }, { displayName: 'Name', type: 'text', required: true }, choice('Unit', ['pcs', 'kg', 'm', 'l', 'box'], { default: 'pcs' }), { displayName: 'Reorder level', type: 'decimal' }]), primary: 'Name' },
      { key: 'wh', ...T('Warehouse', [{ displayName: 'Code', type: 'text', required: true, unique: true }, { displayName: 'Name', type: 'text', required: true }, { displayName: 'Location', type: 'text' }]), primary: 'Name' },
      { key: 'mv', ...T('Stock movement', [choice('Type', ['Receipt', 'Issue', 'Transfer in', 'Transfer out', 'Adjustment'], { required: true }), { displayName: 'Quantity', type: 'decimal', required: true }, { displayName: 'Moved on', type: 'datetime', required: true, default: 'now' }, { displayName: 'Reference', type: 'text' }]), primary: 'Type' },
    ], made)
    const r1 = rel(model, ids.item, ids.mv, 'oneToMany', 'restrict', { required: true, columnName: 'Item' })
    const r2 = rel(r1.model, ids.wh, ids.mv, 'oneToMany', 'restrict', { required: true, columnName: 'Warehouse' })
    model = r2.model
    const sum = summaryTable(model, { source: ids.mv, groupBy: [r1.relationships[0].fromColumn, r2.relationships[0].fromColumn], measures: [{ fn: 'sum', column: 'Quantity' }], displayName: 'Stock balance' })
    model = sum.model
    made.push(sum.table.id)
    return { model, tables: made, area: 'Inventory', notes: ['Quantity is signed: issues and transfers out are negative.', 'Stock balance needs the server (a scheduled refresh).'] }
  },
}

export const PATTERNS: Pattern[] = [
  masterDetail, lookupReference, hierarchy, manyToMany, partyModel, statusWorkflow, documentNumbering, auditTrail, approvalReady,
  starSchema, dateDimension, snowflake, summary,
  manufacturing, crm, inventory,
]

export const PATTERN_GROUPS: Record<PatternGroup, { label: string; note?: string }> = {
  transactional: { label: 'Transactional', note: 'For entering and changing data in apps.' },
  reporting: { label: 'Reporting', note: 'For reports and dashboards, not for data entry: views and summaries are read-only.' },
  industry: { label: 'Industry starters', note: 'Small, correct models to start from (tables only, no apps).' },
}

export const patternByKey = (k: string): Pattern | undefined => PATTERNS.find((p) => p.key === k)
