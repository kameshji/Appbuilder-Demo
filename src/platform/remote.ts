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
import type { AppDef, FxRecord, FxValue } from '@/contracts'
import { PlatformError } from './contracts'
import type {
  AccessScope, AppMeta, AttachmentRef, ColumnAccess, ColumnDef, ConnectionRef, DataErrorEvent, DataFileDef,
  DataOp, PlatformApi, RoleDef, Row, Session, SolutionDef, TableDef, UserDef, WorkspaceState,
} from './contracts'
import { API_BASE, CSRF_HEADER, DEFAULT_ROW_CAP } from './http'
import type {
  ApiError, AppGetResponse, AttachmentResolveResponse, QueryResponse, QueryValue, RowResponse, SourceTableInfo, StatusResponse,
  WorkspaceResponse,
} from './http'
import { rowsToCsv } from './csv'
import { coerceValue, defaultValue, formatDate, isBlankValue, uniqueKey, uuid } from './values'

export interface RemotePlatformOptions {
  /** fetch implementation (default: globalThis.fetch, looked up on each call) */
  fetch?: typeof fetch
  /** clock in ms (default Date.now) */
  now?: () => number
  /** reload loaded tables on window focus when older than this, ms (default 30 000) */
  staleMs?: number
  /** listen to window focus (default: true when a window exists) */
  reloadOnFocus?: boolean
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
    storage: { kind: 'mysql', location: '' },
    apps: [], tables: [], roles: [], users: [], currentUserId: '', connections: [], solutions: [], dataFiles: [],
    dataVersion: 0, loading: [], truncated: [],
  }
  const listeners = new Set<() => void>()
  const errorListeners = new Set<(e: DataErrorEvent) => void>()
  let entries = new Map<string, TableEntry>() // by table id
  let initPromise: Promise<void> | null = null
  let seq = 0

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
  }

  async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, o: CallOptions = {}): Promise<T> {
    let url = API_BASE + path
    if (o.query) {
      const qs = Object.entries(o.query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${enc(k)}=${enc(v as string)}`).join('&')
      if (qs) url += (url.includes('?') ? '&' : '?') + qs
    }
    const headers: Record<string, string> = {}
    let body: BodyInit | undefined
    if (method !== 'GET') headers[CSRF_HEADER] = '1'
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
    try {
      res = await doFetch(url, { method, headers, body, credentials: 'same-origin' })
    } catch {
      throw new PlatformError('unavailable', 'Could not reach the server.')
    }
    if (!res.ok) {
      let code: PlatformError['code'] | undefined
      let message: string | undefined
      let field: string | undefined
      try {
        const b = (await res.json()) as Partial<ApiError>
        if (b && isObj(b.error)) {
          code = b.error.code
          message = b.error.message
          field = b.error.field
        }
      } catch { /* not JSON */ }
      const err = new PlatformError(code ?? codeForStatus(res.status), message ?? `The server answered ${res.status}.`)
      if (field) Object.assign(err, { field })
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
    entries = new Map(state.tables.map((d) => [d.id, newEntry(d)]))
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
  const rowOk = (scope: AccessScope, row: Row | undefined) => scope === 'all' || (scope === 'own' && (!row || row.owner === null || row.owner === undefined || row.owner === meId()))

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
    const name = e.def.name
    if (!o.quiet) setState({ loading: setNames(state.loading, name, true) })
    e.loadPromise = (async () => {
      try {
        for (let attempt = 0; ; attempt++) {
          const epoch = e.epoch
          const res = await call<QueryResponse>('POST', `/data/${enc(name)}/query`, { json: { top: DEFAULT_ROW_CAP } })
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

  function settle(e: TableEntry, op: Op, apply?: () => void) {
    e.ops = e.ops.filter((o) => o !== op)
    if (!isCurrent(e)) return
    if (apply) {
      apply()
      e.epoch++
    }
    recompute(e)
    setState({}, true)
  }
  function rollback(e: TableEntry, op: Op, kind: DataErrorEvent['op'], ids: string[], err: unknown) {
    settle(e, op)
    const error = err instanceof PlatformError ? err : new PlatformError('storage', (err as Error)?.message ?? 'The write failed.')
    if (!firstError) firstError = error
    emitError({ table: e.def.name, op: kind, rowIds: ids, error })
  }

  /* ------------------------------------------------------------------ workspace load */

  function applyWorkspace(ws: WorkspaceResponse, reset = false) {
    if (reset) entries = new Map()
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
    setState({
      session: ws.session, currentUserId: ws.session.user.id, apps: sortApps(ws.apps), tables: sortTables(ws.tables), roles: ws.roles,
      users: ws.users, connections: ws.connections, solutions: ws.solutions, dataFiles: ws.dataFiles ?? [], storage: ws.storage,
      setup: { needsDatabase: false, needsAdmin: false },
      loading: state.loading.filter((n) => names.has(n)), truncated: state.truncated.filter((n) => names.has(n)),
    }, true)
    for (const e of stale) if (e.loaded && isCurrent(e)) load(e, { quiet: true, force: true }).catch(() => {})
  }

  /** signed in with a password an administrator set: only the change-password screen until it is changed */
  function applyPendingSession(session: Session) {
    entries = new Map()
    setState({
      session, currentUserId: session.user.id, apps: [], tables: [], roles: [], users: [], connections: [], solutions: [], dataFiles: [],
      setup: { needsDatabase: false, needsAdmin: false }, loading: [], truncated: [],
    }, true)
  }

  async function loadWorkspace(reset: boolean) {
    let ws: WorkspaceResponse
    try {
      ws = await call<WorkspaceResponse>('GET', '/workspace')
    } catch (e) {
      if (e instanceof PlatformError && e.code === 'password_change_required') {
        applyPendingSession(await call<Session>('GET', '/auth/session'))
        return
      }
      throw e
    }
    applyWorkspace(ws, reset)
  }
  const refresh = () => loadWorkspace(false)

  function clearWorkspace() {
    entries = new Map()
    setState({
      session: null, apps: [], tables: [], roles: [], users: [], connections: [], solutions: [], dataFiles: [], currentUserId: '',
      loading: [], truncated: [],
    }, true)
  }

  async function refreshStatus(): Promise<StatusResponse> {
    const st = await call<StatusResponse>('GET', '/status')
    const setup: WorkspaceState['setup'] = { needsDatabase: !!st.setup?.needsDatabase, needsAdmin: !!st.setup?.needsAdmin }
    if (st.setup?.unavailable) setup.unavailable = true
    if (st.setup?.incompatible) setup.incompatible = true
    // storage details come only to administrators (and with the workspace); keep what we have otherwise
    setState({ setup, ...(st.storage ? { storage: st.storage } : {}) })
    return st
  }

  function init(): Promise<void> {
    if (!initPromise) {
      initPromise = (async () => {
        const st = await refreshStatus()
        if (st.session?.user.mustChangePassword) applyPendingSession(st.session)
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
    setState({}, true)
    enqueue(async () => {
      try {
        const res = await call<RowResponse>('POST', `/data/${enc(def.name)}/rows`, { json: { values: payload } })
        settle(e, op, () => upsertConfirmed(e, rowFromJson(e.def, res.row)))
      } catch (err) {
        rollback(e, op, 'create', [id], err)
      }
    })
    return row
  }

  function updateRow(tableName: string, id: string, changes: FxRecord): Row {
    const e = needEntry(tableName)
    const def = e.def
    const existing = e.rows.find((r) => r.id === id) ?? fail('not-found', `No row with id "${id}" in "${def.displayName}".`)
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
    setState({}, true)
    const optimistic = e.rows.find((r) => r.id === id)!
    enqueue(async () => {
      try {
        const res = await call<RowResponse>('PATCH', `/data/${enc(def.name)}/rows/${enc(id)}`, { json: { changes: payload } })
        settle(e, op, () => {
          const i = e.confirmed.findIndex((r) => r.id === id)
          if (i >= 0) {
            e.confirmed = e.confirmed.slice()
            e.confirmed[i] = rowFromJson(e.def, res.row)
          }
        })
      } catch (err) {
        rollback(e, op, 'update', [id], err)
      }
    })
    return optimistic
  }

  function deleteRows(tableName: string, ids: string[]): void {
    const e = needEntry(tableName)
    const def = e.def
    const g = grantOf(def)
    const known = new Set(e.rows.map((r) => r.id as string))
    const targets = e.loaded ? ids.filter((id) => known.has(id)) : [...ids]
    if (targets.length === 0) return
    if (g.delete === 'none') denied('delete', def)
    for (const id of targets) {
      const row = e.rows.find((r) => r.id === id)
      if (!rowOk(g.delete, row)) denied('delete', def)
    }
    const op: Op = { seq: ++seq, kind: 'delete', ids: new Set(targets) }
    e.ops.push(op)
    recompute(e)
    setState({}, true)
    enqueue(async () => {
      try {
        await call<{ deleted: number }>('POST', `/data/${enc(def.name)}/delete`, { json: { ids: targets } })
        settle(e, op, () => {
          e.confirmed = e.confirmed.filter((r) => !op.ids.has(r.id as string))
        })
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
  const tablesUpdate = ((a: string, b: unknown, c?: FxRecord) => {
    if (typeof b === 'string') return updateRow(a, b, c ?? {})
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
        scheduleLoad(e)
        return []
      }
      return e.rows.slice()
    },
    insert: (tableName, values) => insertRow(tableName, values),
    delete: (tableName, ids) => deleteRows(tableName, ids),

    async reload(tableName) {
      await load(needEntry(tableName), { force: true })
    },
    exportCsv(tableName) {
      const e = needEntry(tableName)
      return rowsToCsv(e.def.columns, e.rows)
    },
    async importCsv(tableName, csvText, mode) {
      const e = needEntry(tableName)
      const res = await call<{ imported: number }>('POST', `/data/${enc(e.def.name)}/import`, { json: { csv: csvText, mode } })
      await load(e, { force: true })
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
    async ensureLoaded(tableNames) {
      const todo: Promise<void>[] = []
      for (const n of tableNames) {
        const e = findEntry(n)
        if (e) todo.push(load(e, e.failed ? { force: true } : {}))
      }
      await Promise.all(todo)
    },
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
      if (session.user.mustChangePassword) applyPendingSession(session)
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
      const ref = await call<AttachmentRef>('POST', '/attachments', {
        query: { table: e?.def.name ?? tableName, column, rowId, name: file.name },
        raw: file,
        contentType: file.type || 'application/octet-stream',
      })
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
    url: (id) => `${API_BASE}/attachments/${enc(id)}`,
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
      const sol = await call<SolutionDef>('POST', '/solutions/import', { json: { yaml: yamlText, ...(opts?.filesAs ? { filesAs: opts.filesAs } : {}) } })
      await refresh()
      return state.solutions.find((s) => s.id === sol.id) ?? sol
    },
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
    connections: connectionsApi,
    solutions: solutionsApi,
  }
}
