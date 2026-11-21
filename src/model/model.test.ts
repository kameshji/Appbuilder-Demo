import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Model } from './types.ts'
import {
  addColumn, addTable, applyOps, checkOps, clone, createRelationship, diffModels, removeColumn, removeRelationship, removeTable, requiredCycles,
  tableById, updateColumn, updateRelationship, withImplicitRelationships,
} from './ops.ts'
import { CARD_W, GAP_X, autoLayout, autoLayoutByArea, cardHeight, placeMissing } from './layout.ts'
import { lintModel } from './lint.ts'
import { parseDbml, toDbml } from './dbml.ts'
import { inferSheets, inferenceToModel } from './infer.ts'
import { PATTERNS, generateStar, patternByKey, summaryTable } from './patterns.ts'
import { dateDimRows, fiscalYearLabel } from './datedim.ts'
import { renderModelSvg } from './svg.ts'

const empty = (): Model => ({ tables: [], relationships: [] })

function orders(): { m: Model; cust: string; ord: string; line: string } {
  let m = empty()
  const c = addTable(m, { displayName: 'Customer', columns: [{ displayName: 'Name', type: 'text', required: true }, { displayName: 'Region', type: 'choice', choices: ['N', 'S'] }] })
  m = c.model
  const o = addTable(m, { displayName: 'Order', columns: [{ displayName: 'Number', type: 'autonumber', prefix: 'O-' }, { displayName: 'Date', type: 'date' }] })
  m = o.model
  const l = addTable(m, { displayName: 'Order line', columns: [{ displayName: 'Item', type: 'text' }, { displayName: 'Qty', type: 'decimal' }, { displayName: 'Amount', type: 'currency' }] })
  m = l.model
  m = createRelationship(m, { parent: c.table.id, child: o.table.id, cardinality: 'oneToMany', onDelete: 'restrict', required: true }).model
  m = createRelationship(m, { parent: o.table.id, child: l.table.id, cardinality: 'oneToMany', onDelete: 'cascade', required: true }).model
  return { m, cust: c.table.id, ord: o.table.id, line: l.table.id }
}

describe('model editing and diff', () => {
  it('relationships create lookup columns; many-to-many makes a junction with a unique pair', () => {
    const { m, cust, ord } = orders()
    const o = tableById(m, ord)!
    expect(o.columns.find((c) => c.name === 'Customer')).toMatchObject({ type: 'lookup', lookupTable: 'Customer', required: true })
    expect(m.relationships).toHaveLength(2)
    const r = createRelationship(m, { parent: cust, child: ord, cardinality: 'manyToMany', onDelete: 'cascade' })
    expect(r.junction?.uniqueTogether).toEqual([[r.junction!.columns[5].name, r.junction!.columns[6].name]])
    expect(r.relationships.map((x) => x.junction?.group)).toEqual([r.relationships[0].junction!.group, r.relationships[0].junction!.group])
    // removing one side of a junction removes the junction table
    expect(removeRelationship(r.model, r.relationships[0].id).tables.some((t) => t.id === r.junction!.id)).toBe(false)
  })

  it('set blank is not allowed on a required lookup', () => {
    const { m, cust, ord } = orders()
    const rel = m.relationships.find((r) => r.toTable === cust)!
    const next = updateRelationship(m, rel.id, { onDelete: 'setBlank' })
    expect(next.relationships.find((r) => r.id === rel.id)!.onDelete).toBe('restrict')
    const opt = updateRelationship(next, rel.id, { required: false, onDelete: 'setBlank' })
    expect(opt.relationships.find((r) => r.id === rel.id)!.onDelete).toBe('setBlank')
    expect(tableById(opt, ord)!.columns.find((c) => c.name === 'Customer')!.required).toBeUndefined()
  })

  it('diff -> ops -> applyOps reproduces the draft, and is empty for no change', () => {
    const { m, ord, line } = orders()
    const base = withImplicitRelationships(m)
    expect(diffModels(base, base)).toEqual([])
    let d = addColumn(base, ord, { displayName: 'Notes', type: 'multiline' }).model
    d = updateColumn(d, line, 'Qty', { type: 'number', displayName: 'Quantity' })
    d = removeColumn(d, line, 'Amount')
    d = addTable(d, { displayName: 'Warehouse' }).model
    const ops = diffModels(base, d)
    expect(ops.map((o) => o.op).sort()).toEqual(['addColumn', 'createTable', 'dropColumn', 'updateColumn'])
    const { model, conflicts } = applyOps(base, ops)
    expect(conflicts).toEqual([])
    expect(diffModels(model, d)).toEqual([])
    expect(checkOps(base, ops)).toEqual([])
  })

  it('applyOps reports conflicts when the target changed since the draft started', () => {
    const { m, line } = orders()
    const draft = updateColumn(m, line, 'Qty', { type: 'number' })
    const ops = diffModels(m, draft)
    const live = updateColumn(m, line, 'Qty', { displayName: 'Units' })
    expect(applyOps(live, ops).conflicts[0]).toMatch(/changed by someone else/)
  })

  it('removing a table removes lookups and relationships to it', () => {
    const { m, cust, ord } = orders()
    const next = removeTable(m, cust)
    expect(tableById(next, ord)!.columns.some((c) => c.name === 'Customer')).toBe(false)
    expect(next.relationships.every((r) => r.toTable !== cust)).toBe(true)
  })

  it('checkOps refuses required lookup circles, unknown targets and ab_ names', () => {
    const { m, cust, ord } = orders()
    const cyc = createRelationship(m, { parent: ord, child: cust, cardinality: 'oneToMany', onDelete: 'restrict', required: true, columnName: 'Last order' }).model
    expect(requiredCycles(cyc)).toEqual(['Customer → Order → Customer'])
    expect(checkOps(m, diffModels(m, cyc)).join(' ')).toMatch(/circle/)
    const bad = clone(m)
    bad.tables.push({ ...clone(bad.tables[0]), id: 'new_x', name: 'ab_x' })
    expect(checkOps(m, diffModels(m, bad)).join(' ')).toMatch(/cannot start with "ab_"/)
  })

  it('withImplicitRelationships records lookups without a relationship (required: restrict, optional: set blank)', () => {
    const { m, ord } = orders()
    const bare = { ...clone(m), relationships: [] }
    const t = tableById(bare, ord)!
    t.columns.push({ name: 'Ref', displayName: 'Ref', type: 'lookup', lookupTable: 'Order' })
    const out = withImplicitRelationships(bare)
    expect(out.relationships.map((r) => [r.fromColumn, r.kind, r.onDelete]).sort()).toEqual([['Customer', 'oneToMany', 'restrict'], ['Order', 'oneToMany', 'restrict'], ['Ref', 'self', 'setBlank']])
  })
})

describe('layout', () => {
  it('puts parents left of children and stacks unconnected tables below', () => {
    let { m, cust, ord, line } = orders()
    m = addTable(m, { displayName: 'Loose' }).model
    const pos = autoLayout(m)
    expect(pos[cust].x).toBe(0)
    expect(pos[ord].x).toBe(CARD_W + GAP_X)
    expect(pos[line].x).toBe(2 * (CARD_W + GAP_X))
    const loose = m.tables.find((t) => t.name === 'Loose')!
    expect(pos[loose.id].y).toBeGreaterThan(Math.max(pos[cust].y + cardHeight(tableById(m, cust)!), pos[line].y))
    expect(autoLayout(m)).toEqual(pos)
  })
  it('a cycle of lookups (A -> C -> B -> A) still gets finite positions (an empty first layer is not NaN)', () => {
    let m = orders().m
    const ids: string[] = []
    for (const n of ['Alpha', 'Beta', 'Gamma']) { const r = addTable(m, { displayName: n }); m = r.model; ids.push(m.tables.find((t) => t.name === n)!.id) }
    const link = (from: string, to: string) => tableById(m, ids[['Alpha', 'Beta', 'Gamma'].indexOf(from)])!.columns.push({ name: `${to}Ref`, displayName: `${to} ref`, type: 'lookup', lookupTable: to })
    link('Alpha', 'Gamma')
    link('Gamma', 'Beta')
    link('Beta', 'Alpha')
    // only the three: nothing else fills the first layer
    const pos = autoLayout(m, { ids })
    for (const id of ids) expect(Number.isFinite(pos[id].x) && Number.isFinite(pos[id].y), JSON.stringify(pos[id])).toBe(true)
    expect(Object.values(pos).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
  })
  it('auto-layout by area keeps areas apart (stacked blocks)', () => {
    const { m, cust, ord, line } = orders()
    const pos = autoLayoutByArea(m, { positions: {}, areas: [{ id: 'a', name: 'Lines', color: 'blue', tables: [line] }] })
    expect(pos[line]).toEqual({ x: 0, y: 0 })
    expect(Math.min(pos[cust].y, pos[ord].y)).toBeGreaterThan(cardHeight(tableById(m, line)!))
  })
  it('places only missing tables, to the right of the others', () => {
    const { m, cust, ord, line } = orders()
    const layout = { positions: { [cust]: { x: 0, y: 0 }, [ord]: { x: 400, y: 0 } }, areas: [] }
    const out = placeMissing(m, layout)
    expect(out.positions[cust]).toEqual({ x: 0, y: 0 })
    expect(out.positions[line].x).toBeGreaterThanOrEqual(400 + CARD_W)
  })
})

describe('lint', () => {
  it('finds missing display columns, orphans, junctions without a unique pair, text numbers, unindexed rule columns', () => {
    let { m, ord, cust } = orders()
    const orphan = addTable(m, { displayName: 'Orphan', columns: [{ displayName: 'Amount', type: 'decimal' }] })
    m = orphan.model
    tableById(m, orphan.table.id)!.primaryColumn = 'id'
    const j = createRelationship(m, { parent: cust, child: ord, cardinality: 'manyToMany', onDelete: 'cascade' })
    m = j.model
    tableById(m, j.junction!.id)!.uniqueTogether = undefined
    const codes = lintModel(m, {
      stats: [{ table: cust, column: 'Name', values: 100, numeric: 100, dates: 0 }],
      rules: [{ table: cust, column: 'Region', source: 'role Sales' }],
    }).map((f) => f.code)
    expect(codes).toEqual(expect.arrayContaining(['no-display-column', 'orphan-table', 'm2m-no-unique', 'text-looks-numeric', 'rule-unindexed']))
  })
  it('a clean master-detail model has no warnings', () => {
    const r = patternByKey('master-detail')!.generate(empty(), {})
    expect(lintModel(r.model).filter((f) => f.level === 'warning')).toEqual([])
  })
})

describe('DBML', () => {
  it('round-trips tables, types, lookups and delete behaviours', () => {
    const { m } = orders()
    const text = toDbml(m)
    expect(text).toContain('Table Order {')
    expect(text).toMatch(/Ref: OrderLine\.Order > Order\.id \[delete: cascade\]/)
    const back = parseDbml(text)
    expect(back.warnings).toEqual([])
    expect(back.model.tables.map((t) => t.name).sort()).toEqual(['Customer', 'Order', 'OrderLine'])
    const line = back.model.tables.find((t) => t.name === 'OrderLine')!
    expect(line.columns.find((c) => c.name === 'Order')).toMatchObject({ type: 'lookup', lookupTable: 'Order', required: true })
    expect(back.model.relationships.map((r) => r.onDelete).sort()).toEqual(['cascade', 'restrict'])
    expect(toDbml(back.model)).toBe(text)
  })
  it('reads common SQL types and Ref directions', () => {
    const r = parseDbml(`
      Table users { id int [pk] \n email varchar(255) [unique, not null] \n created timestamp }
      Table posts { id int [pk]
        user_id int
        body longtext
        price numeric(10,2)
        status enum('draft','live')
      }
      Ref: users.id < posts.user_id [delete: cascade]
    `)
    const posts = r.model.tables.find((t) => t.name === 'posts')!
    expect(posts.columns.map((c) => [c.name, c.type])).toEqual(expect.arrayContaining([['user_id', 'lookup'], ['body', 'multiline'], ['price', 'currency'], ['status', 'choice']]))
    expect(r.model.relationships[0]).toMatchObject({ onDelete: 'cascade', kind: 'oneToMany' })
    expect(r.model.tables.find((t) => t.name === 'users')!.columns.find((c) => c.name === 'created')!.type).toBe('datetime')
  })
})

describe('inference from sheets', () => {
  it('finds keys and relationships by name and value overlap', () => {
    const inf = inferSheets([
      { name: 'Customers', headers: ['Customer code', 'Name', 'City'], rows: [['C1', 'Acme', 'Pune'], ['C2', 'Bolt', 'Delhi'], ['C3', 'Core', 'Pune']] },
      { name: 'Orders', headers: ['Order no', 'Customer', 'Date', 'Amount'], rows: [['1', 'C1', '2026-01-02', '10.5'], ['2', 'C2', '2026-01-03', '7'], ['3', 'C1', '2026-02-01', '1']] },
    ])
    expect(inf.tables[0]).toMatchObject({ key: 'Customer code', rows: 3 })
    expect(inf.tables[1].columns.map((c) => c.type)).toEqual(['number', 'text', 'date', 'decimal'])
    expect(inf.relationships).toEqual([expect.objectContaining({ from: 'Orders', fromColumn: 'Customer', to: 'Customers', toColumn: 'Customer code' })])
    expect(inf.relationships[0].confidence).toBeGreaterThan(0.9)
    const { model } = inferenceToModel(inf, inf.relationships)
    const ordersT = model.tables.find((t) => t.name === 'Orders')!
    expect(ordersT.columns.find((c) => c.name === 'Customer')).toMatchObject({ type: 'lookup', lookupTable: 'Customers' })
    expect(model.tables.find((t) => t.name === 'Customers')!.columns.find((c) => c.name === 'CustomerCode')).toMatchObject({ unique: true, required: true })
  })
})

describe('patterns', () => {
  it('every pattern generates a consistent model', () => {
    const { m, ord, line } = orders()
    const base = withImplicitRelationships(m)
    for (const p of PATTERNS) {
      const params: Record<string, unknown> = p.key === 'star-schema' || p.key === 'snowflake'
        ? { fact: line, measures: ['Qty', 'Amount'], dimensions: ['Order'], dateColumn: '' }
        : p.key === 'summary-table' ? { source: line, groupBy: ['Order'], measures: ['Amount'] } : {}
      const r = p.generate(base, params)
      expect(r.tables.length, p.key).toBeGreaterThan(0)
      expect(checkOps(base, diffModels(base, r.model)), p.key).toEqual([])
      void ord
    }
  })
  it('master-detail: cascade lines and a rollup total', () => {
    const r = patternByKey('master-detail')!.generate(empty(), { header: 'Invoice', lines: 'Invoice line' })
    const [h, l] = r.tables.map((id) => tableById(r.model, id)!)
    expect(h.columns.find((c) => c.name === 'Total')!.computed).toEqual({ kind: 'rollup', table: 'InvoiceLine', via: 'Invoice', fn: 'sum', column: 'Amount' })
    expect(r.model.relationships).toEqual([expect.objectContaining({ fromTable: l.id, toTable: h.id, onDelete: 'cascade' })])
  })
  it('star schema: fact view with lineage, dimension views, date key; snowflake adds sub-dimensions', () => {
    let { m, cust, line } = orders()
    const reg = addTable(m, { displayName: 'Region' })
    m = createRelationship(reg.model, { parent: reg.table.id, child: cust, cardinality: 'oneToMany', onDelete: 'setBlank', columnName: 'Sales region' }).model
    const star = generateStar(m, { fact: line, measures: ['Qty', 'Amount'], dimensions: ['Order'], dateColumn: undefined })
    const fact = star.model.tables.find((t) => t.name === 'FactOrderLine')!
    expect(fact.reporting).toMatchObject({ kind: 'view', role: 'fact', base: line })
    expect(fact.readOnly).toBe(true)
    expect((fact.reporting as { columns: { name: string; source: string; lookupTable?: string }[] }).columns.map((c) => [c.name, c.source, c.lookupTable])).toEqual([['Order', 'Order', 'DimOrder'], ['Qty', 'Qty', undefined], ['Amount', 'Amount', undefined]])
    expect(star.model.tables.some((t) => t.name === 'DimCustomer')).toBe(false)
    const snow = generateStar(m, { fact: line, measures: ['Amount'], dimensions: ['Order'], snowflake: true })
    expect(snow.model.tables.filter((t) => t.reporting?.kind === 'view').map((t) => t.name).sort()).toEqual(['DimCustomer', 'DimOrder', 'DimRegion', 'FactOrderLine'])
  })
  it('summary tables keep the group-by columns and measures', () => {
    const { m, line } = orders()
    const s = summaryTable(m, { source: line, groupBy: ['Order', 'Item'], measures: [{ fn: 'sum', column: 'Amount' }, { fn: 'count' }] })
    expect(s.table.reporting).toMatchObject({ kind: 'summary', groupBy: ['Order', 'Item'], measures: [{ name: 'SumAmount', fn: 'sum', column: 'Amount' }, { name: 'RowCount', fn: 'count' }], cron: '15 * * * *' })
    expect(s.table.columns.map((c) => c.name)).toContain('RefreshedOn')
  })
})

describe('date dimension', () => {
  it('fiscal years start in April by default (India)', () => {
    expect(fiscalYearLabel(2026, 3, 4)).toBe('FY2025-26')
    expect(fiscalYearLabel(2026, 4, 4)).toBe('FY2026-27')
    expect(fiscalYearLabel(2026, 4, 1)).toBe('FY2026')
    const rows = dateDimRows({ kind: 'date', from: '2026-03-30', to: '2026-04-02', fiscalYearStartMonth: 4 })
    expect(rows.map((r) => [r.DateKey, r.FiscalYear, r.FiscalMonth, r.FiscalQuarter, r.WeekdayName])).toEqual([
      [20260330, 'FY2025-26', 12, 4, 'Monday'], [20260331, 'FY2025-26', 12, 4, 'Tuesday'], [20260401, 'FY2026-27', 1, 1, 'Wednesday'], [20260402, 'FY2026-27', 1, 1, 'Thursday'],
    ])
    expect(dateDimRows({ kind: 'date', from: '2024-01-01', to: '2024-12-31', fiscalYearStartMonth: 4 })).toHaveLength(366)
    expect(() => dateDimRows({ kind: 'date', from: '1900-01-01', to: '2026-01-01', fiscalYearStartMonth: 4 })).toThrow(/40 years/)
  })
})

describe('svg export', () => {
  it('draws cards, crow feet and areas', () => {
    const { m, ord } = orders()
    const layout = { positions: autoLayout(m), areas: [{ id: 'a1', name: 'Sales', color: 'blue', tables: [ord] }] }
    const svg = renderModelSvg(m, layout, { title: 'Model' })
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain('>Order line<')
    expect(svg).toContain('>Sales<')
    expect((svg.match(/<path d="M [\d.-]+ [\d.-]+ C/g) ?? []).length).toBe(2)
  })
})

describe('layering', () => {
  it('src/model imports only src/model (and types from src/platform)', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      for (const m of text.matchAll(/^\s*import\s+(type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
        const spec = m[2]
        expect(spec.startsWith('./') || (m[1] && spec.startsWith('../platform/')), `${f}: ${spec}`).toBeTruthy()
        if (spec.startsWith('./')) expect(spec.endsWith('.ts'), `${f}: ${spec}`).toBe(true)
      }
    }
  })
})
