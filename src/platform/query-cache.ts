/**
 * Client query cache for Data API v2 (P0 package D), server mode. Pure TypeScript (no React); remote.ts wires it to
 * HTTP and to its optimistic write queue.
 *
 * - Entries are keyed by the plan (stable JSON without `page`). A rows plan that is unbounded is PAGED: the entry holds
 *   the pages loaded so far (first page on demand, `loadMore()` appends the next one through the keyset cursor) plus the
 *   exact count; every other plan (record, count, scalar, aggregates, bounded rows) is fetched whole.
 * - De-duplication: one request per key at a time; every caller waits for the same promise.
 * - Cancellation: callers name an `owner` (a formula property, a control). When the owner moves to another plan (the user
 *   typed one more letter), the old plan loses it; an in-flight request nobody wants any more is aborted.
 * - Invalidation: a write to a table (and later a table-changed message from the server) marks that table's entries
 *   stale; entries someone still watches refetch in the background while their previous rows stay visible (no flicker),
 *   the others are dropped.
 * - Optimistic writes: the platform's pending writes are overlaid on the cached rows (`overlay`), and a confirmed write is
 *   folded into them (`fold`) before the background refetch brings the server's truth.
 * Listeners get the keys that changed, so the evaluator re-runs only the formulas that read them.
 */
import type { Row } from './contracts.ts'
import { PlatformError } from './contracts.ts'
import type { QueryPlan, QueryV2Response } from './query.ts'
import { QUERY_MAX_PAGE_SIZE } from './query.ts'

export type QueryStatus = 'loading' | 'ready' | 'error'

export interface QueryState {
  key: string
  plan: QueryPlan
  status: QueryStatus
  /** result rows (all pages loaded so far for paged entries), with pending optimistic writes applied */
  rows: Row[]
  count?: number
  /** paged entries: more rows exist on the server */
  hasMore: boolean
  /** capped connectors only (see QueryV2Response.truncated) */
  truncated?: boolean
  error?: PlatformError
  /** a refetch runs; `rows` are the previous result */
  refreshing: boolean
  /** a next page is being fetched */
  loadingMore: boolean
  /** bumps on every change of this entry */
  version: number
}

export interface QueryOptions {
  /** page the result (unbounded rows): first page size */
  pageSize?: number
  /** who wants the result; moving an owner to another plan releases the previous one (cancel when unwanted) */
  owner?: string
}

export interface QueryCacheDeps {
  post(plan: QueryPlan, signal: AbortSignal): Promise<QueryV2Response>
  /** wire rows -> formula rows */
  toRows(plan: QueryPlan, rows: QueryV2Response['rows']): Row[]
  /** apply the table's pending optimistic writes to confirmed rows (identity when none) */
  overlay(table: string, rows: Row[], plan: QueryPlan, paged: boolean, complete: boolean): Row[]
  onChange(keys: string[]): void
  /** most entries kept (least recently used dropped first) */
  maxEntries?: number
}

interface Entry {
  key: string
  plan: QueryPlan
  table: string
  paged: boolean
  pageSize: number
  status: QueryStatus
  confirmed: Row[]
  rows: Row[]
  count?: number
  nextCursor: string | null
  truncated?: boolean
  error?: PlatformError
  stale: boolean
  refreshing: boolean
  loadingMore: boolean
  version: number
  owners: Set<string>
  lastUsed: number
  inflight: { promise: Promise<void>; ctl: AbortController; kind: 'load' | 'more' } | null
  generation: number
  snapshot: QueryState | null
}

/** stable JSON (object keys sorted) */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const o = v as Record<string, unknown>
  return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}'
}

/** cache key of a plan (paging is the cache's business, not part of the key) */
export function planKey(plan: QueryPlan): string {
  const { page: _page, ...rest } = plan
  void _page
  return stableStringify(rest)
}

const isPaged = (plan: QueryPlan, opts: QueryOptions) => !!opts.pageSize && !plan.aggregate && !plan.single

/** the cache key of a plan read with these options: a paged list and a whole answer of one plan are different entries */
export function cacheKey(plan: QueryPlan, opts: QueryOptions = {}): string {
  return (isPaged(plan, opts) ? 'p:' : '') + planKey(plan)
}

const isAbort = (e: unknown) => (e instanceof DOMException && e.name === 'AbortError') || (e instanceof Error && e.name === 'AbortError')

export class QueryCache {
  private entries = new Map<string, Entry>()
  private ownerKey = new Map<string, string>()
  private clock = 0
  private deps: QueryCacheDeps
  private max: number

  constructor(deps: QueryCacheDeps) {
    this.deps = deps
    this.max = deps.maxEntries ?? 300
  }

  /* -------------------------------------------------------------- reads */

  /** current state of a plan; starts (or refreshes) the fetch when needed. Never throws. */
  get(plan: QueryPlan, opts: QueryOptions = {}): QueryState {
    const e = this.entry(plan, opts)
    if (e.status !== 'error' && (e.stale || (e.status === 'loading' && !e.inflight)) && !e.inflight) this.load(e)
    return this.state(e)
  }

  /** the state without starting anything (undefined when never requested) */
  peek(plan: QueryPlan, opts: QueryOptions = {}): QueryState | undefined {
    const e = this.entries.get(cacheKey(plan, opts))
    return e ? this.state(e) : undefined
  }

  /** the complete answer (actions): waits for an in-flight or fresh fetch; throws the server's error */
  async fetch(plan: QueryPlan, opts: QueryOptions = {}): Promise<QueryState> {
    const e = this.entry(plan, opts)
    if (e.inflight?.kind === 'load') await e.inflight.promise.catch(() => {})
    else if (e.stale || e.status !== 'ready') await this.load(e).catch(() => {})
    if (e.status === 'error') throw e.error ?? new PlatformError('storage', 'The query failed.')
    return this.state(e)
  }

  /** the state of a key, if cached */
  byKey(key: string): QueryState | undefined {
    const e = this.entries.get(key)
    return e ? this.state(e) : undefined
  }

  /** paged entries: fetch the next page (no-op when everything is loaded or a page is already coming) */
  loadMore(key: string): Promise<void> {
    const e = this.entries.get(key)
    if (!e || !e.paged || !e.nextCursor || e.inflight) return e?.inflight?.promise ?? Promise.resolve()
    const ctl = new AbortController()
    const cursor = e.nextCursor
    const gen = e.generation
    e.loadingMore = true
    this.changed([e])
    const promise = (async () => {
      try {
        // the exact count came with the first page; later pages don't count again
        const res = await this.deps.post({ ...e.plan, count: undefined, page: { size: e.pageSize, cursor } }, ctl.signal)
        if (gen !== e.generation || this.entries.get(e.key) !== e) return
        e.confirmed = [...e.confirmed, ...this.deps.toRows(e.plan, res.rows)]
        e.nextCursor = res.nextCursor ?? null
        if (res.count !== undefined) e.count = res.count
        if (res.truncated) e.truncated = true
      } catch (err) {
        if (!isAbort(err) && gen === e.generation) e.error = toPlatformError(err)
      } finally {
        if (e.inflight?.ctl === ctl) e.inflight = null
        e.loadingMore = false
        this.recompute(e)
        this.changed([e])
      }
    })()
    e.inflight = { promise, ctl, kind: 'more' }
    return promise
  }

  /** release an owner (a control unmounted, a property no longer reads a plan) */
  release(owner: string): void {
    const key = this.ownerKey.get(owner)
    if (key === undefined) return
    this.ownerKey.delete(owner)
    const e = this.entries.get(key)
    if (!e) return
    e.owners.delete(owner)
    if (!e.owners.size && e.inflight) {
      e.inflight.ctl.abort()
      e.inflight = null
      e.loadingMore = false
      if (e.status === 'loading') { this.entries.delete(e.key); return }
      e.stale = true
    }
  }

  /* -------------------------------------------------------------- writes */

  /**
   * The rows of `table` changed on the server (a write was confirmed, or a table-changed message): every entry of the
   * table becomes stale. Watched entries refetch now (previous rows stay visible); unwatched ones are dropped.
   */
  invalidateTable(table: string): void {
    const touched: Entry[] = []
    for (const e of [...this.entries.values()]) {
      if (e.table.toLowerCase() !== table.toLowerCase()) continue
      e.generation++
      if (e.inflight) { e.inflight.ctl.abort(); e.inflight = null; e.loadingMore = false }
      if (!e.owners.size && e.status !== 'loading') { this.entries.delete(e.key); continue }
      e.stale = true
      touched.push(e)
    }
    for (const e of touched) this.load(e)
    if (touched.length) this.changed(touched)
  }

  /** everything (sign-out, environment switch) */
  clear(): void {
    for (const e of this.entries.values()) e.inflight?.ctl.abort()
    this.entries.clear()
    this.ownerKey.clear()
  }

  /** pending optimistic writes of a table changed: re-apply the overlay */
  opsChanged(table: string): void {
    const touched: Entry[] = []
    for (const e of this.entries.values()) {
      if (e.table.toLowerCase() !== table.toLowerCase() || e.status !== 'ready') continue
      this.recompute(e)
      touched.push(e)
    }
    if (touched.length) this.changed(touched)
  }

  /**
   * Fold a confirmed write into the cached rows (so the screen keeps the change while the refetch runs):
   * update -> the row's new values; delete -> rows removed (counts follow); create -> appended where the entry
   * is an unfiltered, unsorted list that is completely loaded.
   */
  fold(table: string, w: { kind: 'update'; row: Row } | { kind: 'delete'; ids: Set<string> } | { kind: 'create'; row: Row }): void {
    for (const e of this.entries.values()) {
      if (e.table.toLowerCase() !== table.toLowerCase() || e.status !== 'ready' || e.plan.aggregate) continue
      if (w.kind === 'update') {
        e.confirmed = e.confirmed.map((r) => (r.__id === w.row.__id ? mergeRow(r, w.row) : r))
      } else if (w.kind === 'delete') {
        const before = e.confirmed.length
        e.confirmed = e.confirmed.filter((r) => !w.ids.has(String(r.__id)))
        if (e.count !== undefined) e.count = Math.max(0, e.count - (before - e.confirmed.length))
      } else if (appendable(e)) {
        if (!e.confirmed.some((r) => r.__id === w.row.__id)) {
          e.confirmed = [...e.confirmed, w.row]
          if (e.count !== undefined) e.count++
        }
      }
      this.recompute(e)
    }
  }

  /** a cached row by id (rows the user is looking at but that the full-table cache does not hold) */
  findRow(table: string, id: string): Row | undefined {
    for (const e of this.entries.values()) {
      if (e.table.toLowerCase() !== table.toLowerCase() || e.plan.aggregate || e.plan.select) continue
      const r = e.rows.find((x) => x.__id === id)
      if (r) return r
    }
    return undefined
  }

  size(): number { return this.entries.size }

  /* -------------------------------------------------------------- internals */

  private entry(plan: QueryPlan, opts: QueryOptions): Entry {
    const key = cacheKey(plan, opts)
    let e = this.entries.get(key)
    if (!e) {
      const paged = isPaged(plan, opts)
      e = {
        key, plan: { ...plan, page: undefined }, table: plan.table, paged, pageSize: Math.max(1, Math.min(QUERY_MAX_PAGE_SIZE, Math.trunc(opts.pageSize ?? 100))),
        status: 'loading', confirmed: [], rows: [], nextCursor: null, stale: false, refreshing: false, loadingMore: false, version: 0,
        owners: new Set(), lastUsed: 0, inflight: null, generation: 0, snapshot: null,
      }
      delete e.plan.page
      this.entries.set(key, e)
      this.evict()
    }
    e.lastUsed = ++this.clock
    if (opts.owner) {
      const prev = this.ownerKey.get(opts.owner)
      if (prev !== key) {
        if (prev !== undefined) this.release(opts.owner)
        this.ownerKey.set(opts.owner, key)
      }
      e.owners.add(opts.owner)
    }
    return e
  }

  private load(e: Entry): Promise<void> {
    if (e.inflight?.kind === 'load') return e.inflight.promise
    if (e.inflight) { e.inflight.ctl.abort(); e.inflight = null; e.loadingMore = false }
    const ctl = new AbortController()
    const gen = e.generation
    const wasReady = e.status === 'ready'
    e.stale = false
    e.refreshing = wasReady
    const promise = (async () => {
      try {
        let rows: Row[] = []
        let count: number | undefined
        let next: string | null = null
        let truncated = false
        if (e.paged) {
          // a refresh reloads as many rows as were on screen, page by page
          const want = Math.max(e.pageSize, wasReady ? e.confirmed.length : 0)
          let cursor: string | undefined
          do {
            const size = Math.min(QUERY_MAX_PAGE_SIZE, Math.max(e.pageSize, want - rows.length))
            const res = await this.deps.post({ ...e.plan, count: cursor ? undefined : true, page: { size, cursor } }, ctl.signal)
            if (gen !== e.generation) return
            rows = rows.concat(this.deps.toRows(e.plan, res.rows))
            if (res.count !== undefined) count = res.count
            next = res.nextCursor ?? null
            truncated ||= !!res.truncated
            cursor = next ?? undefined
          } while (next && rows.length < want)
        } else {
          const plan = e.plan.count && !e.plan.aggregate && !e.plan.single && !e.plan.take && !e.plan.select ? { ...e.plan, page: { size: 0 } } : e.plan
          const res = await this.deps.post(plan, ctl.signal)
          if (gen !== e.generation) return
          rows = this.deps.toRows(e.plan, res.rows)
          count = res.count
          truncated = !!res.truncated
        }
        e.confirmed = rows
        e.count = count
        e.nextCursor = next
        e.truncated = truncated || undefined
        e.status = 'ready'
        e.error = undefined
      } catch (err) {
        if (isAbort(err) || gen !== e.generation) return
        e.error = toPlatformError(err)
        // a failed refresh keeps the previous rows; a first load shows the error
        if (!wasReady) e.status = 'error'
      } finally {
        if (e.inflight?.ctl === ctl) e.inflight = null
        if (gen === e.generation) {
          e.refreshing = false
          this.recompute(e)
          this.changed([e])
        }
      }
    })()
    e.inflight = { promise, ctl, kind: 'load' }
    return promise
  }

  private recompute(e: Entry): void {
    e.rows = this.deps.overlay(e.table, e.confirmed, e.plan, e.paged, !e.nextCursor)
    e.version++
    e.snapshot = null
  }

  private state(e: Entry): QueryState {
    if (e.snapshot && e.snapshot.version === e.version) return e.snapshot
    e.snapshot = {
      key: e.key, plan: e.plan, status: e.status, rows: e.rows, count: e.count, hasMore: e.paged && !!e.nextCursor, truncated: e.truncated,
      error: e.error, refreshing: e.refreshing, loadingMore: e.loadingMore, version: e.version,
    }
    return e.snapshot
  }

  private changed(list: Entry[]): void {
    for (const e of list) { e.version++; e.snapshot = null }
    try {
      this.deps.onChange(list.map((e) => e.key))
    } catch (err) {
      console.error('[query cache] listener failed', err)
    }
  }

  private evict(): void {
    if (this.entries.size <= this.max) return
    const idle = [...this.entries.values()].filter((e) => !e.owners.size && !e.inflight).sort((a, b) => a.lastUsed - b.lastUsed)
    for (const e of idle) {
      if (this.entries.size <= this.max) break
      this.entries.delete(e.key)
    }
  }
}

function appendable(e: Entry): boolean {
  const p = e.plan
  return !p.filter && !p.search && !p.sort?.length && !p.take && !p.aggregate && !p.single && !e.nextCursor
}

function mergeRow(old: Row, next: Row): Row {
  const out: Row = { ...old }
  for (const k of Object.keys(old)) if (Object.prototype.hasOwnProperty.call(next, k)) out[k] = next[k]!
  return out
}

function toPlatformError(e: unknown): PlatformError {
  if (e instanceof PlatformError) return e
  return new PlatformError('storage', e instanceof Error ? e.message : String(e))
}
