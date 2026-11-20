/**
 * RemotePlatform: PlatformApi over Data API v1 (see http.ts) against the local Node server (later a PHP gateway).
 * Server mode: the server owns rows and rules (RBAC + RLS + CLS); this client keeps a lazy per-table row cache,
 * applies writes optimistically after pre-validating them against the TableDef and the mirrored privileges,
 * and rolls back with a DataErrorEvent when the server refuses. No credentials or tokens are ever stored here
 * (the session is an HttpOnly cookie); secrets typed for connections are sent once and forgotten.
 *
 * Row cache model per table: `confirmed` = what the server last told us; `ops` = optimistic writes that are
 * still in flight; `rows` = confirmed with the ops replayed on top. Success folds the server's answer into
 * `confirmed`, failure just drops the op, so a rollback can never clobber a later write.
 */
import { answerFromSnapshot, backoffMs, isIdempotentRead, isNetworkError, offlineHook, readKey, type Snapshot } from './offline-hook'
import { remoteCollab } from './remote-collab.ts'
import { remoteRecycle, type RecycleBatch } from './recycle-api.ts'
import type { AppDef, FxRecord, FxValue } from '@/contracts'
import { PlatformError } from './contracts'
import { rememberErrorReference } from './errorMessages'
import type {
  AccessScope, AppMeta, AttachmentRef, ColumnAccess, ColumnDef, ConnectionRef, DataErrorEvent, DataFileDef,
  DataOp, PlatformApi, RoleDef, Row, Session, SolutionDef, TableDef, UserDef, WorkspaceState,
  DepartmentDef, ExplainResult, OrgDirectoryInfo, SharesInfo, TeamDef, UserImportResult,
} from './contracts'
import { API_BASE, CSRF_HEADER, DEFAULT_ROW_CAP } from './http'
import type {
  ApiError, AppGetResponse, AttachmentResolveResponse, EnvironmentsResponse, QueryResponse, QueryValue, RowResponse, SourceTableInfo, StatusResponse,
  WorkspaceResponse,
} from './http'
import { rowsToCsv } from './csv'
import {
  environmentHeaders, getRequestEnvironment, pickEnvironment, readSelectedEnvironment, selectEnvironment, setRequestEnvironment, withEnvironment,
  writeSelectedEnvironment,
} from './environments'
import { coerceValue, defaultValue, formatDate, isBlankValue, uniqueKey, uuid } from './values'
import type { QueryPlan, QueryV2Response } from './query'
import { QueryCache, type QueryState } from './query-cache'
import { rowsFromWire } from './query-wire'
import { createRemoteLive } from './remote-live'
import type { RemoteLiveDeps } from './remote-live'
import type { LivePerson } from './live-protocol'

/** tables with at most this many readable rows are held in memory whole (formulas the server can't run work in the browser) */
export const SMALL_TABLE_ROWS = 2000

export interface RemotePlatformOptions {
  /** fetch implementation (default: globalThis.fetch, looked up on each call) */
  fetch?: typeof fetch
  /** clock in ms (default Date.now) */
  now?: () => number
  /** reload loaded tables on window focus when older than this, ms (default 30 000) */
  staleMs?: number
  /** listen to window focus (default: true when a window exists) */
  reloadOnFocus?: boolean
  /** realtime connection (tests inject a fake socket); live: false turns it off */
  live?: RemoteLiveDeps['live'] | false
}

const SIGNED_OUT: UserDef = { id: '', name: 'Signed out', email: '', roleIds: [] }

const fail = (code: PlatformError['code'], message: string): never => {
  throw new PlatformError(code, message)
}
const enc = encodeURIComponent
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/* ------------------------------------------------------------------ JSON <-> typed values */

function parseDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const t = Date.parse(s)
  if (Number.isNaN(t)) return null
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function convertIn(col: ColumnDef, v: QueryValue | undefined): FxValue {
  if (v === null || v === undefined) return null
  switch (col.type) {
    case 'date':
      return typeof v === 'string' ? parseDay(v) : null
    case 'datetime': {
      if (typeof v !== 'string') return null
      // "2026-03-15 10:30:00.000" (no zone) is UTC on the wire
      const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v) ? `${v.replace(' ', 'T')}Z` : /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(v) ? `${v}Z` : v
      const d = new Date(iso)
      return Number.isNaN(d.getTime()) ? null : d
    }
    case 'number':
    case 'decimal':
    case 'currency': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
      return Number.isFinite(n) ? n : null
    }
    case 'boolean':
      return typeof v === 'boolean' ? v : v === 1 || v === '1' || v === 'true' ? true : v === 0 || v === '0' || v === 'false' ? false : null
    default:
      return typeof v === 'string' ? v : String(v)
  }
}

function convertOut(col: ColumnDef, v: FxValue): QueryValue {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : col.type === 'date' ? formatDate(v) : v.toISOString()
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  return null
}

function rowFromJson(def: TableDef, raw: Record<string, QueryValue>): Row {
  const row: FxRecord = {}
  for (const col of def.columns) row[col.name] = convertIn(col, raw[col.name])
  const id = raw.id === null || raw.id === undefined ? '' : String(raw.id)
  row.id = id
  row.__id = id
  return row
}

const codeForStatus = (s: number): PlatformError['code'] =>
  s === 401 ? 'unauthenticated' : s === 403 ? 'denied' : s === 404 ? 'not-found' : s === 405 ? 'method_not_allowed' : s === 409 ? 'conflict'
    : s === 422 || s === 400 ? 'invalid' : s === 429 ? 'rate_limited' : s === 503 ? 'unavailable' : 'storage'

const sortApps = (as: AppMeta[]) => [...as].sort((a, b) => b.modifiedOn.localeCompare(a.modifiedOn) || a.name.localeCompare(b.name))
const sortTables = (ts: TableDef[]) => [...ts].sort((a, b) => a.displayName.localeCompare(b.displayName))

/* ------------------------------------------------------------------ cache structures */

type Op =
  | { seq: number; kind: 'create'; row: Row }
  | { seq: number; kind: 'update'; id: string; changes: FxRecord; at: Date }
  | { seq: number; kind: 'delete'; ids: Set<string> }

interface TableEntry {
  def: TableDef
  confirmed: Row[]
  rows: Row[]
  loaded: boolean
  loadedAt: number
  loadPromise: Promise<void> | null
  scheduled: boolean
  failed: boolean
  /** bumps when a write is confirmed; a load that started before it re-fetches */
  epoch: number
  ops: Op[]
}

const newEntry = (def: TableDef): TableEntry => ({
  def, confirmed: [], rows: [], loaded: false, loadedAt: 0, loadPromise: null, scheduled: false, failed: false, epoch: 0, ops: [],
})

interface Grant {
  create: boolean
  read: AccessScope
  update: AccessScope
  delete: AccessScope
  columns: Record<string, ColumnAccess>
  filtered: boolean
}

/* ------------------------------------------------------------------ the platform */

export function createRemotePlatform(options: RemotePlatformOptions = {}): PlatformApi {
  const nowMs = options.now ?? (() => Date.now())
  const staleMs = options.staleMs ?? 30_000
  const doFetch = (input: string, init: RequestInit): Promise<Response> => (options.fetch ?? globalThis.fetch.bind(globalThis))(input, init)

  let state: WorkspaceState = {
    ready: false, mode: 'server', setup: { needsDatabase: false, needsAdmin: false }, session: null,
    storage: { kind: 'postgres', location: '' },
    apps: [], tables: [], roles: [], users: [], currentUserId: '', connections: [], solutions: [], dataFiles: [],
    dataVersion: 0, loading: [], truncated: [], environments: [], environmentId: '', departments: [], teams: [],
  }
  const listeners = new Set<() => void>()
  const errorListeners = new Set<(e: DataErrorEvent) => void>()
  let entries = new Map<string, TableEntry>() // by table id
  let initPromise: Promise<void> | null = null
  let seq = 0
  /** realtime glue (package H); created at the end of this function */
  let rl: ReturnType<typeof createRemoteLive> | null = null

  const emit = () => {
    for (const l of [...listeners]) {
      try {
        l()
      } catch (e) {
        console.error('[platform] listener failed', e)
      }
    }
  }
  const setState = (patch: Partial<WorkspaceState>, bumpData = false) => {
    state = { ...state, ...patch, dataVersion: bumpData ? state.dataVersion + 1 : state.dataVersion }
    emit()
  }
  const emitError = (e: DataErrorEvent) => {
    for (const l of [...errorListeners]) {
      try {
        l(e)
      } catch (err) {
        console.error('[platform] data error listener failed', err)
      }
    }
  }

  /* ------------------------------------------------------------------ http */

  interface CallOptions {
    json?: unknown
    raw?: BodyInit
    contentType?: string
    query?: Record<string, string | undefined>
    as?: 'json' | 'blob'
    signal?: AbortSignal
  }

  async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, o: CallOptions = {}): Promise<T> {
    let url = API_BASE + path
    if (o.query) {
      const qs = Object.entries(o.query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${enc(k)}=${enc(v as string)}`).join('&')
      if (qs) url += (url.includes('?') ? '&' : '?') + qs
    }
    const headers: Record<string, string> = {}
    let body: BodyInit | undefined
    if (method !== 'GET') {
      headers[CSRF_HEADER] = '1'
      // our own writes come back on the live socket marked `self` (already applied here)
      Object.assign(headers, rl?.liveHeader() ?? {})
    }
    // every request names the environment it works in (the server checks it against the session)
    Object.assign(headers, environmentHeaders())
    if (o.raw !== undefined) {
      body = o.raw
      headers['Content-Type'] = o.contentType ?? 'application/octet-stream'
    } else if (o.json !== undefined) {
      body = JSON.stringify(o.json)
      headers['Content-Type'] = 'application/json'
    } else if (method !== 'GET' && method !== 'DELETE') {
      headers['Content-Type'] = 'application/json'
      body = '{}'
    }
    let res: Response
    // P2-A plant Wi-Fi: reads that change nothing are retried with backoff after a network failure or a 502-504
    // (offline-hook.ts); writes are never retried here (the offline outbox replays them with idempotency keys)
    const retries = isIdempotentRead(method, path) && !o.signal?.aborted ? 2 : 0
    for (let attempt = 0; ; attempt++) {
      try {
        res = await doFetch(url, { method, headers, body, credentials: 'same-origin', signal: o.signal })
      } catch (e) {
        if (o.signal?.aborted) throw e
        const knownOffline = typeof navigator !== 'undefined' && navigator.onLine === false
        if (attempt < retries && !knownOffline) {
          await new Promise((r) => setTimeout(r, backoffMs(attempt + 1)))
          continue
        }
        offlineHook()?.noteNetwork(false)
        throw Object.assign(new PlatformError('unavailable', 'Could not reach the server.'), { network: true })
      }
      if (attempt < retries && (res.status === 502 || res.status === 503 || res.status === 504) && !o.signal?.aborted) {
        await new Promise((r) => setTimeout(r, backoffMs(attempt + 1)))
        continue
      }
      break
    }
    offlineHook()?.noteNetwork(true)
    if (!res.ok) {
      let code: PlatformError['code'] | undefined
      let message: string | undefined
      let field: string | undefined
      let extra: { current?: unknown; changedBy?: unknown } | undefined
      try {
        const b = (await res.json()) as Partial<ApiError> & { current?: unknown; changedBy?: unknown }
        if (b && isObj(b.error)) {
          code = b.error.code
          message = b.error.message
          field = b.error.field
        }
        if (b && (b.current !== undefined || b.changedBy !== undefined)) extra = { current: b.current, changedBy: b.changedBy }
      } catch { /* not JSON */ }
      const err = new PlatformError(code ?? codeForStatus(res.status), message ?? `The server answered ${res.status}.`)
      if (field) Object.assign(err, { field })
      // the server's request id: "Reference: ..." in error toasts and dialogs (support finds it in the log)
      const rid = res.headers?.get?.('x-request-id')
      if (rid) {
        err.requestId = rid
        rememberErrorReference(err.message, rid)
      }
      // 409 version conflict: the row as it is now and who changed it (package H)
      if (extra) Object.assign(err, extra)
      if (res.status === 401 && !path.startsWith('/auth/login')) onUnauthenticated()
      throw err
    }
    if (o.as === 'blob') return (await res.blob()) as T
    if (res.status === 204) return undefined as T
    try {
      return (await res.json()) as T
    } catch {
      throw new PlatformError('storage', 'The server sent an unreadable answer.')
    }
  }

  /** the session ended (cookie expired / signed out elsewhere): drop rows, tell the UI to show the login */
  function onUnauthenticated() {
    if (state.session === null) return
    rl?.stop()
    entries = new Map(state.tables.map((d) => [d.id, newEntry(d)]))
    queries.clear()
    setState({ session: null, loading: [], truncated: [] }, true)
  }

  /* ------------------------------------------------------------------ lookups */

  const findEntry = (nameOrId: string): TableEntry | undefined => {
    const byId = entries.get(nameOrId)
    if (byId) return byId
    let low: TableEntry | undefined
    const lower = nameOrId.toLowerCase()
    for (const e of entries.values()) {
      if (e.def.name === nameOrId) return e
      if (!low && e.def.name.toLowerCase() === lower) low = e
    }
    return low
  }
  const needEntry = (nameOrId: string): TableEntry => findEntry(nameOrId) ?? fail('not-found', `Table "${nameOrId}" was not found.`)
  const isCurrent = (e: TableEntry) => entries.get(e.def.id) === e

  const findColumn = (def: TableDef, name: string): ColumnDef | undefined =>
    def.columns.find((c) => c.name === name) ?? def.columns.find((c) => c.name.toLowerCase() === name.toLowerCase())

  /* ------------------------------------------------------------------ Query v2 cache */

  const queryListeners = new Set<(keys: string[]) => void>()
  const typesOf = (def: TableDef): Record<string, ColumnDef['type']> => {
    const out: Record<string, ColumnDef['type']> = { id: 'text' }
    for (const c of def.columns) out[c.name] = c.type
    return out
  }
  /** pending optimistic writes of a table on top of a query's confirmed rows */
  function overlay(table: string, rows: Row[], plan: QueryPlan, _paged: boolean, complete: boolean): Row[] {
    const e = findEntry(table)
    if (!e || !e.ops.length || plan.aggregate) return rows
    let out = rows
    for (const op of e.ops) {
      if (op.kind === 'update') {
        if (!out.some((r) => r.__id === op.id)) continue
        out = out.map((r) => (r.__id === op.id ? { ...r, ...pickKnown(r, op.changes), ...('modifiedOn' in r ? { modifiedOn: op.at } : {}) } : r))
      } else if (op.kind === 'delete') {
        if (out.some((r) => op.ids.has(String(r.__id)))) out = out.filter((r) => !op.ids.has(String(r.__id)))
      } else if (complete && !plan.filter && !plan.search && !plan.sort?.length && !plan.take && !plan.single && !plan.select) {
        if (!out.some((r) => r.__id === op.row.__id)) out = [...out, op.row]
      }
    }
    return out
  }
  const pickKnown = (row: Row, changes: FxRecord): FxRecord => {
    const o: FxRecord = {}
    for (const [k, v] of Object.entries(changes)) if (k in row) o[k] = v
    return o
  }
  /** P2-A offline entry: answers over tables of offline apps are kept on the device; offline, the last one answers */
  async function cachedRead<T>(path: string, table: string, body: unknown, run: () => Promise<T>, fromSnapshot?: (snap: Snapshot) => T | undefined): Promise<T> {
    const h = offlineHook()
    if (!h) return run()
    const key = readKey(path, body)
    try {
      const res = await run()
      h.storeAnswer(key, table, res)
      return res
    } catch (e) {
      if (isNetworkError(e)) {
        const hit = await h.cachedAnswer(key, table)
        if (hit !== undefined) return hit as T
        // a table kept on the device for offline use ("available offline"): answer from its rows (offline-hook.ts)
        if (fromSnapshot && h.snapshot) {
          const snap = await h.snapshot(table)
          const ans = snap ? fromSnapshot(snap) : undefined
          if (ans !== undefined) return ans
        }
      }
      throw e
    }
  }
  const snapshotAnswer = (plan: QueryPlan) => (snap: Snapshot): QueryV2Response | undefined => {
    const e = findEntry(plan.table)
    return e ? answerFromSnapshot(plan, snap, e.def) : undefined
  }
  const queries = new QueryCache({
    post: (plan, signal) => cachedRead('/query', plan.table, { plan }, () => call<QueryV2Response>('POST', '/query', { json: { plan }, signal }), snapshotAnswer(plan)),
    toRows: (plan, rows) => {
      const e = findEntry(plan.table)
      return rowsFromWire(plan, rows, e ? typesOf(e.def) : {})
    },
    overlay,
    onChange: (keys) => {
      for (const k of keys) {
        const st = queries.byKey(k)
        if (st && st.status === 'ready') {
          noteTruncated(st.plan.table, st)
          // a count of a table came in: small tables are then held in memory whole
          if (isCountPlan(st.plan)) {
            const e = findEntry(st.plan.table)
            if (e && !e.loaded && (st.count ?? Infinity) <= SMALL_TABLE_ROWS) scheduleLoad(e)
          }
        }
      }
      for (const l of [...queryListeners]) {
        try {
          l(keys)
        } catch (err) {
          console.error('[platform] query listener failed', err)
        }
      }
    },
  })
  const countPlan = (def: TableDef): QueryPlan => ({ version: 2, table: def.name, count: true })
  const isCountPlan = (p: QueryPlan) => p.count === true && !p.filter && !p.search && !p.take && !p.aggregate && !p.select && !p.single && !p.sort

  /**
   * How big a table is for the current user (an exact count, cached and refreshed after writes) and whether every row
   * is held in memory. Small tables (at most SMALL_TABLE_ROWS readable rows) are loaded whole on first use, so formulas
   * the server cannot run still work on them (with a Studio warning); larger tables are only ever read through queries.
   */
  function sizeInfo(tableName: string): { rowCount?: number; fullyLoaded: boolean } {
    const e = findEntry(tableName)
    if (!e || !state.session) return { fullyLoaded: false }
    const st = queries.get(countPlan(e.def), { owner: `size:${e.def.id}` })
    const rowCount = st.status === 'ready' || st.refreshing ? st.count : undefined
    const small = rowCount !== undefined && rowCount <= SMALL_TABLE_ROWS
    if (small && !e.loaded) scheduleLoad(e)
    return { rowCount, fullyLoaded: e.loaded && small && !state.truncated.includes(e.def.name) }
  }

  /** capped connectors: the tables whose last v2 answer was truncated (the UI warns) */
  function noteTruncated(table: string, st: QueryState) {
    const name = findEntry(table)?.def.name ?? table
    const on = !!st.truncated
    if (state.truncated.includes(name) !== on) setState({ truncated: setNames(state.truncated, name, on) })
  }
  /** after a confirmed (or refused) write: fold it into cached results, then refetch them in the background */
  function queriesAfterWrite(table: string, w?: Parameters<QueryCache['fold']>[1]) {
    if (w) queries.fold(table, w)
    queries.invalidateTable(table)
  }

  /* ------------------------------------------------------------------ mirrored security (UX only) */

  const meId = () => state.session?.user.id ?? ''

  function grantOf(def: TableDef): Grant {
    const s = state.session
    if (!s) return { create: false, read: 'none', update: 'none', delete: 'none', columns: {}, filtered: false }
    if (s.privileges.isAdmin) return { create: true, read: 'all', update: 'all', delete: 'all', columns: {}, filtered: false }
    const t = s.privileges.tables[def.id]
    return t ? { ...t } : { create: false, read: 'none', update: 'none', delete: 'none', columns: {}, filtered: false }
  }
  const denied = (op: DataOp, def: TableDef): never =>
    fail('denied', `You are not allowed to ${op} rows in "${def.displayName}".`)

  /** own scope can be checked on the client; `all` + RLS filters are left to the server */
  const rowOk = (scope: AccessScope, row: Row | undefined) => scope === 'all' || (scope === 'own' ? (!row || row.owner === null || row.owner === undefined || row.owner === meId()) : scope !== 'none')
  // organisation scopes (team, manager, department ...) depend on the directory: the server decides (filtered is set)

  function can(tableName: string, op: DataOp, row?: Row): boolean {
    const e = findEntry(tableName)
    if (!e) return false
    const g = grantOf(e.def)
    if (op === 'create') return g.create
    return g[op] !== 'none' && rowOk(g[op], row)
  }

  function assertWritable(g: Grant, col: ColumnDef) {
    const a = g.columns[col.name] ?? 'update'
    if (a !== 'update') fail('denied', `${col.displayName} is ${a === 'read' ? 'read-only' : 'not available'}.`)
  }

  /* ------------------------------------------------------------------ row cache */

  function recompute(e: TableEntry) {
    if (!e.ops.length) {
      e.rows = e.confirmed
      return
    }
    let rows = e.confirmed
    for (const op of e.ops) {
      if (op.kind === 'create') {
        if (!rows.some((r) => r.id === op.row.id)) rows = [...rows, op.row]
      } else if (op.kind === 'update') {
        const i = rows.findIndex((r) => r.id === op.id)
        if (i >= 0) {
          rows = rows.slice()
          rows[i] = { ...rows[i], ...op.changes, modifiedOn: op.at }
        }
      } else if (rows.some((r) => op.ids.has(r.id as string))) {
        rows = rows.filter((r) => !op.ids.has(r.id as string))
      }
    }
    e.rows = rows
  }

  const upsertConfirmed = (e: TableEntry, row: Row) => {
    const i = e.confirmed.findIndex((r) => r.id === row.id)
    if (i < 0) e.confirmed = [...e.confirmed, row]
    else {
      e.confirmed = e.confirmed.slice()
      e.confirmed[i] = row
    }
  }

  const setNames = (list: string[], name: string, on: boolean) => (on ? (list.includes(name) ? list : [...list, name].sort()) : list.filter((n) => n !== name))

  function load(e: TableEntry, o: { quiet?: boolean; force?: boolean } = {}): Promise<void> {
    if (e.loadPromise) return e.loadPromise
    if (e.loaded && !o.force) return Promise.resolve()
    rl?.trackTable(e.def.id)
    const name = e.def.name
    if (!o.quiet) setState({ loading: setNames(state.loading, name, true) })
    e.loadPromise = (async () => {
      try {
        for (let attempt = 0; ; attempt++) {
          const epoch = e.epoch
          const res = await cachedRead(`/data/${name}/query`, name, { top: DEFAULT_ROW_CAP }, () => call<QueryResponse>('POST', `/data/${enc(name)}/query`, { json: { top: DEFAULT_ROW_CAP } }), (snap): QueryResponse => ({ rows: snap.rows.slice(0, DEFAULT_ROW_CAP), truncated: snap.partial || snap.rows.length > DEFAULT_ROW_CAP }))
          if (!isCurrent(e)) return
          if (e.epoch !== epoch && attempt < 2) continue // a write finished while we were reading: read again
          e.confirmed = res.rows.map((r) => rowFromJson(e.def, r))
          e.loaded = true
          e.failed = false
          e.loadedAt = nowMs()
          recompute(e)
          setState({ loading: setNames(state.loading, name, false), truncated: setNames(state.truncated, name, !!res.truncated) }, true)
          return
        }
      } catch (err) {
        e.failed = true
        if (isCurrent(e)) setState({ loading: setNames(state.loading, name, false) })
        throw err
      } finally {
        e.loadPromise = null
      }
    })()
    return e.loadPromise
  }

  function scheduleLoad(e: TableEntry) {
    if (e.scheduled || e.loadPromise || e.failed || !state.session) return
    e.scheduled = true
    queueMicrotask(() => {
      e.scheduled = false
      if (isCurrent(e)) load(e).catch(() => {})
    })
  }

  /* ------------------------------------------------------------------ write queue */

  let chain: Promise<void> = Promise.resolve()
  let firstError: PlatformError | null = null
  const enqueue = (fn: () => Promise<void>) => {
    chain = chain.then(fn).then(() => {}, () => {})
  }

  function settle(e: TableEntry, op: Op, apply?: () => void, fold?: Parameters<QueryCache['fold']>[1]) {
    e.ops = e.ops.filter((o) => o !== op)
    if (!isCurrent(e)) return
    if (apply) {
      apply()
      e.epoch++
    }
    recompute(e)
    // cached queries keep the confirmed change, then refetch the server's truth (a refused write simply disappears)
    queriesAfterWrite(e.def.name, apply ? fold : undefined)
    if (apply) refreshRollupsOf(e.def.name)
    setState({}, true)
  }

  /**
   * Rollup columns of other tables that read `child` are updated by the server shortly after a write (job queue):
   * loaded parent tables are read again a little later (the realtime hub, when connected, also refreshes them).
   */
  const rollupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  function refreshRollupsOf(child: string) {
    for (const p of entries.values()) {
      if (!p.loaded || !isCurrent(p)) continue
      if (!p.def.columns.some((c: ColumnDef) => c.computed?.kind === 'rollup' && c.computed.table.toLowerCase() === child.toLowerCase())) continue
      const prev = rollupTimers.get(p.def.name)
      if (prev) clearTimeout(prev)
      const run = (left: number) => rollupTimers.set(p.def.name, setTimeout(() => {
        if (p.loaded && isCurrent(p)) load(p, { quiet: true, force: true }).catch(() => {})
        queriesAfterWrite(p.def.name)
        if (left > 0) run(left - 1)
        else rollupTimers.delete(p.def.name)
      }, left > 0 ? 700 : 2500))
      run(1)
    }
  }
  function rollback(e: TableEntry, op: Op, kind: DataErrorEvent['op'], ids: string[], err: unknown) {
    settle(e, op)
    const error = err instanceof PlatformError ? err : new PlatformError('storage', (err as Error)?.message ?? 'The write failed.')
    if (error.code === 'conflict' && (error as PlatformError & { field?: string }).field === 'modifiedOn') {
      // a stale save: remember who changed the row and fetch its current state (forms show the conflict dialog)
      const by = (error as PlatformError & { changedBy?: LivePerson }).changedBy
      if (by && ids[0]) rl?.noteRowChange(e.def.id, ids[0], by)
      if (e.loaded && isCurrent(e)) load(e, { quiet: true, force: true }).catch(() => {})
    }
    if (!firstError) firstError = error
    emitError({ table: e.def.name, op: kind, rowIds: ids, error })
  }

  /* ------------------------------------------------------------------ workspace load */

  function applyWorkspace(ws: WorkspaceResponse, reset = false) {
    const prevEnvironment = state.environmentId
    if (reset) {
      entries = new Map()
      queries.clear()
    }
    const next = new Map<string, TableEntry>()
    const stale: TableEntry[] = []
    for (const def of ws.tables) {
      const old = entries.get(def.id)
      if (!old) next.set(def.id, newEntry(def))
      else {
        if (JSON.stringify(old.def.columns) !== JSON.stringify(def.columns) || old.def.name !== def.name) stale.push(old)
        old.def = def
        next.set(def.id, old)
      }
    }
    entries = next
    const names = new Set(ws.tables.map((t) => t.name))
    const environments = ws.environments ?? []
    // the workspace belongs to the environment the server answered for (the session's); older servers: this browser's choice
    const environmentId = ws.session.environmentId ?? pickEnvironment(environments, readSelectedEnvironment(ws.session.user.id))?.id ?? ''
    setRequestEnvironment(environments.some((e) => e.id === environmentId) ? environmentId : '')
    if (environmentId) writeSelectedEnvironment(ws.session.user.id, environmentId)
    setState({
      environments, environmentId,
      session: ws.session, currentUserId: ws.session.user.id, apps: sortApps(ws.apps), tables: sortTables(ws.tables), roles: ws.roles,
      users: ws.users, connections: ws.connections, solutions: ws.solutions, dataFiles: ws.dataFiles ?? [], storage: ws.storage,
      setup: { needsDatabase: false, needsAdmin: false },
      loading: state.loading.filter((n) => names.has(n)), truncated: state.truncated.filter((n) => names.has(n)),
    }, true)
    for (const e of stale) if (e.loaded && isCurrent(e)) load(e, { quiet: true, force: true }).catch(() => {})
    for (const e of stale) queries.invalidateTable(e.def.name)
    // realtime: connect once signed in; another environment means other topics
    if (prevEnvironment && prevEnvironment !== environmentId) rl?.envChanged()
    rl?.start()
  }

  /** signed in with a password an administrator set: only the change-password screen until it is changed */
  function applyPendingSession(session: Session) {
    rl?.stop()
    entries = new Map()
    queries.clear()
    setState({
      session, currentUserId: session.user.id, apps: [], tables: [], roles: [], users: [], connections: [], solutions: [], dataFiles: [],
      setup: { needsDatabase: false, needsAdmin: false }, loading: [], truncated: [], environments: [], environmentId: '',
    }, true)
  }

  async function loadWorkspace(reset: boolean) {
    let ws: WorkspaceResponse
    try {
      ws = await call<WorkspaceResponse>('GET', '/workspace')
    } catch (e) {
      if (e instanceof PlatformError && (e.code === 'password_change_required' || e.code === 'mfa_enrolment_required')) {
        applyPendingSession(await call<Session>('GET', '/auth/session'))
        return
      }
      // the environment this page worked in is gone, or the user lost access to it: the server's choice instead
      if (e instanceof PlatformError && ['denied', 'not-found', 'unavailable'].includes(e.code) && getRequestEnvironment()) {
        setRequestEnvironment('')
        ws = await call<WorkspaceResponse>('GET', '/workspace')
        applyWorkspace(ws, true)
        return
      }
      throw e
    }
    applyWorkspace(ws, reset)
    // organisation lists for the admin console and the rule builder (others ask platform.org.directory() on demand)
    if (ws.session.privileges.isAdmin && (reset || !state.departments.length)) await loadOrg()
  }
  const refresh = () => loadWorkspace(false)

  function clearWorkspace() {
    rl?.stop()
    entries = new Map()
    queries.clear()
    setRequestEnvironment('')
    setState({
      session: null, apps: [], tables: [], roles: [], users: [], connections: [], solutions: [], dataFiles: [], currentUserId: '',
      loading: [], truncated: [], environments: [], environmentId: '', departments: [], teams: [],
    }, true)
  }

  async function refreshStatus(): Promise<StatusResponse> {
    const st = await call<StatusResponse>('GET', '/status')
    const setup: WorkspaceState['setup'] = { needsDatabase: !!st.setup?.needsDatabase, needsAdmin: !!st.setup?.needsAdmin }
    if (st.setup?.unavailable) setup.unavailable = true
    if (st.setup?.incompatible) setup.incompatible = true
    if (st.setup?.codeIn) setup.codeIn = st.setup.codeIn
    if (st.setup?.platform) setup.platform = st.setup.platform
    // storage details come only to administrators (and with the workspace); keep what we have otherwise
    setState({ setup, ...(st.storage ? { storage: st.storage } : {}) })
    return st
  }

  function init(): Promise<void> {
    if (!initPromise) {
      initPromise = (async () => {
        const st = await refreshStatus()
        if (st.session?.user.mustChangePassword || st.session?.user.mfaEnrolmentRequired) applyPendingSession(st.session)
        else if (st.session && !st.setup.needsDatabase) {
          try {
            await loadWorkspace(true)
          } catch (e) {
            if (!(e instanceof PlatformError && e.code === 'unauthenticated')) throw e
            setState({ session: null })
          }
        } else setState({ session: null })
        setState({ ready: true })
        if (typeof window !== 'undefined' && options.reloadOnFocus !== false) window.addEventListener('focus', onFocus)
      })().catch((e) => {
        initPromise = null
        throw e
      })
    }
    return initPromise
  }

  function onFocus() {
    if (!state.session) return
    for (const e of entries.values()) {
      if (e.loaded && !e.loadPromise && e.ops.length === 0 && nowMs() - e.loadedAt > staleMs) load(e, { quiet: true, force: true }).catch(() => {})
    }
  }

  /* ------------------------------------------------------------------ rows: pre-validated optimistic writes */

  function checkUnique(col: ColumnDef, value: FxValue, rows: Row[], exceptId?: string) {
    if (!col.unique || value === null) return
    const key = uniqueKey(value)
    for (const r of rows) {
      if (r.id === exceptId) continue
      const other = r[col.name]
      if (other !== null && other !== undefined && uniqueKey(other) === key) {
        fail('invalid', `${col.displayName}: "${String(value instanceof Date ? convertOut(col, value) : value)}" already exists (values must be unique).`)
      }
    }
  }

  function resolveKeys(def: TableDef, values: FxRecord): Map<string, FxValue> {
    const given = new Map<string, FxValue>()
    for (const [k, v] of Object.entries(values)) {
      if (k === '__id') continue
      const col = findColumn(def, k)
      if (!col) fail('invalid', `Column "${k}" does not exist in "${def.displayName}".`)
      given.set(col!.name, v)
    }
    return given
  }

  function insertRow(tableName: string, values: FxRecord): Row {
    const e = needEntry(tableName)
    const def = e.def
    const g = grantOf(def)
    if (!g.create) denied('create', def)
    const given = resolveKeys(def, values)
    const at = new Date(nowMs())
    const payload: Record<string, QueryValue> = {}
    const row: FxRecord = {}
    let id = typeof given.get('id') === 'string' && given.get('id') ? (given.get('id') as string) : ''
    if (id && e.rows.some((r) => r.id === id)) fail('conflict', `A row with id "${id}" already exists.`)
    if (!id) id = uuid()
    for (const col of def.columns) {
      if (col.system) {
        if (col.name === 'id') row.id = id
        else if (col.name === 'createdOn' || col.name === 'modifiedOn') row[col.name] = at
        else row[col.name] = meId()
        continue
      }
      if (col.type === 'autonumber') {
        row[col.name] = null // the server issues the number
        continue
      }
      const writable = (g.columns[col.name] ?? 'update') === 'update'
      let v: FxValue
      if (given.has(col.name)) {
        assertWritable(g, col)
        v = coerceValue(col, given.get(col.name))
        payload[col.name] = convertOut(col, v)
      } else v = writable ? defaultValue(col, at) : null
      if (writable && col.required && isBlankValue(v)) fail('invalid', `${col.displayName} is required.`)
      checkUnique(col, v, e.rows)
      row[col.name] = v
    }
    row.__id = id
    payload.id = id
    const op: Op = { seq: ++seq, kind: 'create', row }
    e.ops.push(op)
    recompute(e)
    queries.opsChanged(def.name)
    setState({}, true)
    // P2-A offline entry: offline (or behind an earlier queued write of this row) the outbox keeps the write
    const queueCreate = () => offlineHook()!.queue({ kind: 'create', table: def.name, rowId: id, values: payload }, {
      done: (res) => {
        const saved = rowFromJson(e.def, (res as RowResponse).row)
        settle(e, op, () => upsertConfirmed(e, saved), { kind: 'create', row: saved })
      },
      fail: (err) => rollback(e, op, 'create', [id], err),
    })
    enqueue(async () => {
      if (offlineHook()?.divert(def.name, id)) return queueCreate()
      try {
        const res = await call<RowResponse>('POST', `/data/${enc(def.name)}/rows`, { json: { values: payload } })
        const saved = rowFromJson(e.def, res.row)
        settle(e, op, () => upsertConfirmed(e, saved), { kind: 'create', row: saved })
      } catch (err) {
        if (isNetworkError(err) && offlineHook()?.accepts(def.name)) return queueCreate()
        rollback(e, op, 'create', [id], err)
      }
    })
    return row
  }

  function updateRow(tableName: string, id: string, changes: FxRecord, opts: { ifVersion?: Date | string | null } = {}): Row {
    const e = needEntry(tableName)
    const def = e.def
    // the full-table cache (small tables) or any query result the row is shown in
    const existing = e.rows.find((r) => r.id === id) ?? queries.findRow(def.name, id) ?? fail('not-found', `No row with id "${id}" in "${def.displayName}".`)
    const g = grantOf(def)
    if (g.update === 'none' || !rowOk(g.update, existing)) denied('update', def)
    const given = resolveKeys(def, changes)
    const typed: FxRecord = {}
    const payload: Record<string, QueryValue> = {}
    for (const [name, raw] of given) {
      const col = findColumn(def, name)!
      if (col.system || col.type === 'autonumber') continue
      assertWritable(g, col)
      const v = coerceValue(col, raw)
      if (col.required && isBlankValue(v)) fail('invalid', `${col.displayName} is required.`)
      checkUnique(col, v, e.rows, id)
      const before = existing![name]
      const same = before instanceof Date && v instanceof Date ? before.getTime() === v.getTime() : before === v || (before == null && v == null)
      if (same) continue
      typed[name] = v
      payload[name] = convertOut(col, v)
    }
    if (Object.keys(typed).length === 0) return existing!
    const op: Op = { seq: ++seq, kind: 'update', id, changes: typed, at: new Date(nowMs()) }
    e.ops.push(op)
    recompute(e)
    queries.opsChanged(def.name)
    setState({}, true)
    const optimistic = e.rows.find((r) => r.id === id) ?? { ...existing!, ...typed, modifiedOn: op.at }
    // a form started from a version of the row: a newer save by someone else answers 409 (the form offers reload / keep mine)
    const ifModifiedOn = opts.ifVersion instanceof Date ? opts.ifVersion.toISOString() : typeof opts.ifVersion === 'string' && opts.ifVersion ? opts.ifVersion : undefined
    const applySaved = (res: RowResponse) => {
      const saved = rowFromJson(e.def, res.row)
      settle(e, op, () => {
        const i = e.confirmed.findIndex((r) => r.id === id)
        if (i >= 0) {
          e.confirmed = e.confirmed.slice()
          e.confirmed[i] = saved
        }
      }, { kind: 'update', row: saved })
    }
    // P2-A offline entry (see insertRow): the version check travels with the queued change
    const queueUpdate = () => offlineHook()!.queue({ kind: 'update', table: def.name, rowId: id, values: payload, ...(ifModifiedOn ? { ifModifiedOn } : {}) }, {
      done: (res) => applySaved(res as RowResponse),
      fail: (err) => rollback(e, op, 'update', [id], err),
    })
    enqueue(async () => {
      if (offlineHook()?.divert(def.name, id)) return queueUpdate()
      try {
        const res = await call<RowResponse>('PATCH', `/data/${enc(def.name)}/rows/${enc(id)}`, { json: { changes: payload, ...(ifModifiedOn ? { ifModifiedOn } : {}) } })
        applySaved(res)
      } catch (err) {
        if (isNetworkError(err) && offlineHook()?.accepts(def.name)) return queueUpdate()
        rollback(e, op, 'update', [id], err)
      }
    })
    return optimistic
  }

  // recycle bin: restores refresh every table they brought rows back to (the live hub tells the other sessions)
  const recycle = remoteRecycle(call, {
    invalidate: (tableIds) => {
      for (const id of tableIds) {
        if (entries.get(id)) invalidateFromRemote(id)
        else queries.invalidateTable(id)
      }
    },
  })

  function deleteRows(tableName: string, ids: string[]): void {
    const e = needEntry(tableName)
    const def = e.def
    const g = grantOf(def)
    const known = new Set(e.rows.map((r) => r.id as string))
    const targets = e.loaded ? ids.filter((id) => known.has(id) || !!queries.findRow(def.name, id)) : [...ids]
    if (targets.length === 0) return
    if (g.delete === 'none') denied('delete', def)
    for (const id of targets) {
      const row = e.rows.find((r) => r.id === id) ?? queries.findRow(def.name, id)
      if (!rowOk(g.delete, row)) denied('delete', def)
    }
    const op: Op = { seq: ++seq, kind: 'delete', ids: new Set(targets) }
    e.ops.push(op)
    recompute(e)
    queries.opsChanged(def.name)
    setState({}, true)
    enqueue(async () => {
      try {
        const res = await call<{ deleted: number; batch?: RecycleBatch | null }>('POST', `/data/${enc(def.name)}/delete`, { json: { ids: targets } })
        // recycle bin: the batch that can undo this delete (the app's Undo toast)
        if (res.batch) {
          recycle.emit({ table: def.name, tableId: def.id, batch: res.batch, keepDays: res.batch.daysLeft })
          // the delete took related rows along (cascade): the other tables this page reads refetch too (the live hub
          // does not push our own changes back to us)
          if (res.batch.rows > targets.length) for (const id of [...entries.keys()]) if (id !== def.id) invalidateFromRemote(id)
        }
        settle(e, op, () => {
          e.confirmed = e.confirmed.filter((r) => !op.ids.has(r.id as string))
        }, { kind: 'delete', ids: op.ids })
      } catch (err) {
        rollback(e, op, 'delete', targets, err)
      }
    })
  }

  /* ------------------------------------------------------------------ API: apps */

  const upsertApp = (meta: AppMeta) =>
    setState({ apps: sortApps(state.apps.some((a) => a.id === meta.id) ? state.apps.map((a) => (a.id === meta.id ? meta : a)) : [...state.apps, meta]) })

  const appsApi: PlatformApi['apps'] = {
    async create(input) {
      const meta = await call<AppMeta>('POST', '/apps', { json: input })
      upsertApp(meta)
      if (input.template === 'sample') await refresh()
      return meta
    },
    async load(id) {
      try {
        const res = await call<AppGetResponse>('GET', `/apps/${enc(id)}`)
        return res.definition as AppDef
      } catch (e) {
        if (e instanceof PlatformError && e.code === 'not-found') return null
        throw e
      }
    },
    async save(id, def) {
      const meta = await call<AppMeta>('PUT', `/apps/${enc(id)}`, { json: { definition: def } })
      upsertApp(meta)
    },
    async rename(id, name) {
      upsertApp(await call<AppMeta>('PATCH', `/apps/${enc(id)}`, { json: { name } }))
    },
    async duplicate(id) {
      const meta = await call<AppMeta>('POST', `/apps/${enc(id)}/duplicate`)
      upsertApp(meta)
      return meta
    },
    async remove(id) {
      await call('DELETE', `/apps/${enc(id)}`)
      await refresh()
    },
    async exportPackage(id, opts) {
      const res = await call<{ yaml: string }>('GET', `/apps/${enc(id)}/package`, { query: { data: opts?.includeData ? '1' : undefined } })
      return res.yaml
    },
    async importPackage(yamlText) {
      const meta = await call<AppMeta>('POST', '/apps/import', { json: { yaml: yamlText } })
      await refresh()
      return meta
    },
  }

  /* ------------------------------------------------------------------ API: tables */

  /**
   * `update` is overloaded in the contract: update(tableId, patch) edits the definition (async),
   * update(tableName, rowId, changes) edits a row (sync, optimistic). Dispatched on the second argument.
   */
  const tablesUpdate = ((a: string, b: unknown, c?: FxRecord, d?: { ifVersion?: Date | string | null }) => {
    if (typeof b === 'string') return updateRow(a, b, c ?? {}, d ?? {})
    return (async () => {
      await call<TableDef>('PATCH', `/tables/${enc(a)}`, { json: b ?? {} })
      await refresh()
    })()
  }) as PlatformApi['tables']['update']

  const tablesApi: PlatformApi['tables'] = {
    update: tablesUpdate,
    async create(input) {
      const def = await call<TableDef>('POST', '/tables', { json: input })
      await refresh()
      return state.tables.find((t) => t.id === def.id) ?? def
    },
    /**
     * `opts.dropSource` (default false): also drop the physical table. The server allows it only for tables Appbuilder
     * created (`def.managed` or a data-file table); a linked table is only unregistered.
     */
    async remove(id: string, opts?: { dropSource?: boolean }) {
      await call('DELETE', `/tables/${enc(id)}`, { query: { dropSource: opts?.dropSource === true ? '1' : undefined } })
      await refresh()
    },
    async addColumn(tableId, col) {
      const def = await call<TableDef>('POST', `/tables/${enc(tableId)}/columns`, { json: col })
      await refresh()
      const named = col.name ? def.columns.find((c) => c.name === col.name) : undefined
      return named ?? [...def.columns].reverse().find((c) => !c.system && c.displayName === col.displayName) ?? def.columns[def.columns.length - 1]
    },
    async updateColumn(tableId, name, patch) {
      await call<TableDef>('PATCH', `/tables/${enc(tableId)}/columns/${enc(name)}`, { json: patch })
      await refresh()
    },
    async removeColumn(tableId, name) {
      await call<TableDef>('DELETE', `/tables/${enc(tableId)}/columns/${enc(name)}`)
      await refresh()
    },
    get(nameOrId) {
      return findEntry(nameOrId)?.def
    },

    rows(tableName) {
      const e = needEntry(tableName)
      if (!e.loaded) {
        // only small tables are ever held whole; sizeInfo() starts the count and schedules the load when small
        sizeInfo(e.def.name)
        return []
      }
      return e.rows.slice()
    },
    insert: (tableName, values) => insertRow(tableName, values),
    delete: (tableName, ids) => deleteRows(tableName, ids),

    async reload(tableName) {
      const e = needEntry(tableName)
      queries.invalidateTable(e.def.name)
      if (e.loaded) await load(e, { force: true })
    },
    exportCsv(tableName) {
      const e = needEntry(tableName)
      return rowsToCsv(e.def.columns, e.rows)
    },
    async importCsv(tableName, csvText, mode) {
      const e = needEntry(tableName)
      const res = await call<{ imported: number }>('POST', `/data/${enc(e.def.name)}/import`, { json: { csv: csvText, mode } })
      queries.invalidateTable(e.def.name)
      if (e.loaded) await load(e, { force: true })
      return res.imported
    },
    async createFromCsv(displayName, csvText) {
      const def = await call<TableDef>('POST', '/tables/from-csv', { json: { displayName, csv: csvText } })
      await refresh()
      return state.tables.find((t) => t.id === def.id) ?? def
    },
    async flush() {
      let seen: Promise<void>
      do {
        seen = chain
        await seen
      } while (seen !== chain)
      const e = firstError
      firstError = null
      if (e) throw e
    },
    /** loads the SMALL tables among these whole (an exact count decides); larger tables are only read through queries */
    async ensureLoaded(tableNames) {
      const todo: Promise<void>[] = []
      for (const n of tableNames) {
        const e = findEntry(n)
        if (!e || !state.session) continue
        todo.push((async () => {
          const st = await queries.fetch(countPlan(e.def), { owner: `size:${e.def.id}` })
          if ((st.count ?? Infinity) <= SMALL_TABLE_ROWS) await load(e, e.failed ? { force: true } : {})
        })().catch(() => {}))
      }
      await Promise.all(todo)
    },
    query: (plan, opts) => {
      track(plan.table)
      return queries.fetch(plan, opts)
    },
    queryState: (plan, opts) => {
      track(plan.table)
      return queries.get(plan, opts)
    },
    loadMore: (key) => queries.loadMore(key),
    releaseQuery: (owner) => queries.release(owner),
    onQueryChange(listener) {
      queryListeners.add(listener)
      return () => {
        queryListeners.delete(listener)
      }
    },
    invalidateQueries: (tableName) => queries.invalidateTable(tableName),
    sizeInfo,
    async listSourceTables(connectionId) {
      const res = await call<{ items: SourceTableInfo[] }>('GET', `/connections/${enc(connectionId)}/source-tables`)
      return res.items
    },
    async linkSourceTable(connectionId, source, input) {
      const def = await call<TableDef>('POST', `/connections/${enc(connectionId)}/link`, { json: { source, ...(input ?? {}) } })
      await refresh()
      return state.tables.find((t) => t.id === def.id) ?? def
    },
    async moveToConnection(tableId, connectionId) {
      const def = await call<TableDef>('POST', `/tables/${enc(tableId)}/move`, { json: { connectionId } })
      await refresh()
      const e = findEntry(def.id)
      if (e?.loaded) await load(e, { quiet: true, force: true }).catch(() => {})
      return state.tables.find((t) => t.id === def.id) ?? def
    },
  }

  /* ------------------------------------------------------------------ API: auth */

  const authApi: PlatformApi['auth'] = {
    async login(email, password) {
      const session = await call<Session>('POST', '/auth/login', { json: { email, password } })
      return authApi.completeSignIn!(session)
    },
    /** a session from another sign-in path (second step, invitation): load the workspace, or only the pending screen */
    async completeSignIn(session) {
      if (session.user.mustChangePassword || session.user.mfaEnrolmentRequired) applyPendingSession(session)
      else await loadWorkspace(true)
      return state.session ?? session
    },
    async logout() {
      try {
        await call('POST', '/auth/logout')
      } finally {
        clearWorkspace()
      }
    },
    async changePassword(current, next) {
      await call('POST', '/auth/password', { json: { current, next } })
      // a forced change is done: now the workspace may load
      if (state.session?.user.mustChangePassword) await loadWorkspace(true)
    },
    async updateProfile(input) {
      const user = await call<UserDef>('PATCH', '/auth/profile', { json: { name: input.name } })
      await refresh()
      return user
    },
    async setupDatabase(input) {
      await call('POST', '/setup/database', { json: input })
      await refreshStatus()
    },
    async setupAdmin(input) {
      const session = await call<Session>('POST', '/setup/admin', { json: input })
      await loadWorkspace(true)
      return state.session ?? session
    },
  }

  /* ------------------------------------------------------------------ API: attachments, files */

  const attachmentsApi: PlatformApi['attachments'] = {
    async upload(tableName, column, rowId, file) {
      const e = findEntry(tableName)
      const table = e?.def.name ?? tableName
      // P2-A offline entry: the file waits in the outbox (after the row it belongs to) and is sent when online
      const queueUpload = () => new Promise<AttachmentRef>((resolve) => {
        offlineHook()!.queue({ kind: 'upload', table, rowId, column, file, fileName: file.name }, { done: () => {}, fail: () => {} })
        resolve({ id: `att_pending_${Date.now().toString(36)}`, fileName: file.name, mime: file.type || 'application/octet-stream', sizeBytes: file.size, url: '' })
      })
      if (offlineHook()?.divert(table, rowId)) return queueUpload()
      let ref: AttachmentRef
      try {
        ref = await call<AttachmentRef>('POST', '/attachments', {
          query: { table, column, rowId, name: file.name },
          raw: file,
          contentType: file.type || 'application/octet-stream',
        })
      } catch (err) {
        if (isNetworkError(err) && offlineHook()?.accepts(table)) return queueUpload()
        throw err
      }
      // the server links the attachment to the cell; mirror that in the cache (single: the id, multiple: appended to the JSON array)
      if (e && isCurrent(e)) {
        const col = findColumn(e.def, column)
        const i = e.confirmed.findIndex((r) => r.id === rowId)
        if (col && i >= 0) {
          const cur = e.confirmed[i][col.name]
          let value: string = ref.id
          if (col.multiple) {
            let ids: string[] = []
            if (typeof cur === 'string' && cur) {
              try {
                const parsed: unknown = JSON.parse(cur)
                ids = Array.isArray(parsed) ? parsed.map(String) : [cur]
              } catch {
                ids = [cur]
              }
            }
            if (!ids.includes(ref.id)) ids.push(ref.id)
            value = JSON.stringify(ids)
          }
          e.confirmed = e.confirmed.slice()
          e.confirmed[i] = { ...e.confirmed[i], [col.name]: value }
          recompute(e)
          setState({}, true)
        }
      }
      return ref
    },
    async resolve(ids) {
      if (ids.length === 0) return []
      const res = await call<AttachmentResolveResponse>('POST', '/attachments/resolve', { json: { ids } })
      return res.items
    },
    url: (id) => withEnvironment(`${API_BASE}/attachments/${enc(id)}`, state.environmentId),
    async remove(id) {
      await call('DELETE', `/attachments/${enc(id)}`)
    },
  }

  const filesApi: PlatformApi['files'] = {
    async add(file, opts) {
      const def = await call<DataFileDef>('POST', '/files', {
        query: { name: file.name, displayName: opts?.displayName }, raw: file, contentType: file.type || 'application/octet-stream',
      })
      await refresh()
      return def
    },
    async replace(fileId, file) {
      const def = await call<DataFileDef>('POST', `/files/${enc(fileId)}/replace`, {
        query: { name: file.name }, raw: file, contentType: file.type || 'application/octet-stream',
      })
      await refresh()
      return def
    },
    download: (fileId) => call<Blob>('GET', `/files/${enc(fileId)}/download`, { as: 'blob' }),
    async remove(fileId, opts) {
      await call('DELETE', `/files/${enc(fileId)}`, { query: { dropTables: opts?.dropTables ? '1' : undefined } })
      await refresh()
    },
  }

  /* ------------------------------------------------------------------ API: security, connections, solutions */

  const securityApi: PlatformApi['security'] = {
    currentUser: () => state.session?.user ?? SIGNED_OUT,
    setCurrentUser() {
      fail('denied', 'Switching users is only available in demo mode. Sign out and sign in as another user.')
    },
    async setPassword(userId, password) {
      await call('POST', `/users/${enc(userId)}/password`, { json: { password } })
      await refresh()
    },
    can,
    canRunApp(appId) {
      const s = state.session
      if (!s) return false
      return s.privileges.isAdmin || s.privileges.apps === 'all' || s.privileges.apps.includes(appId)
    },
    async createRole(input) {
      const role = await call<RoleDef>('POST', '/roles', { json: input })
      await refresh()
      return state.roles.find((r) => r.id === role.id) ?? role
    },
    async updateRole(id, patch) {
      await call<RoleDef>('PATCH', `/roles/${enc(id)}`, { json: patch })
      await refresh()
    },
    async removeRole(id) {
      await call('DELETE', `/roles/${enc(id)}`)
      await refresh()
    },
    async createUser(input) {
      const user = await call<UserDef>('POST', '/users', { json: input })
      await refresh()
      return state.users.find((u) => u.id === user.id) ?? user
    },
    async updateUser(id, patch) {
      await call<UserDef>('PATCH', `/users/${enc(id)}`, { json: patch })
      await refresh()
    },
    async removeUser(id) {
      await call('DELETE', `/users/${enc(id)}`)
      await refresh()
    },
  }

  const environmentsApi: PlatformApi['environments'] = {
    async list() {
      const res = await call<EnvironmentsResponse>('GET', '/environments')
      // the workspace shown stays the current one; the list (names, types, locks) is refreshed
      const id = res.items.some((e) => e.id === state.environmentId) ? state.environmentId : (pickEnvironment(res.items, readSelectedEnvironment(state.currentUserId))?.id ?? '')
      setState({ environments: res.items, environmentId: id })
      return res.items
    },
    current: () => state.environments.find((e) => e.id === state.environmentId) ?? null,
    async select(id) {
      const env = selectEnvironment(state.environments, id, state.currentUserId)
      if (env.id === state.environmentId) return env
      // remembered on the user record, then the whole workspace of that environment is loaded (rows of the old one dropped)
      // without the old environment's header: it may be one the user can no longer enter
      const prev = getRequestEnvironment()
      setRequestEnvironment('')
      try {
        await call('POST', `/environments/${enc(env.id)}/select`)
      } catch (e) {
        setRequestEnvironment(prev)
        throw e
      }
      setRequestEnvironment(env.id)
      setState({ environmentId: env.id, loading: [], truncated: [] })
      await loadWorkspace(true)
      return env
    },
  }

  /* ------------------------------------------------------------------ API: organisation and sharing */

  async function loadOrg() {
    try {
      const o = await call<{ departments: DepartmentDef[]; teams: TeamDef[] }>('GET', '/org')
      setState({ departments: o.departments ?? [], teams: o.teams ?? [] })
    } catch {
      /* an older server, or no access: the organisation stays empty */
    }
  }

  const orgApi: PlatformApi['org'] = {
    refresh: loadOrg,
    async createDepartment(input) {
      const d = await call<DepartmentDef>('POST', '/departments', { json: input })
      await loadOrg()
      await refresh()
      return d
    },
    async updateDepartment(id, patch) {
      await call('PATCH', `/departments/${enc(id)}`, { json: { ...patch, ...('parentId' in patch && !patch.parentId ? { parentId: null } : {}) } })
      await loadOrg()
    },
    async removeDepartment(id) {
      await call('DELETE', `/departments/${enc(id)}`)
      await loadOrg()
      await refresh()
    },
    async createTeam(input) {
      const t = await call<TeamDef>('POST', '/teams', { json: input })
      await loadOrg()
      return t
    },
    async updateTeam(id, patch) {
      await call('PATCH', `/teams/${enc(id)}`, { json: { ...patch, ...('environmentId' in patch && !patch.environmentId ? { environmentId: null } : {}) } })
      await loadOrg()
    },
    async removeTeam(id) {
      await call('DELETE', `/teams/${enc(id)}`)
      await loadOrg()
    },
    async directory() {
      const o = await call<{ users: OrgDirectoryInfo['users']; teams: OrgDirectoryInfo['teams'] }>('GET', '/org')
      return {
        users: (o.users ?? []).filter((u) => (u as { status?: string }).status !== 'disabled').map((u) => ({ id: u.id, name: u.name, email: u.email })),
        teams: (o.teams ?? []).map((t) => ({ id: t.id, code: t.code, name: t.name })),
      }
    },
    async importUsers(csv, commit) {
      const res = await call<UserImportResult>('POST', '/users/import', { json: { csv, commit } })
      if (commit) {
        await refresh()
        await loadOrg()
      }
      return res
    },
    shares: (rowId, table) => call<SharesInfo>('GET', '/shares', { query: { row: rowId, table } }),
    async share(rowId, principal, access, table) {
      await call('POST', '/shares', { json: { row: rowId, principal, access: access ?? 'read', ...(table ? { table } : {}) } })
      return call<SharesInfo>('GET', '/shares', { query: { row: rowId, table } })
    },
    async unshare(rowId, principal, table) {
      await call('POST', '/shares/remove', { json: { row: rowId, principal, ...(table ? { table } : {}) } })
      return call<SharesInfo>('GET', '/shares', { query: { row: rowId, table } }).catch(() => ({ table: table ?? '', row: rowId, sharing: true, canShare: false, canShareUpdate: false, shares: [] }))
    },
    explain: (table, rowId, userId) => call<ExplainResult>('GET', '/security/explain', { query: { table, row: rowId, user: userId } }),
  }

  const connectionsApi: PlatformApi['connections'] = {
    async create(input) {
      const conn = await call<ConnectionRef>('POST', '/connections', { json: input })
      await refresh()
      return state.connections.find((c) => c.id === conn.id) ?? conn
    },
    async update(id, patch) {
      await call<ConnectionRef>('PATCH', `/connections/${enc(id)}`, { json: patch })
      await refresh()
    },
    async remove(id) {
      await call('DELETE', `/connections/${enc(id)}`)
      await refresh()
    },
    async test(id) {
      const res = await call<{ ok: boolean; message: string }>('POST', `/connections/${enc(id)}/test`)
      await refresh().catch(() => {})
      return res
    },
    async setDefault(id) {
      await call<ConnectionRef>('POST', `/connections/${enc(id)}/default`)
      await refresh()
    },
  }

  const solutionsApi: PlatformApi['solutions'] = {
    async create(input) {
      const sol = await call<SolutionDef>('POST', '/solutions', { json: input })
      await refresh()
      return state.solutions.find((s) => s.id === sol.id) ?? sol
    },
    async update(id, patch) {
      await call<SolutionDef>('PATCH', `/solutions/${enc(id)}`, { json: patch })
      await refresh()
    },
    async remove(id) {
      await call('DELETE', `/solutions/${enc(id)}`)
      await refresh()
    },
    async addComponent(id, kind, componentId) {
      await call('POST', `/solutions/${enc(id)}/components`, { json: { kind, id: componentId } })
      await refresh()
    },
    async removeComponent(id, kind, componentId) {
      await call('DELETE', `/solutions/${enc(id)}/components/${enc(kind)}/${enc(componentId)}`)
      await refresh()
    },
    async exportPackage(id, opts) {
      const res = await call<{ yaml: string }>('GET', `/solutions/${enc(id)}/package`, { query: { data: opts?.includeData ? '1' : undefined } })
      return res.yaml
    },
    async importPackage(yamlText, opts) {
      const sol = await call<SolutionDef & { warnings?: string[] }>('POST', '/solutions/import', { json: {
        yaml: yamlText, ...(opts?.filesAs ? { filesAs: opts.filesAs } : {}), ...(opts?.confirm ? { confirm: opts.confirm } : {}), ...(opts?.asCopy ? { asCopy: true } : {}), ...(opts?.proceedWithoutBackup ? { proceedWithoutBackup: true } : {}),
        // P1-E: the mappings chosen on the plan screen (the plan's token covers them)
        ...(opts?.connectionMap ? { connectionMap: opts.connectionMap } : {}), ...(opts?.peopleMap ? { peopleMap: opts.peopleMap } : {}), ...(opts?.enableFlows ? { enableFlows: opts.enableFlows } : {}),
      } })
      await refresh()
      return { ...(state.solutions.find((s) => s.id === sol.id) ?? sol), ...(sol.warnings ? { warnings: sol.warnings } : {}) }
    },
  }

  /* ------------------------------------------------------------------ realtime (package H) */

  /** a table this page reads: its live topic is subscribed (pushes invalidate it) */
  function track(tableName: string) {
    const e = findEntry(tableName)
    if (e) rl?.trackTable(e.def.id)
  }

  /** rows of a table changed elsewhere: cached queries refetch (rows stay visible), the small-table cache reloads */
  function invalidateFromRemote(tableId: string) {
    const e = entries.get(tableId)
    if (!e || !state.session) return
    queries.invalidateTable(e.def.name)
    if (e.loaded && isCurrent(e)) load(e, { quiet: true, force: true }).catch(() => {})
  }

  if (options.live !== false) {
    rl = createRemoteLive({
      call,
      getState: () => state,
      setState: (patch) => setState(patch),
      invalidateTable: invalidateFromRemote,
      invalidateAll: () => {
        for (const id of [...entries.keys()]) invalidateFromRemote(id)
      },
      refreshWorkspace: () => {
        refresh().catch(() => {})
      },
      async checkSession(code) {
        try {
          const s = await call<Session>('GET', '/auth/session')
          if (s.user.mustChangePassword) {
            if (!state.session?.user.mustChangePassword) applyPendingSession(s)
            return false
          }
          return code !== 4403
        } catch {
          return false // a 401 has already switched the page to the sign-in screen
        }
      },
      live: options.live,
    })
  }

  return {
    init,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    apps: appsApi,
    tables: tablesApi,
    auth: authApi,
    onDataError(listener) {
      errorListeners.add(listener)
      return () => {
        errorListeners.delete(listener)
      }
    },
    attachments: attachmentsApi,
    files: filesApi,
    security: securityApi,
    org: orgApi,
    connections: connectionsApi,
    solutions: solutionsApi,
    environments: environmentsApi,
    live: rl ? rl.live : offlineLive(),
    notifications: rl ? rl.notifications : offlineNotifications(),
    recycle: recycle.api,
    // core data model (P0-N): timeline, comments, activities, follow, tags, my tasks, mentions
    collab: remoteCollab(call, {
      invalidate: (tableId) => {
        const e = entries.get(tableId)
        if (e) invalidateFromRemote(tableId)
        else queries.invalidateTable(tableId)
      },
      upload: (tableId, column, rowId, file) => attachmentsApi.upload(tableId, column, rowId, file),
      deleted: (tableId, batch) => recycle.emit({ table: findEntry(tableId)?.def.name ?? tableId, tableId, batch, keepDays: batch.daysLeft }),
    }),
  }
}

/** live: false (tests): a platform without realtime */
function offlineLive(): PlatformApi['live'] {
  return {
    status: () => ({ state: 'off', since: 0 }),
    onStatus: () => () => {},
    subscribe: () => () => {},
    setPresence: () => {},
    lock: async () => ({ ok: true, holder: null, mine: true }),
    lastRowChange: () => null,
    me: () => null,
  }
}
function offlineNotifications(): PlatformApi['notifications'] {
  const no = () => Promise.reject(new PlatformError('unavailable', 'Notifications are not available.'))
  return { list: no, markRead: no, remove: no, settings: no, saveSettings: no, send: no, onNotification: () => () => {} }
}
