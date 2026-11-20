/**
 * Lookups that work on real tables (auto apps' main gap, docs/dev/frontend.md "Lookup fields and labels"). Pure: no
 * React, no DOM, no platform access. The picker and the label resolver (lookupLabels.ts) and the server-side list
 * search (src/runtime/delegation.ts) take their decisions here:
 *
 *  - the type-ahead plan of the Form's lookup picker (Query v2, delegable: contains on the target's primary column,
 *    sorted, paged by the query cache);
 *  - label resolution in batches: the ids a list shows become `id in [...]` plans of at most LABEL_BATCH ids, so a
 *    screen of 100 rows costs one request per target table, never one per row;
 *  - what a lookup cell shows: the label, a neutral placeholder for a row the viewer cannot read (or that is gone),
 *    a loading mark while the batch is on its way, nothing for a blank value; never the raw id;
 *  - whether a list may sort by a lookup column (server lists: no, it would sort by id; lists held in the browser:
 *    by label) and the condition that searches a lookup column by its label on the server (`via`).
 */
import type { ColumnDef, ColumnType, Row, TableDef } from '../platform/contracts.ts'
import type { ConditionV2, QueryPlan } from '../platform/query.ts'

/** rows per page of the picker (the query cache pages it; scrolling loads the next page) */
export const PICKER_PAGE = 25
/** ids per label request (the server takes up to 1,000 values in `in`) */
export const LABEL_BATCH = 200
/** a list held in the browser sorts / searches by label only up to this many distinct ids per lookup column */
export const LABEL_SORT_LIMIT = 2000
/** shown instead of a label when the viewer cannot read the row (or it was deleted): neutral, never the id */
export const NOT_AVAILABLE = 'Not available'
/** shown while the label is being fetched */
export const LOADING_MARK = '…'

const TEXT_KEY: ColumnType[] = ['text', 'multiline', 'email', 'url', 'phone', 'choice', 'autonumber']
const NUMBER_KEY: ColumnType[] = ['number', 'decimal', 'currency']

type TargetLike = Pick<TableDef, 'name' | 'primaryColumn' | 'columns'>

/** the target's primary column, when the table has it */
export function primaryOf(target: TargetLike): ColumnDef | undefined {
  return target.columns.find((c) => c.name === target.primaryColumn)
}

/** the primary column can be searched with `contains` (text-like) */
export function searchableByText(target: TargetLike): boolean {
  const p = primaryOf(target)
  return !!p && TEXT_KEY.includes(p.type)
}

/**
 * The picker's server query: the target's primary column (id comes with every row), sorted by it, narrowed by
 * `contains` while the user types. A number primary column is matched exactly when the text is a number. No `page`:
 * the query cache pages it (first page with the exact count).
 */
export function pickerPlan(target: TargetLike, text: string): QueryPlan {
  const p = primaryOf(target)
  const needle = text.trim()
  const plan: QueryPlan = { version: 2, table: target.name }
  if (!p) return plan
  plan.select = [p.name]
  if (TEXT_KEY.includes(p.type)) {
    plan.sort = [{ col: p.name, dir: 'asc' }]
    if (needle) plan.filter = { col: p.name, op: 'contains', value: needle }
  } else if (NUMBER_KEY.includes(p.type)) {
    plan.sort = [{ col: p.name, dir: 'asc' }]
    const n = Number(needle.replace(',', '.'))
    if (needle && Number.isFinite(n)) plan.filter = { col: p.name, op: 'eq', value: n }
  }
  return plan
}

/** distinct, non-blank ids of `values` that `known` does not have yet, sorted (stable batch plans: same ids, same key) */
export function missingIds(values: Iterable<unknown>, known: (id: string) => boolean): string[] {
  const out = new Set<string>()
  for (const v of values) {
    if (typeof v !== 'string') continue
    const id = v.trim()
    if (id && !known(id)) out.add(id)
  }
  return [...out].sort()
}

/** split ids into batches of at most `size` */
export function batches<T>(ids: T[], size = LABEL_BATCH): T[][] {
  const out: T[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

/**
 * The label requests for these ids: one `id in [...]` plan per batch. `full` asks for every column the viewer may read
 * (a Gallery template reading `ThisItem.Customer.City`); otherwise only the primary column.
 */
export function labelPlans(target: TargetLike, ids: string[], opts: { full?: boolean } = {}): QueryPlan[] {
  const p = primaryOf(target)
  return batches(ids).map((chunk) => ({
    version: 2 as const,
    table: target.name,
    filter: { col: 'id', op: 'in' as const, value: chunk },
    ...(!opts.full && p ? { select: [p.name] } : {}),
  }))
}

/** a label of a primary-column value (dates as yyyy-mm-dd, a blank primary as "(blank)") */
export function labelText(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(blank)'
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
  }
  if (typeof v === 'object') return '(blank)'
  return String(v)
}

/** what the label store holds per id: the label, or null when the viewer cannot read the row (or it is gone) */
export type LabelEntry = string | null

/**
 * Fold one answer into a label map: every returned row gets its label; every asked id that did not come back is null
 * (not readable, deleted). Returns whether anything changed.
 */
export function mergeLabels(map: Map<string, LabelEntry>, asked: string[], rows: Row[], primary: string): boolean {
  let changed = false
  const got = new Set<string>()
  for (const r of rows) {
    const id = String(r.__id ?? r.id ?? '')
    if (!id) continue
    got.add(id)
    const label = labelText(r[primary])
    if (map.get(id) !== label) {
      map.set(id, label)
      changed = true
    }
  }
  for (const id of asked) {
    if (got.has(id) || map.get(id) === null) continue
    map.set(id, null)
    changed = true
  }
  return changed
}

export type LookupCellState = 'blank' | 'loading' | 'label' | 'missing'
export interface LookupCell { state: LookupCellState; text: string }

/** what a lookup cell shows for a value and what the store knows about it */
export function lookupCell(value: unknown, entry: LabelEntry | undefined): LookupCell {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) return { state: 'blank', text: '' }
  if (entry === undefined) return { state: 'loading', text: LOADING_MARK }
  if (entry === null) return { state: 'missing', text: NOT_AVAILABLE }
  return { state: 'label', text: entry }
}

/** the text a lookup cell contributes to a search or a sort held in the browser (placeholders count as blank) */
export function lookupSortText(value: unknown, entry: LabelEntry | undefined): string {
  const c = lookupCell(value, entry)
  return c.state === 'label' ? c.text : ''
}

/** partition of the label store: labels belong to the signed-in user (their row access) and a table */
export function labelStoreKey(userId: string, table: string): string {
  return `${userId}\u0001${table.toLowerCase()}`
}

/**
 * May a list sort by this lookup column? A list paged from the server cannot (the server would order by the row id,
 * not by what the user sees); a list held in the browser sorts by label when it holds few enough distinct ids.
 */
export function lookupSort(server: boolean, header: string, distinctIds: number): { sortable: boolean; reason?: string } {
  if (server) return { sortable: false, reason: `Sorting by ${header} is not available here: the server would order the rows by record id, not by the names you see.` }
  if (distinctIds > LABEL_SORT_LIMIT) return { sortable: false, reason: `Sorting by ${header} is not available: too many different records (${distinctIds.toLocaleString('en-US')}).` }
  return { sortable: true }
}

/**
 * Server-side search of a lookup column by its label: the row's lookup points at a row of the target whose primary
 * column contains the text (Query v2 lookup path, docs/dev/query-v2.md 4c). Null when the target's primary column is
 * not text (then the column is left out of the search rather than matched by id).
 */
export function lookupSearchCondition(col: string, target: TargetLike, text: string): ConditionV2 | null {
  const p = primaryOf(target)
  if (!p || !TEXT_KEY.includes(p.type)) return null
  return { via: { col, table: target.name, where: { col: p.name, op: 'contains', value: text } } }
}

/** the picker's empty / error line, in plain words; null when rows are shown */
export function pickerMessage(o: {
  status: 'loading' | 'ready' | 'error'
  rows: number
  search: string
  table: string
  /** the error was "no connection" (the browser or the last request had no answer) */
  offline?: boolean
  errorMessage?: string
}): string | null {
  if (o.status === 'error') {
    if (o.offline) return `${o.table} is not available offline. Connect to pick a record.`
    return `Could not load ${o.table}: ${o.errorMessage || 'the server did not answer'}.`
  }
  if (o.status === 'loading') return o.rows ? null : 'Searching…'
  if (o.rows > 0) return null
  const s = o.search.trim()
  return s ? `No ${o.table} match "${s}".` : `${o.table} has no records you can pick yet.`
}

/** the line under the picker's rows: how many of how many, while more exist */
export function pickerNote(shown: number, count: number | undefined, hasMore: boolean): string | null {
  if (!hasMore || count === undefined || count <= shown) return null
  return `${shown.toLocaleString('en-US')} of ${count.toLocaleString('en-US')}: scroll or type to narrow`
}

/** is this error a missing connection (no answer at all) rather than a refusal */
export function isNoConnection(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const x = e as { network?: unknown; code?: unknown; message?: unknown }
  return x.network === true || (x.code === 'unavailable' && /reach the server/i.test(String(x.message ?? '')))
}
