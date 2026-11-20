/**
 * Number sequences in solutions (P3 package M1; docs/dev/solution-templates.md "Number sequences"). A new solution
 * component kind, `numberSequence`: a row of the core data model's Number sequences table (sys_number_sequences), by its
 * row id. A package carries the name and the FORMAT only (prefix, suffix, digits, reset rule, description), never the
 * next value: numbering belongs to the environment.
 *
 *  - plan: new / changed (format) / unchanged by id; a sequence of the same name with another identity is a problem (the
 *    template layer avoids it: it reuses a same-named sequence with the same format, else gives the pack's a prefixed name);
 *  - apply (inside the import's transaction): created with NextValue 1, or its format updated; NextValue and the current
 *    period are NEVER written by an upgrade;
 *  - a sequence a newer version no longer has is kept (documents may carry its numbers): never removed by an upgrade.
 */
import type { Services, UserContext } from '../contracts.ts'
import type { TableDef } from '../../../src/platform/contracts.ts'
import type { PlanItem } from '../../../src/platform/http.ts'
import { HttpError } from '../contracts.ts'
import { SYS } from '../../../src/platform/system-tables.ts'

export const SEQUENCE_KIND = 'numberSequence'
export interface PkgSequence { id: string; name: string; prefix?: string; suffix?: string; padding?: number; resetRule?: 'never' | 'yearly' | 'financialYear'; description?: string }
export interface SequenceOps { upsert: { pkg: PkgSequence; existing: boolean }[] }
export interface SequenceRow { id: string; name: string; prefix: string; suffix: string; padding: number; resetRule: string; description: string; nextValue: number }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const RESET = ['never', 'yearly', 'financialYear'] as const
const kind = SEQUENCE_KIND as PlanItem['kind']

export async function sequenceTable(s: Services): Promise<TableDef> {
  const t = await s.meta.tables.get(SYS.sequences)
  if (!t) throw new HttpError(503, 'unavailable', 'The Number sequences table is missing in this environment.')
  return t
}

/** every number sequence of this environment (system context) */
export async function listSequences(s: Services): Promise<SequenceRow[]> {
  const t = await sequenceTable(s)
  const r = await s.data.query(null, t, { top: 5000 })
  return r.rows.map((x) => ({
    id: String(x.id), name: String(x.Name ?? ''), prefix: String(x.Prefix ?? ''), suffix: String(x.Suffix ?? ''), padding: Number(x.Padding ?? 4) || 4,
    resetRule: String(x.ResetRule ?? 'never') || 'never', description: String(x.Description ?? ''), nextValue: Number(x.NextValue ?? 1) || 1,
  }))
}

/** the format of a sequence, comparable between a package and a row */
export const formatOf = (x: { prefix?: string; suffix?: string; padding?: number; resetRule?: string }): string =>
  JSON.stringify([x.prefix ?? '', x.suffix ?? '', Number(x.padding ?? 4) || 4, x.resetRule || 'never'])

export function readPkgSequences(v: unknown): PkgSequence[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new HttpError(422, 'invalid', 'The package "numberSequences" must be a list.')
  return v.map((x) => {
    if (!isObj(x) || typeof x.id !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(x.id) || typeof x.name !== 'string' || !x.name.trim()) throw new HttpError(422, 'invalid', 'A number sequence in the package is malformed.')
    const padding = x.padding === undefined ? undefined : Math.trunc(Number(x.padding))
    if (padding !== undefined && !(padding >= 1 && padding <= 12)) throw new HttpError(422, 'invalid', `The number sequence "${x.name}" has a wrong number of digits.`)
    const resetRule = x.resetRule === undefined ? undefined : String(x.resetRule)
    if (resetRule !== undefined && !(RESET as readonly string[]).includes(resetRule)) throw new HttpError(422, 'invalid', `The number sequence "${x.name}" has an unknown reset rule.`)
    return {
      id: x.id, name: x.name.trim().slice(0, 100),
      ...(typeof x.prefix === 'string' && x.prefix ? { prefix: x.prefix.slice(0, 40) } : {}), ...(typeof x.suffix === 'string' && x.suffix ? { suffix: x.suffix.slice(0, 40) } : {}),
      ...(padding !== undefined ? { padding } : {}), ...(resetRule ? { resetRule: resetRule as PkgSequence['resetRule'] } : {}),
      ...(typeof x.description === 'string' && x.description ? { description: x.description.slice(0, 1000) } : {}),
    }
  })
}

export async function exportSequences(s: Services, ids: string[]): Promise<PkgSequence[]> {
  if (!ids.length) return []
  const rows = (await listSequences(s)).filter((r) => ids.includes(r.id))
  return rows.map((r) => ({ id: r.id, name: r.name, ...(r.prefix ? { prefix: r.prefix } : {}), ...(r.suffix ? { suffix: r.suffix } : {}), padding: r.padding, resetRule: r.resetRule as PkgSequence['resetRule'], ...(r.description ? { description: r.description } : {}) }))
}

export async function planSequences(s: Services, user: UserContext, pkg: PkgSequence[] | undefined, previous: string[]): Promise<{ items: PlanItem[]; problems: string[]; warnings: string[]; ops: SequenceOps; matched: boolean }> {
  const items: PlanItem[] = []
  const problems: string[] = []
  const warnings: string[] = []
  const ops: SequenceOps = { upsert: [] }
  let matched = false
  if (!pkg || (!pkg.length && !previous.length)) return { items, problems, warnings, ops, matched }
  if (pkg.length && !user.privileges.isMaker && !user.privileges.isAdmin) problems.push('Only makers can import number sequences.')
  const rows = await listSequences(s)
  for (const p of pkg) {
    const cur = rows.find((r) => r.id === p.id)
    if (cur) {
      matched = true
      const changed = cur.name !== p.name || formatOf(cur) !== formatOf(p) || cur.description !== (p.description ?? '')
      items.push({ kind, id: p.id, name: p.name, change: changed ? 'changed' : 'unchanged', ...(changed ? { note: `the format changes; the next number here (${cur.nextValue}) stays` } : {}) })
      if (changed) ops.upsert.push({ pkg: p, existing: true })
      continue
    }
    if (rows.some((r) => r.name.toLowerCase() === p.name.toLowerCase())) {
      problems.push(`A number sequence named "${p.name}" already exists here with another identity; rename one of them.`)
      continue
    }
    items.push({ kind, id: p.id, name: p.name, change: 'new', note: `${p.prefix ?? ''}${'0'.repeat(Math.max(0, (p.padding ?? 4) - 1))}1${p.suffix ?? ''} first` })
    ops.upsert.push({ pkg: p, existing: false })
  }
  for (const id of previous) {
    if (pkg.some((p) => p.id === id)) continue
    const cur = rows.find((r) => r.id === id)
    if (cur) warnings.push(`The number sequence "${cur.name}" is no longer part of the solution: it is kept here (documents may carry its numbers).`)
  }
  return { items, problems, warnings, ops, matched }
}

/** inside the import's transaction; never writes NextValue or the current period of an existing sequence */
export async function applySequences(s: Services, userId: string, ops: SequenceOps): Promise<void> {
  if (!ops.upsert.length) return
  const t = await sequenceTable(s)
  for (const u of ops.upsert) {
    const p = u.pkg
    const values = { Name: p.name, Prefix: p.prefix ?? null, Suffix: p.suffix ?? null, Padding: p.padding ?? 4, ResetRule: p.resetRule ?? 'never', Description: p.description ?? null }
    if (u.existing) await s.data.update(null, t, p.id, values)
    else await s.data.insert(null, t, { id: p.id, ...values, NextValue: 1, createdBy: userId, owner: userId })
  }
}

export async function sequenceExists(s: Services, id: string): Promise<boolean> {
  return (await listSequences(s)).some((r) => r.id === id)
}
