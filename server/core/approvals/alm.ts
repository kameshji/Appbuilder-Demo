/**
 * Approval policies in solutions (P1 package C; docs/dev/approvals.md "ALM"). A package carries, per policy: id, name,
 * description and the definition. Approvers travel as references that mean the same in another environment where
 * possible (role:, team:, department:, manager ...); a direct person travels as `user:<email>` (ids differ between
 * installs). The plan lists policies as new / changed / removed and every person they name: found by email in the target,
 * or flagged (`plan.approvalPeople[].to = null`, a warning; the import may map an email to another with `peopleMap`).
 * Requests (pending or decided) are data and never travel; an environment copy copies policies, not requests.
 */
import type { Services, UserContext } from '../contracts.ts'
import type { PlanItem } from '../../../src/platform/http.ts'
import { HttpError } from '../contracts.ts'
import { currentEnvironment } from '../env-context.ts'
import { definitionProblems, parseApproverRef, type ApprovalDefinition } from '../../../src/platform/approvals.ts'

export interface PkgApprovalPolicy { id: string; name: string; description?: string; definition: ApprovalDefinition }
export interface ApprovalPolicyOps { upsert: { pkg: PkgApprovalPolicy; existing: boolean }[]; remove: string[]; peopleMap: Map<string, string> }
export interface ApprovalPeopleMapping { email: string; to: string | null; toName?: string; usedBy: string[] }

type Row = Record<string, unknown>
const q = (id: string): string => `"${id.replace(/"/g, '""')}"`
const T = (t: string): string => `${q(currentEnvironment().schema)}.${q(t)}`
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const canon = (v: unknown): string => JSON.stringify(v ?? null, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x))
const db = (s: Services) => {
  const d = (s as unknown as { state?: { db?: import('../contracts.ts').SqlDb | null } }).state?.db
  if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
  return d
}

/** every approver reference of a definition, with a function to rewrite them */
function mapRefs(def: ApprovalDefinition, fn: (ref: string) => string): ApprovalDefinition {
  const out = structuredClone(def)
  if (out.approvers) out.approvers = out.approvers.map(fn)
  for (const st of out.stages ?? []) st.approvers = st.approvers.map(fn)
  for (const r of out.rules ?? []) r.approvers = r.approvers.map(fn)
  if (out.escalation?.to) out.escalation.to = fn(out.escalation.to)
  return out
}
function refsOf(def: ApprovalDefinition): string[] {
  const all: string[] = []
  mapRefs(def, (r) => { all.push(r); return r })
  return all
}

export async function exportApprovalPolicies(s: Services, ids: string[]): Promise<PkgApprovalPolicy[]> {
  if (!ids.length) return []
  const rows = await db(s).query<Row>(`SELECT * FROM ${T('ab_approval_policies')} WHERE id = ANY($1::text[]) ORDER BY lower(name)`, [ids])
  const users = await s.meta.users.list()
  return rows.map((r) => {
    const def = (typeof r.definition === 'string' ? JSON.parse(r.definition) : r.definition) as ApprovalDefinition
    // people by email (user ids differ between installs)
    const portable = mapRefs(def, (ref) => {
      const p = parseApproverRef(ref)
      if (p?.kind !== 'user') return ref
      const u = users.find((x) => x.id === p.value) ?? users.find((x) => x.email.toLowerCase() === p.value.toLowerCase())
      return u ? `user:${u.email}` : ref
    })
    return { id: String(r.id), name: String(r.name), ...(r.description ? { description: String(r.description) } : {}), definition: portable }
  })
}

/** undefined: the package has no policy list (older exports): the solution's policies are left alone */
export function readPkgApprovalPolicies(v: unknown): PkgApprovalPolicy[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new HttpError(422, 'invalid', 'The package "approvalPolicies" must be a list.')
  return v.map((p) => {
    if (!isObj(p) || typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(p.id) || typeof p.name !== 'string' || !p.name.trim()) throw new HttpError(422, 'invalid', 'An approval policy in the package is malformed.')
    const problems = definitionProblems(p.definition)
    if (problems.length) throw new HttpError(422, 'invalid', `The approval policy "${p.name}" in the package is not valid: ${problems[0].field}: ${problems[0].message}`)
    return { id: p.id, name: p.name.trim().slice(0, 100), ...(typeof p.description === 'string' && p.description ? { description: p.description } : {}), definition: p.definition as ApprovalDefinition }
  })
}

export async function planApprovalPolicies(s: Services, user: UserContext, pkg: PkgApprovalPolicy[] | undefined, previous: string[], o: { peopleMap?: Record<string, string> } = {}): Promise<{ items: PlanItem[]; problems: string[]; warnings: string[]; people: ApprovalPeopleMapping[]; ops: ApprovalPolicyOps; matched: boolean }> {
  const items: PlanItem[] = []
  const problems: string[] = []
  const warnings: string[] = []
  const ops: ApprovalPolicyOps = { upsert: [], remove: [], peopleMap: new Map() }
  let matched = false
  if (!pkg || (!pkg.length && !previous.length)) return { items, problems, warnings, people: [], ops, matched }
  if (!(s as unknown as { state?: { db?: unknown } }).state?.db) {
    problems.push('Approval policies are not available on this server.')
    return { items, problems, warnings, people: [], ops, matched }
  }
  if (pkg.length && !user.privileges.isMaker) problems.push('Only makers can import approval policies.')
  const users = await s.meta.users.list()
  const existing = await db(s).query<Row>(`SELECT * FROM ${T('ab_approval_policies')}`)
  const people = new Map<string, ApprovalPeopleMapping>()
  for (const p of pkg) {
    const cur = existing.find((x) => String(x.id) === p.id)
    if (cur) matched = true
    if (!cur && existing.some((x) => String(x.name).toLowerCase() === p.name.toLowerCase())) problems.push(`An approval policy named "${p.name}" already exists here with another identity; rename one of them.`)
    for (const ref of refsOf(p.definition)) {
      const r = parseApproverRef(ref)
      if (r?.kind !== 'user' || !r.value.includes('@')) continue
      const email = r.value.toLowerCase()
      const m = people.get(email) ?? { email, to: null, usedBy: [] }
      if (!m.usedBy.includes(p.name)) m.usedBy.push(p.name)
      people.set(email, m)
    }
    const changed = !cur || canon({ name: cur.name, description: cur.description ?? undefined, definition: typeof cur.definition === 'string' ? JSON.parse(cur.definition) : cur.definition }) !== canon({ name: p.name, description: p.description, definition: p.definition })
    items.push({ kind: 'approvalPolicy' as PlanItem['kind'], id: p.id, name: p.name, change: !cur ? 'new' : changed ? 'changed' : 'unchanged' })
    if (changed) ops.upsert.push({ pkg: p, existing: !!cur })
  }
  for (const m of people.values()) {
    const wanted = o.peopleMap?.[m.email] ?? o.peopleMap?.[m.email.toLowerCase()]
    const target = users.find((u) => u.email.toLowerCase() === (wanted ?? m.email).toLowerCase())
    m.to = target?.id ?? null
    if (target) {
      m.toName = target.name
      if (wanted) ops.peopleMap.set(m.email, target.email)
    } else {
      if (wanted) problems.push(`peopleMap names ${wanted}, who is not a user here.`)
      warnings.push(`Approval policies name ${m.email}, who has no account here (${m.usedBy.join(', ')}): requests fall back to the requester's manager or an administrator until you map the person or change the policy.`)
    }
  }
  for (const id of previous) {
    if (pkg.some((p) => p.id === id)) continue
    const cur = existing.find((x) => String(x.id) === id)
    if (!cur) continue
    items.push({ kind: 'approvalPolicy' as PlanItem['kind'], id, name: String(cur.name), change: 'removed', note: 'open requests keep their copy of the definition' })
    ops.remove.push(id)
  }
  return { items, problems, warnings, people: [...people.values()], ops, matched }
}

/** inside the import's transaction */
export async function applyApprovalPolicies(s: Services, userId: string, ops: ApprovalPolicyOps, solutionId: string): Promise<void> {
  if (!ops.upsert.length && !ops.remove.length) return
  const d = db(s)
  const at = new Date()
  for (const u of ops.upsert) {
    const def = ops.peopleMap.size ? mapRefs(u.pkg.definition, (ref) => {
      const p = parseApproverRef(ref)
      const to = p?.kind === 'user' ? ops.peopleMap.get(p.value.toLowerCase()) : undefined
      return to ? `user:${to}` : ref
    }) : u.pkg.definition
    await d.exec(
      `INSERT INTO ${T('ab_approval_policies')} (id, name, description, definition, solution_id, created_by, created_on, modified_by, modified_on) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $6, $7)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, definition = EXCLUDED.definition, solution_id = EXCLUDED.solution_id, modified_by = EXCLUDED.modified_by, modified_on = EXCLUDED.modified_on`,
      [u.pkg.id, u.pkg.name, u.pkg.description ?? null, JSON.stringify(def), solutionId, userId, at],
    )
  }
  if (ops.remove.length) await d.exec(`DELETE FROM ${T('ab_approval_policies')} WHERE id = ANY($1::text[])`, [ops.remove])
}
