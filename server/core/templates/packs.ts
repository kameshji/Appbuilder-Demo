/**
 * Solution templates (P3 package M1; docs/dev/solution-templates.md): what a pack (template kind `solution`, format 2)
 * adds to the P2 machinery in service.ts.
 *
 *  - BINDING of the pack's components: number sequences resolved by the clash rule (a free name is created; a same-named
 *    sequence with the same format is reused; otherwise the pack's gets a prefixed name), names of flows, approval
 *    policies, dashboards and print templates prefixed with the pack's short name (and made unique), the COMPONENT TOKENS
 *    (Slot_App_<key> ... Slot_Seq_<key>) added to the slot tokens, then every app, flow, policy, dashboard, print document
 *    and role row rule bound (bind.ts bindApp / bindJson);
 *  - the parts of the solution document (apps, flows that arrive off, policies, print templates, dashboards, number
 *    sequences) with the install's stable ids, or, for a component kept local by an upgrade, its current definition here;
 *  - HASHES of every delivered component (local changes are found by comparing them with what is here now);
 *  - REFERENCE rows (loaded always, upgraded unless the customer changed them) and SAMPLE rows (recorded by id, removed
 *    exactly by "Remove sample data");
 *  - role privileges on tables the pack maps (shared slots, your own tables): set on the pack's own roles only.
 */
import { createHash } from 'node:crypto'
import type { AppDef } from '../../../src/contracts.ts'
import type { TableDef, TablePrivilege } from '../../../src/platform/contracts.ts'
import type { Services } from '../contracts.ts'
import { HttpError } from '../contracts.ts'
import { canonicalJson, componentToken, type PackSequence, type TemplatePackage, type TemplateRow } from '../../../src/templates/format.ts'
import { bindApp, bindJson, type Resolution } from '../../../src/templates/bind.ts'
import { currentEnvironment } from '../env-context.ts'
import { rowUid } from '../util.ts'
import { uniqueLabel } from '../../routes/meta/util.ts'
import { exportFlows } from '../flows/alm.ts'
import { exportApprovalPolicies } from '../approvals/alm.ts'
import { exportPrintTemplates } from '../print/alm.ts'
import { exportDashboards } from '../dashboards/alm.ts'
import { formatOf, listSequences } from './sequences.ts'

export const sha = (v: unknown): string => createHash('sha256').update(canonicalJson(v)).digest('hex')
export const hid = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 12)
/** a stable row id (rows of the core data model, such as number sequences, have UUID ids): version 8, from a hash */
export const rowIdOf = (v: string): string => { const x = createHash('sha256').update(v).digest('hex'); return `${x.slice(0, 8)}-${x.slice(8, 12)}-8${x.slice(13, 16)}-a${x.slice(17, 20)}-${x.slice(20, 32)}` }

/** the stable ids of a Linked install's components (format 2 adds the pack kinds) */
export interface LinkedIds {
  solution: string
  app?: string
  tables: Record<string, string>
  roles: Record<string, string>
  events: Record<string, string>
  /** format 2: the hashing base (template id # install number), so a later version's new components get ids too */
  base?: string
  apps?: Record<string, string>
  flows?: Record<string, string>
  policies?: Record<string, string>
  dashboards?: Record<string, string>
  prints?: Record<string, string>
  sequences?: Record<string, string>
}

/** ids for every component of a pack (existing ones are kept: an upgrade passes the install's ids) */
export function packIds(pkg: TemplatePackage, base: string, have?: LinkedIds): LinkedIds {
  const p = pkg.payload
  const keep = <T extends string>(cur: Record<string, string> | undefined, keys: string[], prefix: T): Record<string, string> => {
    const out: Record<string, string> = { ...(cur ?? {}) }
    for (const k of keys) if (!out[k]) out[k] = prefix === 'seq' ? rowIdOf(`${base}:seq:${k}`) : `${prefix}_tpl_${hid(`${base}:${prefix}:${k}`)}`
    return out
  }
  const tables: Record<string, string> = { ...(have?.tables ?? {}) }
  for (const sl of pkg.slots) if (!tables[sl.id] && !sl.from) tables[sl.id] = `tbl_tpl_${hid(`${base}:table:${sl.id}`)}`
  const roles: Record<string, string> = { ...(have?.roles ?? {}) }
  for (const r of p.roles ?? []) { const k = r.key ?? r.name; if (!roles[k]) roles[k] = `role_tpl_${hid(`${base}:role:${k}`)}` }
  const events: Record<string, string> = { ...(have?.events ?? {}) }
  for (const sl of pkg.slots) (sl.events ?? []).forEach((e, i) => { const k = `${sl.id}:${i}`; if (!events[k]) events[k] = `evt_tpl_${hid(`${base}:event:${sl.id}:${i}:${e.name ?? ''}`)}` })
  return {
    solution: have?.solution ?? `tpl_${hid(`${base}:solution`)}`, tables, roles, events, base,
    apps: keep(have?.apps, (p.apps ?? []).map((a) => a.key), 'app'),
    flows: keep(have?.flows, (p.flows ?? []).map((a) => a.key), 'flow'),
    policies: keep(have?.policies, (p.approvalPolicies ?? []).map((a) => a.key), 'apol'),
    dashboards: keep(have?.dashboards, (p.dashboards ?? []).map((a) => a.key), 'dash'),
    prints: keep(have?.prints, (p.printTemplates ?? []).map((a) => a.key), 'prt'),
    sequences: keep(have?.sequences, (p.sequences ?? []).map((a) => a.key), 'seq'),
  }
}

/* ------------------------------------------------------------------ binding the pack's components */

export interface BoundSequence extends PackSequence { id: string; action: 'create' | 'reuse' | 'renamed'; note?: string }
export interface PackPlan {
  apps: { key: string; id: string; name: string; description?: string; phone?: boolean; def: AppDef }[]
  flows: { key: string; id: string; name: string; description?: string; definition: Record<string, unknown>; runRoles: string[] }[]
  policies: { key: string; id: string; name: string; description?: string; definition: Record<string, unknown> }[]
  dashboards: { key: string; id: string; name: string; def: Record<string, unknown>; roles: string[] }[]
  prints: { key: string; id: string; name: string; description?: string; doc: Record<string, unknown> }[]
  sequences: BoundSequence[]
  /** the role keys -> rowFilter / columns of each slot, bound */
  roleRules: Record<string, Record<string, { rowFilter?: unknown[]; columns?: Record<string, 'none' | 'read' | 'update'> }>>
  tokens: Map<string, string | null>
  problems: string[]
  warnings: string[]
}

type Row = Record<string, unknown>
const T = (t: string): string => `"${currentEnvironment().schema}"."${t}"`
function sqlDb(s: Services) {
  const d = (s as unknown as { state?: { db?: { query<R>(q: string, p?: unknown[]): Promise<R[]>; exec(q: string, p?: unknown[]): Promise<{ affectedRows: number }> } | null } }).state?.db
  if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
  return d
}

/** names taken here by components of other identities (a pack's names must be free: the solution import refuses a clash) */
async function takenNames(s: Services, ids: LinkedIds): Promise<{ flows: string[]; policies: string[]; prints: string[]; dashboards: string[] }> {
  const d = sqlDb(s)
  const mine = (v: Record<string, string> | undefined) => new Set(Object.values(v ?? {}))
  const names = async (table: string, own: Set<string>) => (await d.query<Row>(`SELECT id, name FROM ${T(table)}`)).filter((r) => !own.has(String(r.id))).map((r) => String(r.name))
  return {
    flows: await names('ab_flows', mine(ids.flows)),
    policies: await names('ab_approval_policies', mine(ids.policies)),
    prints: await names('ab_print_templates', mine(ids.prints)),
    dashboards: await names('ab_dashboards', mine(ids.dashboards)),
  }
}

/**
 * Binds the components of a pack. `names`: the names the components already have here (an upgrade keeps them);
 * `roleIds`: role key -> the role's id here (null: roles are not created, so the token cannot be bound).
 */
export async function bindPack(s: Services, pkg: TemplatePackage, resolution: Resolution, ids: LinkedIds, o: { names?: Record<string, string>; columnOf: (slot: string, col: string) => string | null }): Promise<PackPlan> {
  const p = pkg.payload
  const problems: string[] = []
  const warnings: string[] = []
  const short = pkg.shortName ?? pkg.name
  const named = (n: string) => (n.toLowerCase().startsWith(`${short.toLowerCase()}:`) ? n : `${short}: ${n}`)
  const taken = await takenNames(s, ids)
  const pick = (kind: string, id: string, wanted: string, list: string[]): string => {
    const have = o.names?.[`${kind}:${id}`]
    if (have) return have
    const name = uniqueLabel(named(wanted).slice(0, 100), list)
    list.push(name)
    return name
  }
  // number sequences (default 23)
  const existing = await listSequences(s)
  const sequences: BoundSequence[] = []
  for (const q of p.sequences ?? []) {
    const id = ids.sequences![q.key]
    const mine = existing.find((r) => r.id === id)
    if (mine) { sequences.push({ ...q, id, name: mine.name, action: 'create' }); continue }
    const same = existing.find((r) => r.name.toLowerCase() === q.name.toLowerCase())
    if (!same) { sequences.push({ ...q, id, action: 'create' }); continue }
    if (formatOf(same) === formatOf(q)) {
      sequences.push({ ...q, id: same.id, name: same.name, action: 'reuse', note: `a number sequence "${same.name}" with the same format exists here: it is used (its next value stays ${same.nextValue})` })
      continue
    }
    const name = uniqueLabel(`${short} ${q.name}`.slice(0, 100), existing.map((r) => r.name))
    sequences.push({ ...q, id, name, action: 'renamed', note: `"${q.name}" exists here with another format: the pack's is called "${name}"` })
    warnings.push(`A number sequence named "${q.name}" exists here with another format: the template's is created as "${name}" (yours is not changed).`)
  }
  // the component tokens
  const tokens = new Map(resolution.tokens)
  for (const a of p.apps ?? []) tokens.set(componentToken('app', a.key), ids.apps![a.key])
  for (const r of p.roles ?? []) tokens.set(componentToken('role', r.key ?? r.name), ids.roles[r.key ?? r.name] ?? null)
  for (const f of p.flows ?? []) tokens.set(componentToken('flow', f.key), ids.flows![f.key])
  for (const a of p.approvalPolicies ?? []) tokens.set(componentToken('policy', a.key), ids.policies![a.key])
  for (const d of p.dashboards ?? []) tokens.set(componentToken('dashboard', d.key), ids.dashboards![d.key])
  for (const d of p.printTemplates ?? []) tokens.set(componentToken('print', d.key), ids.prints![d.key])
  for (const q of sequences) tokens.set(componentToken('sequence', q.key), q.name)
  const bound = <V>(v: V, where: string): V => {
    const b = bindJson(v, tokens)
    problems.push(...b.problems.map((x) => `${where}: ${x}`))
    return b.value
  }
  const apps = (p.apps ?? []).map((a) => {
    const b = bindApp(a.app, tokens)
    problems.push(...b.problems.map((x) => `App ${a.name}: ${x}`))
    return { key: a.key, id: ids.apps![a.key], name: o.names?.[`app:${ids.apps![a.key]}`] ?? a.name, ...(a.description ? { description: a.description } : {}), ...(a.phone ? { phone: true } : {}), def: { ...b.value, name: o.names?.[`app:${ids.apps![a.key]}`] ?? a.name } }
  })
  const flows = (p.flows ?? []).map((f) => {
    const id = ids.flows![f.key]
    const b = bound({ definition: f.definition, runRoles: f.runRoles ?? [] }, `Flow ${f.name}`)
    return { key: f.key, id, name: pick('flow', id, f.name, taken.flows), ...(f.description ? { description: f.description } : {}), definition: b.definition, runRoles: b.runRoles.filter((x): x is string => typeof x === 'string' && !!x) }
  })
  const policies = (p.approvalPolicies ?? []).map((a) => {
    const id = ids.policies![a.key]
    return { key: a.key, id, name: pick('approvalPolicy', id, a.name, taken.policies), ...(a.description ? { description: a.description } : {}), definition: bound(a.definition, `Approval policy ${a.name}`) }
  })
  const dashboards = (p.dashboards ?? []).map((d) => {
    const id = ids.dashboards![d.key]
    const b = bound({ def: d.def, roles: d.roles ?? [] }, `Dashboard ${d.name}`)
    const name = pick('dashboard', id, d.name, taken.dashboards)
    return { key: d.key, id, name, def: { ...b.def, title: name }, roles: b.roles.filter((x): x is string => typeof x === 'string' && !!x) }
  })
  const prints = (p.printTemplates ?? []).map((d) => {
    const id = ids.prints![d.key]
    return { key: d.key, id, name: pick('printTemplate', id, d.name, taken.prints), ...(d.description ? { description: d.description } : {}), doc: bound(d.doc, `Print template ${d.name}`) }
  })
  // role rules: relationship row rules bound; column security from slot column ids to the column names here
  const roleRules: PackPlan['roleRules'] = {}
  for (const r of p.roles ?? []) {
    const k = r.key ?? r.name
    for (const [slot, t] of Object.entries(r.tables ?? {})) {
      if (!t.rowFilter && !t.columns) continue
      const out: { rowFilter?: unknown[]; columns?: Record<string, 'none' | 'read' | 'update'> } = {}
      if (t.rowFilter) out.rowFilter = bound(t.rowFilter, `Role ${r.name}`)
      if (t.columns) {
        out.columns = {}
        for (const [c, v] of Object.entries(t.columns)) { const n = o.columnOf(slot, c); if (n) out.columns[n] = v }
      }
      ;(roleRules[k] ??= {})[slot] = out
    }
  }
  return { apps, flows, policies, dashboards, prints, sequences, roleRules, tokens, problems: [...new Set(problems)], warnings }
}

/* ------------------------------------------------------------------ the solution document's pack parts */

export interface KeepParts {
  flows?: Record<string, unknown>
  policies?: Record<string, unknown>
  dashboards?: Record<string, unknown>
  prints?: Record<string, unknown>
  sequences?: Record<string, unknown>
}

/** the pack parts of the solution document (a component kept local is its current definition here) */
export function packDocParts(pack: PackPlan, roleNames: Record<string, string>, keep: KeepParts = {}): Record<string, unknown[]> {
  return {
    flows: pack.flows.map((f) => keep.flows?.[f.id] ?? ({ id: f.id, name: f.name, ...(f.description ? { description: f.description } : {}), runAs: 'owner', enabled: false, definition: f.definition, connections: [], runRoles: f.runRoles })),
    approvalPolicies: pack.policies.map((a) => keep.policies?.[a.id] ?? ({ id: a.id, name: a.name, ...(a.description ? { description: a.description } : {}), definition: a.definition })),
    printTemplates: pack.prints.map((d) => keep.prints?.[d.id] ?? ({ id: d.id, name: d.name, ...(d.description ? { description: d.description } : {}), kind: 'pdf', doc: d.doc })),
    dashboards: pack.dashboards.map((d) => keep.dashboards?.[d.id] ?? ({ id: d.id, name: d.name, def: d.def, roles: d.roles.map((r) => ({ id: r, name: roleNames[r] ?? r })) })),
    numberSequences: pack.sequences.filter((q) => q.action !== 'reuse').map((q) => keep.sequences?.[q.id] ?? ({ id: q.id, name: q.name, ...(q.prefix ? { prefix: q.prefix } : {}), ...(q.suffix ? { suffix: q.suffix } : {}), padding: q.padding ?? 4, resetRule: q.resetRule ?? 'never', ...(q.description ? { description: q.description } : {}) })),
  }
}

/* ------------------------------------------------------------------ what is here now, and its hash */

/** current definitions in the solution package's shapes (what an upgrade puts into the package to keep a local change) */
export async function currentParts(s: Services, ids: LinkedIds): Promise<Required<KeepParts>> {
  const out: Required<KeepParts> = { flows: {}, policies: {}, dashboards: {}, prints: {}, sequences: {} }
  for (const f of await exportFlows(s, Object.values(ids.flows ?? {}))) out.flows[f.id] = f
  for (const a of await exportApprovalPolicies(s, Object.values(ids.policies ?? {}))) out.policies[a.id] = a
  for (const d of await exportDashboards(s, Object.values(ids.dashboards ?? {}))) out.dashboards[d.id] = d
  for (const d of await exportPrintTemplates(s, Object.values(ids.prints ?? {}))) out.prints[d.id] = d
  const seq = Object.values(ids.sequences ?? {})
  for (const r of (await listSequences(s)).filter((x) => seq.includes(x.id))) out.sequences[r.id] = { id: r.id, name: r.name, ...(r.prefix ? { prefix: r.prefix } : {}), ...(r.suffix ? { suffix: r.suffix } : {}), padding: r.padding, resetRule: r.resetRule, ...(r.description ? { description: r.description } : {}) }
  return out
}

/** hashes of what is here now, per kind and id (turning a flow on or off is not a change; numbering is not either) */
export function partHashes(cur: Required<KeepParts>): Record<'flows' | 'approvalPolicies' | 'dashboards' | 'printTemplates' | 'numberSequences', Record<string, string>> {
  const map = (o: Record<string, unknown>, f: (v: Record<string, unknown>) => unknown) => Object.fromEntries(Object.entries(o).map(([id, v]) => [id, sha(f(v as Record<string, unknown>))]))
  return {
    flows: map(cur.flows, (f) => ({ ...f, enabled: null })),
    approvalPolicies: map(cur.policies, (a) => a),
    dashboards: map(cur.dashboards, (d) => ({ name: d.name, def: d.def, roles: ((d.roles as { id: string }[]) ?? []).map((r) => r.id).sort() })),
    printTemplates: map(cur.prints, (d) => d),
    numberSequences: map(cur.sequences, (q) => q),
  }
}

/** a role as compared by an upgrade: name, flags, apps and privileges on the given tables */
export function roleHash(r: { name: string; description?: string; isMaker?: boolean; apps: string[] | 'all'; privileges: TablePrivilege[] }, tables: Set<string>): string {
  return sha({ n: r.name, d: r.description ?? null, m: !!r.isMaker, a: r.apps === 'all' ? 'all' : [...r.apps].sort(), p: r.privileges.filter((x) => tables.has(x.table)).sort((a, b) => a.table.localeCompare(b.table)) })
}

/* ------------------------------------------------------------------ reference and SAMPLE rows */

export interface RefRecord { table: string; id: string; hash: string }
/** values compared as text (numbers, yes/no, dates read back from the database in other types) */
const norm = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : v instanceof Date ? v.toISOString() : String(v))
const rowHash = (r: Record<string, unknown>, cols: string[]): string => sha(Object.fromEntries(cols.map((c) => [c, norm(r[c])])))

/**
 * Rows of a pack into the tables it created: fresh row ids (row ids are unique across tables), lookups between them by
 * local `_id` (a lookup to a row that is not part of the load stays blank). Returns the ids per local id and per table.
 */
export async function loadRows(s: Services, pkg: TemplatePackage, rows: Record<string, TemplateRow[]>, tableOf: (slot: string) => TableDef | undefined, userId: string, insert: (s: Services, items: { def: TableDef; rows: Record<string, string | number | boolean | null>[] }[], userId: string) => Promise<number>, known: Map<string, string> = new Map()): Promise<{ count: number; ids: Map<string, string>; byTable: Record<string, string[]>; hashes: Map<string, string> }> {
  const ids = new Map(known)
  for (const list of Object.values(rows)) for (const r of list) if (typeof r._id === 'string' && !ids.has(r._id)) ids.set(r._id, rowUid())
  const items: { def: TableDef; rows: Record<string, string | number | boolean | null>[] }[] = []
  const byTable: Record<string, string[]> = {}
  const hashes = new Map<string, string>()
  for (const sl of pkg.slots) {
    const def = tableOf(sl.id)
    const list = rows[sl.id] ?? []
    if (!def || !list.length) continue
    const cols = sl.columns.map((c) => c.id)
    items.push({
      def,
      rows: list.map((r) => {
        const out: Record<string, string | number | boolean | null> = {}
        // every row gets its id here, so the register can name it ("Remove sample data", reference upgrades)
        out.id = typeof r._id === 'string' ? ids.get(r._id)! : rowUid()
        for (const c of sl.columns) {
          if (!(c.id in r)) continue
          const v = r[c.id]
          out[c.id] = c.lookupSlot && typeof v === 'string' ? (ids.get(v) ?? null) : v
        }
        ;(byTable[def.id] ??= []).push(String(out.id ?? ''))
        if (typeof r._id === 'string') hashes.set(`${sl.id}:${r._id}`, rowHash(out, cols))
        return out
      }),
    })
  }
  const count = items.length ? await insert(s, items, userId) : 0
  return { count, ids, byTable, hashes }
}

/** the current values of a row, hashed like loadRows (null: the row is gone) */
export async function currentRowHash(s: Services, def: TableDef, id: string, cols: string[]): Promise<string | null> {
  const r = await s.data.query(null, def, { where: { col: 'id', op: 'eq', value: id }, top: 1 })
  const row = r.rows[0]
  if (!row) return null
  return rowHash(row, cols)
}

/** "Remove sample data": deletes exactly the recorded rows that are still here; rows still used by other rows are kept */
export async function removeRows(s: Services, byTable: Record<string, string[]>, order: string[]): Promise<{ removed: number; kept: { table: string; id: string; reason: string }[] }> {
  let removed = 0
  const kept: { table: string; id: string; reason: string }[] = []
  // children first (the order of the slots, reversed), so lookups between sample rows do not block
  const tables = [...new Set([...order.filter((t) => byTable[t]), ...Object.keys(byTable)])].reverse()
  for (const tid of tables) {
    const def = await s.meta.tables.get(tid)
    if (!def || def.id !== tid) continue
    for (const id of byTable[tid] ?? []) {
      try {
        removed += await s.data.delete(null, def, [id])
      } catch (e) {
        kept.push({ table: def.displayName, id, reason: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  return { removed, kept }
}

/** the pack's privileges on tables it maps (not part of its solution): set on its own roles (never on other roles) */
export async function grantMapped(s: Services, roles: { id: string; privileges: Record<string, Omit<TablePrivilege, 'table'>> }[], tableOf: (slot: string) => string | undefined, created: Set<string>): Promise<void> {
  for (const r of roles) {
    const cur = await s.meta.roles.get(r.id)
    if (!cur) continue
    const extra: TablePrivilege[] = []
    for (const [slot, p] of Object.entries(r.privileges)) {
      const t = tableOf(slot)
      if (!t || created.has(t)) continue
      extra.push({ table: t, ...p })
    }
    if (!extra.length) continue
    await s.meta.roles.upsert({ ...cur, privileges: [...cur.privileges.filter((x) => !extra.some((e) => e.table === x.table)), ...extra] })
  }
}

/** clears the solution of a Copy install's components (a Copy is not a versioned solution) */
export async function unlinkComponents(s: Services, solutionId: string): Promise<void> {
  const d = sqlDb(s)
  for (const t of ['ab_flows', 'ab_approval_policies', 'ab_print_templates']) await d.exec(`UPDATE ${T(t)} SET solution_id = NULL WHERE solution_id = $1`, [solutionId])
}
