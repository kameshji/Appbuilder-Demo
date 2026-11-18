/**
 * Safe bridge to the platform (tables, users). Every call is wrapped so the runtime keeps working
 * when the platform is unavailable (stub, tests, storage failure): reads return empty values and
 * writes throw a PlatformError the host turns into a formula failure.
 */
import type { FxRecord, FxValue } from '@/contracts'
import { platform, PlatformError, userRecord, type ColumnDef, type DataErrorEvent, type Row, type TableDef, type WorkspaceState } from '@/platform'
import { CODE_MESSAGES } from '@/platform/errorMessages'

export const SYSTEM_COLUMNS = new Set(['id', 'createdOn', 'modifiedOn', 'createdBy', 'owner'])

export function platformState(): WorkspaceState | null {
  try {
    return platform.getState()
  } catch {
    return null
  }
}

export function platformReady(): boolean {
  return !!platformState()?.ready
}

export function tableDef(name: string): TableDef | undefined {
  try {
    return platform.tables.get(name)
  } catch {
    return undefined
  }
}

/** a platform table with exactly this (formula) name */
export function isTable(name: string): boolean {
  const t = tableDef(name)
  return !!t && t.name === name
}

export function tableNames(): string[] {
  return platformState()?.tables.map((t) => t.name) ?? []
}

export function tableRows(name: string): Row[] {
  try {
    return platform.tables.rows(name)
  } catch {
    return []
  }
}

export function tableColumns(name: string): ColumnDef[] {
  return tableDef(name)?.columns ?? []
}

export function currentUserRecord(): FxRecord | null {
  try {
    const st = platform.getState()
    return userRecord(platform.security.currentUser(), st.roles)
  } catch {
    return null
  }
}

export function currentUserId(): string {
  return platformState()?.currentUserId ?? ''
}

export function platformMode(): 'server' | 'demo' {
  return platformState()?.mode === 'server' ? 'server' : 'demo'
}

/** table names that are loading from the server / hit the row cap (server mode) */
export function loadingTables(): string[] {
  return platformState()?.loading ?? []
}
export function truncatedTables(): string[] {
  return platformState()?.truncated ?? []
}

/**
 * Load the rows of these tables (plus the tables their lookup columns point at) into the platform cache.
 * Idempotent; never throws (a failure just leaves the table empty and shows in the platform state).
 */
export function ensureTablesLoaded(names: string[]): void {
  try {
    const seen = new Set<string>()
    const queue = names.slice()
    while (queue.length) {
      const n = queue.pop() as string
      if (seen.has(n)) continue
      const def = tableDef(n)
      if (!def) continue
      seen.add(def.name)
      for (const c of def.columns) if (c.type === 'lookup' && c.lookupTable && !seen.has(c.lookupTable)) queue.push(c.lookupTable)
    }
    if (seen.size === 0) return
    void Promise.resolve(platform.tables.ensureLoaded([...seen])).catch(() => {})
  } catch {
    /* platform unavailable */
  }
}

export function dataVersion(): number {
  return platformState()?.dataVersion ?? 0
}

export function errorMessage(e: unknown): string {
  if (e instanceof PlatformError) return CODE_MESSAGES[e.code] ?? e.message
  if (e instanceof Error) return e.message
  return String(e)
}

export function isPlatformError(e: unknown): e is PlatformError {
  return e instanceof PlatformError || (e instanceof Error && typeof (e as { code?: unknown }).code === 'string')
}

/** values a formula may write to a table row: drop hidden and system fields */
export function writableValues(rec: FxRecord): FxRecord {
  const out: FxRecord = {}
  for (const [k, v] of Object.entries(rec)) {
    if (k.startsWith('__') || SYSTEM_COLUMNS.has(k)) continue
    out[k] = v as FxValue
  }
  return out
}

export function rowId(rec: FxRecord | null | undefined): string | null {
  if (!rec) return null
  if (typeof rec.__id === 'string' && rec.__id) return rec.__id
  if (typeof rec.id === 'string' && rec.id) return rec.id
  return null
}

export const tables = {
  insert(name: string, values: FxRecord): Row {
    return platform.tables.insert(name, writableValues(values))
  },
  /** ifVersion: the row's modifiedOn the caller started from (a Form): a newer save by someone else answers 409 */
  update(name: string, id: string, changes: FxRecord, opts?: { ifVersion?: Date | string | null }): Row {
    return opts?.ifVersion ? platform.tables.update(name, id, writableValues(changes), { ifVersion: opts.ifVersion }) : platform.tables.update(name, id, writableValues(changes))
  },
  delete(name: string, ids: string[]) {
    platform.tables.delete(name, ids)
  },
  reload(name: string) {
    try {
      void platform.tables.reload(name).catch(() => {})
    } catch {
      /* ignore */
    }
  },
}

/** the async tail of a Form submit talks to the platform through these */
export const submitDeps = {
  flush: () => platform.tables.flush(),
  upload: (table: string, column: string, id: string, file: File) => platform.attachments.upload(table, column, id, file),
  reload: (table: string) => platform.tables.reload(table),
}

/** the freshest copy of a row from the cache (after an upload refreshed its file cells) */
export function currentRow(name: string, id: string): Row | undefined {
  return tableRows(name).find((r) => r.__id === id)
}

/** subscribe to platform changes; returns a no-op unsubscribe when the platform is unavailable */
export function subscribePlatform(fn: () => void): () => void {
  try {
    return platform.subscribe(fn)
  } catch {
    return () => {}
  }
}

/** server-side write refusals (after the platform rolled the optimistic change back) */
export function subscribeDataErrors(fn: (e: DataErrorEvent) => void): () => void {
  try {
    if (typeof platform.onDataError === 'function') return platform.onDataError(fn)
  } catch {
    /* ignore */
  }
  return () => {}
}

/* ------------------------------------------------------------------ query feed (server mode, P0 package D) */

let qVersion = 0
const qLog: { v: number; deps: string[] }[] = []
const qListeners = new Set<() => void>()
let qFeed = false
const COUNT_KEY = /^\{"count":true,"table":("(?:[^"\\]|\\.)*"),"version":2\}$/

/** subscribe once to the platform's query cache (after init picked a backend); cheap to call often */
export function ensureQueryFeed(): void {
  if (qFeed) return
  try {
    if (!platform.getState().ready) return
    qFeed = true
    platform.tables.onQueryChange((keys) => {
      qVersion++
      const deps: string[] = []
      for (const k of keys) {
        deps.push('q:' + k)
        const m = COUNT_KEY.exec(k)
        if (m) deps.push('ts:' + (JSON.parse(m[1]!) as string))
      }
      qLog.push({ v: qVersion, deps })
      if (qLog.length > 1000) qLog.shift()
      for (const l of [...qListeners]) l()
    })
  } catch {
    qFeed = false
  }
}

/** bumps whenever cached query results change */
export function queryVersion(): number {
  return qVersion
}

/** evaluator dependencies ('q:<key>', 'ts:<table>') changed after version `v`; null when the log no longer reaches back */
export function queryDepsSince(v: number): string[] | null {
  if (v >= qVersion) return []
  if (!qLog.length || qLog[0]!.v > v + 1) return null
  const out = new Set<string>()
  for (const e of qLog) if (e.v > v) for (const d of e.deps) out.add(d)
  return [...out]
}

export function subscribeQueries(fn: () => void): () => void {
  qListeners.add(fn)
  return () => {
    qListeners.delete(fn)
  }
}

/* ------------------------------------------------------------------ record sharing (SharedWith, Share, Unshare) */

const sharedWith = new Map<string, { rows: FxRecord[]; loading: boolean }>()

function bumpQueryDeps(deps: string[]) {
  qVersion++
  qLog.push({ v: qVersion, deps })
  if (qLog.length > 1000) qLog.shift()
  for (const l of [...qListeners]) l()
}

/** SharedWith(record): the cached shares of a row; the first call loads them (formulas re-evaluate on arrival) */
export function sharedWithRows(rowId: string): FxRecord[] {
  const hit = sharedWith.get(rowId)
  if (hit) return hit.rows
  sharedWith.set(rowId, { rows: [], loading: true })
  void loadShares(rowId)
  return []
}

async function loadShares(rowId: string): Promise<void> {
  let rows: FxRecord[] = []
  try {
    const info = await platform.org.shares(rowId)
    const users = new Map((await platform.org.directory().catch(() => ({ users: [], teams: [] }))).users.map((u) => [u.id, u]))
    rows = info.shares.map((s) => ({
      Name: s.principalName ?? s.principalId,
      Email: s.principalType === 'user' ? (users.get(s.principalId)?.email ?? '') : '',
      Id: s.principalId,
      Type: s.principalType === 'team' ? 'Team' : 'User',
      Access: s.access === 'update' ? 'Edit' : 'Read',
    }))
  } catch {
    rows = []
  }
  sharedWith.set(rowId, { rows, loading: false })
  bumpQueryDeps([`q:sw:${rowId}`])
}

const shareErrorListeners = new Set<(message: string) => void>()
/** Share / Unshare failures (they finish after the behaviour formula): the app store shows them */
export function subscribeShareErrors(fn: (message: string) => void): () => void {
  shareErrorListeners.add(fn)
  return () => {
    shareErrorListeners.delete(fn)
  }
}

/** Share / Unshare from formulas: run, then refresh the row's SharedWith; failures go to the listeners */
export async function changeShare(rowId: string, principal: string, access: 'read' | 'update' | null): Promise<void> {
  try {
    if (access) await platform.org.share(rowId, principal, access)
    else await platform.org.unshare(rowId, principal)
  } catch (e) {
    const message = `${access ? 'Share' : 'Unshare'}: ${errorMessage(e)}`
    for (const l of [...shareErrorListeners]) l(message)
  }
  await loadShares(rowId)
}

/**
 * SendNotification(user, title, body, link) from formulas (package H): sent through the platform (server: POST
 * /api/v1/notifications/send, rate-limited, only to people in this environment). It finishes after the behaviour
 * formula; a failure is shown like a Share failure (the app store's toast).
 */
export async function sendNotification(input: { to: string; title: string; body?: string; link?: string; app?: string }): Promise<void> {
  try {
    await platform.notifications.send(input)
  } catch (e) {
    const message = `SendNotification: ${errorMessage(e)}`
    for (const l of [...shareErrorListeners]) l(message)
  }
}
