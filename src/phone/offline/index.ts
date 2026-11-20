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
 *  - Sign-out (beforeSignOut) and wipe (wipeDeviceData) delete the user's database and the session key, and ask the
 *    service worker to drop its caches.
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
}
export const useOffline = create<OfflineUiState>(() => ({ items: [], unlocked: false, active: false, lastError: null, notice: null }))

/* ------------------------------------------------------------------ registry of offline apps */

const apps = new Map<string, string[]>()
const tablesLower = () => new Set([...apps.values()].flat().map((t) => t.toLowerCase()))
let offlineTables = new Set<string>()

export function registerOfflineApp(appId: string, dataSources: string[]): () => void {
  apps.set(appId, dataSources)
  offlineTables = tablesLower()
  useOffline.setState({ active: true })
  void ensureStarted()
  return () => {
    apps.delete(appId)
    offlineTables = tablesLower()
    useOffline.setState({ active: apps.size > 0 || (current?.outbox.count ?? 0) > 0 })
  }
}
export const isOfflineTable = (t: string) => offlineTables.has(t.toLowerCase())

/* ------------------------------------------------------------------ per-user store */

interface UserStore {
  userId: string
  kv: KV
  outbox: Outbox
  codec: Codec | null
  cacheIndex: Map<string, { table: string; bytes: number; at: number }>
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
    outbox.subscribe(() => useOffline.setState({ items: outbox.list(), unlocked: outbox.unlocked, active: apps.size > 0 || outbox.count > 0 }))
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
    const idx = await kv.get<Array<[string, { table: string; bytes: number; at: number }]>>('meta', 'cache-index')
    store.cacheIndex = new Map(idx ?? [])
    current = store
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
      useOffline.setState({ lastError: 'The offline data on this device was wiped (an administrator or you asked for it).' })
    }
    await store.kv.put('meta', 'epoch', k.epoch)
    await store.kv.put('meta', 'check', await codec.seal('appbuilder-offline'))
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
    init = { method: 'POST', body: JSON.stringify({ values: body.values ?? {} }) }
    headers['Content-Type'] = 'application/json'
  } else if (item.kind === 'update') {
    url = `/api/v1/data/${t}/rows/${encodeURIComponent(item.rowId)}`
    init = { method: 'PATCH', body: JSON.stringify({ changes: body.values ?? {}, ...(body.ifModifiedOn ? { ifModifiedOn: body.ifModifiedOn } : {}) }) }
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
  const s = current
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
  onBackOnline(() => void replay())
}

/* ------------------------------------------------------------------ read cache */

async function storeAnswer(key: string, table: string, answer: unknown): Promise<void> {
  const s = current
  if (!s?.codec) return
  const sealed = await s.codec.seal(answer)
  const bytes = sealed.data.byteLength
  if (bytes > CACHE_CAP_BYTES / 4) return
  await s.kv.put('cache', key, sealed)
  s.cacheIndex.set(key, { table, bytes, at: Date.now() })
  let total = 0
  for (const v of s.cacheIndex.values()) total += v.bytes
  if (total > CACHE_CAP_BYTES) {
    for (const [k, v] of [...s.cacheIndex.entries()].sort((a, b) => a[1].at - b[1].at)) {
      if (total <= CACHE_CAP_BYTES * 0.8) break
      total -= v.bytes
      s.cacheIndex.delete(k)
      await s.kv.delete('cache', k)
    }
  }
  await s.kv.put('meta', 'cache-index', [...s.cacheIndex.entries()])
}

async function cachedAnswer(key: string): Promise<unknown | undefined> {
  const s = current
  if (!s?.codec || !s.cacheIndex.has(key)) return undefined
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
    if (!isOfflineTable(table) || !current?.codec) return false
    const d = useConnectivity.getState().status === 'offline' || current.outbox.pendingFor(table, rowId)
    note(`write ${table}: ${d ? 'to the outbox' : 'to the server'}`)
    return d
  },
  accepts(table) {
    const a = isOfflineTable(table) && !!current?.codec
    note(`no connection for ${table}: ${a ? 'kept' : 'not an offline table'}`)
    return a
  },
  queue(w: QueuedWrite, cb: QueueCallbacks) {
    const s = current
    if (!s) {
      cb.fail(new Error('The offline store is not available.'))
      return
    }
    note(`queue ${w.kind} ${w.table}`)
    const label = w.kind === 'create' ? `New row in ${w.table}` : w.kind === 'update' ? `Change to a row of ${w.table}` : `File ${w.fileName ?? ''} for ${w.table}`
    s.outbox
      .add({ kind: w.kind, table: w.table, rowId: w.rowId, environmentId: getRequestEnvironment(), values: w.values, ifModifiedOn: w.ifModifiedOn, column: w.column, file: w.file, fileName: w.fileName, label }, cb)
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
  if (typeof window !== 'undefined') (window as unknown as { __abOffline?: unknown }).__abOffline = { state: () => ({ ...useOffline.getState(), count: current?.outbox.count ?? 0, unlocked: !!current?.codec }), trace: () => trace.slice() }
  // a signed-in user with items left from an earlier session: open the store so they are counted and sent
  platform.subscribe(() => {
    const uid = sessionUserId()
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
  useOffline.setState({ items: [], unlocked: false, active: apps.size > 0 })
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
