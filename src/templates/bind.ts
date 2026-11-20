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
  SLOT_PREFIX, columnToken, declaredTokens, tableToken, type CandidateColumn, type SlotBinding, type SlotColumn, type SlotColumnReport, type SlotReport,
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

/**
 * the default binding: create where the template can and the name is free, else the same-named table, else create (a
 * clash to resolve). Solution packs: `defaultMode: map` slots use a same-named table when there is one; other slots are
 * created (a taken name is a clash to resolve); shared slots (`from`) are bound by the server to the dependency's table.
 */
export function defaultBindings(pkg: Pick<TemplatePackage, 'slots' | 'kind'> & { prefix?: string }, tables: EnvTable[]): Record<string, SlotBinding> {
  const out: Record<string, SlotBinding> = {}
  const taken = tables.map((t) => t.name)
  for (const s of pkg.slots) {
    if (s.from) continue
    if (pkg.kind === 'solution' && s.create && s.defaultMode === 'map') {
      // a shared table (Accounts): the same-named table when its columns fit, else a new one under the pack's prefix
      const same = byName(tables, s.create.name)
      const cols = same ? autoColumns(s, same) : {}
      if (same && !same.system && s.columns.every((c) => !c.required || cols[c.id])) { out[s.id] = { mode: 'map', table: same.id, columns: cols }; continue }
      const prefix = (pkg as { prefix?: string }).prefix ?? ''
      const name = same ? uniqueIdentifier(`${prefix}${s.create.name}`, taken) : s.create.name
      out[s.id] = { mode: 'create', name, displayName: same && prefix ? `${s.create.displayName} (${prefix})` : s.create.displayName }
      taken.push(name)
      continue
    }
    const preferCreate = s.create && (pkg.kind === 'solution' ? true : (s.defaultMode === 'create' || pkg.kind === 'dataModel' || pkg.kind === 'app'))
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
export function resolveBindings(pkg: Pick<TemplatePackage, 'slots' | 'kind'> & { prefix?: string }, given: Record<string, SlotBinding> | undefined, tables: EnvTable[]): Resolution {
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
          const takenNames = [...tables.map((t) => t.name), ...createdNames, ...resolved.filter((x) => x.mode === 'create').map((x) => x.tableName ?? '')]
          // packs propose their prefix (Mfg + ProductionLog); otherwise a number
          const prefixed = pkg.prefix ? `${pkg.prefix}${name}` : ''
          const suggestion = prefixed && !takenNames.some((n) => n.toLowerCase() === prefixed.toLowerCase()) ? prefixed : uniqueIdentifier(prefixed || name, takenNames)
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
          const lookupTarget = sc.lookupSlot ? nameOfSlot(sc.lookupSlot) : sc.lookupSystem ?? null
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
    if (c.create?.default !== undefined) {
      col.default = c.create.default
      // a formula default (=NextNumber("Slot_Seq_Passes")) is bound like any formula
      if (typeof col.default === 'string' && col.default.trimStart().startsWith('=') && col.default.includes('Slot_')) {
        const f = rewriteFormula(col.default, resolution.tokens)
        col.default = f.out
        problems.push(...f.problems.map((p) => `${s.label}.${c.label} default: ${p}`))
      }
    }
    if (type === 'choice') col.choices = [...(c.create?.choices ?? [])]
    if (type === 'autonumber' && c.create?.prefix) col.prefix = c.create.prefix
    if (type === 'lookup' && c.lookupSystem && !c.lookupSlot) {
      // a table of the core data model (Users, Currencies ...): in every environment, no relationship row needed
      col.lookupTable = c.lookupSystem
      cols.push(col)
      continue
    }
    if (type === 'lookup') {
      const target = c.lookupSlot ? nameOfSlot(c.lookupSlot) : null
      if (!target) { problems.push(`${s.label}.${c.label} points at ${c.lookupSlot}, which is left out.`); continue }
      col.lookupTable = target
      lookups.push({ column: c.id, toSlot: c.lookupSlot!, ...(c.create?.onDelete ? { onDelete: c.create.onDelete } : {}) })
    }
    if (c.create?.computed) {
      let comp = clone(c.create.computed)
      if (comp.kind === 'formula') {
        const f = rewriteFormula(comp.formula, resolution.tokens, { noEq: true })
        comp.formula = f.out
        problems.push(...f.problems.map((p) => `${s.label}.${c.label}: ${p}`))
      } else {
        // a rollup names its child table, the lookup and the column: tokens as whole values
        const b = bindJson(comp, resolution.tokens)
        comp = b.value
        problems.push(...b.problems.map((p) => `${s.label}.${c.label}: ${p}`))
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
  // P3-P: a synchronous balance names the movements table and the columns by token (docs/dev/balances.md)
  let balance: TableDef['balance']
  if (s.create?.balance) {
    const b = bindJson(s.create.balance, resolution.tokens)
    balance = b.value as TableDef['balance']
    problems.push(...b.problems.map((p) => `${s.label} balance: ${p}`))
  }
  const primary = s.create?.primaryColumn ?? cols.find((c) => c.type === 'text' || c.type === 'autonumber')?.name ?? cols[0]?.name ?? 'id'
  return {
    def: {
      name: r.tableName ?? s.create?.name ?? s.id, displayName: r.displayName || s.create?.displayName || s.label, primaryColumn: primary,
      ...(s.create?.description ? { description: s.create.description } : {}),
      ...(s.create?.uniqueTogether?.length ? { uniqueTogether: s.create.uniqueTogether.map((u) => [...u]) } : {}),
      ...(balance ? { balance } : {}),
      columns: [...systemColumnDefs(), ...cols], createdOn: now, modifiedOn: now,
    },
    events, problems, lookups,
  }
}

/* ------------------------------------------------------------------ binding JSON parts of a pack (format 2) */

const TOKEN_RE = /^Slot_[A-Za-z0-9_]+$/
const PREFIXED_RE = /^([A-Za-z-]+):(Slot_[A-Za-z0-9_]+)$/

/**
 * Binds a JSON part of a solution pack (a flow definition, an approval policy, a dashboard, a print document, a role's
 * row rule, a rollup) with the token map. A string is rewritten when it is
 *   - exactly a token, or a comma list of tokens            "Slot_Visits", "Slot_Visits_Status, Slot_Visits_Arrival"
 *   - `<word>:<token>`                                         "role:Slot_Role_Reception"
 *   - text with {formulas} (print documents)                  "Pass {Slot_Visits_PassNumber}"   (each {...} through the parser)
 *   - otherwise a formula (with or without the leading =)    "Trigger.Record.Slot_Visits_Status = \"Pending\""
 * Object keys that are exactly a token are renamed (data.create / data.update values, column security). A token mapped to
 * null cannot be bound in JSON and is reported.
 */
export function bindJson<T>(v: T, tokens: ReadonlyMap<string, string | null>): Bound<T> {
  const problems: string[] = []
  const look = (t: string, where: string): string | null => {
    if (!tokens.has(t)) { problems.push(`${where}: the token ${t} is not declared by the template`); return null }
    const to = tokens.get(t) ?? null
    if (to === null) problems.push(`${where}: ${t} is left out, but this part of the template needs it`)
    return to
  }
  const str = (s: string, where: string): string => {
    if (!s.includes(SLOT_PREFIX)) return s
    const t = s.trim()
    if (TOKEN_RE.test(t)) return look(t, where) ?? s
    const pieces = t.split(',').map((x) => x.trim())
    if (pieces.length > 1 && pieces.every((x) => TOKEN_RE.test(x) || !x.includes(SLOT_PREFIX)) && pieces.some((x) => TOKEN_RE.test(x))) {
      return pieces.map((x) => (TOKEN_RE.test(x) ? look(x, where) ?? x : x)).join(s.includes(', ') ? ', ' : ',')
    }
    const pre = PREFIXED_RE.exec(t)
    if (pre) { const to = look(pre[2], where); return to === null ? s : `${pre[1]}:${to}` }
    const r = rewriteFormula(s, tokens, { noEq: !s.trimStart().startsWith('=') })
    const parses = !r.problems.some((p) => /does not parse/.test(p))
    if (!parses && /\{[^{}]*Slot_[^{}]*\}/.test(s)) {
      // not a formula: text with {formulas} (print documents)
      return s.replace(/\{([^{}]*)\}/g, (all, inner: string) => {
        if (!inner.includes(SLOT_PREFIX)) return all
        const b = rewriteFormula(inner, tokens, { noEq: true })
        problems.push(...b.problems.map((p) => `${where}: ${p}`))
        return `{${b.out}}`
      })
    }
    problems.push(...r.problems.map((p) => `${where}: ${p}`))
    return r.out
  }
  const walk = (x: unknown, where: string): unknown => {
    if (typeof x === 'string') return str(x, where)
    if (Array.isArray(x)) return x.map((y, i) => walk(y, `${where}[${i}]`))
    if (!x || typeof x !== 'object') return x
    const out: Record<string, unknown> = {}
    for (const [k, y] of Object.entries(x as Record<string, unknown>)) {
      const key = TOKEN_RE.test(k) ? (look(k, `${where}.${k}`) ?? k) : k
      out[key] = walk(y, `${where}.${key}`)
    }
    return out
  }
  return { value: walk(v, '') as T, problems: [...new Set(problems.map((p) => p.replace(/^: /, '').replace(/^\./, '')))] }
}

/** the JSON parts of a pack, with where they are (for the catalogue's check and the docs) */
export function packParts(pkg: TemplatePackage): { where: string; value: unknown }[] {
  const p = pkg.payload
  const out: { where: string; value: unknown }[] = []
  for (const f of p.flows ?? []) out.push({ where: `flow ${f.key}`, value: { definition: f.definition, runRoles: f.runRoles ?? [] } })
  for (const a of p.approvalPolicies ?? []) out.push({ where: `approval policy ${a.key}`, value: a.definition })
  for (const d of p.dashboards ?? []) out.push({ where: `dashboard ${d.key}`, value: { def: d.def, roles: d.roles ?? [] } })
  for (const d of p.printTemplates ?? []) out.push({ where: `print template ${d.key}`, value: d.doc })
  for (const r of p.roles ?? []) for (const [slot, t] of Object.entries(r.tables ?? {})) if (t.rowFilter) out.push({ where: `role ${r.key ?? r.name} on ${slot}`, value: t.rowFilter })
  for (const s of pkg.slots) for (const c of s.columns) if (c.create?.computed && c.create.computed.kind !== 'formula') out.push({ where: `${s.id}.${c.id}`, value: c.create.computed })
  return out
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
  const apps = [...(pkg.payload.app ? [pkg.payload.app] : []), ...(pkg.payload.apps ?? []).map((a) => a.app)]
  for (const app of apps) {
    formulasOfNodes(app.screens, out)
    for (const [k, f] of Object.entries(app.appProps ?? {})) out.push({ where: `App.${k}`, f, noEq: k === 'Formulas' })
    for (const t of app.offline?.tables ?? []) if (t.filter) out.push({ where: `offline ${t.table}`, f: t.filter, noEq: true })
  }
  for (const s of pkg.slots) {
    for (const e of s.events ?? []) for (const k of ['condition', 'actions'] as const) if (e[k]) out.push({ where: `${s.id} rule ${e.name ?? ''}`, f: e[k]!, noEq: true })
    for (const c of s.columns) if (c.create?.computed?.kind === 'formula') out.push({ where: `${s.id}.${c.id}`, f: c.create.computed.formula, noEq: true })
    for (const c of s.columns) if (typeof c.create?.default === 'string' && c.create.default.trimStart().startsWith('=')) out.push({ where: `${s.id}.${c.id} default`, f: c.create.default })
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
  for (const app of [...(pkg.payload.app ? [pkg.payload.app] : []), ...(pkg.payload.apps ?? []).map((a) => a.app)]) {
    for (const n of app.dataSources ?? []) if (n.startsWith('Slot_') && !declared.has(n)) problems.push(`App data source ${n} is not a declared slot.`)
    for (const t of app.offline?.tables ?? []) if (t.table.startsWith('Slot_') && !declared.has(t.table)) problems.push(`Offline table ${t.table} is not a declared slot.`)
  }
  // format 2: flows, policies, dashboards, print documents, row rules, rollups
  if (pkg.kind === 'solution') {
    const identity = new Map([...declared.keys()].map((k) => [k, k]))
    for (const part of packParts(pkg)) for (const pr of bindJson(part.value, identity).problems) if (!/left after binding/.test(pr)) problems.push(`${part.where}: ${pr}`)
  }
  return [...new Set(problems)]
}
