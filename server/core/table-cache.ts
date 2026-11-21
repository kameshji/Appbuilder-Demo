/**
 * The table registry (`meta.tables.list()`, every table definition of an environment) cached per environment schema.
 * Load test, November 2026: it was the largest consumer of database time (2.2 full reads of ab_tables per request).
 *
 * - Key: the environment's schema (currentEnvironment().schema, the same as the store's queries use), per store (a
 *   process may hold several databases: tests). The cached list is the raw registry, the same for everyone:
 *   permissions are applied by each caller per request, after the cache.
 * - Every caller gets its own copy (structuredClone), so a caller that changes a definition does not change the cache.
 * - Invalidated by every write of the registry: meta.tables.upsert / remove (wrapped here, so every model change through
 *   the store: table and column create / alter / delete, solutions install / uninstall, ALM import and deploy, data
 *   files, table migrations, recycle bin, approvals) and invalidateTableList() after the writers that use SQL directly
 *   (environment create / copy / delete, backup restore in place / as new / of tables, the schema migration).
 * - Transactions (the store joins the ambient transaction of its database, connectors/postgres/db.ts): a read inside a
 *   transaction that wrote the registry of that schema reads the database (its own uncommitted definitions); any other
 *   read inside a transaction may use the cache (READ COMMITTED: it sees the committed registry) but never fills it;
 *   a registry write inside a
 *   transaction keeps every other reader from filling the cache for that schema until the transaction has ended, and
 *   the schema is invalidated again after COMMIT or ROLLBACK. A read that started before an invalidation is not stored.
 * - Backstop: an entry older than APPBUILDER_TABLE_CACHE_TTL_MS (default 60 s) is read again (a write by another
 *   process, e.g. a CLI command against a running server). APPBUILDER_TABLE_CACHE=off turns the cache off.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { TableDef } from '../../src/platform/contracts.ts'
import type { MetaStore, SqlDb } from './contracts.ts'
import { currentEnvironment } from './env-context.ts'

interface Entry { gen: string; at: number; tables: TableDef[] }
/** one cache per store */
interface Cache { entries: Map<string, Entry>; gens: Map<string, number>; open: Map<string, number> }
interface TxMark { open: boolean; dirty: Set<string> }

const caches = new Set<WeakRef<Cache>>()
const counters = { hits: 0, misses: 0, bypassed: 0, invalidations: 0 }

const enabled = (): boolean => (process.env.APPBUILDER_TABLE_CACHE ?? '').toLowerCase() !== 'off'
const ttlMs = (): number => {
  const v = Number(process.env.APPBUILDER_TABLE_CACHE_TTL_MS)
  return Number.isFinite(v) && v >= 0 ? v : 60_000
}

function forget(c: Cache, schema?: string): void {
  counters.invalidations++
  if (schema === undefined) {
    c.entries.clear()
    c.gens.set('', (c.gens.get('') ?? 0) + 1)
    return
  }
  c.gens.set(schema, (c.gens.get(schema) ?? 0) + 1)
  c.entries.delete(schema)
}
/** the generation of a schema: changes with every invalidation of it or of everything */
const genOf = (c: Cache, schema: string): string => `${c.gens.get('') ?? 0}:${c.gens.get(schema) ?? 0}`

/** forgets the cached list of one environment schema, or of every environment (no argument), in every store */
export function invalidateTableList(schema?: string): void {
  for (const r of caches) {
    const c = r.deref()
    if (c) forget(c, schema)
    else caches.delete(r)
  }
}

export function tableCacheStats(): { entries: number; hits: number; misses: number; bypassed: number; invalidations: number } {
  let n = 0
  for (const r of caches) n += r.deref()?.entries.size ?? 0
  return { entries: n, ...counters }
}

const WRAPPED = Symbol('tableCache')

/**
 * wraps meta.tables.list / upsert / remove of a MetaStore and the tx() of its database (idempotent); returns the store.
 * `db` must be the database the store was made with.
 */
export function withTableCache(meta: MetaStore, db: SqlDb): MetaStore {
  const m = meta as MetaStore & { [WRAPPED]?: Cache }
  if (m[WRAPPED]) return meta
  const c: Cache = { entries: new Map(), gens: new Map(), open: new Map() }
  m[WRAPPED] = c // the cache lives as long as the store
  caches.add(new WeakRef(c))
  const txs = new AsyncLocalStorage<TxMark>()
  const inTx = (): boolean => {
    const t = txs.getStore()
    return !!t?.open || !!(db as { inTransaction?: () => boolean }).inTransaction?.()
  }

  const tx = db.tx.bind(db)
  db.tx = async <T>(fn: (d: SqlDb) => Promise<T>): Promise<T> => {
    if (txs.getStore()?.open) return tx(fn) // nested: a savepoint of the outer one
    const mark: TxMark = { open: true, dirty: new Set() }
    try {
      return await txs.run(mark, () => tx(fn))
    } finally {
      mark.open = false
      for (const s of mark.dirty) {
        const n = (c.open.get(s) ?? 1) - 1
        if (n > 0) c.open.set(s, n)
        else c.open.delete(s)
        forget(c, s)
      }
    }
  }

  /** after a registry write: at once; inside a transaction also when it ends */
  const written = (schema: string) => {
    forget(c, schema)
    const t = txs.getStore()
    if (t?.open && !t.dirty.has(schema)) {
      t.dirty.add(schema)
      c.open.set(schema, (c.open.get(schema) ?? 0) + 1)
    }
  }

  const list = meta.tables.list.bind(meta.tables)
  const upsert = meta.tables.upsert.bind(meta.tables)
  const remove = meta.tables.remove.bind(meta.tables)
  meta.tables.list = async () => {
    if (!enabled()) return list()
    const schema = currentEnvironment().schema
    const tx = inTx()
    if (tx) {
      // inside a transaction that has written the registry of this schema (or one this wrapper did not open): its own,
      // uncommitted view. Otherwise the transaction sees the committed registry (READ COMMITTED), which is the cache's.
      const t = txs.getStore()
      if (!t?.open || t.dirty.has(schema)) {
        counters.bypassed++
        return list()
      }
    }
    const hit = c.entries.get(schema)
    if (hit && hit.gen === genOf(c, schema) && Date.now() - hit.at <= ttlMs()) {
      counters.hits++
      return structuredClone(hit.tables)
    }
    counters.misses++
    const gen = genOf(c, schema)
    const tables = await list()
    // stored only when no write happened while it was read and no transaction that wrote the registry is open
    if (!tx && gen === genOf(c, schema) && !c.open.has(schema)) c.entries.set(schema, { gen, at: Date.now(), tables: structuredClone(tables) })
    return tables
  }
  meta.tables.upsert = async (t) => {
    const schema = currentEnvironment().schema
    try { await upsert(t) } finally { written(schema) }
  }
  meta.tables.remove = async (id) => {
    const schema = currentEnvironment().schema
    try { await remove(id) } finally { written(schema) }
  }
  return meta
}
