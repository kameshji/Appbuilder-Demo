/**
 * Offline entry, wired into the server-mode platform (P2-A, docs/dev/phone.md "Offline entry").
 *
 *  - Which tables: the data sources of the open apps that have "Works offline (entry)" on (registerOfflineApp, called
 *    by RunApp). Writes to other tables behave exactly as before (no hook involvement).
 *  - The key (keyring): a random device id (localStorage, not secret) is sent to POST /api/v1/offline/key; the answer
 *    (key + epoch) is kept in memory and in sessionStorage only. One IndexedDB database per user. A stored epoch that
 *    differs from the server's (an administrator or the user wiped device data) or a check record that does not decrypt
 *    deletes the local store before anything else happens.
 *  - Outbox (outbox.ts) and read cache: answers of queries over offline tables are sealed into the `cache` store
 *    (least recently used beyond 25 MB are evicted) and answer the same request when the server cannot be reached.
 *  - Replay: when the connection returns (connectivity.ts), after a queued write while online, and every 30 s while
 *    items wait.
 *  - "Available offline" tables (tables.ts): downloaded as the signed-in user through POST /api/v1/query up to their row
 *    cap, sealed into `cache` (same budget), and given to remote.ts (`snapshot`) to answer plans offline.
 *  - Form drafts (drafts.ts, Form.tsx): sealed into `meta` under `draft:<key>`, with their files.
 *  - Sign-out (beforeSignOut) and wipe (wipeDeviceData) delete the user's database and the session key, and ask the
 *    service worker to drop its caches (kept rows and drafts go with the database).
 */
import { create } from 'zustand'
import { platform } from '@/platform'
import { getRequestEnvironment } from '@/platform/environments'
import { setOfflineHook, type OfflineHook, type QueuedWrite, type QueueCallbacks } from '@/platform/offline-hook'
import { CSRF_HEADER, ENVIRONMENT_HEADER } from '@/platform/http'
import { codecFor, type Codec, type Sealed } from './codec'
import { openKV, type KV } from './kv'
import { Outbox, type ItemView, type SendRequest, type SendResult } from './outbox'
import { onBackOnline, report, useConnectivity } from '../connectivity'
import { capMessage, downloadPlan, specKey, type OfflineTableSpec } from './tables'
import type { QueryValue } from '@/platform/http'
import type { QueryPlan, QueryV2Response } from '@/platform/query'
import type { Snapshot } from '@/platform/offline-hook'

const DEVICE_KEY = 'appbuilder-device-id'
const sessionKeyName = (userId: string) => `appbuilder-offline-key:${userId}`
export const CACHE_CAP_BYTES = 25 * 1024 * 1024

/* ------------------------------------------------------------------ UI state */

export interface OfflineUiState {
  /** the outbox items (metadata always; details when unlocked) */
  items: ItemView[]
  unlocked: boolean
  /** an offline app is open (the indicator and banner show) */
  active: boolean
  lastError: string | null
  /** last message for a toast: "Saved on this phone ..." */
  notice: { id: number; text: string } | null
  /** "available offline" tables: download progress and what is kept (tables.ts) */
  tables: Record<string, TableSync>
  /** a plain message when a row cap cut a table, or a table could not be kept (dismissible) */
  tableNotice: string | null
}
export interface TableSync {
  table: string
  state: 'loading' | 'ready' | 'error' | 'skipped'
  loaded: number
  total?: number
  /** rows kept on the device */
  kept?: number
  at?: number
  message?: string
}
export const useOffline = create<OfflineUiState>(() => ({ items: [], unlocked: false, active: false, lastError: null, notice: null, tables: {}, tableNotice: null }))

/* ------------------------------------------------------------------ registry of offline apps */

const apps = new Map<string, { sources: string[]; tables: OfflineTableSpec[] }>()
const tablesLower = () => new Set([...apps.values()].flatMap((a) => a.sources).map((t) => t.toLowerCase()))
let offlineTables = new Set<string>()

/**
 * an offline-entry app opened (RunApp): its data sources become offline tables; `tables` (compiled from
 * AppDef.offline.tables, tables.ts) are downloaded for offline use when the device is online
 */
export function registerOfflineApp(appId: string, dataSources: string[], tables: OfflineTableSpec[] = []): () => void {
  apps.set(appId, { sources: dataSources, tables })
  offlineTables = tablesLower()
  useOffline.setState({ active: true })
  void ensureStarted().then(() => (tables.length ? syncTables(appId) : undefined))
  return () => {
    apps.delete(appId)
    offlineTables = tablesLower()
    useOffline.setState({ active: apps.size > 0 || (current?.outbox.count ?? 0) > 0 })
  }
}
export const isOfflineTable = (t: string) => offlineTables.has(t.toLowerCase())

/* ------------------------------------------------------------------ per-user store */

interface CacheEntry {
  table: string
  bytes: number
  at: number
  /** the rows of an "available offline" table (evicted after plain answers) */
  snap?: true
}
interface UserStore {
  userId: string
  kv: KV
  outbox: Outbox
  codec: Codec | null
  cacheIndex: Map<string, CacheEntry>
}
let current: UserStore | null = null
let starting: Promise<UserStore | null> | null = null

export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      const b = new Uint8Array(16)
      crypto.getRandomValues(b)
      id = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
      localStorage.setItem(DEVICE_KEY, id)
    }
    return id
  } catch {
    return 'nostorage0'
  }
}

function sessionUserId(): string | null {
  const st = platform.getState()
  return st.mode === 'server' && st.session ? st.session.user.id : null
}

/**
 * The open store, only while it belongs to the person signed in now (P2 security re-check, finding P2-2). Another person
 * can sign in on the same page without a reload (after a session ran out, or a sign-out that did not go through
 * beforeSignOut): the previous person's store must then never answer reads, take writes or replay its outbox, because
 * the requests would carry the new person's session.
 */
function mine(): UserStore | null {
  const s = current
  const uid = sessionUserId()
  return s && uid && s.userId === uid ? s : null
}

/** the signed-in person changed (or signed out): forget the previous store's key; its sealed data stays on the device */
function lockForeignStore(): void {
  const s = current
  if (!s || s.userId === sessionUserId()) return
  note('locked: the signed-in user changed')
  current = null
  snapMemo.clear()
  syncGen.clear()
  try {
    sessionStorage.removeItem(sessionKeyName(s.userId))
  } catch {
    /* no session storage */
  }
  s.codec = null
  void s.outbox.setCodec(null).catch(() => {})
  useOffline.setState({ items: [], unlocked: false, active: apps.size > 0, tables: {}, tableNotice: null })
}

/** the record key of a kept answer: keyed (never the request text in clear) and per environment */
const answerKey = async (s: UserStore, key: string): Promise<string> => `a:${await s.codec!.name(`${getRequestEnvironment()}\u0000${key}`)}`

async function fetchKey(userId: string): Promise<{ key: string; epoch: number } | null> {
  try {
    const cached = sessionStorage.getItem(sessionKeyName(userId))
    if (cached) return JSON.parse(cached) as { key: string; epoch: number }
  } catch {
    /* no session storage */
  }
  try {
    const res = await fetch('/api/v1/offline/key', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: '1' },
      body: JSON.stringify({ deviceId: deviceId() }),
    })
    if (!res.ok) return null
    const k = (await res.json()) as { key: string; epoch: number }
    try {
      sessionStorage.setItem(sessionKeyName(userId), JSON.stringify(k))
    } catch {
      /* memory only */
    }
    return k
  } catch {
    return null
  }
}

/** open (or reuse) the store of the signed-in user; unlock it when the key can be had */
async function ensureStarted(): Promise<UserStore | null> {
  const userId = sessionUserId()
  if (!userId) return null
  if (current && current.userId === userId) {
    if (!current.codec) await unlock(current)
    return current
  }
  starting ??= (async () => {
    const kv = openKV(userId)
    const outbox = new Outbox(kv, { send })
    const store: UserStore = { userId, kv, outbox, codec: null, cacheIndex: new Map() }
    // the UI shows the outbox of the person signed in only (a locked store of someone else says nothing)
    outbox.subscribe(() => {
      if (current !== store || store.userId !== sessionUserId()) return
      useOffline.setState({ items: outbox.list(), unlocked: outbox.unlocked, active: apps.size > 0 || outbox.count > 0 })
    })
    outbox.onSent = (item, _res, settled) => {
      note(`sent ${item.kind} ${item.table}${settled ? '' : ' (after restart)'}`)
      if (settled) return
      try {
        platform.tables.invalidateQueries(item.table)
        void platform.tables.reload(item.table).catch(() => {})
      } catch {
        /* table gone */
      }
    }
    await outbox.load()
    const idx = await kv.get<Array<[string, CacheEntry]>>('meta', 'cache-index')
    store.cacheIndex = new Map(idx ?? [])
    current = store
    useOffline.setState({ items: outbox.list(), unlocked: outbox.unlocked, active: apps.size > 0 || outbox.count > 0 })
    await unlock(store)
    return store
  })().finally(() => {
    starting = null
  })
  return starting
}

async function unlock(store: UserStore): Promise<void> {
  const k = await fetchKey(store.userId)
  if (!k) return
  try {
    const codec = await codecFor(k.key)
    const epoch = await store.kv.get<number>('meta', 'epoch')
    const check = await store.kv.get<Sealed>('meta', 'check')
    let ok = epoch === undefined || epoch === k.epoch
    if (ok && check) {
      try {
        ok = (await codec.open<string>(check)) === 'appbuilder-offline'
      } catch {
        ok = false
      }
    }
    if (!ok) {
      // wiped (epoch raised) or another key: the old data can never be read again; delete it
      note('wiped: epoch or key changed')
      await store.kv.destroy()
      store.outbox.reset()
      store.cacheIndex.clear()
      snapMemo.clear()
      useOffline.setState({ tables: {}, tableNotice: null })
      useOffline.setState({ lastError: 'The offline data on this device was wiped (an administrator or you asked for it).' })
    }
    await store.kv.put('meta', 'epoch', k.epoch)
    await store.kv.put('meta', 'check', await codec.seal('appbuilder-offline'))
    // answers kept by an older version under the request text in clear: drop them (the text held filter values)
    const legacy = [...store.cacheIndex.keys()].filter((x) => !x.startsWith('a:') && !x.startsWith('snap:'))
    for (const x of legacy) {
      store.cacheIndex.delete(x)
      await store.kv.delete('cache', x)
    }
    if (legacy.length) await store.kv.put('meta', 'cache-index', [...store.cacheIndex.entries()])
    store.codec = codec
    await store.outbox.setCodec(codec)
    if (useConnectivity.getState().status === 'online') void replay()
  } catch (e) {
    useOffline.setState({ lastError: e instanceof Error ? e.message : String(e) })
  }
}

/* ------------------------------------------------------------------ transport (the outbox's sends) */

async function send(r: SendRequest): Promise<SendResult> {
  const { item, body } = r
  const headers: Record<string, string> = { [CSRF_HEADER]: '1', 'Idempotency-Key': r.idempotencyKey }
  if (item.environmentId) headers[ENVIRONMENT_HEADER] = item.environmentId
  const t = encodeURIComponent(item.table)
  let url: string
  let init: RequestInit
  if (item.kind === 'create') {
    url = `/api/v1/data/${t}/rows`
    init = { method: 'POST', body: JSON.stringify({ values: body.values ?? {}, ...(body.form ? { form: body.form } : {}) }) }
    headers['Content-Type'] = 'application/json'
  } else if (item.kind === 'update') {
    url = `/api/v1/data/${t}/rows/${encodeURIComponent(item.rowId)}`
    init = { method: 'PATCH', body: JSON.stringify({ changes: body.values ?? {}, ...(body.ifModifiedOn ? { ifModifiedOn: body.ifModifiedOn } : {}), ...(body.form ? { form: body.form } : {}) }) }
    headers['Content-Type'] = 'application/json'
  } else {
    const q = new URLSearchParams({ table: item.table, column: body.column ?? '', rowId: item.rowId, name: body.fileName ?? 'file' })
    url = `/api/v1/attachments?${q}`
    init = { method: 'POST', body: r.file }
    headers['Content-Type'] = body.fileType ?? 'application/octet-stream'
  }
  let res: Response
  try {
    res = await fetch(url, { ...init, headers, credentials: 'same-origin' })
  } catch {
    report({ t: 'request', ok: false })
    return { ok: false, network: true }
  }
  report({ t: 'request', ok: true })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* not JSON */
  }
  if (res.ok) return { ok: true, result: data }
  const err = (data as { error?: { code?: string; message?: string; field?: string }; current?: Record<string, unknown> } | null) ?? {}
  return { ok: false, status: res.status, code: err.error?.code ?? 'storage', message: err.error?.message ?? `The server answered ${res.status}.`, ...(err.error?.field ? { field: err.error.field } : {}), ...(err.current ? { current: err.current } : {}) }
}

/* ------------------------------------------------------------------ replay */

let replayTimer: ReturnType<typeof setInterval> | null = null
export async function replay(): Promise<void> {
  const s = mine()
  if (!s || !s.codec || s.outbox.count === 0) return
  note(`replay ${s.outbox.count}`)
  const r = await s.outbox.flush()
  note(`replay done sent=${r.sent}${r.stopped ? ` stopped=${r.stopped}` : ''}`)
  if (r.stopped === 'auth') useOffline.setState({ lastError: 'Sign in again to send the changes waiting on this device.' })
}
function startTimers() {
  if (replayTimer || typeof window === 'undefined') return
  replayTimer = setInterval(() => {
    if ((current?.outbox.count ?? 0) > 0 && useConnectivity.getState().status === 'online') void replay()
  }, 30_000)
  onBackOnline(() => {
    void replay()
    // a download of the offline tables that the connection cut: try again
    const failed = new Set(Object.values(useOffline.getState().tables).filter((t) => t.state === 'error').map((t) => t.table.toLowerCase()))
    if (failed.size) for (const [id, a] of apps) if (a.tables.some((t) => failed.has(t.table.toLowerCase()))) void syncTables(id)
  })
}

/* ------------------------------------------------------------------ read cache */

async function storeAnswer(requestKey: string, table: string, answer: unknown): Promise<void> {
  const s = mine()
  if (!s?.codec) return
  const key = await answerKey(s, requestKey)
  const sealed = await s.codec.seal(answer)
  const bytes = sealed.data.byteLength
  if (bytes > CACHE_CAP_BYTES / 4) return
  await s.kv.put('cache', key, sealed)
  s.cacheIndex.set(key, { table, bytes, at: Date.now() })
  await enforceBudget(s, key)
  await s.kv.put('meta', 'cache-index', [...s.cacheIndex.entries()])
}

/**
 * One budget for everything in `cache` (CACHE_CAP_BYTES, 25 MB): kept answers and the rows of "available offline"
 * tables. Beyond it, the least recently used answers go first, then the least recently used tables; `keep` (the
 * record just written) is never evicted. Down to 80 % so the next writes do not evict again at once.
 */
async function enforceBudget(s: UserStore, keep: string): Promise<void> {
  let total = 0
  for (const v of s.cacheIndex.values()) total += v.bytes
  if (total <= CACHE_CAP_BYTES) return
  const order = [...s.cacheIndex.entries()].filter(([k]) => k !== keep).sort((a, b) => Number(!!a[1].snap) - Number(!!b[1].snap) || a[1].at - b[1].at)
  for (const [k, v] of order) {
    if (total <= CACHE_CAP_BYTES * 0.8) break
    total -= v.bytes
    s.cacheIndex.delete(k)
    if (v.snap) snapMemo.delete(k)
    await s.kv.delete('cache', k)
  }
}

async function cachedAnswer(requestKey: string): Promise<unknown | undefined> {
  const s = mine()
  if (!s?.codec) return undefined
  const key = await answerKey(s, requestKey)
  if (!s.cacheIndex.has(key)) return undefined
  const sealed = await s.kv.get<Sealed>('cache', key)
  if (!sealed) return undefined
  try {
    const v = await s.codec.open(sealed)
    s.cacheIndex.get(key)!.at = Date.now()
    return v
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ "available offline" tables (tables.ts) */

/** what is sealed under `snap:<environment>:<table>` in `cache` */
interface SnapshotRecord {
  v: 1
  userId: string
  environmentId: string
  table: string
  spec: string
  rows: Record<string, QueryValue>[]
  total?: number
  filtered: boolean
  at: number
}
const snapKey = (environmentId: string, table: string) => `snap:${environmentId}:${table.toLowerCase()}`
/** decrypted snapshots of this session (cleared with the store); a user check on every read */
const snapMemo = new Map<string, SnapshotRecord>()
/** a newer download of a table makes an older one stop */
const syncGen = new Map<string, number>()

function setTable(table: string, patch: Partial<TableSync>) {
  const prev = useOffline.getState().tables[table] ?? { table, state: 'loading', loaded: 0 }
  useOffline.setState({ tables: { ...useOffline.getState().tables, [table]: { ...prev, ...patch } } })
}

async function postQuery(plan: QueryPlan): Promise<{ ok: true; res: QueryV2Response } | { ok: false; network?: true; status?: number; message: string }> {
  const env = getRequestEnvironment()
  let res: Response
  try {
    res = await fetch('/api/v1/query', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: '1', ...(env ? { [ENVIRONMENT_HEADER]: env } : {}) },
      body: JSON.stringify({ plan }),
    })
  } catch {
    report({ t: 'request', ok: false })
    return { ok: false, network: true, message: 'No connection to the server.' }
  }
  report({ t: 'request', ok: true })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* not JSON */
  }
  if (res.ok) return { ok: true, res: data as QueryV2Response }
  return { ok: false, status: res.status, message: (data as { error?: { message?: string } } | null)?.error?.message ?? `The server answered ${res.status}.` }
}

/**
 * Download the "available offline" tables of an open app, as the signed-in user through the normal query endpoint
 * (POST /api/v1/query: row and column security apply exactly as online), page by page up to each table's row cap, and
 * seal them into `cache`. Online only; offline the rows kept earlier stay. Progress and the cap message go to useOffline.
 */
export async function syncTables(appId: string): Promise<void> {
  const app = apps.get(appId)
  const s = current
  if (!app || !s?.codec || !app.tables.length) return
  if (useConnectivity.getState().status === 'offline') return
  const env = getRequestEnvironment()
  const notes: string[] = []
  for (const spec of app.tables) {
    if (spec.error) {
      setTable(spec.table, { state: 'skipped', message: spec.error })
      notes.push(spec.error)
      continue
    }
    const gen = (syncGen.get(spec.table) ?? 0) + 1
    syncGen.set(spec.table, gen)
    setTable(spec.table, { state: 'loading', loaded: 0, total: undefined, message: undefined })
    const rows: Record<string, QueryValue>[] = []
    let total: number | undefined
    let cursor: string | undefined
    let failed: string | null = null
    do {
      const r = await postQuery(downloadPlan(spec, rows.length, cursor))
      if (syncGen.get(spec.table) !== gen || current !== s) return
      if (!r.ok) {
        failed = r.network ? 'No connection: the rows kept earlier stay on this device.' : r.message
        break
      }
      if (!cursor && typeof r.res.count === 'number') total = r.res.count
      rows.push(...(r.res.rows ?? []))
      cursor = r.res.nextCursor ?? undefined
      setTable(spec.table, { loaded: rows.length, total: total === undefined ? undefined : Math.min(total, spec.maxRows) })
    } while (cursor && rows.length < spec.maxRows)
    if (failed) {
      note(`offline table ${spec.table}: ${failed}`)
      setTable(spec.table, { state: 'error', message: failed })
      continue
    }
    const kept = rows.slice(0, spec.maxRows)
    const rec: SnapshotRecord = { v: 1, userId: s.userId, environmentId: env, table: spec.table, spec: specKey(spec), rows: kept, ...(total !== undefined ? { total } : {}), filtered: !!spec.filter, at: Date.now() }
    const stored = await storeSnapshot(s, rec)
    if (!stored) {
      const msg = `${spec.table} is too large to keep on this device for offline use (more than the ${Math.round(CACHE_CAP_BYTES * 0.8 / 1024 / 1024)} MB it may use). Lower its row limit or add a filter.`
      setTable(spec.table, { state: 'error', message: msg })
      notes.push(msg)
      continue
    }
    const cap = capMessage(spec.table, kept.length, total ?? (cursor ? kept.length + 1 : undefined))
    if (cap) notes.push(cap)
    note(`offline table ${spec.table}: ${kept.length} rows kept${cap ? ' (capped)' : ''}`)
    setTable(spec.table, { state: 'ready', loaded: kept.length, kept: kept.length, ...(total !== undefined ? { total } : {}), at: rec.at, message: cap ?? undefined })
  }
  const text = notes.join(' ')
  if (text && !dismissedNotices.has(text)) useOffline.setState({ tableNotice: text })
}

/** cap / size notices the person dismissed in this page session (memory only): not shown again on the next open */
const dismissedNotices = new Set<string>()
export function dismissTableNotice(): void {
  const t = useOffline.getState().tableNotice
  if (t) dismissedNotices.add(t)
  useOffline.setState({ tableNotice: null })
}

/** pull to refresh: download the app's offline tables again */
export async function refreshOfflineTables(appId: string): Promise<void> {
  if (!apps.get(appId)?.tables.length) return
  await ensureStarted()
  await syncTables(appId)
}

async function storeSnapshot(s: UserStore, rec: SnapshotRecord): Promise<boolean> {
  if (!s.codec) return false
  const key = snapKey(rec.environmentId, rec.table)
  const sealed = await s.codec.seal(rec)
  const bytes = sealed.data.byteLength
  // one table may use at most 80 % of the budget, so answers and the outbox's neighbours keep some room
  if (bytes > CACHE_CAP_BYTES * 0.8) return false
  try {
    await s.kv.put('cache', key, sealed)
  } catch {
    return false // storage full: the browser refused the write
  }
  s.cacheIndex.set(key, { table: rec.table, bytes, at: rec.at, snap: true })
  snapMemo.set(key, rec)
  await enforceBudget(s, key)
  await s.kv.put('meta', 'cache-index', [...s.cacheIndex.entries()])
  return true
}

/** the kept rows of a table for the signed-in user in the current environment (never another user's) */
async function snapshotOf(table: string): Promise<Snapshot | undefined> {
  const s = current
  const uid = sessionUserId()
  if (!s?.codec || !uid || s.userId !== uid) return undefined
  const key = snapKey(getRequestEnvironment(), table)
  if (!s.cacheIndex.has(key)) return undefined
  let rec = snapMemo.get(key)
  if (!rec) {
    const sealed = await s.kv.get<Sealed>('cache', key)
    if (!sealed) return undefined
    try {
      rec = await s.codec.open<SnapshotRecord>(sealed)
    } catch {
      return undefined
    }
    snapMemo.set(key, rec)
  }
  if (rec.v !== 1 || rec.userId !== uid || rec.environmentId !== getRequestEnvironment()) return undefined
  s.cacheIndex.get(key)!.at = Date.now()
  note(`answered from the kept rows of ${table}`)
  return { rows: rec.rows, partial: rec.filtered || (rec.total !== undefined && rec.total > rec.rows.length) }
}

/* ------------------------------------------------------------------ form drafts (Form.tsx) */

/** what a Form keeps while it has unsaved changes (sealed; files sealed one by one) */
export interface FormDraft {
  /** the form's field values (FormValues; Dates survive) */
  values: Record<string, unknown>
  /** Edit: the record version (modifiedOn) the edits started from */
  base: string | null
  mode: string
  table: string
  /** files waiting for upload, per column (their bytes are sealed separately) */
  files: Array<{ column: string; name: string; type: string; lastModified: number }>
  /** photos left out because they were too large to keep */
  filesDropped?: boolean
  savedAt: number
}
interface StoredDraft {
  /** in clear: for expiry and the per-user limit only */
  at: number
  body: Sealed
  files: Sealed[]
}
export const DRAFT_MAX = 50
export const DRAFT_DAYS = 14
export const DRAFT_FILE_BYTES = 8 * 1024 * 1024
const draftKey = (key: string) => `draft:${key}`

async function unlockedStore(): Promise<UserStore | null> {
  const s = await ensureStarted()
  return s?.codec && s.userId === sessionUserId() ? s : null
}

export const drafts = {
  /** keep (replace) the draft of one form; false when the store is not available (no key: nothing is kept) */
  async save(key: string, draft: Omit<FormDraft, 'files' | 'filesDropped'>, files: Array<{ column: string; file: File }>): Promise<boolean> {
    const s = await unlockedStore()
    if (!s?.codec) return false
    let size = 0
    const metas: FormDraft['files'] = []
    const sealedFiles: Sealed[] = []
    let dropped = false
    for (const f of files) {
      if (size + f.file.size > DRAFT_FILE_BYTES) {
        dropped = true
        continue
      }
      size += f.file.size
      sealedFiles.push(await s.codec.sealBytes(await f.file.arrayBuffer()))
      metas.push({ column: f.column, name: f.file.name, type: f.file.type, lastModified: f.file.lastModified })
    }
    const body = await s.codec.seal({ ...draft, files: metas, ...(dropped ? { filesDropped: true } : {}), userId: s.userId })
    await s.kv.put('meta', draftKey(key), { at: Date.now(), body, files: sealedFiles } satisfies StoredDraft)
    // at most DRAFT_MAX drafts per user, none older than DRAFT_DAYS
    const all = (await s.kv.entries<StoredDraft>('meta')).filter(([k]) => k.startsWith('draft:'))
    const old = Date.now() - DRAFT_DAYS * 86400_000
    const sorted = all.sort((a, b) => b[1].at - a[1].at)
    for (let i = 0; i < sorted.length; i++) if (i >= DRAFT_MAX || sorted[i]![1].at < old) await s.kv.delete('meta', sorted[i]![0])
    return true
  },
  async load(key: string): Promise<{ draft: FormDraft; files: Array<{ column: string; file: File }> } | null> {
    const s = await unlockedStore()
    if (!s?.codec) return null
    const st = await s.kv.get<StoredDraft>('meta', draftKey(key))
    if (!st) return null
    if (st.at < Date.now() - DRAFT_DAYS * 86400_000) {
      await s.kv.delete('meta', draftKey(key))
      return null
    }
    try {
      const draft = await s.codec.open<FormDraft & { userId?: string }>(st.body)
      if (draft.userId !== s.userId) return null
      const files: Array<{ column: string; file: File }> = []
      for (let i = 0; i < draft.files.length && i < st.files.length; i++) {
        const m = draft.files[i]!
        const bytes = await s.codec.openBytes(st.files[i]!)
        files.push({ column: m.column, file: new File([bytes], m.name, { type: m.type, lastModified: m.lastModified }) })
      }
      return { draft, files }
    } catch {
      return null
    }
  },
  async remove(key: string): Promise<void> {
    const s = current ?? (await ensureStarted())
    if (!s) return
    try {
      await s.kv.delete('meta', draftKey(key))
    } catch {
      /* the store is gone */
    }
  },
}

/* ------------------------------------------------------------------ the hook */

let noticeId = 0
/** the last 50 outbox events, for support and the browser checks (window.__abOffline.trace()); no values, only kinds */
const trace: string[] = []
export function note(e: string): void {
  trace.push(`${new Date().toISOString().slice(11, 23)} ${e}`)
  if (trace.length > 50) trace.shift()
}
const hook: OfflineHook = {
  divert(table, rowId) {
    const s = mine()
    if (!isOfflineTable(table) || !s?.codec) return false
    const d = useConnectivity.getState().status === 'offline' || s.outbox.pendingFor(table, rowId)
    note(`write ${table}: ${d ? 'to the outbox' : 'to the server'}`)
    return d
  },
  accepts(table) {
    const a = isOfflineTable(table) && !!mine()?.codec
    note(`no connection for ${table}: ${a ? 'kept' : 'not an offline table'}`)
    return a
  },
  queue(w: QueuedWrite, cb: QueueCallbacks) {
    const s = mine()
    if (!s) {
      cb.fail(new Error('The offline store is not available.'))
      return
    }
    note(`queue ${w.kind} ${w.table}`)
    const label = w.kind === 'create' ? `New row in ${w.table}` : w.kind === 'update' ? `Change to a row of ${w.table}` : `File ${w.fileName ?? ''} for ${w.table}`
    s.outbox
      .add({ kind: w.kind, table: w.table, rowId: w.rowId, environmentId: getRequestEnvironment(), values: w.values, ifModifiedOn: w.ifModifiedOn, column: w.column, file: w.file, fileName: w.fileName, label, ...(w.form ? { form: w.form } : {}) }, cb)
      .then(() => {
        useOffline.setState({ notice: { id: ++noticeId, text: 'Saved on this device. It will be sent when the connection returns.' } })
        if (useConnectivity.getState().status === 'online') void replay()
      })
      .catch((e: unknown) => cb.fail(e))
  },
  storeAnswer(key, table, answer) {
    if (!isOfflineTable(table)) return
    void storeAnswer(key, table, answer).catch(() => {})
  },
  cachedAnswer: (key) => cachedAnswer(key),
  snapshot: (table) => (isOfflineTable(table) ? snapshotOf(table) : Promise.resolve(undefined)),
  noteNetwork(ok) {
    report({ t: 'request', ok })
  },
}
let installed = false
/** install the hook (main.tsx); the per-user store opens when the first offline app opens */
export function startOffline(): void {
  if (installed) return
  installed = true
  setOfflineHook(hook)
  startTimers()
  try {
    platform.onDataError((e) => note(`refused ${e.op} ${e.table}: ${e.error.code}${isOfflineTable(e.table) ? ' (offline table)' : ''}`))
  } catch {
    /* tests without a platform */
  }
  // browser checks (scripts/exit-check/p2-phone.mjs) read the outbox state here
  if (typeof window !== 'undefined') (window as unknown as { __abOffline?: unknown }).__abOffline = { state: () => ({ ...useOffline.getState(), count: current?.outbox.count ?? 0, unlocked: !!current?.codec, cacheBytes: [...(current?.cacheIndex.values() ?? [])].reduce((n, v) => n + v.bytes, 0) }), trace: () => trace.slice() }
  // a signed-in user with items left from an earlier session: open the store so they are counted and sent
  platform.subscribe(() => {
    const uid = sessionUserId()
    // another person (or nobody) is signed in now: the previous person's store is locked at once
    if (current && current.userId !== uid) lockForeignStore()
    if (uid && current?.userId !== uid && !starting) {
      void hasStore(uid).then((has) => {
        if (has) void ensureStarted()
      })
    }
  })
}

async function hasStore(userId: string): Promise<boolean> {
  try {
    if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return false
    return (await indexedDB.databases()).some((d) => d.name === `appbuilder-offline-${userId}`)
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ actions for the UI */

export const outboxActions = {
  keepMine: (id: string) => current?.outbox.keepMine(id).then(replay),
  useServer: (id: string) => current?.outbox.useServer(id),
  resend: (id: string, values?: Record<string, unknown>) => current?.outbox.resend(id, values).then(replay),
  discard: (id: string) => current?.outbox.discard(id),
  sendNow: () => replay(),
}

/** number of unsent items for the signed-in user (sign-out warning) */
export const pendingCount = () => current?.outbox.count ?? 0

/** delete everything this device keeps for the user: outbox, cache, session key, service worker caches */
export async function clearLocalOfflineData(userId?: string): Promise<void> {
  note('clear local data')
  snapMemo.clear()
  syncGen.clear()
  const uid = userId ?? current?.userId ?? sessionUserId()
  if (current && (!uid || current.userId === uid)) {
    current.outbox.reset()
    await current.kv.destroy()
    current = null
  } else if (uid) {
    await openKV(uid).destroy()
  }
  try {
    if (uid) sessionStorage.removeItem(sessionKeyName(uid))
  } catch {
    /* ignore */
  }
  try {
    const sw = navigator.serviceWorker?.controller
    sw?.postMessage({ type: 'clear' })
    if (typeof caches !== 'undefined') for (const k of await caches.keys()) if (k.startsWith('ab-')) await caches.delete(k)
  } catch {
    /* no service worker */
  }
  useOffline.setState({ items: [], unlocked: false, active: apps.size > 0, tables: {}, tableNotice: null })
}

/** sign-out: ask first when changes are still waiting; true = go on */
export async function beforeSignOut(confirm: (text: string) => boolean): Promise<boolean> {
  const n = pendingCount()
  if (n > 0 && !confirm(`${n} ${n === 1 ? 'change has' : 'changes have'} not been sent yet. Signing out deletes ${n === 1 ? 'it' : 'them'} from this device. Sign out anyway?`)) return false
  await clearLocalOfflineData()
  return true
}

/** "Wipe device data" for the signed-in user: raises the server epoch (every device) and clears this one */
export async function wipeDeviceData(userId?: string): Promise<void> {
  const res = await fetch('/api/v1/offline/wipe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: '1' },
    body: JSON.stringify(userId ? { userId } : {}),
  })
  if (!res.ok) {
    let msg = `The server answered ${res.status}.`
    try {
      msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? msg
    } catch {
      /* not JSON */
    }
    throw new Error(msg)
  }
  if (!userId || userId === sessionUserId()) await clearLocalOfflineData()
}
