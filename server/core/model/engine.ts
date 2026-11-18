/**
 * Data model designer engine (P0-K, docs/dev/data-model.md): the live model, plans and the transactional apply.
 *
 * A plan is computed from ModelOps (the diff of a draft against the snapshot it started from, or what a pattern or a
 * template produces) against the LIVE schema: blocking problems, one item per change with row counts, data conversion
 * pre-checks and index builds, and a token over (ops + live fingerprint). Apply recomputes the plan, refuses a stale
 * token (409), takes the pre-change backup (backup.snapshot, package J), then runs every op in ONE unit of work through
 * the same route handlers the table designer uses (so every rule, audit entry and job is the same), plus what only the
 * designer does: relationship records, composite unique indexes, reporting views, date dimension rows, summary tables
 * and their refresh schedule. A failure rolls everything back.
 */
import { createHash } from 'node:crypto'
import type { ColumnDef, TableDef, TablePrivilege } from '../../../src/platform/contracts.ts'
import type { Ctx, Handler, Router, Services, UserContext } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import type { DateDimDef, Model, ModelApplyResult, ModelOp, ModelPlan, ModelPlanItem, ModelTable, RelationshipDef, SummaryDef, ViewDef } from '../../../src/model/types.ts'
import { isNewId, isSystemTable } from '../../../src/model/types.ts'
import { applyOps, checkOps, describeOp, isSystemColumn, withImplicitRelationships } from '../../../src/model/ops.ts'
import { dateDimRows } from '../../../src/model/datedim.ts'
import { DEFAULT_CONNECTION_ID } from '../connections.ts'
import { NO_BACKUP_MESSAGE } from '../backup.ts'
import { registerTableRoutes } from '../../routes/meta/tables.ts'
import { registerConnectionRoutes } from '../../routes/meta/connections.ts'
import { audit, isPlatformManaged, pickSource, resolveConnection } from '../../routes/meta/tables-core.ts'
import { isBlankCell, tryCoerce } from '../../routes/meta/util.ts'
import type { RoleX } from '../../routes/meta/util.ts'
import { quoteId, uniqueTogetherIndexName, uniqueTogetherSql } from '../../connectors/postgres/sql.ts'
import { currentEnvironment } from '../env-context.ts'
import { summaryRefreshSql, SUMMARY_JOB } from './summary.ts'

/** rows checked per column by the conversion pre-check */
export const CONVERSION_CHECK_ROWS = 200_000

/* ------------------------------------------------------------------ live model */

export async function liveModel(s: Services): Promise<Model> {
  const tables = await s.meta.tables.list()
  const store = s.meta.relationships
  const rels = store ? await store.list() : []
  return withImplicitRelationships({ tables: tables as ModelTable[], relationships: rels })
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))

/** a fingerprint of the live schema (tables with their columns, relationships) */
export function fingerprint(m: Model): string {
  const t = [...m.tables].sort((a, b) => a.id.localeCompare(b.id)).map((x) => ({ id: x.id, n: x.name, d: x.displayName, p: x.primaryColumn, c: x.columns, u: x.uniqueTogether, r: x.reporting }))
  const r = [...m.relationships].sort((a, b) => a.id.localeCompare(b.id))
  return createHash('sha256').update(stable({ t, r })).digest('hex').slice(0, 32)
}

/* ------------------------------------------------------------------ plan */

export interface PlanOutcome { plan: ModelPlan; live: Model }

const label = (m: Model, id: string): string => m.tables.find((t) => t.id === id)?.displayName ?? id
const isView = (t: TableDef | undefined): boolean => t?.reporting?.kind === 'view'
const onDefault = (t: TableDef): boolean => (t.connectionId ?? DEFAULT_CONNECTION_ID) === DEFAULT_CONNECTION_ID

async function rowCount(s: Services, def: TableDef, where?: import('../../../src/platform/http.ts').Condition): Promise<number | undefined> {
  try {
    const { connector } = await resolveConnection(s, def.connectionId)
    const r = await connector.select(def, { select: ['id'], count: true, top: 1, ...(where ? { where } : {}) })
    return r.total ?? r.rows.length
  } catch {
    return undefined
  }
}

async function valuesOf(s: Services, def: TableDef, col: string): Promise<unknown[]> {
  const { connector } = await resolveConnection(s, def.connectionId)
  const r = await connector.select(def, { select: ['id', col], where: { col, op: 'notBlank' }, top: CONVERSION_CHECK_ROWS })
  return r.rows.map((x) => x[col])
}

export async function planModel(s: Services, user: UserContext, ops: ModelOp[]): Promise<PlanOutcome> {
  if (!Array.isArray(ops)) throw new HttpError(422, 'invalid', 'ops must be a list.')
  if (ops.length > 2000) throw new HttpError(422, 'invalid', 'Too many changes in one plan (at most 2,000).')
  const live = await liveModel(s)
  const problems = checkOps(live, ops)
  const warnings: string[] = []
  const items: ModelPlanItem[] = []
  const { model: after } = applyOps(live, ops)
  const byId = (id: string) => live.tables.find((t) => t.id === id)
  const tables = await s.meta.tables.list()

  for (const o of ops) {
    switch (o.op) {
      case 'createTable': {
        const t = o.table
        const r = t.reporting
        if (t.link) {
          items.push({ kind: 'table', change: 'new', table: t.displayName, name: t.name, note: `Linked to ${t.link.source} (an existing table in another database; nothing is copied).` })
          break
        }
        if (r?.kind === 'view') {
          const base = after.tables.find((x) => x.id === r.base)
          if (!base) problems.push(`The view "${t.displayName}" reads a table that does not exist.`)
          else {
            if (isView(base)) problems.push(`"${t.displayName}": a view cannot read another view.`)
            if (!isNewId(base.id) && !onDefault(base)) problems.push(`"${t.displayName}": reporting views can only read tables in the default database.`)
            for (const c of r.columns) {
              if (!base.columns.some((x) => x.name === c.source)) problems.push(`"${t.displayName}.${c.displayName}" reads a column "${c.source}" that ${base.displayName} does not have.`)
              if (c.expr && c.expr !== 'value') {
                const src = base.columns.find((x) => x.name === c.source)
                if (src && src.type !== 'date' && src.type !== 'datetime') problems.push(`"${t.displayName}.${c.displayName}": ${c.expr} needs a date column.`)
              }
            }
          }
          items.push({ kind: 'view', change: 'new', table: t.displayName, name: t.name, note: `${r.role === 'fact' ? 'Fact' : 'Dimension'} view over ${base?.displayName ?? '?'} (${r.columns.length} columns). Read-only; readers see only the rows and columns they may see in ${base?.displayName ?? 'the source'}.` })
          break
        }
        const notes: string[] = []
        const idx = t.columns.filter((c) => !isSystemColumn(c) && (c.unique || c.indexed || c.type === 'lookup')).length + (t.uniqueTogether?.length ?? 0)
        if (idx) notes.push(`${idx} index${idx === 1 ? '' : 'es'}`)
        if (r?.kind === 'date') {
          try { notes.push(`filled with ${dateDimRows(r).length.toLocaleString('en')} days (${r.from} to ${r.to}, fiscal year from month ${r.fiscalYearStartMonth})`) } catch (e) { problems.push(`${t.displayName}: ${(e as Error).message}`) }
        }
        if (r?.kind === 'summary') {
          const src = after.tables.find((x) => x.id === r.source)
          if (!src) problems.push(`The summary "${t.displayName}" reads a table that does not exist.`)
          else if (!isNewId(src.id) && !onDefault(src)) problems.push(`"${t.displayName}": summary tables can only read tables in the default database.`)
          notes.push(`refreshed by a scheduled job (${r.cron}), first run right after applying`)
        }
        items.push({ kind: r?.kind === 'date' || r?.kind === 'summary' ? 'data' : 'table', change: 'new', table: t.displayName, name: t.name, note: `${t.columns.filter((c) => !isSystemColumn(c)).length} columns${notes.length ? `; ${notes.join('; ')}` : ''}` })
        break
      }
      case 'dropTable': {
        const t = byId(o.id)
        if (!t) break
        if (isSystemTable(t)) { problems.push(`"${t.displayName}" is a system table and cannot be removed.`); break }
        if (isView(t)) { items.push({ kind: 'view', change: 'removed', table: t.displayName, name: t.name, note: 'The view is dropped; no data is lost (it shows data of other tables).' }); break }
        const dependants = tables.filter((x) => x.reporting?.kind === 'view' && x.reporting.base === t.id && !ops.some((p) => p.op === 'dropTable' && p.id === x.id))
        if (dependants.length) problems.push(`"${t.displayName}" is read by the reporting view${dependants.length > 1 ? 's' : ''} ${dependants.map((d) => `"${d.displayName}"`).join(', ')}: remove ${dependants.length > 1 ? 'them' : 'it'} too.`)
        const rows = await rowCount(s, t)
        const managed = isPlatformManaged(t)
        items.push({
          kind: 'table', change: 'removed', table: t.displayName, name: t.name, destructive: managed && (rows ?? 1) > 0, rows,
          note: managed ? `The table and its ${rows === undefined ? '' : `${rows.toLocaleString('en')} `}rows are deleted.` : 'Linked table: only Appbuilder\'s registration goes; the table stays in its database.',
        })
        break
      }
      case 'updateTable': {
        const t = byId(o.id)
        if (!t) break
        const parts: string[] = []
        if (o.patch.displayName !== undefined) parts.push(`display name "${o.patch.displayName}"`)
        if (o.patch.primaryColumn !== undefined) parts.push(`display column ${o.patch.primaryColumn}`)
        if (o.patch.description !== undefined) parts.push('description')
        if (o.patch.uniqueTogether !== undefined) {
          if (!onDefault(t)) problems.push(`${t.displayName}: unique pairs need the default database.`)
          for (const set of o.patch.uniqueTogether) {
            parts.push(`unique together: ${set.join(' + ')}`)
            const dup = await duplicatePairs(s, t, set)
            if (dup) problems.push(`${t.displayName}: ${dup} combination${dup === 1 ? '' : 's'} of ${set.join(' + ')} appear more than once, so they cannot be made unique.`)
          }
        }
        items.push({ kind: o.patch.uniqueTogether !== undefined ? 'index' : 'table', change: 'changed', table: t.displayName, name: t.name, note: parts.join('; ') })
        break
      }
      case 'addColumn': {
        const t = byId(o.table)
        if (!t) break
        if (isSystemTable(t) && !(t as TableDef & { extensible?: boolean }).extensible) problems.push(`"${t.displayName}" is a system table that does not take extra columns.`)
        const c = o.column
        const notes: string[] = []
        if (c.unique || c.indexed || c.type === 'lookup') notes.push('index build')
        if (c.computed) notes.push(c.computed.kind === 'formula' ? 'calculated for every row by a job' : 'rolled up for every row by a job')
        const rows = await rowCount(s, t)
        if (c.required && c.default === undefined && !c.computed && (rows ?? 0) > 0) warnings.push(`${t.displayName}.${c.displayName} is required, but its ${rows} existing rows stay blank until they are next saved.`)
        if (c.unique && c.default !== undefined && (rows ?? 0) > 1) problems.push(`${t.displayName}.${c.displayName}: a unique column with a default cannot be added to a table with ${rows} rows.`)
        items.push({ kind: 'column', change: 'new', table: t.displayName, name: c.displayName, note: `${c.type}${notes.length ? `; ${notes.join('; ')}` : ''}` })
        break
      }
      case 'updateColumn': {
        const t = byId(o.table)
        if (!t) break
        const b = o.before
        const a = o.after
        if (b.locked || isSystemColumn(b)) { problems.push(`${t.displayName}.${b.displayName} is a system column and cannot be changed.`); break }
        const notes: string[] = []
        const item: ModelPlanItem = { kind: 'column', change: 'changed', table: t.displayName, name: a.displayName }
        if (a.displayName !== b.displayName) notes.push(`renamed from "${b.displayName}"`)
        if (a.type !== b.type || (a.type === 'lookup' && a.lookupTable?.toLowerCase() !== b.lookupTable?.toLowerCase())) {
          notes.push(a.type !== b.type ? `type ${b.type} → ${a.type}` : `lookup ${b.lookupTable} → ${a.lookupTable}`)
          const values = onDefault(t) || t.connectionId ? await valuesOf(s, t, b.name).catch(() => [] as unknown[]) : []
          const failing: string[] = []
          let n = 0
          if (a.type === 'lookup') {
            const target = after.tables.find((x) => x.name.toLowerCase() === (a.lookupTable ?? '').toLowerCase())
            if (target && !isNewId(target.id)) {
              const distinct = [...new Set(values.filter((v) => !isBlankCell(v)).map(String))]
              const { connector } = await resolveConnection(s, target.connectionId)
              const found = new Set<string>()
              for (let i = 0; i < distinct.length; i += 400) {
                const r = await connector.select(target, { select: ['id'], where: { col: 'id', op: 'in', value: distinct.slice(i, i + 400) } })
                for (const row of r.rows) found.add(String(row.id))
              }
              for (const v of distinct) if (!found.has(v)) { n++; if (failing.length < 5) failing.push(v) }
            } else if (values.length) { n = values.length; failing.push(...values.slice(0, 5).map(String)) }
          } else {
            for (const v of values) {
              const r = tryCoerce(a, v as never, b)
              if (!r.ok) { n++; if (failing.length < 5) failing.push(String(v instanceof Date ? v.toISOString() : v)) }
            }
          }
          item.conversion = { failing: n, examples: failing, checked: values.length }
          item.rows = values.length
          if (n) problems.push(`${t.displayName}.${b.displayName}: ${n.toLocaleString('en')} value${n === 1 ? '' : 's'} cannot become ${a.type === 'lookup' ? `a lookup to ${a.lookupTable}` : a.type} (for example ${failing.slice(0, 3).map((x) => `"${x}"`).join(', ')}).`)
          if (a.type === 'autonumber' && values.length) problems.push(`${t.displayName}.${b.displayName}: a column can only become an autonumber while the table is empty.`)
          if (values.length >= CONVERSION_CHECK_ROWS) warnings.push(`${t.displayName}.${b.displayName}: the pre-check read the first ${CONVERSION_CHECK_ROWS.toLocaleString('en')} values; the apply checks the rest.`)
          if (['decimal', 'currency'].includes(b.type) && a.type === 'number') item.destructive = true
          if (['multiline'].includes(b.type) && a.type !== 'multiline') item.destructive = true
        }
        if (!!a.unique !== !!b.unique) {
          notes.push(a.unique ? 'unique (index build)' : 'no longer unique')
          if (a.unique) {
            const dup = await duplicatePairs(s, t, [b.name])
            if (dup) problems.push(`${t.displayName}.${b.displayName}: ${dup} value${dup === 1 ? '' : 's'} appear more than once, so it cannot be unique.`)
          }
        }
        if (!!a.indexed !== !!b.indexed) notes.push(a.indexed ? 'indexed (built in the background)' : 'index dropped')
        if (!!a.required !== !!b.required) {
          notes.push(a.required ? 'required' : 'optional')
          if (a.required) {
            const blanks = await rowCount(s, t, { col: b.name, op: 'isBlank' })
            if (blanks) warnings.push(`${t.displayName}.${b.displayName} becomes required; ${blanks} row${blanks === 1 ? ' has' : 's have'} no value (they must get one when next saved).`)
          }
        }
        if (stable(a.computed) !== stable(b.computed)) notes.push('calculation changed (recomputed by a job)')
        if (stable(a.choices) !== stable(b.choices)) notes.push('choices changed')
        if ((a.default ?? '') !== (b.default ?? '')) notes.push('default changed')
        item.note = notes.join('; ') || 'settings change'
        items.push(item)
        break
      }
      case 'dropColumn': {
        const t = byId(o.table)
        const c = t?.columns.find((x) => x.name === o.name)
        if (!t || !c) break
        if (c.locked || isSystemColumn(c)) { problems.push(`${t.displayName}.${c.displayName} is a system column and cannot be removed.`); break }
        const viewUse = tables.filter((x) => x.reporting?.kind === 'view' && x.reporting.base === t.id && x.reporting.columns.some((vc) => vc.source === c.name) && !ops.some((p) => p.op === 'dropTable' && p.id === x.id))
        if (viewUse.length) problems.push(`${t.displayName}.${c.displayName} is read by the reporting view ${viewUse.map((v) => `"${v.displayName}"`).join(', ')}: remove the view first.`)
        const managed = isPlatformManaged(t)
        const rows = c.computed ? undefined : await rowCount(s, t, { col: c.name, op: 'notBlank' })
        items.push({
          kind: 'column', change: 'removed', table: t.displayName, name: c.displayName, rows, destructive: managed && !c.computed && (rows ?? 1) > 0,
          note: !managed ? 'Linked table: the column is only unmapped; it stays in its database.' : c.computed ? 'Calculated column: nothing is lost that cannot be calculated again.' : `${rows === undefined ? 'Its' : rows.toLocaleString('en')} value${rows === 1 ? ' is' : 's are'} deleted.`,
        })
        break
      }
      case 'putRelationship': {
        const r = o.rel
        const col = after.tables.find((x) => x.id === r.fromTable)?.columns.find((c) => c.name === r.fromColumn)
        const what = `${label(after, r.fromTable)}.${col?.displayName ?? r.fromColumn} → ${label(after, r.toTable)}`
        const kind = r.kind === 'oneToOne' ? 'one-to-one' : r.kind === 'self' ? 'hierarchy' : r.junction ? 'many-to-many side' : 'one-to-many'
        const del = r.onDelete === 'setBlank' ? 'set blank' : r.onDelete
        items.push({ kind: 'relationship', change: o.before ? 'changed' : 'new', table: label(after, r.fromTable), name: what, note: `${kind}; on delete: ${del}${r.preventCycles ? '; no loops' : ''}${o.before && o.before.onDelete !== r.onDelete ? ` (was ${o.before.onDelete === 'setBlank' ? 'set blank' : o.before.onDelete})` : ''}` })
        break
      }
      case 'dropRelationship': {
        const r = live.relationships.find((x) => x.id === o.id)
        if (r) items.push({ kind: 'relationship', change: 'removed', table: label(live, r.fromTable), name: `${label(live, r.fromTable)}.${r.fromColumn} → ${label(live, r.toTable)}` })
        break
      }
    }
  }
  // tables on connections that cannot change structure
  for (const o of ops) {
    const id = o.op === 'addColumn' || o.op === 'updateColumn' || o.op === 'dropColumn' ? o.table : null
    const t = id ? byId(id) : undefined
    if (t?.readOnly && !isView(t) && !t.reporting) problems.push(`"${t.displayName}" is linked read-only: its columns cannot be changed here.`)
  }
  const backupAvailable = !!s.backup?.available()
  const plan: ModelPlan = {
    items,
    destructive: items.some((i) => i.destructive),
    problems: [...new Set(problems)],
    warnings: [...new Set(warnings)],
    backup: { available: backupAvailable, message: backupAvailable ? 'A backup of this environment is taken before the change.' : NO_BACKUP_MESSAGE },
    token: createHash('sha256').update(stable({ ops, live: fingerprint(live), env: currentEnvironment().id, user: user.user.id })).digest('hex').slice(0, 40),
    opCount: ops.length,
  }
  return { plan, live }
}

/** how many value combinations of `cols` occur more than once (0 when the table is not on the default database) */
async function duplicatePairs(s: Services, t: TableDef, cols: string[]): Promise<number> {
  if (!onDefault(t) || !t.source) return 0
  const db = s.env.systemDb?.()
  if (!db) return 0
  try {
    const exprs = cols.map((c) => {
      const col = t.columns.find((x) => x.name === c)
      const q = quoteId(c)
      return col && ['text', 'email', 'url', 'phone', 'choice'].includes(col.type) ? `lower(${q})` : q
    })
    const where = cols.map((c) => `${quoteId(c)} IS NOT NULL`).join(' AND ')
    const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (SELECT 1 FROM ${quoteId(currentEnvironment().schema)}.${quoteId(t.source)} WHERE ${where} GROUP BY ${exprs.join(', ')} HAVING count(*) > 1) d`)
    return Number(r[0]?.n ?? 0)
  } catch {
    return 0
  }
}

/* ------------------------------------------------------------------ apply */

/** the table and connection route handlers, called in-process inside the apply's unit of work */
function captureHandlers(s: Services): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const router: Router = { add: (method, pattern, handler) => { handlers.set(`${method} ${pattern.replace(/^\/api\/v1/, '')}`, handler) } }
  registerTableRoutes(router, s)
  registerConnectionRoutes(router, s)
  return handlers
}

/** a ColumnDef as the column routes take it (explicit false / blank for removed settings) */
function columnBody(c: ColumnDef, forPatch: boolean): Record<string, unknown> {
  const b: Record<string, unknown> = { displayName: c.displayName, type: c.type }
  if (!forPatch) b.name = c.name
  for (const k of ['required', 'unique', 'indexed'] as const) if (c[k] || forPatch) b[k] = !!c[k]
  if (c.default !== undefined || forPatch) b.default = c.default ?? ''
  if (c.type === 'choice') b.choices = c.choices ?? []
  if (c.type === 'lookup') b.lookupTable = c.lookupTable
  if (c.type === 'autonumber') b.prefix = c.prefix ?? ''
  for (const k of ['multiple', 'accept', 'maxSizeMB'] as const) if (c[k] !== undefined) b[k] = c[k]
  if (c.computed || forPatch) b.computed = c.computed ?? null
  return b
}

export async function applyModel(s: Services, ctx: Ctx, ops: ModelOp[], token: unknown): Promise<ModelApplyResult> {
  const user = ctx.user!
  const first = await planModel(s, user, ops)
  if (first.plan.problems.length) throw new HttpError(422, 'invalid', `The changes cannot be applied: ${first.plan.problems[0]}`, undefined, { plan: first.plan })
  if (token !== first.plan.token) throw new HttpError(409, 'conflict', 'The schema changed since you reviewed the plan. Review the changes again.', undefined, { plan: first.plan })
  // the pre-change backup (package J); without one the plan said so in words
  let backup = { taken: false, message: NO_BACKUP_MESSAGE }
  if (s.backup?.available()) {
    const r = await s.backup.snapshot(s.environment(), 'Data model change')
    backup = { taken: !!r.taken, message: r.message ?? (r.taken ? 'A backup was taken before the change.' : NO_BACKUP_MESSAGE) }
  }
  const ids = await s.transaction(async () => {
    // the plan again, inside the transaction: nothing may have changed in between
    const again = await planModel(s, user, ops)
    if (again.plan.token !== first.plan.token) throw new HttpError(409, 'conflict', 'The schema changed while applying. Review the changes again.', undefined, { plan: again.plan })
    const map = await execute(s, ctx, ops)
    await audit(s, ctx, 'model.apply', { changes: ops.length, ops: ops.slice(0, 200).map((o) => describeOp(first.live, o)), backup: backup.taken })
    return map
  })
  return { ids, plan: first.plan, backup }
}

async function execute(s: Services, ctx: Ctx, opsIn: ModelOp[]): Promise<Record<string, string>> {
  const h = captureHandlers(s)
  const call = async <T>(key: string, params: Record<string, string>, body?: unknown, query?: Record<string, string>): Promise<T> => {
    const fn = h.get(key)
    if (!fn) throw new Error(`internal: no handler ${key}`)
    return (await fn({ ...ctx, params, body, query: new URLSearchParams(query ?? {}) })) as T
  }
  const store = s.meta.relationships
  const ids: Record<string, string> = {}
  const real = (id: string) => ids[id] ?? id
  const ops = opsIn
  const live = await liveModel(s)
  const created: TableDef[] = []
  const deferred: { table: string; column: ColumnDef }[] = []
  const after: { def: ModelTable; real: string }[] = []

  // 1. relationship records that go
  for (const o of ops) if (o.op === 'dropRelationship' && store) await store.remove(o.id)
  // 2. columns that go: calculated first, then lookups, then the rest
  const drops = ops.filter((o): o is Extract<ModelOp, { op: 'dropColumn' }> => o.op === 'dropColumn')
  const rank = (o: Extract<ModelOp, { op: 'dropColumn' }>) => {
    const c = live.tables.find((t) => t.id === o.table)?.columns.find((x) => x.name === o.name)
    return c?.computed ? 0 : c?.type === 'lookup' ? 1 : 2
  }
  for (const o of [...drops].sort((a, b) => rank(a) - rank(b))) await call('DELETE /tables/:id/columns/:name', { id: o.table, name: o.name })
  // 3. tables that go: views first, then tables nothing else still points at
  let pending = ops.filter((o): o is Extract<ModelOp, { op: 'dropTable' }> => o.op === 'dropTable')
  for (let guard = 0; pending.length && guard < 500; guard++) {
    const current = await s.meta.tables.list()
    const next = pending.find((o) => {
      const t = current.find((x) => x.id === o.id)
      if (!t) return true
      if (isView(t)) return true
      return !current.some((x) => x.id !== t.id && (
        (x.reporting?.kind === 'view' && x.reporting.base === t.id)
        || x.columns.some((c) => (c.type === 'lookup' && c.lookupTable?.toLowerCase() === t.name.toLowerCase()) || (c.computed?.kind === 'rollup' && (c.computed.table.toLowerCase() === t.name.toLowerCase() || c.computed.table === t.id)))))
    }) ?? pending[0]
    pending = pending.filter((x) => x !== next)
    await dropTable(s, call, next.id)
  }
  // 4. new tables, in dependency order: each with the columns whose lookup targets exist by then
  const creates = ops.filter((o): o is Extract<ModelOp, { op: 'createTable' }> => o.op === 'createTable')
  const plain = creates.filter((o) => !o.table.reporting || o.table.reporting.kind !== 'view')
  const remaining = [...plain]
  const existsNow = async (name: string | undefined) => !!name && (await s.meta.tables.get(name)) !== null
  while (remaining.length) {
    let pick = -1
    for (let i = 0; i < remaining.length && pick < 0; i++) {
      const t = remaining[i].table
      const needs = t.columns.filter((c) => c.type === 'lookup' && c.lookupTable?.toLowerCase() !== t.name.toLowerCase()).map((c) => c.lookupTable)
      const others = remaining.filter((_, j) => j !== i).map((x) => x.table.name.toLowerCase())
      if (needs.every((n) => !n || !others.includes(n.toLowerCase()))) pick = i
    }
    if (pick < 0) pick = 0 // a cycle among new tables: its lookups are added after
    const o = remaining.splice(pick, 1)[0]
    const t = o.table
    if (t.link) {
      const def = await call<TableDef>('POST /connections/:id/link', { id: t.link.connectionId }, { source: t.link.source, name: t.name, displayName: t.displayName })
      ids[t.id] = def.id
      created.push(def)
      continue
    }
    const now: ColumnDef[] = []
    for (const c of t.columns) {
      if (isSystemColumn(c)) continue
      const later = !!c.computed || (c.type === 'lookup' && c.lookupTable?.toLowerCase() !== t.name.toLowerCase() && !(await existsNow(c.lookupTable)))
      if (later) deferred.push({ table: t.id, column: c })
      else now.push(c)
    }
    const def = await call<TableDef>('POST /tables', {}, {
      displayName: t.displayName, name: t.name, ...(t.description ? { description: t.description } : {}),
      columns: now.length ? now.map((c) => columnBody(c, false)) : undefined,
    })
    ids[t.id] = def.id
    created.push(def)
    after.push({ def: t, real: def.id })
    if (!now.length) deferred.push({ table: t.id, column: { name: '__placeholder', displayName: '', type: 'text' } })
  }
  // 5. columns of existing tables, then changes, then table settings
  for (const o of ops) if (o.op === 'addColumn' && !o.column.computed) await call('POST /tables/:id/columns', { id: real(o.table) }, columnBody(o.column, false))
  // lookups first, then formula columns, then rollups (a rollup may sum a formula column of its child)
  const rankCol = (c: ColumnDef) => (c.type === 'lookup' && !c.computed ? 0 : c.computed?.kind === 'formula' ? 1 : c.computed?.kind === 'rollup' ? 2 : 0)
  for (const d of [...deferred].sort((x, y) => rankCol(x.column) - rankCol(y.column))) {
    if (d.column.name === '__placeholder') continue
    await call('POST /tables/:id/columns', { id: real(d.table) }, columnBody(d.column, false))
  }
  for (const d of deferred) {
    if (d.column.name !== '__placeholder') continue
    // the route gave an all-deferred table a "Name" column: it goes now that the real columns exist
    const def = await s.meta.tables.get(real(d.table))
    const extra = def?.columns.find((c) => c.name === 'Name' && !after.find((a) => a.real === def.id)?.def.columns.some((x) => x.name === 'Name'))
    if (def && extra) await call('DELETE /tables/:id/columns/:name', { id: def.id, name: extra.name })
  }
  const computedAdds = ops.filter((o): o is Extract<ModelOp, { op: 'addColumn' }> => o.op === 'addColumn' && !!o.column.computed)
  for (const o of computedAdds.sort((x, y) => rankCol(x.column) - rankCol(y.column))) await call('POST /tables/:id/columns', { id: real(o.table) }, columnBody(o.column, false))
  // linked tables: their foreign keys become lookups when the link is writable (a read-only link keeps plain columns)
  const linkedIds = new Set<string>()
  for (const o of creates) {
    if (!o.table.link) continue
    linkedIds.add(real(o.table.id))
    const def = await s.meta.tables.get(real(o.table.id))
    if (!def || def.readOnly) continue
    for (const c of o.table.columns) {
      if (c.type !== 'lookup' || !def.columns.some((x) => x.name === c.name)) continue
      await call('PATCH /tables/:id/columns/:name', { id: def.id, name: c.name }, { type: 'lookup', lookupTable: c.lookupTable })
    }
  }
  for (const o of ops) if (o.op === 'updateColumn') await call('PATCH /tables/:id/columns/:name', { id: real(o.table), name: o.name }, columnBody(o.after, true))
  for (const o of ops) {
    if (o.op !== 'updateTable') continue
    const { uniqueTogether, ...patch } = o.patch
    if (Object.keys(patch).length) await call('PATCH /tables/:id', { id: real(o.id) }, patch)
    if (uniqueTogether !== undefined) await setUniqueTogether(s, real(o.id), uniqueTogether)
  }
  // 6. new tables: display column, unique pairs, reporting settings
  for (const a of after) {
    const def = await s.meta.tables.get(a.real)
    if (!def) continue
    if (a.def.primaryColumn && a.def.primaryColumn !== def.primaryColumn && def.columns.some((c) => c.name === a.def.primaryColumn)) await call('PATCH /tables/:id', { id: def.id }, { primaryColumn: a.def.primaryColumn })
    if (a.def.uniqueTogether?.length) await setUniqueTogether(s, def.id, a.def.uniqueTogether)
    const r = a.def.reporting
    if (r?.kind === 'date') await fillDateDimension(s, ctx, def.id, r)
    if (r?.kind === 'summary') await createSummary(s, ctx, def.id, { ...r, source: real(r.source) })
  }
  // 7. reporting views (their base tables exist now)
  for (const o of creates) {
    const r = o.table.reporting
    if (r?.kind !== 'view') continue
    const def = await createView(s, ctx, o.table, { ...r, base: real(r.base), columns: r.columns.map((c) => ({ ...c })) }, real)
    ids[o.table.id] = def.id
  }
  // 8. relationship records (ids of new tables mapped), then every other lookup gets its default record
  if (store) {
    for (const o of ops) {
      if (o.op !== 'putRelationship') continue
      const rel: RelationshipDef = { ...o.rel, fromTable: real(o.rel.fromTable), toTable: real(o.rel.toTable) }
      const from = await s.meta.tables.get(rel.fromTable)
      const col = from?.columns.find((c) => c.name === rel.fromColumn)
      if (from && linkedIds.has(from.id) && col?.type !== 'lookup') continue
      if (!from || !col || col.type !== 'lookup') throw new HttpError(422, 'invalid', `A relationship of ${from?.displayName ?? rel.fromTable} has no lookup column "${rel.fromColumn}".`)
      const target = await s.meta.tables.get(col.lookupTable ?? '')
      if (!target || target.id !== rel.toTable) throw new HttpError(422, 'invalid', `${from.displayName}.${col.displayName}: the relationship does not match the lookup's table.`)
      if (rel.onDelete === 'setBlank' && col.required) rel.onDelete = 'restrict'
      await store.put(rel)
    }
    await store.sync(await s.meta.tables.list())
  }
  s.security.invalidate()
  return ids
}

async function dropTable(s: Services, call: <T>(key: string, params: Record<string, string>, body?: unknown, query?: Record<string, string>) => Promise<T>, id: string): Promise<void> {
  const def = await s.meta.tables.get(id)
  if (!def) return
  if (def.reporting?.kind === 'view') {
    const { connector } = await resolveConnection(s, def.connectionId)
    await connector.dropTable(def)
    await s.meta.tables.remove(def.id)
    await audit(s, null, 'table.delete', { name: def.name, view: true }, def.id)
    return
  }
  if (def.reporting?.kind === 'summary') await removeSummarySchedules(s, def.id)
  // summary tables and date dimensions are read-only for apps, not for their removal
  if (def.readOnly && def.reporting) await s.meta.tables.upsert({ ...def, readOnly: false })
  await call('DELETE /tables/:id', { id }, undefined, isPlatformManaged(def) ? { dropSource: '1' } : {})
  await s.meta.relationships?.removeForTable(id)
}

async function setUniqueTogether(s: Services, tableId: string, sets: string[][]): Promise<void> {
  const def = await s.meta.tables.get(tableId)
  if (!def) return
  const db = s.env.systemDb?.()
  if (!db || !onDefault(def)) throw new HttpError(422, 'invalid', `${def.displayName}: unique pairs need the default database.`)
  const schema = currentEnvironment().schema
  for (const old of def.uniqueTogether ?? []) await db.exec(`DROP INDEX IF EXISTS ${quoteId(schema)}.${quoteId(uniqueTogetherIndexName(def, old))}`)
  const next: TableDef = { ...def, modifiedOn: s.now() }
  if (sets.length) next.uniqueTogether = sets
  else delete next.uniqueTogether
  for (const stmt of uniqueTogetherSql({ schema, icu: true }, next)) await db.exec(stmt)
  await s.meta.tables.upsert(next)
}

async function createView(s: Services, ctx: Ctx, t: ModelTable, r: ViewDef, real: (id: string) => string): Promise<TableDef> {
  const base = await s.meta.tables.get(r.base)
  if (!base || !base.source || !onDefault(base)) throw new HttpError(422, 'invalid', `The view "${t.displayName}" needs a base table in the default database.`)
  const { record, connector } = await resolveConnection(s, DEFAULT_CONNECTION_ID)
  const all = await s.meta.tables.list()
  if (all.some((x) => x.name.toLowerCase() === t.name.toLowerCase())) throw new HttpError(409, 'conflict', `A table named "${t.name}" already exists.`)
  const columns: ColumnDef[] = [
    ...base.columns.filter((c) => isSystemColumn(c)).map((c) => ({ ...c })),
    ...r.columns.map((vc) => {
      const src = base.columns.find((c) => c.name === vc.source)
      if (!src) throw new HttpError(422, 'invalid', `"${t.displayName}": ${base.displayName} has no column "${vc.source}".`)
      const col: ColumnDef = { name: vc.name, displayName: vc.displayName, type: vc.expr && vc.expr !== 'value' ? 'number' : src.type }
      if (col.type === 'choice') col.choices = src.choices ?? []
      if (col.type === 'lookup') {
        const target = vc.lookupTable ? (all.find((x) => x.name.toLowerCase() === vc.lookupTable!.toLowerCase()) ?? all.find((x) => x.id === real(vc.lookupTable!))) : undefined
        col.lookupTable = target?.name ?? src.lookupTable
      }
      if (col.type === 'autonumber') col.type = 'text'
      return col
    }),
  ]
  const now = s.now()
  const def: TableDef = {
    id: s.uid('tbl'), name: t.name, displayName: t.displayName, primaryColumn: r.columns[0]?.name ?? 'id', columns, createdOn: now, modifiedOn: now,
    connectionId: record.id, readOnly: true, managed: true,
    reporting: { kind: 'view', role: r.role, base: base.id, baseSource: base.source, columns: r.columns.map((c) => ({ ...c, type: columns.find((x) => x.name === c.name)!.type })) },
  }
  if (t.description) def.description = t.description
  def.source = (await pickSource(s, record, connector, t.name)).replace(/^t_/, 'v_')
  await connector.createTable(def)
  await s.meta.tables.upsert(def)
  await audit(s, ctx, 'table.create', { name: def.name, view: true, base: base.name }, def.id)
  return def
}

async function fillDateDimension(s: Services, ctx: Ctx, tableId: string, r: DateDimDef): Promise<void> {
  const def = await s.meta.tables.get(tableId)
  if (!def) return
  const rows = dateDimRows(r)
  const cols = ['Date', 'DateKey', 'Year', 'Quarter', 'Month', 'MonthName', 'Day', 'Weekday', 'WeekdayName', 'IsWeekend', 'FiscalYear', 'FiscalQuarter', 'FiscalMonth'] as const
  const csv = [cols.join(','), ...rows.map((x) => cols.map((c) => String(x[c])).join(','))].join('\n')
  await s.data.importCsv(null, def, csv, 'replace', { actorId: ctx.user?.user.id })
  await s.meta.tables.upsert({ ...def, reporting: r, readOnly: true, modifiedOn: s.now() })
}

async function createSummary(s: Services, ctx: Ctx, tableId: string, r: SummaryDef): Promise<void> {
  const def = await s.meta.tables.get(tableId)
  const src = await s.meta.tables.get(r.source)
  if (!def || !src) throw new HttpError(422, 'invalid', 'The summary table or its source is missing.')
  if (!onDefault(src)) throw new HttpError(422, 'invalid', 'Summary tables can only read tables in the default database.')
  await s.meta.tables.upsert({ ...def, reporting: r, readOnly: true, modifiedOn: s.now() })
  // access: only roles that may read EVERY row and every used column of the source read the totals (no writes)
  const used = new Set([...r.groupBy, ...r.measures.flatMap((m) => (m.column ? [m.column] : []))])
  for (const role of (await s.meta.roles.list()) as RoleX[]) {
    if (role.isAdmin) continue
    const p = role.privileges.find((x) => x.table === src.id)
    const full = !!p && p.read === 'all' && !p.rowFilter?.length && ![...used].some((c) => p.columns?.[c] === 'none')
    const priv: TablePrivilege = { table: def.id, create: false, read: full ? 'all' : 'none', update: 'none', delete: 'none' }
    await s.meta.roles.upsert({ ...role, privileges: [...role.privileges.filter((x) => x.table !== def.id), priv] } as RoleX)
  }
  s.security.invalidate()
  const core = s as CoreServices
  if (core.kernel?.jobs) {
    await core.kernel.jobs.schedules.create({ name: `Refresh ${def.displayName}`, description: `Recomputes the summary table ${def.displayName} from ${src.displayName} (data model designer).`, cron: r.cron, timeZone: 'UTC', jobType: SUMMARY_JOB, payload: { tableId: def.id }, misfire: 'run_once' }, ctx.user?.user.id ?? null)
    await core.kernel.jobs.enqueue(SUMMARY_JOB, { tableId: def.id }, { createdBy: ctx.user?.user.id })
  } else {
    // no job queue (metadata test harness): refresh once now
    const db = s.env.systemDb?.()
    if (db) for (const stmt of summaryRefreshSql(currentEnvironment().schema, { ...def, reporting: r }, src)) await db.exec(stmt)
  }
}

async function removeSummarySchedules(s: Services, tableId: string): Promise<void> {
  const core = s as CoreServices
  if (!core.kernel?.jobs) return
  for (const sc of await core.kernel.jobs.schedules.list()) {
    const p = sc.payload as { tableId?: string } | null
    if (sc.jobType === SUMMARY_JOB && p?.tableId === tableId) await core.kernel.jobs.schedules.remove(sc.id)
  }
}

export { removeSummarySchedules }
