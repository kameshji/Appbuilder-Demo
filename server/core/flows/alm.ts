/**
 * Flows in solutions (docs/dev/flows.md "ALM"; docs/guide/maker/solutions.md). A package carries, per flow: its id,
 * name, the current definition, enabled, run-as, its connection references (with the connection's id, name and kind in
 * the source) and the roles that may run it.
 *
 * Plan: new / changed / removed by flow id. New flows arrive turned off unless the import names them in `enableFlows`
 * (or `true`); a flow that runs as a service account needs an administrator and the plan's confirmation token; every
 * connection reference must map to a connection of the target (`connectionMap`: source connection id -> target id;
 * defaults: same id, then same name and kind), else the plan has a problem. Apply (inside the solution's transaction):
 * definitions are validated against the target first, then written as new versions; references and run grants mapped;
 * schedules armed for enabled flows only.
 */
import { HttpError } from '../contracts.ts'
import type { Services, UserContext } from '../contracts.ts'
import type { PlanItem } from '../../../src/platform/http.ts'
import { DEFAULT_SETTINGS, type FlowDefinition, type RunAs } from '../../../src/platform/flows.ts'
import type { Flows } from './index.ts'
import type { FlowDoc } from './store.ts'

export interface PkgFlow {
  id: string
  name: string
  description?: string
  runAs: RunAs
  enabled: boolean
  definition: FlowDefinition
  connections: { ref: string; connectionId: string; connectionName?: string; connector?: string }[]
  runRoles: string[]
}

export interface FlowConnectionMapping {
  /** the source connection id (the key of connectionMap) */
  from: string
  fromName?: string
  connector?: string
  /** the flows and references that use it */
  usedBy: { flowId: string; flowName: string; ref: string }[]
  /** the target connection, or null when it must be chosen */
  to: string | null
  candidates: { id: string; name: string }[]
}

export interface FlowPlanOps {
  upsert: { pkg: PkgFlow; existing: boolean; enable: boolean }[]
  remove: string[]
  mapping: Map<string, string>
}

const flowsOf = (s: Services): Flows | undefined => (s as unknown as { flows?: Flows }).flows
const canon = (v: unknown): string => JSON.stringify(v ?? null, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x))
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export async function exportFlows(s: Services, ids: string[]): Promise<PkgFlow[]> {
  const fl = flowsOf(s)
  if (!fl || !ids.length) return []
  const out: PkgFlow[] = []
  for (const id of ids) {
    const f = await fl.store.get(id)
    if (!f) continue
    out.push({
      id: f.id, name: f.name, ...(f.description ? { description: f.description } : {}), runAs: f.runAs, enabled: f.enabled,
      definition: { trigger: f.trigger, steps: f.steps, ...(f.variables ? { variables: f.variables } : {}), settings: f.settings },
      connections: f.connections.map((c) => ({ ref: c.ref, connectionId: c.connectionId, ...(c.connectionName ? { connectionName: c.connectionName } : {}), ...(c.connector ? { connector: c.connector } : {}) })),
      runRoles: await fl.store.grants(f.id),
    })
  }
  return out
}

/** undefined: the package has no flows list (older exports): flows of the solution are left alone */
export function readPkgFlows(v: unknown): PkgFlow[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new HttpError(422, 'invalid', 'The package "flows" must be a list.')
  return v.map((f) => {
    if (!isObj(f) || typeof f.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(f.id) || typeof f.name !== 'string' || !isObj(f.definition)) throw new HttpError(422, 'invalid', 'A flow in the package is malformed.')
    const d = f.definition as Partial<FlowDefinition>
    return {
      id: f.id, name: f.name.slice(0, 100), ...(typeof f.description === 'string' && f.description ? { description: f.description } : {}),
      runAs: (f.runAs ?? 'owner') as RunAs, enabled: f.enabled === true,
      definition: { trigger: d.trigger as FlowDefinition['trigger'], steps: Array.isArray(d.steps) ? d.steps : [], ...(Array.isArray(d.variables) ? { variables: d.variables } : {}), settings: { ...DEFAULT_SETTINGS, ...(isObj(d.settings) ? d.settings : {}) } },
      connections: (Array.isArray(f.connections) ? f.connections : []).filter(isObj).map((c) => ({ ref: String(c.ref ?? ''), connectionId: String(c.connectionId ?? ''), ...(typeof c.connectionName === 'string' ? { connectionName: c.connectionName } : {}), ...(typeof c.connector === 'string' ? { connector: c.connector } : {}) })),
      runRoles: Array.isArray(f.runRoles) ? f.runRoles.map(String) : [],
    }
  })
}

const docOfPkg = (p: PkgFlow): FlowDoc => ({ name: p.name, ...(p.description ? { description: p.description } : {}), runAs: p.runAs, ...p.definition })

/** the flow part of a solution plan (nothing is changed) */
export async function planFlows(s: Services, user: UserContext, pkg: PkgFlow[] | undefined, previous: string[], o: { connectionMap?: Record<string, string>; enableFlows?: boolean | string[] }): Promise<{ items: PlanItem[]; problems: string[]; warnings: string[]; serviceFlows: string[]; connections: FlowConnectionMapping[]; ops: FlowPlanOps; matched: boolean }> {
  const fl = flowsOf(s)
  const items: PlanItem[] = []
  const problems: string[] = []
  const warnings: string[] = []
  const serviceFlows: string[] = []
  const ops: FlowPlanOps = { upsert: [], remove: [], mapping: new Map() }
  let matched = false
  if (!pkg || !fl) {
    if (pkg?.length && !fl) problems.push('Flows are not available on this server.')
    return { items, problems, warnings, serviceFlows, connections: [], ops, matched }
  }
  const conns = await s.meta.connections.list()
  const byConn = new Map<string, FlowConnectionMapping>()
  for (const p of pkg) {
    const existing = await fl.store.get(p.id)
    if (existing) matched = true
    const sameName = !existing ? (await fl.store.byName(p.name)) : null
    if (sameName) problems.push(`A flow named "${p.name}" already exists here with another identity; rename one of them.`)
    const doc = docOfPkg(p)
    const changed = !existing || canon({ ...docOfPkg({ ...p }), connections: p.connections.map((c) => c.ref).sort() }) !== canon({ name: existing.name, ...(existing.description ? { description: existing.description } : {}), runAs: existing.runAs, trigger: existing.trigger, steps: existing.steps, ...(existing.variables ? { variables: existing.variables } : {}), settings: existing.settings, connections: existing.connections.map((c) => c.ref).sort() })
    const enable = existing ? existing.enabled : o.enableFlows === true || (Array.isArray(o.enableFlows) && o.enableFlows.includes(p.id))
    const service = typeof p.runAs === 'object'
    if (service && (!existing || canon(existing.runAs) !== canon(p.runAs))) {
      serviceFlows.push(p.name)
      const sa = await s.meta.users.get((p.runAs as { serviceAccount: string }).serviceAccount)
      if (!sa || sa.kind !== 'service') problems.push(`The flow "${p.name}" runs as a service account that does not exist here.`)
    }
    const notes: string[] = []
    if (!existing) notes.push(enable ? 'arrives turned on' : 'arrives turned off (turn it on after checking it)')
    if (service) notes.push('runs as a service account: ignores the rights of the people who trigger it')
    items.push({ kind: 'flow' as PlanItem['kind'], id: p.id, name: p.name, change: !existing ? 'new' : changed ? 'changed' : 'unchanged', ...(notes.length ? { note: notes.join('; ') } : {}) })
    if (changed || !existing) ops.upsert.push({ pkg: p, existing: !!existing, enable })
    for (const c of p.connections) {
      const m = byConn.get(c.connectionId) ?? { from: c.connectionId, ...(c.connectionName ? { fromName: c.connectionName } : {}), ...(c.connector ? { connector: c.connector } : {}), usedBy: [], to: null, candidates: conns.filter((x) => !c.connector || x.connector === c.connector).map((x) => ({ id: x.id, name: x.name })) }
      m.usedBy.push({ flowId: p.id, flowName: p.name, ref: c.ref })
      byConn.set(c.connectionId, m)
    }
    void doc
  }
  for (const m of byConn.values()) {
    const wanted = o.connectionMap?.[m.from]
    const pick = wanted ? conns.find((x) => x.id === wanted) : conns.find((x) => x.id === m.from) ?? conns.find((x) => x.name.toLowerCase() === (m.fromName ?? '').toLowerCase() && (!m.connector || x.connector === m.connector))
    if (wanted && !pick) problems.push(`connectionMap names ${wanted}, which is not a connection here.`)
    if (pick && m.connector && pick.connector !== m.connector) problems.push(`"${pick.name}" is a ${pick.connector} connection; the flows need a ${m.connector} connection for ${m.fromName ?? m.from}.`)
    m.to = pick?.id ?? null
    if (!pick) problems.push(`Choose the connection that replaces "${m.fromName ?? m.from}" (${m.connector ?? 'connection'}) for ${m.usedBy.map((u) => `${u.flowName} (${u.ref})`).join(', ')}.`)
    else {
      ops.mapping.set(m.from, pick.id)
      // the importer attaches the connections: the same right as attaching one in the designer
      if (!user.privileges.isAdmin) {
        const a = s.actions
        const ok = a ? await a.canUse(user, pick.id).catch(() => false) : false
        if (!ok) problems.push(`You may not attach the connection "${pick.name}" to flows here.`)
      }
    }
  }
  for (const id of previous) {
    if (pkg.some((p) => p.id === id)) continue
    const f = await fl.store.get(id)
    if (!f) continue
    ops.remove.push(id)
    items.push({ kind: 'flow' as PlanItem['kind'], id, name: f.name, change: 'removed', note: 'the flow is deleted (its active runs are cancelled; the run history stays)' })
  }
  if (serviceFlows.length && !user.privileges.isAdmin) problems.push(`The flows ${serviceFlows.join(', ')} run as a service account: only an administrator of this environment can import them.`)
  else if (serviceFlows.length) warnings.push(`The flows ${serviceFlows.join(', ')} run as a service account (they ignore the rights of the people who trigger them): confirm them explicitly.`)
  return { items, problems, warnings, serviceFlows, connections: [...byConn.values()], ops, matched }
}

/** inside the solution's transaction: validate against the target, write versions, map references and grants */
export async function applyFlows(s: Services, user: UserContext, ops: FlowPlanOps, solutionId: string, roleMap: Map<string, string>): Promise<string[]> {
  const fl = flowsOf(s)
  if (!fl) return []
  const ids: string[] = []
  fl.invalidate()
  for (const u of ops.upsert) {
    const p = u.pkg
    const doc = docOfPkg(p)
    const refs = p.connections.map((c) => ({ ref: c.ref, connectionId: ops.mapping.get(c.connectionId) ?? c.connectionId }))
    const withKinds = []
    for (const r of refs) withKinds.push({ ...r, connector: (await s.meta.connections.get(r.connectionId))?.connector ?? '' })
    const problems = (await fl.validate(doc, u.existing ? p.id : null, withKinds)).filter((x) => x.severity === 'error')
    if (problems.length) throw new HttpError(422, 'invalid', `The flow "${p.name}" does not fit this environment: ${problems[0].step ? `step ${problems[0].step}, ` : ''}${problems[0].field ? `${problems[0].field}: ` : ''}${problems[0].message}`)
    if (u.existing) await fl.store.saveVersion(p.id, doc, user.user.id, { note: 'solution import', solutionId })
    else await fl.store.insert({ id: p.id, doc, ownerId: user.user.id, enabled: u.enable, solutionId, by: user.user.id, note: 'solution import' })
    await fl.store.setConnections(p.id, refs.map((r) => ({ ...r, grantedBy: user.user.id })))
    const roles = p.runRoles.map((r) => (r === '*' ? r : roleMap.get(r) ?? r))
    const known = new Set((await s.meta.roles.list()).map((r) => r.id))
    await fl.store.setGrants(p.id, roles.filter((r) => known.has(r)), user.user.id)
    await fl.syncSchedule((await fl.store.get(p.id))!)
    if (typeof p.runAs === 'object') await s.meta.audit({ userId: user.user.id, action: 'flow.run_as_service', details: { flow: p.id, name: p.name, serviceAccount: p.runAs.serviceAccount, via: 'solution', solution: solutionId } })
    ids.push(p.id)
  }
  for (const id of ops.remove) {
    const f = await fl.store.get(id)
    if (!f) continue
    await fl.syncSchedule({ ...f, enabled: false })
    await fl.store.remove(id)
  }
  fl.invalidate()
  return ids
}

/** after the import committed: active runs of removed flows are cancelled */
export async function afterApplyFlows(s: Services, removed: string[], by: string): Promise<void> {
  const fl = flowsOf(s)
  if (!fl || !removed.length) return
  const db = (s as unknown as { state: { db: { query<T>(q: string, p: unknown[]): Promise<T[]> } } }).state.db
  for (const id of removed) {
    const rows = await db.query<{ id: string }>(`SELECT id FROM "${s.environment().schema}"."ab_flow_runs" WHERE flow_id = $1 AND state IN ('queued', 'running', 'waiting')`, [id])
    for (const r of rows) await fl.engine.cancelRun(r.id, by)
  }
}
