/**
 * The data model in solution and app packages (package K): relationships travel with their child table's entry
 * (`relationships`), reporting settings and unique pairs with the schema (TableDef.reporting / uniqueTogether, validated
 * here because packages are untrusted input), and reporting views are re-created from their lineage on import.
 */
import type { ColumnType, TableDef } from '../../../src/platform/contracts.ts'
import type { RelationshipDef, ReportingDef, ViewExpr } from '../../../src/model/types.ts'
import { DELETE_BEHAVIOURS } from '../../../src/model/types.ts'
import type { Services } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import { IDENT } from '../../../src/model/names.ts'

const COLUMN_TYPES: ColumnType[] = ['text', 'multiline', 'email', 'url', 'phone', 'number', 'decimal', 'currency', 'boolean', 'date', 'datetime', 'choice', 'lookup', 'image', 'autonumber', 'file']
const EXPRS: ViewExpr[] = ['value', 'dateKey', 'year', 'month', 'quarter']
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v)

/** relationships whose child is this table (for its package entry) */
export async function pkgRelationshipsOf(s: Services, tableId: string): Promise<RelationshipDef[]> {
  const all = (await s.meta.relationships?.list()) ?? []
  return all.filter((r) => r.fromTable === tableId)
}

export function readPkgRelationships(v: unknown): RelationshipDef[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: RelationshipDef[] = []
  for (const r of v) {
    if (!isObj(r) || !isId(r.id) || !isId(r.fromTable) || !isId(r.toTable) || typeof r.fromColumn !== 'string' || !IDENT.test(r.fromColumn)) continue
    const kind = r.kind === 'oneToOne' || r.kind === 'self' ? r.kind : 'oneToMany'
    const onDelete = DELETE_BEHAVIOURS.includes(r.onDelete as never) ? (r.onDelete as RelationshipDef['onDelete']) : 'restrict'
    const rel: RelationshipDef = { id: r.id, fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, kind, onDelete }
    if (r.preventCycles === true) rel.preventCycles = true
    if (isObj(r.junction) && isId(r.junction.group)) rel.junction = { group: r.junction.group }
    out.push(rel)
  }
  return out
}

/** TableDef.reporting from a package, validated against the table's columns (null: drop it) */
export function sanitizeReporting(raw: unknown, columns: string[]): ReportingDef | null {
  if (!isObj(raw)) return null
  if (raw.kind === 'view') {
    if (!isId(raw.base) || !Array.isArray(raw.columns)) return null
    const cols = []
    for (const c of raw.columns) {
      if (!isObj(c) || typeof c.name !== 'string' || !IDENT.test(c.name) || typeof c.source !== 'string' || !IDENT.test(c.source) || !columns.includes(c.name)) return null
      const expr = c.expr === undefined ? undefined : EXPRS.includes(c.expr as ViewExpr) ? (c.expr as ViewExpr) : null
      if (expr === null) return null
      cols.push({
        name: c.name, displayName: typeof c.displayName === 'string' ? c.displayName.slice(0, 200) : c.name,
        type: COLUMN_TYPES.includes(c.type as ColumnType) ? (c.type as ColumnType) : 'text', source: c.source,
        ...(expr ? { expr } : {}), ...(typeof c.lookupTable === 'string' && IDENT.test(c.lookupTable) ? { lookupTable: c.lookupTable } : {}),
      })
    }
    return { kind: 'view', role: raw.role === 'fact' ? 'fact' : 'dimension', base: raw.base, columns: cols }
  }
  if (raw.kind === 'summary') {
    if (!isId(raw.source) || !Array.isArray(raw.groupBy) || !Array.isArray(raw.measures)) return null
    const groupBy = raw.groupBy.filter((g): g is string => typeof g === 'string' && IDENT.test(g))
    const measures = raw.measures.filter(isObj).flatMap((m) => {
      if (typeof m.name !== 'string' || !IDENT.test(m.name) || !['sum', 'count', 'avg', 'min', 'max'].includes(String(m.fn))) return []
      return [{ name: m.name, fn: m.fn as 'sum', ...(typeof m.column === 'string' && IDENT.test(m.column) ? { column: m.column } : {}) }]
    })
    const cron = typeof raw.cron === 'string' && raw.cron.trim().split(/\s+/).length === 5 ? raw.cron.trim() : '15 * * * *'
    return { kind: 'summary', source: raw.source, groupBy, measures, cron }
  }
  if (raw.kind === 'date') {
    const d = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
    const from = d(raw.from)
    const to = d(raw.to)
    if (!from || !to) return null
    const m = Math.trunc(Number(raw.fiscalYearStartMonth))
    return { kind: 'date', from, to, fiscalYearStartMonth: m >= 1 && m <= 12 ? m : 4 }
  }
  return null
}

export function sanitizeUniqueTogether(raw: unknown, columns: string[]): string[][] | null {
  if (!Array.isArray(raw)) return null
  const sets = raw.filter((x): x is unknown[] => Array.isArray(x)).map((x) => x.filter((c): c is string => typeof c === 'string' && columns.includes(c))).filter((x) => x.length > 1)
  return sets.length ? sets.slice(0, 8) : null
}

/**
 * Before a reporting view from a package (or a copy) is created: its base must be a table of this environment in the
 * default database (`map` translates package ids); the physical base name and the read-only flags come from here.
 */
export async function prepareViewDef(s: Services, def: TableDef, map?: Map<string, string>): Promise<void> {
  const r = def.reporting
  if (r?.kind !== 'view') return
  const baseId = map?.get(r.base) ?? r.base
  const base = await s.meta.tables.get(baseId)
  if (!base || !base.source || (base.connectionId ?? 'conn_default') !== 'conn_default' || base.reporting?.kind === 'view') {
    throw new HttpError(422, 'invalid', `The reporting view "${def.displayName}" needs its source table (in the default database) first.`)
  }
  for (const c of r.columns) if (!base.columns.some((x) => x.name === c.source)) throw new HttpError(422, 'invalid', `The reporting view "${def.displayName}" reads "${c.source}", which ${base.displayName} does not have.`)
  def.reporting = { ...r, base: base.id, baseSource: base.source }
  def.readOnly = true
  if (def.source?.startsWith('t_')) def.source = `v_${def.source.slice(2)}`
}

/** relationships of the package's tables, with package ids translated (map) */
export async function restorePkgRelationships(s: Services, tables: { def: TableDef; relationships?: RelationshipDef[] }[], map: Map<string, string>): Promise<void> {
  const store = s.meta.relationships
  if (!store) return
  const live = await s.meta.tables.list()
  for (const p of tables) {
    for (const r of p.relationships ?? []) {
      const from = map.get(r.fromTable) ?? r.fromTable
      const to = map.get(r.toTable) ?? r.toTable
      const child = live.find((t) => t.id === from)
      const col = child?.columns.find((c) => c.name === r.fromColumn)
      const parent = live.find((t) => t.id === to)
      if (!child || !col || col.type !== 'lookup' || !parent || parent.name.toLowerCase() !== (col.lookupTable ?? '').toLowerCase()) continue
      // a copy gets its own relationship ids; an install or upgrade keeps the package's
      const id = from !== r.fromTable ? `rel_${from}_${r.fromColumn}`.slice(0, 64) : r.id
      await store.put({ ...r, id, fromTable: from, toTable: to, onDelete: r.onDelete === 'setBlank' && col.required ? 'restrict' : r.onDelete })
    }
  }
  await store.sync(await s.meta.tables.list())
}

/** lines for a solution import plan: relationship behaviours that the import adds or changes */
export async function relationshipPlanLines(s: Services, tables: { def: TableDef; relationships?: RelationshipDef[] }[], map: Map<string, string>): Promise<string[]> {
  const store = s.meta.relationships
  if (!store) return []
  const have = await store.list()
  let added = 0
  const changed: string[] = []
  const other: string[] = []
  for (const p of tables) {
    for (const r of p.relationships ?? []) {
      const from = map.get(r.fromTable) ?? r.fromTable
      const cur = have.find((x) => x.fromTable === from && x.fromColumn === r.fromColumn)
      if (!cur) added++
      else if (cur.onDelete !== r.onDelete) changed.push(`${p.def.displayName}.${r.fromColumn}: ${cur.onDelete} → ${r.onDelete}`)
      else if ((cur.kind ?? 'oneToMany') !== (r.kind ?? 'oneToMany') || !!cur.preventCycles !== !!r.preventCycles) other.push(`${p.def.displayName}.${r.fromColumn}`)
    }
  }
  const out: string[] = []
  if (added) out.push(`Relationships: ${added} new (with their delete behaviours).`)
  if (changed.length) out.push(`Delete behaviour changes: ${changed.slice(0, 10).join('; ')}.`)
  if (other.length) out.push(`Relationship changes (kind or loop prevention): ${other.slice(0, 10).join('; ')}.`)
  return out
}
