/**
 * Dashboards in solutions (P2-C second wave; docs/dev/dashboards.md "Solutions and environment copies"). Component kind
 * `dashboard`. A package carries, per dashboard: id, name, the definition, and the viewer roles as `{ id, name }` (roles
 * have stable ids in packages; the name is the fallback when the id is not here). The plan lists dashboards as new /
 * changed / unchanged / removed, with warnings for tables the tiles read that are neither here nor in the package and for
 * viewer roles that cannot be resolved (they are dropped). Apply writes them inside the import's transaction; an
 * upgrade keeps the dashboard's owner here. View tokens and snapshots never travel; a removed dashboard takes its tokens
 * and snapshots with it.
 */
import type { Services, SqlDb, UserContext } from '../contracts.ts'
import type { CoreServices } from '../services.ts'
import type { PlanItem } from '../../../src/platform/http.ts'
import { HttpError } from '../contracts.ts'
import { currentEnvironment } from '../env-context.ts'
import { checkDashboardDef } from '../../../src/dashboards/types.ts'
import type { DashboardDef } from '../../../src/dashboards/types.ts'
import { removeDashboardTokens } from './tokens.ts'
import { removeDashboardSnapshots } from './snapshots.ts'

export const DASHBOARD_KIND = 'dashboard'
export interface PkgDashboard { id: string; name: string; def: DashboardDef; roles: { id: string; name: string }[] }
export interface DashboardOps { upsert: { pkg: PkgDashboard; existing: boolean; roles: string[] }[]; remove: string[] }

type Row = Record<string, unknown>
const T = (t: string): string => `"${currentEnvironment().schema}"."${t}"`
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const canon = (v: unknown): string => JSON.stringify(v ?? null, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x))
const db = (s: Services): SqlDb => {
  const d = (s as unknown as { state?: { db?: SqlDb | null } }).state?.db
  if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
  return d
}
const kind = DASHBOARD_KIND as PlanItem['kind']

export async function exportDashboards(s: Services, ids: string[]): Promise<PkgDashboard[]> {
  if (!ids.length) return []
  const rows = await db(s).query<Row>(`SELECT * FROM ${T('ab_dashboards')} WHERE id = ANY($1::text[]) ORDER BY lower(name), id`, [ids])
  const roles = await s.meta.roles.list()
  return rows.map((r) => ({
    id: String(r.id), name: String(r.name), def: r.def as DashboardDef,
    roles: ((r.roles as string[]) ?? []).map((id) => ({ id, name: roles.find((x) => x.id === id)?.name ?? id })),
  }))
}

export function readPkgDashboards(v: unknown): PkgDashboard[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new HttpError(422, 'invalid', 'The package "dashboards" must be a list.')
  return v.map((p) => {
    if (!isObj(p) || typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(p.id) || typeof p.name !== 'string' || !p.name.trim()) throw new HttpError(422, 'invalid', 'A dashboard in the package is malformed.')
    let def: DashboardDef
    try { def = checkDashboardDef(p.def) } catch (e) { throw new HttpError(422, 'invalid', `The dashboard "${p.name.slice(0, 100)}" in the package is not valid: ${(e as Error).message}`) }
    const roles = (Array.isArray(p.roles) ? p.roles : []).slice(0, 100).map((r) => (isObj(r) ? { id: String(r.id ?? ''), name: String(r.name ?? '') } : { id: String(r), name: '' })).filter((r) => r.id || r.name)
    return { id: p.id, name: p.name.trim().slice(0, 200), def, roles }
  })
}

/** the tables a dashboard's tiles read (names or ids as written) */
export function dashboardTables(def: DashboardDef): string[] {
  const out = new Set<string>()
  for (const t of def.tiles) {
    if (t.query?.table) out.add(t.query.table)
    if (t.query?.target?.table) out.add(t.query.target.table)
  }
  return [...out]
}

/**
 * The plan of the package's dashboards in the current environment. `pkgRoles`: the roles the package carries (created
 * or matched by the import when the importer is an administrator); `pkgTables`: names and ids of the package's tables.
 */
export async function planDashboards(
  s: Services, user: UserContext, pkg: PkgDashboard[] | undefined, previous: string[], pkgRoles: { id?: string; name: string }[], pkgTables: string[],
): Promise<{ items: PlanItem[]; problems: string[]; warnings: string[]; ops: DashboardOps; matched: boolean }> {
  const items: PlanItem[] = []
  const problems: string[] = []
  const warnings: string[] = []
  const ops: DashboardOps = { upsert: [], remove: [] }
  let matched = false
  if (!pkg || (!pkg.length && !previous.length)) return { items, problems, warnings, ops, matched }
  if (pkg.length && !user.privileges.isMaker && !user.privileges.isAdmin) problems.push('Only makers can import dashboards.')
  const existing = await db(s).query<Row>(`SELECT id, name, roles, def FROM ${T('ab_dashboards')}`)
  const roles = await s.meta.roles.list()
  const tables = await s.meta.tables.list()
  const known = new Set([...tables.flatMap((t) => [t.id, t.name.toLowerCase()]), ...pkgTables.map((t) => t.toLowerCase()), ...pkgTables])
  const willCreate = user.privileges.isAdmin
  for (const p of pkg) {
    const cur = existing.find((x) => String(x.id) === p.id)
    if (cur) matched = true
    const resolved: string[] = []
    for (const r of p.roles) {
      const here = roles.find((x) => x.id === r.id)
      if (here) { resolved.push(here.id); continue }
      if (willCreate && r.id && pkgRoles.some((x) => x.id === r.id)) { resolved.push(r.id); continue }
      const byName = r.name ? roles.find((x) => x.name.toLowerCase() === r.name.toLowerCase()) : undefined
      if (byName) { resolved.push(byName.id); continue }
      warnings.push(`The dashboard "${p.name}" lists the viewer role "${r.name || r.id}", which is not here: it is left out (people with that role elsewhere do not see the dashboard here).`)
    }
    const missing = dashboardTables(p.def).filter((t) => !known.has(t) && !known.has(t.toLowerCase()))
    if (missing.length) warnings.push(`The dashboard "${p.name}" reads ${missing.length === 1 ? 'the table' : 'the tables'} ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not here: ${missing.length === 1 ? 'its tiles show' : 'those tiles show'} "does not exist" until the table is added.`)
    const finalRoles = [...new Set(resolved)].sort()
    const changed = !cur || canon({ n: cur.name, d: cur.def, r: [...((cur.roles as string[]) ?? [])].sort() }) !== canon({ n: p.name, d: p.def, r: finalRoles })
    items.push({ kind, id: p.id, name: p.name, change: !cur ? 'new' : changed ? 'changed' : 'unchanged', ...(changed && cur ? { note: 'the definition and viewer roles are replaced; the owner, view tokens and snapshots here are kept' } : {}) })
    if (changed) ops.upsert.push({ pkg: p, existing: !!cur, roles: finalRoles })
  }
  for (const id of previous) {
    if (pkg.some((p) => p.id === id)) continue
    const cur = existing.find((x) => String(x.id) === id)
    if (!cur) continue
    items.push({ kind, id, name: String(cur.name), change: 'removed', note: 'the dashboard is deleted with its view tokens and email snapshots' })
    ops.remove.push(id)
  }
  return { items, problems, warnings, ops, matched }
}

/** inside the import's transaction; roleMap: package role id -> the role id here (roles the same import created or matched) */
export async function applyDashboards(s: Services, userId: string, ops: DashboardOps, roleMap: Map<string, string>): Promise<void> {
  if (!ops.upsert.length && !ops.remove.length) return
  const d = db(s)
  const here = new Set((await s.meta.roles.list()).map((r) => r.id))
  for (const u of ops.upsert) {
    const roles = [...new Set(u.roles.map((r) => roleMap.get(r) ?? r).filter((r) => here.has(r)))]
    await d.exec(
      `INSERT INTO ${T('ab_dashboards')} (id, name, owner_id, roles, def, created_on, modified_on) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, now(), now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, roles = EXCLUDED.roles, def = EXCLUDED.def, modified_on = EXCLUDED.modified_on`,
      [u.pkg.id, u.pkg.name, userId, JSON.stringify(roles), JSON.stringify(u.pkg.def)],
    )
  }
  for (const id of ops.remove) {
    await removeDashboardTokens(d, id)
    await removeDashboardSnapshots(s as CoreServices, d, id)
    await d.exec(`DELETE FROM ${T('ab_dashboards')} WHERE id = $1`, [id])
  }
}

/** a solution component check: does the dashboard exist here */
export async function dashboardExists(s: Services, id: string): Promise<boolean> {
  return (await db(s).query(`SELECT 1 FROM ${T('ab_dashboards')} WHERE id = $1`, [id])).length > 0
}
