/**
 * The binding step (master-plan 11.3 rule 2; docs/dev/templates.md): every slot of a template is mapped to an existing
 * table and its columns (of a compatible type), created, or (optional slots) left out. Pure: the caller passes the
 * environment's tables. The server runs it for the plan and again for the install; the browser shows its report.
 */
import type { AppDef, ControlNode } from '../contracts.ts'
import type { ColumnDef, ColumnType, TableDef } from '../platform/contracts.ts'
import type { TableEventInput } from '../platform/events.ts'
import { IDENT, uniqueIdentifier } from '../model/names.ts'
import { systemColumnDefs } from '../model/ops.ts'
import {
  columnToken, declaredTokens, tableToken, type CandidateColumn, type SlotBinding, type SlotColumn, type SlotColumnReport, type SlotReport,
  type TemplatePackage, type TemplateSlot,
} from './format.ts'
import { rewriteFormula, tokensIn } from './rewrite.ts'

/** what the binding needs to know about a table of the environment */
export type EnvTable = Pick<TableDef, 'id' | 'name' | 'displayName' | 'columns'> & Partial<Pick<TableDef, 'system' | 'readOnly' | 'reporting'>>

export interface ResolvedSlot {
  slot: TemplateSlot
  mode: SlotBinding['mode']
  /** the table's name once bound (the existing one, or the one created); null: left out */
  tableName: string | null
  tableId?: string
  displayName?: string
  /** slot column id -> column name there (null: not mapped) */
  columns: Map<string, string | null>
}

export interface Resolution {
  slots: SlotReport[]
  resolved: ResolvedSlot[]
  /** slot token -> name (null: left out, reads Blank()) */
  tokens: Map<string, string | null>
  problems: string[]
  warnings: string[]
}

const TYPE_WORD: Record<ColumnType, string> = {
  text: 'text', multiline: 'long text', email: 'email', url: 'web address', phone: 'phone', number: 'whole number', decimal: 'decimal number',
  currency: 'currency', boolean: 'yes/no', date: 'date', datetime: 'date and time', choice: 'choice', lookup: 'lookup', image: 'image',
  autonumber: 'autonumber', file: 'file',
}
const typeWords = (types: ColumnType[]): string => {
  const w = types.map((t) => TYPE_WORD[t] ?? t)
  return w.length <= 1 ? (w[0] ?? '') : `${w.slice(0, -1).join(', ')} or ${w[w.length - 1]}`
}
const article = (w: string): string => (/^[aeiou]/i.test(w) ? 'an' : 'a')

const byName = (tables: EnvTable[], name: string): EnvTable | undefined => tables.find((t) => t.name.toLowerCase() === name.toLowerCase())
const findTable = (tables: EnvTable[], idOrName: string): EnvTable | undefined => tables.find((t) => t.id === idOrName) ?? byName(tables, idOrName)

/** why `col` (of the bound table) cannot serve slot column `sc`; undefined when it fits */
export function columnMismatch(sc: SlotColumn, col: ColumnDef, lookupTarget: string | null): string | undefined {
  if (!sc.types.includes(col.type)) {
    const w = TYPE_WORD[col.type] ?? col.type
    return `"${col.displayName}" is ${article(w)} ${w} column; ${sc.label} needs ${article(typeWords(sc.types))} ${typeWords(sc.types)} column.`
  }
  if (col.type === 'lookup' && sc.lookupSlot) {
    if (!lookupTarget) return `"${col.displayName}" is a lookup, but no table is chosen for the table it must point at.`
    if ((col.lookupTable ?? '').toLowerCase() !== lookupTarget.toLowerCase()) return `"${col.displayName}" points at ${col.lookupTable ?? 'another table'}; ${sc.label} must point at ${lookupTarget}.`
  }
  return undefined
}

/** the default binding: create where the template can and the name is free, else the same-named table, else create (a clash to resolve) */
export function defaultBindings(pkg: Pick<TemplatePackage, 'slots' | 'kind'>, tables: EnvTable[]): Record<string, SlotBinding> {
  const out: Record<string, SlotBinding> = {}
  const taken = tables.map((t) => t.name)
  for (const s of pkg.slots) {
    const preferCreate = s.create && (s.defaultMode === 'create' || pkg.kind === 'dataModel' || pkg.kind === 'app')
    if (s.create && preferCreate) {
      out[s.id] = { mode: 'create', name: s.create.name, displayName: s.create.displayName }
      taken.push(s.create.name)
      continue
    }
    const same = s.create ? byName(tables, s.create.name) : tables.find((t) => !t.system && t.name.toLowerCase() === s.id.toLowerCase())
    if (same) out[s.id] = { mode: 'map', table: same.id, columns: autoColumns(s, same) }
    else if (s.create) out[s.id] = { mode: 'create', name: s.create.name, displayName: s.create.displayName }
    else if (!s.required) out[s.id] = { mode: 'skip' }
    else out[s.id] = { mode: 'map', table: '', columns: {} }
  }
  return out
}

/** columns of `t` matched to the slot's by name, then display name (compatible types only) */
export function autoColumns(s: TemplateSlot, t: EnvTable): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const sc of s.columns) {
    const hit = t.columns.find((c) => c.name.toLowerCase() === sc.id.toLowerCase() && sc.types.includes(c.type))
      ?? t.columns.find((c) => c.displayName.toLowerCase() === sc.label.toLowerCase() && sc.types.includes(c.type))
    out[sc.id] = hit ? hit.name : null
  }
  return out
}

/**
 * Checks the bindings against the environment's tables: the report per slot (bound table, columns, candidates with the
 * reason a column does not fit, name clashes), blocking problems, and the token map for the payload.
 */
export function resolveBindings(pkg: Pick<TemplatePackage, 'slots' | 'kind'>, given: Record<string, SlotBinding> | undefined, tables: EnvTable[]): Resolution {
  const bindings = { ...defaultBindings(pkg, tables), ...(given ?? {}) }
  const problems: string[] = []
  const warnings: string[] = []
  const resolved: ResolvedSlot[] = []
  const createdNames: string[] = []
  // first pass: the table of every slot (lookups need the name their target slot gets)
  for (const s of pkg.slots) {
    const b = bindings[s.id] ?? { mode: 'map', table: '' }
    if (b.mode === 'skip') {
      resolved.push({ slot: s, mode: 'skip', tableName: null, columns: new Map(s.columns.map((c) => [c.id, null])) })
      continue
    }
    if (b.mode === 'create') {
      resolved.push({ slot: s, mode: 'create', tableName: String(b.name ?? '').trim(), displayName: (b.displayName ?? s.create?.displayName ?? b.name ?? '').trim(), columns: new Map(s.columns.map((c) => [c.id, c.id])) })
      continue
    }
    const t = b.table ? findTable(tables, b.table) : undefined
    resolved.push({ slot: s, mode: 'map', tableName: t?.name ?? null, ...(t ? { tableId: t.id, displayName: t.displayName } : {}), columns: new Map() })
  }
  const nameOfSlot = (id: string): string | null => resolved.find((r) => r.slot.id === id)?.tableName ?? null
  const reports: SlotReport[] = []
  for (const r of resolved) {
    const s = r.slot
    const b = bindings[s.id] ?? { mode: 'map', table: '' }
    const rp: SlotReport = { slot: s.id, label: s.label, ...(s.description ? { description: s.description } : {}), required: s.required, canCreate: !!s.create, mode: r.mode, columns: [], problems: [] }
    if (r.mode === 'skip') {
      if (s.required) rp.problems.push(`${s.label} is required: choose a table or create one.`)
      else warnings.push(`${s.label} is left out: what the template shows from it stays blank.`)
      rp.columns = s.columns.map((c) => ({ id: c.id, label: c.label, required: c.required, types: c.types, ...(c.lookupSlot ? { lookupSlot: c.lookupSlot } : {}), bound: null, candidates: [] }))
    } else if (r.mode === 'create') {
      const name = r.tableName ?? ''
      rp.table = { name, displayName: r.displayName || name }
      if (!s.create) rp.problems.push(`${s.label} cannot be created by this template: choose one of your tables.`)
      else if (!IDENT.test(name)) rp.problems.push(`"${name}" is not a valid table name: use letters, digits and _ (not starting with a digit).`)
      else {
        const clash = byName(tables, name)
        if (clash) {
          const suggestion = uniqueIdentifier(name, [...tables.map((t) => t.name), ...createdNames, ...resolved.filter((x) => x.mode === 'create').map((x) => x.tableName ?? '')])
          rp.clash = { id: clash.id, name: clash.name, displayName: clash.displayName, suggestion }
          rp.problems.push(`A table named ${clash.name} already exists here. Use it (map the slot to it) or install under another name (for example ${suggestion}).`)
        } else if (createdNames.some((n) => n.toLowerCase() === name.toLowerCase())) rp.problems.push(`Two tables of this template would be called ${name}: give one another name.`)
        createdNames.push(name)
      }
      rp.columns = s.columns.map((c) => ({ id: c.id, label: c.label, required: c.required, types: c.types, ...(c.lookupSlot ? { lookupSlot: c.lookupSlot } : {}), bound: c.id, candidates: [] }))
    } else {
      const t = r.tableId ? tables.find((x) => x.id === r.tableId) : undefined
      if (!t) rp.problems.push(`Choose the table for ${s.label}${s.create ? ', or create one' : ''}.`)
      else {
        rp.table = { id: t.id, name: t.name, displayName: t.displayName }
        if (t.reporting || t.readOnly) {
          const writes = s.columns.some((c) => c.required)
          if (writes) warnings.push(`${t.displayName} is read-only: what the template saves into it will be refused.`)
        }
        const want = b.mode === 'map' ? (b.columns ?? {}) : {}
        const auto = autoColumns(s, t)
        for (const sc of s.columns) {
          const lookupTarget = sc.lookupSlot ? nameOfSlot(sc.lookupSlot) : null
          const chosen = sc.id in want ? want[sc.id] : auto[sc.id]
          const candidates: CandidateColumn[] = t.columns.filter((c) => c.name !== 'id').map((c) => {
            const why = columnMismatch(sc, c, lookupTarget)
            return { name: c.name, displayName: c.displayName, type: c.type, ok: !why, ...(why ? { reason: why } : {}) }
          })
          const rc: SlotColumnReport = { id: sc.id, label: sc.label, required: sc.required, types: sc.types, ...(sc.lookupSlot ? { lookupSlot: sc.lookupSlot } : {}), bound: null, candidates }
          if (chosen) {
            const col = t.columns.find((c) => c.name === chosen) ?? t.columns.find((c) => c.name.toLowerCase() === String(chosen).toLowerCase())
            if (!col) rc.problem = `${t.displayName} has no column "${chosen}".`
            else {
              const why = columnMismatch(sc, col, lookupTarget)
              if (why) rc.problem = why
              else rc.bound = col.name
            }
          }
          if (!rc.bound && !rc.problem && sc.required) rc.problem = `Choose the column of ${t.displayName} for ${sc.label} (required).`
          if (rc.problem && (sc.required || chosen)) rp.problems.push(`${s.label} - ${sc.label}: ${rc.problem}`)
          r.columns.set(sc.id, rc.bound)
          rp.columns.push(rc)
        }
      }
    }
    problems.push(...rp.problems)
    reports.push(rp)
  }
  const tokens = new Map<string, string | null>()
  for (const r of resolved) {
    tokens.set(tableToken(r.slot.id), r.tableName && r.mode !== 'skip' ? r.tableName : null)
    for (const c of r.slot.columns) tokens.set(columnToken(r.slot.id, c.id), r.mode === 'skip' ? null : r.columns.get(c.id) ?? null)
  }
  return { slots: reports, resolved, tokens, problems, warnings }
}

/* ------------------------------------------------------------------ binding the payload */

export interface Bound<T> { value: T; problems: string[] }

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** a control tree with every formula rewritten */
export function bindNodes(nodes: ControlNode[], tokens: ReadonlyMap<string, string | null>): Bound<ControlNode[]> {
  const problems: string[] = []
  const walk = (n: ControlNode): ControlNode => {
    const props: Record<string, string> = {}
    for (const [k, f] of Object.entries(n.props ?? {})) {
      const r = rewriteFormula(f, tokens)
      props[k] = r.out
      for (const p of r.problems) problems.push(`${n.name}.${k}: ${p}`)
    }
    return { ...n, props, children: (n.children ?? []).map(walk) }
  }
  return { value: nodes.map(walk), problems: [...new Set(problems)] }
}

/** an app definition with every formula, data source and offline table rewritten */
export function bindApp(app: AppDef, tokens: ReadonlyMap<string, string | null>): Bound<AppDef> {
  const out = clone(app)
  const problems: string[] = []
  const screens = bindNodes(out.screens, tokens)
  out.screens = screens.value
  problems.push(...screens.problems)
  for (const [k, f] of Object.entries(out.appProps ?? {})) {
    const r = rewriteFormula(f, tokens, { noEq: k === 'Formulas' })
    out.appProps[k] = r.out
    for (const p of r.problems) problems.push(`App.${k}: ${p}`)
  }
  const name = (n: string): string | null => (tokens.has(n) ? tokens.get(n) ?? null : n)
  if (Array.isArray(out.dataSources)) out.dataSources = [...new Set(out.dataSources.map(name).filter((x): x is string => !!x))]
  if (out.offline?.tables) {
    out.offline.tables = out.offline.tables.flatMap((t) => {
      const table = name(t.table)
      if (!table) return []
      const f = t.filter ? rewriteFormula(t.filter, tokens, { noEq: true }) : null
      if (f) for (const p of f.problems) problems.push(`offline ${t.table}: ${p}`)
      return [{ ...t, table, ...(f ? { filter: f.out } : {}) }]
    })
  }
  return { value: out, problems: [...new Set(problems)] }
}

/** the definition of a table the install creates for a slot (no id: the data model's plan path gives it one) */
export function createdTable(r: ResolvedSlot, resolution: Resolution, now: string): { def: Omit<TableDef, 'id'>; events: TableEventInput[]; problems: string[]; lookups: { column: string; toSlot: string; onDelete?: 'restrict' | 'cascade' | 'setBlank' }[] } {
  const s = r.slot
  const problems: string[] = []
  const nameOfSlot = (id: string): string | null => resolution.resolved.find((x) => x.slot.id === id)?.tableName ?? null
  const lookups: { column: string; toSlot: string; onDelete?: 'restrict' | 'cascade' | 'setBlank' }[] = []
  const cols: ColumnDef[] = []
  for (const c of s.columns) {
    const type = c.create?.type ?? c.types[0]
    const col: ColumnDef = { name: c.id, displayName: c.create?.displayName ?? c.label, type }
    const req = c.create?.required ?? c.required
    if (req) col.required = true
    if (c.create?.unique) col.unique = true
    if (c.create?.indexed) col.indexed = true
    if (c.create?.default !== undefined) col.default = c.create.default
    if (type === 'choice') col.choices = [...(c.create?.choices ?? [])]
    if (type === 'autonumber' && c.create?.prefix) col.prefix = c.create.prefix
    if (type === 'lookup') {
      const target = c.lookupSlot ? nameOfSlot(c.lookupSlot) : null
      if (!target) { problems.push(`${s.label}.${c.label} points at ${c.lookupSlot}, which is left out.`); continue }
      col.lookupTable = target
      lookups.push({ column: c.id, toSlot: c.lookupSlot!, ...(c.create?.onDelete ? { onDelete: c.create.onDelete } : {}) })
    }
    if (c.create?.computed) {
      const comp = clone(c.create.computed)
      if (comp.kind === 'formula') {
        const f = rewriteFormula(comp.formula, resolution.tokens, { noEq: true })
        comp.formula = f.out
        problems.push(...f.problems.map((p) => `${s.label}.${c.label}: ${p}`))
      }
      col.computed = comp
    }
    cols.push(col)
  }
  const events: TableEventInput[] = []
  for (const e of s.events ?? []) {
    const ev = clone(e)
    for (const k of ['condition', 'actions'] as const) {
      if (!ev[k]) continue
      const f = rewriteFormula(ev[k]!, resolution.tokens, { noEq: true })
      ev[k] = f.out
      problems.push(...f.problems.map((p) => `${s.label} rule "${e.name ?? ''}": ${p}`))
    }
    if (ev.field) ev.field = resolution.tokens.get(ev.field) ?? ev.field
    events.push(ev)
  }
  const primary = s.create?.primaryColumn ?? cols.find((c) => c.type === 'text' || c.type === 'autonumber')?.name ?? cols[0]?.name ?? 'id'
  return {
    def: {
      name: r.tableName ?? s.create?.name ?? s.id, displayName: r.displayName || s.create?.displayName || s.label, primaryColumn: primary,
      ...(s.create?.description ? { description: s.create.description } : {}),
      columns: [...systemColumnDefs(), ...cols], createdOn: now, modifiedOn: now,
    },
    events, problems, lookups,
  }
}

/* ------------------------------------------------------------------ checking a package's formulas */

const formulasOfNodes = (nodes: ControlNode[], out: { where: string; f: string; noEq?: boolean }[]): void => {
  for (const n of nodes) {
    for (const [k, f] of Object.entries(n.props ?? {})) out.push({ where: `${n.name}.${k}`, f })
    formulasOfNodes(n.children ?? [], out)
  }
}

/** every formula of a package with where it is */
export function formulasOf(pkg: TemplatePackage): { where: string; f: string; noEq?: boolean }[] {
  const out: { where: string; f: string; noEq?: boolean }[] = []
  formulasOfNodes(pkg.payload.controls ?? [], out)
  if (pkg.payload.screen) formulasOfNodes([pkg.payload.screen], out)
  const app = pkg.payload.app
  if (app) {
    formulasOfNodes(app.screens, out)
    for (const [k, f] of Object.entries(app.appProps ?? {})) out.push({ where: `App.${k}`, f, noEq: k === 'Formulas' })
    for (const t of app.offline?.tables ?? []) if (t.filter) out.push({ where: `offline ${t.table}`, f: t.filter, noEq: true })
  }
  for (const s of pkg.slots) {
    for (const e of s.events ?? []) for (const k of ['condition', 'actions'] as const) if (e[k]) out.push({ where: `${s.id} rule ${e.name ?? ''}`, f: e[k]!, noEq: true })
    for (const c of s.columns) if (c.create?.computed?.kind === 'formula') out.push({ where: `${s.id}.${c.id}`, f: c.create.computed.formula, noEq: true })
  }
  return out
}

/** problems with a package's formulas: undeclared tokens, and formulas with tokens that do not parse */
export function checkTemplateFormulas(pkg: TemplatePackage): string[] {
  const declared = declaredTokens(pkg)
  const problems: string[] = []
  for (const { where, f, noEq } of formulasOf(pkg)) {
    for (const t of tokensIn(f, { noEq })) if (!declared.has(t)) problems.push(`${where}: the slot token ${t} is not declared.`)
    // rewriting with the identity map tells whether the formula parses and every token sits where it can be rewritten
    const r = rewriteFormula(f, new Map([...declared.keys()].map((k) => [k, k])), { noEq })
    for (const p of r.problems) if (!/left after binding|not declared/.test(p)) problems.push(`${where}: ${p}`)
  }
  for (const n of pkg.payload.app?.dataSources ?? []) if (n.startsWith('Slot_') && !declared.has(n)) problems.push(`App data source ${n} is not a declared slot.`)
  return [...new Set(problems)]
}
