/**
 * Model checks (lint) for the designer's side panel (pure). Each finding names a table (and column) so the canvas can
 * focus it. `stats` (optional) are facts read from the data (text columns whose values look like numbers or dates);
 * `rules` are the columns used by row-security rules and filters.
 */
import type { Model } from './types.ts'
import { isSystemTable } from './types.ts'
import { requiredCycles, tableById, tableByName, userColumns } from './ops.ts'

export type LintLevel = 'warning' | 'info'
export interface LintFinding {
  code: string
  level: LintLevel
  table?: string
  column?: string
  message: string
  /** what to do about it */
  fix?: string
}

export interface ColumnStats {
  table: string
  column: string
  /** non-blank values checked */
  values: number
  numeric: number
  dates: number
}

export interface LintInput {
  stats?: ColumnStats[]
  /** columns used by row rules (roles) and saved filters */
  rules?: { table: string; column: string; source: string }[]
  /** tables on a connection that keeps its own indexes (lookups there are not indexed by Appbuilder) */
  externalTables?: string[]
  wideColumns?: number
}

const style = (name: string): 'snake' | 'pascal' | 'camel' | 'other' =>
  /^[a-z0-9]+(_[a-z0-9]+)+$/.test(name) ? 'snake' : /^[A-Z][A-Za-z0-9]*$/.test(name) ? 'pascal' : /^[a-z][A-Za-z0-9]*$/.test(name) ? 'camel' : 'other'

export function lintModel(m: Model, input: LintInput = {}): LintFinding[] {
  const out: LintFinding[] = []
  const wide = input.wideColumns ?? 40
  const user = m.tables.filter((t) => !isSystemTable(t))
  const related = new Set<string>()
  for (const t of m.tables) {
    for (const c of t.columns) {
      if (c.type !== 'lookup') continue
      const p = tableByName(m, c.lookupTable)
      if (p) { related.add(t.id); related.add(p.id) }
    }
    for (const c of t.columns) if (c.computed?.kind === 'rollup') { related.add(t.id); const s = tableByName(m, c.computed.table); if (s) related.add(s.id) }
    if (t.reporting?.kind === 'view') { related.add(t.id); related.add(t.reporting.base) }
    if (t.reporting?.kind === 'summary') { related.add(t.id); related.add(t.reporting.source) }
  }

  for (const t of user) {
    const cols = userColumns(t)
    const view = t.reporting?.kind === 'view'
    if (!view && (!t.primaryColumn || t.primaryColumn === 'id' || !cols.some((c) => c.name === t.primaryColumn))) {
      out.push({ code: 'no-display-column', level: 'warning', table: t.id, message: `${t.displayName} has no display column, so lookups to it show ids.`, fix: 'Pick a name-like column as the display column.' })
    }
    if (!view && !cols.some((c) => c.type === 'text' || c.type === 'autonumber' || c.type === 'email')) {
      out.push({ code: 'no-name-column', level: 'info', table: t.id, message: `${t.displayName} has no text column that could name a row.` })
    }
    if (cols.length > wide) out.push({ code: 'wide-table', level: 'warning', table: t.id, message: `${t.displayName} has ${cols.length} columns.`, fix: 'Split rarely used groups of columns into a one-to-one child table.' })
    if (!related.has(t.id) && m.tables.length > 1) out.push({ code: 'orphan-table', level: 'info', table: t.id, message: `${t.displayName} is not related to any other table.` })
    for (const c of cols) {
      if (c.type === 'lookup' && (input.externalTables ?? []).includes(t.id) && !c.indexed && !c.unique) {
        out.push({ code: 'lookup-no-index', level: 'warning', table: t.id, column: c.name, message: `${t.displayName}.${c.displayName} is a lookup without an index on its connection.`, fix: 'Ask the database owner for an index on this column.' })
      }
    }
  }

  // many-to-many junction tables without a unique pair
  const groups = new Map<string, string[]>()
  for (const r of m.relationships) if (r.junction) groups.set(r.junction.group, [...(groups.get(r.junction.group) ?? []), r.fromColumn])
  for (const r of m.relationships) {
    if (!r.junction) continue
    const t = tableById(m, r.fromTable)
    if (!t) continue
    const pair = groups.get(r.junction.group) ?? []
    const ok = (t.uniqueTogether ?? []).some((set) => pair.every((p) => set.includes(p)))
    if (!ok && !out.some((f) => f.code === 'm2m-no-unique' && f.table === t.id)) {
      out.push({ code: 'm2m-no-unique', level: 'warning', table: t.id, message: `${t.displayName} links two tables but the same pair can be added twice.`, fix: `Make ${pair.join(' + ')} unique together.` })
    }
  }
  // tables that look like junctions (two required lookups, little else) without a unique pair
  for (const t of user) {
    const lookups = userColumns(t).filter((c) => c.type === 'lookup')
    if (lookups.length !== 2 || userColumns(t).length > 4 || out.some((f) => f.code === 'm2m-no-unique' && f.table === t.id)) continue
    if (!(t.uniqueTogether ?? []).some((set) => lookups.every((l) => set.includes(l.name)))) {
      out.push({ code: 'm2m-no-unique', level: 'info', table: t.id, message: `${t.displayName} looks like a many-to-many link table without a unique pair.`, fix: `Make ${lookups.map((l) => l.displayName).join(' + ')} unique together.` })
    }
  }

  for (const c of requiredCycles(m)) out.push({ code: 'required-cycle', level: 'warning', message: `Required lookups form a circle: ${c}.`, fix: 'Make one of the lookups optional, or no first row can be created.' })

  for (const r of m.relationships) {
    const t = tableById(m, r.fromTable)
    const c = t?.columns.find((x) => x.name === r.fromColumn)
    if (t && c && r.onDelete === 'setBlank' && c.required) out.push({ code: 'setblank-required', level: 'warning', table: t.id, column: c.name, message: `${t.displayName}.${c.displayName} is required but set to be cleared when its parent is deleted.`, fix: 'Use Restrict or Cascade.' })
    if (t && r.kind === 'self' && !r.preventCycles && r.onDelete === 'cascade') out.push({ code: 'self-cascade', level: 'info', table: t.id, column: r.fromColumn, message: `Deleting a row of ${t.displayName} deletes its whole subtree.` })
  }

  for (const s of input.stats ?? []) {
    const t = tableById(m, s.table)
    const c = t?.columns.find((x) => x.name === s.column)
    if (!t || !c || s.values < 5) continue
    if (s.numeric / s.values >= 0.95) out.push({ code: 'text-looks-numeric', level: 'warning', table: t.id, column: c.name, message: `${t.displayName}.${c.displayName} is text but ${pct(s.numeric, s.values)} of its values are numbers.`, fix: 'Change it to Number or Decimal (the plan checks every value first).' })
    else if (s.dates / s.values >= 0.95) out.push({ code: 'text-looks-date', level: 'warning', table: t.id, column: c.name, message: `${t.displayName}.${c.displayName} is text but ${pct(s.dates, s.values)} of its values are dates.`, fix: 'Change it to Date (the plan checks every value first).' })
  }

  for (const r of input.rules ?? []) {
    const t = tableById(m, r.table)
    const c = t?.columns.find((x) => x.name === r.column)
    if (!t || !c || c.system || c.indexed || c.unique || c.type === 'lookup' || c.type === 'multiline') continue
    if (out.some((f) => f.code === 'rule-unindexed' && f.table === t.id && f.column === c.name)) continue
    out.push({ code: 'rule-unindexed', level: 'info', table: t.id, column: c.name, message: `${t.displayName}.${c.displayName} is used by ${r.source} but has no index.`, fix: 'Turn on "Indexed" so the rule stays fast on large tables.' })
  }

  // naming
  const styles = new Map<string, string[]>()
  for (const t of user) styles.set(style(t.name), [...(styles.get(style(t.name)) ?? []), t.name])
  const main = [...styles.entries()].filter(([k]) => k !== 'other').sort((a, b) => b[1].length - a[1].length)
  if (main.length > 1) {
    out.push({ code: 'naming-style', level: 'info', message: `Table names mix styles: ${main.map(([k, v]) => `${k} (${v.slice(0, 3).join(', ')})`).join(' and ')}.`, fix: 'Pick one style for table names.' })
  }
  const pluralNames = user.filter((t) => /[^s]s$/i.test(t.displayName) && !/(ss|us|is)$/i.test(t.displayName))
  if (pluralNames.length && pluralNames.length < user.length && user.length - pluralNames.length > 0 && pluralNames.length / user.length > 0.2 && pluralNames.length / user.length < 0.8) {
    out.push({ code: 'naming-plural', level: 'info', message: `Some table names are plural (${pluralNames.slice(0, 3).map((t) => t.displayName).join(', ')}) and others singular.`, fix: 'Use one form, for example the singular ("Order", "Customer").' })
  }
  for (const t of user) {
    const seen = new Map<string, string>()
    for (const c of t.columns) {
      const k = c.displayName.trim().toLowerCase()
      if (seen.has(k)) out.push({ code: 'duplicate-label', level: 'warning', table: t.id, column: c.name, message: `${t.displayName} has two columns labelled "${c.displayName}".` })
      seen.set(k, c.name)
    }
  }
  return out
}

const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}%`
