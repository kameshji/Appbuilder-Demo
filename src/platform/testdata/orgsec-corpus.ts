/**
 * Loader for the shared organisation-security corpus (orgsec-corpus.json): builds the role, the predicate environment
 * and the expected row ids for one case. Used by the demo-mode / in-memory tests and the PostgreSQL integration test.
 */
import fs from 'node:fs'
import type { AccessScope, RoleDef, RowCondition, ShareDef, TableDef, TablePrivilege } from '../contracts.ts'
import { orgContextFor } from '../orgsec.ts'
import type { OrgDirectory, PredicateEnv, SecOp } from '../orgsec.ts'

export interface CorpusCase {
  name: string
  user: string
  table: string
  op: SecOp
  privilege: Partial<Record<'read' | 'update' | 'delete' | 'share', AccessScope>> & { create?: boolean; rowFilter?: RowCondition[] }
  expect: string[]
}

export interface Corpus {
  departments: OrgDirectory['departments']
  users: OrgDirectory['users']
  teams: OrgDirectory['teams']
  tables: TableDef[]
  rows: Record<string, Record<string, unknown>[]>
  shares: ShareDef[]
  cases: CorpusCase[]
}

const NOW = '2026-11-01T00:00:00.000Z'
export const corpus: Corpus = (() => {
  const c = JSON.parse(fs.readFileSync(new URL('./orgsec-corpus.json', import.meta.url), 'utf8')) as Corpus
  return { ...c, tables: c.tables.map((t) => ({ ...t, createdOn: NOW, modifiedOn: NOW })) }
})()

export const ENV_ID = 'default'
export const directory: OrgDirectory = { departments: corpus.departments, users: corpus.users, teams: corpus.teams }
export const tableByName = (name: string): TableDef => corpus.tables.find((t) => t.name === name)!

export function roleFor(c: CorpusCase): RoleDef {
  const t = tableByName(c.table)
  const p: TablePrivilege = {
    table: t.id, create: !!c.privilege.create, read: c.privilege.read ?? 'none', update: c.privilege.update ?? 'none', delete: c.privilege.delete ?? 'none',
    ...(c.privilege.share ? { share: c.privilege.share } : {}), ...(c.privilege.rowFilter ? { rowFilter: c.privilege.rowFilter } : {}),
  }
  return { id: 'role_case', name: 'Case', privileges: [p], apps: 'all' }
}

/** the predicate environment of a corpus user (organisation sets and shares exactly like the server engine builds them) */
export function envFor(userId: string): PredicateEnv {
  const u = corpus.users.find((x) => x.id === userId)!
  const org = orgContextFor(directory, userId, ENV_ID)
  const principals = new Set([userId, ...org.teams])
  const read: Record<string, string[]> = {}
  const update: Record<string, string[]> = {}
  for (const s of corpus.shares) {
    if (!principals.has(s.principalId)) continue
    ;(read[s.tableId] ??= []).push(s.rowId)
    if (s.access === 'update') (update[s.tableId] ??= []).push(s.rowId)
  }
  return { user: { id: u.id, email: u.email }, org, tables: corpus.tables, sameStore: () => true, shares: { read, update } }
}

/** a row's label in `expect`: its primary column value, or the end of its id */
export function labelOf(table: TableDef, row: Record<string, unknown>): string {
  const p = row[table.primaryColumn]
  return typeof p === 'string' && /^[A-Za-z]/.test(p) && !/^\d{4}-/.test(p) ? p : String(row.id).replace(/^.*-0+/, '')
}

/** typed rows (dates as Date) for the in-memory evaluators */
export function typedRows(name: string): Record<string, unknown>[] {
  const t = tableByName(name)
  return (corpus.rows[name] ?? []).map((r) => {
    const out: Record<string, unknown> = { ...r, __id: r.id }
    for (const c of t.columns) if (c.type === 'date' && typeof r[c.name] === 'string') out[c.name] = new Date(`${r[c.name] as string}T00:00:00.000Z`)
    return out
  })
}
