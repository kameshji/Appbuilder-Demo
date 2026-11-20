/**
 * Lookup labels for lists (DataTable, Gallery, the phone cards) and the Form: the target rows' primary-column values,
 * read through the platform facade (Query v2 in server mode, the same plans run by the reference executor in demo mode,
 * answered from the device for "available offline" tables). Decisions are in lookups.ts (pure, tested).
 *
 *  - Batches: each component asks for the ids it shows that it has not asked for yet, as `id in [...]` plans of up to
 *    200 ids (one request per target table per screenful, never one per row). Identical plans of several components are
 *    one request (the query cache de-duplicates by plan).
 *  - Cache: one label store per signed-in user and table (labelStoreKey), shared by every component; cleared when the
 *    user changes.
 *  - Freshness: a component keeps owning its plans while mounted (at most MAX_PLANS), so when the target table changes
 *    (a save here, a live message from the server) the query cache refetches them and the labels follow.
 *  - Rows the viewer cannot read (or that were deleted) come back as nothing: the store marks them null and the cell
 *    shows a neutral "Not available", never the id.
 *  - Full rows (`full`): a Gallery asks for whole rows so a template's `ThisItem.Customer.City` works in server mode;
 *    src/runtime/data.ts `recordById` reads them through `lookupRowById` and the evaluator re-runs on `lookupRowDep`.
 */
import { useEffect, useReducer, useState, useSyncExternalStore } from 'react'
import { platform } from '@/platform'
import type { Row, TableDef } from '@/platform/contracts'
import type { QueryPlan } from '@/platform/query'
import { labelPlans, labelStoreKey, mergeLabels, missingIds, primaryOf, type LabelEntry } from './lookups'

const MAX_PLANS = 40

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/* ------------------------------------------------------------------ the store */

let storeUser = ''
const labels = new Map<string, Map<string, LabelEntry>>()
const rowsById = new Map<string, Row | null>()
/** id -> the query cache key of the full-row plan that asked for it (the evaluator's dependency) */
const rowKeys = new Map<string, string>()
let version = 0
const listeners = new Set<() => void>()

function userNow(): string {
  return safe(() => platform.getState().session?.user?.id ?? '', '')
}
function checkUser(): void {
  const u = userNow()
  if (u === storeUser) return
  storeUser = u
  labels.clear()
  rowsById.clear()
  rowKeys.clear()
  version++
}
function mapOf(table: string): Map<string, LabelEntry> {
  const k = labelStoreKey(storeUser, table)
  let m = labels.get(k)
  if (!m) labels.set(k, (m = new Map()))
  return m
}
function notify(): void {
  version++
  for (const l of [...listeners]) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** the label of a lookup value: a string, null (not readable / gone) or undefined (not known yet) */
export function lookupLabel(table: string, id: string): LabelEntry | undefined {
  checkUser()
  return labels.get(labelStoreKey(storeUser, table))?.get(id)
}

/** re-render when labels arrive; the number changes whenever the store does */
export function useLabelVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version)
}

/** the picker knows the label of the row just picked: no request, no loading mark */
export function rememberLabel(table: string, id: string, label: string): void {
  checkUser()
  const m = mapOf(table)
  if (m.get(id) === label) return
  m.set(id, label)
  notify()
}

/** a full row fetched for a Gallery (src/runtime/data.ts recordById); undefined when never fetched */
export function lookupRowById(id: string): Row | null | undefined {
  checkUser()
  return rowsById.get(id)
}
/** the evaluator dependency of a lookup row ('q:<key>' is invalidated when that answer changes) */
export function lookupRowDep(id: string): string | undefined {
  return rowKeys.get(id)
}

/* ------------------------------------------------------------------ requests */

export interface LabelRequest {
  /** the target table (name) */
  table: string
  ids: Iterable<unknown>
}

interface Asked { plan: QueryPlan; table: string; ids: string[]; owner: string; key: string }

let ownerSeq = 0

/**
 * Ask for the labels of these lookup values (call it on every render with the ids on screen). Returns nothing: read
 * them with `lookupLabel` (and `useLabelVersion` to re-render).
 */
export function useLookupRequests(requests: LabelRequest[], opts: { full?: boolean } = {}): void {
  const [, bump] = useReducer((x: number) => x + 1, 0)
  // per-instance bookkeeping (mutated in place: what this component asked for, not something it renders)
  const [me] = useState<{ id: string; asked: Asked[]; seen: Map<string, Set<string>>; user: string }>(() => ({ id: `lookup-labels-${++ownerSeq}`, asked: [], seen: new Map(), user: '' }))
  checkUser()
  if (me.user !== storeUser) {
    for (const a of me.asked) safe(() => platform.tables.releaseQuery(a.owner), undefined)
    me.asked = []
    me.seen.clear()
    me.user = storeUser
  }
  for (const r of requests) {
    const def: TableDef | undefined = safe(() => platform.tables.get(r.table), undefined)
    if (!def) continue
    const seen = me.seen.get(def.name) ?? new Set<string>()
    me.seen.set(def.name, seen)
    const ids = missingIds(r.ids, (id) => seen.has(id))
    if (!ids.length) continue
    for (const id of ids) seen.add(id)
    for (const plan of labelPlans(def, ids, opts)) {
      const ids2 = (plan.filter as { value: string[] }).value
      me.asked.push({ plan, table: def.name, ids: ids2, owner: `${me.id}#${me.asked.length}#${ids2[0]}`, key: '' })
    }
  }
  while (me.asked.length > MAX_PLANS) {
    const old = me.asked.shift()!
    safe(() => platform.tables.releaseQuery(old.owner), undefined)
    const seen = me.seen.get(old.table)
    if (seen) for (const id of old.ids) seen.delete(id)
  }
  // read the answers (starts the requests; an answer already cached is used at once)
  let changed = false
  for (const a of me.asked) {
    const st = safe(() => platform.tables.queryState(a.plan, { owner: a.owner }), null)
    if (!st) continue
    a.key = st.key
    const def = safe(() => platform.tables.get(a.table), undefined)
    if (!def) continue
    if (opts.full) for (const id of a.ids) rowKeys.set(id, st.key)
    if (st.status === 'ready') {
      const primary = primaryOf(def)?.name ?? def.primaryColumn
      if (mergeLabels(mapOf(def.name), a.ids, st.rows, primary)) changed = true
      if (opts.full) {
        const got = new Map(st.rows.map((row) => [String(row.__id ?? row.id ?? ''), row]))
        for (const id of a.ids) {
          const row = got.get(id) ?? null
          if (rowsById.get(id) !== row) {
            rowsById.set(id, row)
            changed = true
          }
        }
      }
    } else if (st.status === 'error') {
      // refused (a hidden primary column, no access) or no connection for a table not kept offline: neutral placeholder
      if (mergeLabels(mapOf(def.name), a.ids, [], primaryOf(def)?.name ?? def.primaryColumn)) changed = true
    }
  }
  const keys = me.asked.map((a) => a.key).join('\u0001')
  // other components re-render after this render, not during it
  useEffect(() => {
    if (changed) notify()
  })
  useEffect(() => {
    const mine = new Set(keys.split('\u0001'))
    return safe(() => platform.tables.onQueryChange((ks) => { if (ks.some((k) => mine.has(k))) bump() }), () => {})
  }, [keys])
  useEffect(
    () => () => {
      for (const a of me.asked) safe(() => platform.tables.releaseQuery(a.owner), undefined)
    },
    [me],
  )
}

/** the TableDef of a list's rows: a query result names its table; plain rows are matched by their columns */
export function tableOfRows(rows: Record<string, unknown>[], queryTable?: string): TableDef | undefined {
  if (queryTable) return safe(() => platform.tables.get(queryTable), undefined)
  if (rows.length === 0) return undefined
  return safe(() => {
    const names = new Set(Object.keys(rows[0]!).filter((k) => !k.startsWith('__')))
    if (!names.has('id')) return undefined
    return platform.getState().tables.find((t) => {
      const cols = new Set(t.columns.map((c) => c.name))
      return t.columns.some((c) => c.name === 'id') && [...names].every((n) => cols.has(n))
    })
  }, undefined)
}
