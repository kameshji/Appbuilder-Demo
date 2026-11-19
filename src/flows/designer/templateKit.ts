/**
 * Flow templates (src/flows/templates/*.json): a real definition with {{param}} placeholders and the parameters a maker
 * fills in the "New flow" gallery (a table, columns of a type, a number, a text, a connection). Pure (shared with the
 * validity test in server/core/flows/templates.test.ts, which runs every template through the server's validator).
 */
import type { TableDef } from '../../platform/contracts.ts'

export interface TemplateParam {
  name: string
  label: string
  type: 'table' | 'column' | 'number' | 'text' | 'timezone' | 'connection'
  /** column: the table parameter it belongs to */
  of?: string
  /** column: the column types that fit */
  columnTypes?: string[]
  /** connection: the connector kind */
  connector?: string
  default?: string
}

export interface FlowTemplate {
  id: string
  title: string
  description: string
  category: string
  /** server features it needs ("approvals") */
  needs?: string[]
  params: TemplateParam[]
  flow: Record<string, unknown> & { connections?: Record<string, string> }
}

/** replaces {{name}} in every string (keys too) */
export function instantiate(t: FlowTemplate, values: Record<string, string>): Record<string, unknown> & { connections?: Record<string, string> } {
  const sub = (s: string) => s.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (m, k: string) => (k in values ? values[k] : m))
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return sub(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [sub(k), walk(x)]))
    return v
  }
  return walk(structuredClone(t.flow)) as Record<string, unknown> & { connections?: Record<string, string> }
}

/** columns of a table that fit a column parameter */
export function fittingColumns(p: TemplateParam, t: TableDef | undefined): { name: string; displayName: string }[] {
  if (!t) return []
  return t.columns.filter((c) => !c.system && (!p.columnTypes || p.columnTypes.includes(c.type))).map((c) => ({ name: c.name, displayName: c.displayName }))
}

/** first-guess values: defaults, the given table, the first fitting column (by name hints first) */
export function guessParams(t: FlowTemplate, tables: TableDef[], preset: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  // makers' own tables before system tables; a table that fits every column parameter first
  const ordered = [...tables.filter((x) => !x.system), ...tables.filter((x) => x.system)]
  const fits = (table: TableDef, tableParam: string) => t.params.filter((c) => c.type === 'column' && (c.of ?? 'table') === tableParam).every((c) => fittingColumns(c, table).length > 0)
  for (const p of t.params) {
    if (preset[p.name] !== undefined) { out[p.name] = preset[p.name]; continue }
    if (p.type === 'table') {
      const free = ordered.filter((x) => !Object.values(out).includes(x.name))
      out[p.name] = (free.find((x) => fits(x, p.name)) ?? free[0] ?? ordered[0])?.name ?? ''
    } else if (p.type === 'column') {
      const table = tables.find((x) => x.name === out[p.of ?? 'table'])
      const cols = fittingColumns(p, table)
      const hint = p.name.replace(/Column$/, '').toLowerCase()
      out[p.name] = (cols.find((c) => c.name.toLowerCase().includes(hint)) ?? cols[0])?.name ?? ''
    } else if (p.type === 'timezone') out[p.name] = p.default && p.default !== 'UTC' ? p.default : (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : '') || 'UTC'
    else out[p.name] = p.default ?? ''
  }
  return out
}

/** what is missing before the template can be created */
export function missingParams(t: FlowTemplate, values: Record<string, string>): string[] {
  return t.params.filter((p) => !String(values[p.name] ?? '').trim()).map((p) => p.label)
}
