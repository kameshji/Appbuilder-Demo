/**
 * "Available offline" tables of an offline-entry app (docs/dev/phone.md "Tables kept on the device"). Pure, tested in
 * phone.test.ts; the download and the store are in offline/index.ts, the offline answers in
 * src/platform/offline-hook.ts (`answerFromSnapshot`).
 *
 *  - `AppDef.offline.tables`: `{ table, filter?, maxRows? }`. Only tables that are data sources of the app count; a
 *    table listed twice counts once (the first entry).
 *  - Row cap: DEFAULT_OFFLINE_ROWS (2,000) when not given, never more than MAX_OFFLINE_ROWS (10,000).
 *  - Filter: a formula condition over the table's columns (`Status <> "Closed"`, `owner = User().Id`); it must run on
 *    the server (delegable). It is compiled with the same translator as every formula (src/fx/query `analyze`); a
 *    filter that cannot be translated keeps the table off the device and says why (never "all rows instead").
 */
import type { FxEngine, FxScope, OfflineTableDef } from '@/contracts'
import { analyze } from '@/fx/query'
import type { ConditionV2, QueryPlan, SchemaInfo } from '@/platform/query'

export const DEFAULT_OFFLINE_ROWS = 2000
export const MAX_OFFLINE_ROWS = 10000
/** rows per download request (the server's page maximum) */
export const DOWNLOAD_PAGE = 500

export interface OfflineTableSpec {
  table: string
  maxRows: number
  filter?: ConditionV2
  /** the maker's filter text (shown; part of the snapshot's identity) */
  filterText?: string
  /** why this table is not kept (an untranslatable filter, an unknown table) */
  error?: string
}

export function clampRows(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : DEFAULT_OFFLINE_ROWS
  return Math.max(1, Math.min(MAX_OFFLINE_ROWS, v))
}

/** the maker's list -> one entry per data-source table, rows clamped (case-insensitive table names) */
export function normalizeOfflineTables(list: OfflineTableDef[] | undefined, dataSources: string[] | undefined): OfflineTableDef[] {
  const sources = new Map((dataSources ?? []).map((s) => [s.toLowerCase(), s]))
  const seen = new Set<string>()
  const out: OfflineTableDef[] = []
  for (const t of list ?? []) {
    if (!t || typeof t.table !== 'string') continue
    const name = sources.get(t.table.trim().toLowerCase())
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    const filter = typeof t.filter === 'string' && t.filter.trim() !== '' ? t.filter.trim() : undefined
    out.push({ table: name, ...(filter ? { filter } : {}), maxRows: clampRows(t.maxRows) })
  }
  return out
}

/** compile one entry: the filter becomes a plan condition, or an error in words */
export function compileOfflineTable(t: OfflineTableDef, schema: SchemaInfo, scope?: FxScope, engine?: FxEngine): OfflineTableSpec {
  const maxRows = clampRows(t.maxRows)
  if (!schema.tables[t.table]) return { table: t.table, maxRows, error: `The table ${t.table} was not found.` }
  const text = t.filter?.trim().replace(/^=/, '') ?? ''
  if (!text) return { table: t.table, maxRows }
  let r
  try {
    r = analyze(`=Filter(${quoteName(t.table)}, ${text})`, schema, { ...(scope ? { scope } : {}), ...(engine ? { engine } : {}) })
  } catch (e) {
    return { table: t.table, maxRows, filterText: text, error: `The offline filter of ${t.table} could not be read: ${e instanceof Error ? e.message : String(e)}` }
  }
  const err = r.diagnostics.find((d) => d.severity === 'error')
  const plan = r.plan
  if (err || !plan || r.residual || plan.table !== t.table || plan.aggregate || plan.select || plan.take || plan.single) {
    const why = err ? err.message : 'it must be a condition the server can run'
    return { table: t.table, maxRows, filterText: text, error: `The offline filter of ${t.table} cannot run on the server (${why}), so ${t.table} is not kept on this device.` }
  }
  return { table: t.table, maxRows, filterText: text, ...(plan.filter ? { filter: plan.filter } : {}) }
}

const quoteName = (n: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`)

/** one download request: the first page asks for the count too */
export function downloadPlan(spec: OfflineTableSpec, loaded: number, cursor?: string): QueryPlan {
  const size = Math.max(1, Math.min(DOWNLOAD_PAGE, spec.maxRows - loaded))
  return { version: 2, table: spec.table, ...(spec.filter ? { filter: spec.filter } : {}), ...(cursor ? {} : { count: true }), page: { size, ...(cursor ? { cursor } : {}) } }
}

/** the plain message when the row cap cut the data (null when everything fits) */
export function capMessage(table: string, kept: number, total: number | undefined): string | null {
  if (total === undefined || total <= kept) return null
  const f = (n: number) => n.toLocaleString('en-US')
  return `Only ${f(kept)} of ${f(total)} rows of ${table} are kept on this device for offline use (the app's limit). Without a connection, lists and lookups of ${table} show only those.`
}

/** "Downloading Customers for offline use: 1,000 of 2,000" */
export function progressText(table: string, loaded: number, target: number | undefined): string {
  const f = (n: number) => n.toLocaleString('en-US')
  return target !== undefined ? `Getting ${table} ready for offline use: ${f(Math.min(loaded, target))} of ${f(target)}` : `Getting ${table} ready for offline use: ${f(loaded)}`
}

/** identity of a snapshot: a changed filter or cap means a new download */
export const specKey = (s: OfflineTableSpec) => `${s.table}|${s.maxRows}|${JSON.stringify(s.filter ?? null)}`
