/**
 * Table change feed for the realtime hub (P0 package H). Source: package G's outbox. bridgeOutbox() subscribes to
 * kernel.outbox (committed rows, delivered right after the dispatcher's commit, in id order) and emits one TableChange
 * per outbox row, with the outbox id as the sequence; the hub (hub.ts) listens with onTableChange() and pushes
 * `table:<id>` messages under the leak rule of docs/dev/live.md. Pushes therefore never precede the commit.
 *
 * The DataService calls noteLocalWrite() at write time (inside the request): it remembers who last wrote a row (the 409
 * conflict answer names them) and which live connection the request came from (X-Appbuilder-Live), keyed by the
 * request id the outbox row carries, so the hub can mark the change `self` for that socket.
 * A few changes bypass the DataService and the outbox (assign owner): they call emitTableChange() directly.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export type TableChangeOp = 'insert' | 'update' | 'delete' | 'import'

export interface TableChange {
  op: TableChangeOp
  /** ids of the changed rows (may be long for imports and bulk deletes; the hub decides what to send) */
  rowIds: string[]
  /** names of the changed columns (insert / import: every column written; delete: none) */
  changedColumns: string[]
  /** who changed it; null for system work (migration, seeding, flows running as the system) */
  actor: { id: string; name: string } | null
  /** the live connection the write came from (X-Appbuilder-Live header): the hub marks the message `self` there */
  origin?: string
  /** the outbox id (per environment, increasing); absent for changes outside the outbox */
  seq?: number
}

export type TableChangeListener = (env: string, tableId: string, change: TableChange) => void

const listeners = new Set<TableChangeListener>()
const originStore = new AsyncLocalStorage<string>()

/** subscribe to committed table changes; returns unsubscribe */
export function onTableChange(listener: TableChangeListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitTableChange(env: string, tableId: string, change: TableChange): void {
  const origin = change.origin ?? originStore.getStore()
  const c = origin ? { ...change, origin } : change
  remember(env, tableId, c)
  for (const l of [...listeners]) {
    try {
      l(env, tableId, c)
    } catch {
      /* a listener's failure never fails the write */
    }
  }
}

/** runs fn with the live connection id of the request (router.ts, from the X-Appbuilder-Live header) */
export function withLiveOrigin<T>(origin: string | undefined, fn: () => T): T {
  if (!origin || !/^[A-Za-z0-9_-]{8,64}$/.test(origin)) return fn()
  return originStore.run(origin, fn)
}

/* ------------------------------------------------------------------ last writer per row (conflict dialog) */

const LAST_WRITERS_MAX = 5000
const lastWriters = new Map<string, { id: string; name: string; at: number }>()

function remember(env: string, tableId: string, c: TableChange): void {
  if (!c.actor || (c.op !== 'update' && c.op !== 'insert')) return
  const at = Date.now()
  for (const row of c.rowIds.slice(0, 100)) {
    const k = `${env}\u0001${tableId}\u0001${row}`
    lastWriters.delete(k)
    lastWriters.set(k, { ...c.actor, at })
  }
  while (lastWriters.size > LAST_WRITERS_MAX) {
    const first = lastWriters.keys().next().value
    if (first === undefined) break
    lastWriters.delete(first)
  }
}

/** who last changed this row (since the server started; in memory) */
export function lastWriterOf(env: string, tableId: string, rowId: string): { id: string; name: string } | null {
  const w = lastWriters.get(`${env}\u0001${tableId}\u0001${rowId}`)
  return w ? { id: w.id, name: w.name } : null
}

/* ------------------------------------------------------------------ write-time notes (inside the request) */

const ORIGINS_MAX = 5000
const originByRequest = new Map<string, string>()

/**
 * The DataService wrote rows (not committed yet): remember the writer of each row (409 answers) and, when the request
 * came from a live connection, which one (the outbox row carries the request id).
 */
export function noteLocalWrite(env: string, tableId: string, op: TableChangeOp, rowIds: string[], actor: { id: string; name: string } | null, requestId?: string): void {
  remember(env, tableId, { op, rowIds, changedColumns: [], actor })
  if (actor) userNames.set(actor.id, actor.name)
  const origin = originStore.getStore()
  if (origin && requestId) {
    originByRequest.delete(requestId)
    originByRequest.set(requestId, origin)
    while (originByRequest.size > ORIGINS_MAX) {
      const first = originByRequest.keys().next().value
      if (first === undefined) break
      originByRequest.delete(first)
    }
  }
}

/* ------------------------------------------------------------------ package G's outbox as the source */

/** the fields of G's OutboxEvent (server/core/outbox.ts) the hub needs */
export interface OutboxLike {
  id: number
  environmentId: string
  tableId: string
  op: 'insert' | 'update' | 'delete' | 'import' | 'bulk'
  rowId: string | null
  rowIds: string[] | null
  changed: string[] | null
  actorId: string | null
  requestId?: string | null
}

const userNames = new Map<string, string>()

/** an outbox row -> a table change (bulk = a delete of many rows; an import lists its rows) */
export function outboxToChange(e: OutboxLike, actor: { id: string; name: string } | null, origin?: string): TableChange {
  const op: TableChangeOp = e.op === 'bulk' ? 'delete' : e.op
  const rowIds = e.rowIds ?? (e.rowId ? [e.rowId] : [])
  return { op, rowIds, changedColumns: op === 'delete' ? [] : (e.changed ?? []), actor, seq: e.id, ...(origin ? { origin } : {}) }
}

/**
 * Feed the hub from committed outbox rows (app.ts wires it). Actor names come from the request that wrote the row, else
 * from the user record (looked up in order: a chain keeps the outbox order).
 */
export function bridgeOutbox(
  outbox: { subscribe(fn: (e: OutboxLike) => void): () => void },
  lookupName: (userId: string) => Promise<string | undefined>,
): () => void {
  let chain: Promise<void> = Promise.resolve()
  return outbox.subscribe((e) => {
    const origin = e.requestId ? originByRequest.get(e.requestId) : undefined
    const send = (name: string | undefined) => {
      try {
        emitTableChange(e.environmentId, e.tableId, outboxToChange(e, e.actorId ? { id: e.actorId, name: name ?? 'Someone' } : null, origin))
      } catch { /* never breaks the dispatcher */ }
    }
    const known = e.actorId ? userNames.get(e.actorId) : undefined
    chain = chain.then(async () => {
      if (!e.actorId || known !== undefined) return send(known)
      let name: string | undefined
      try {
        name = await lookupName(e.actorId)
        if (name) userNames.set(e.actorId, name)
      } catch { /* unknown */ }
      send(name)
    })
  })
}
