/**
 * Test harness for the metadata API: an in-memory MetaStore and connector, plus a tiny router that calls
 * handlers directly (with the real auth-level rules). The real SecurityEngine, DataService and
 * ConnectionManager from server/core run on top, so semantics match production. Not used at runtime.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppMeta, ColumnDef, ConnectionRef, DataFileDef, RoleDef, SolutionDef, TableDef, UserDef } from '../../../src/platform/contracts.ts'
import type { AppDef } from '../../../src/contracts.ts'
import type { Condition, Query } from '../../../src/platform/http.ts'
import { HttpError } from '../../core/contracts.ts'
import type {
  AttachmentRecord, Connector, ConnectionRecord, ConnectorEnv, ConnectorFactory, Ctx, Handler, MetaStore, RawRow, RouteOptions, Router, Services,
  SourceColumn, SqlDb, UserRecord,
} from '../../core/contracts.ts'
import { applyQuery, evaluateCondition } from '../../core/condition.ts'
import { createSecretBox } from '../../core/secrets.ts'
import { createSecurityEngine } from '../../core/security.ts'
import { createConnectionManager } from '../../core/connections.ts'
import { createDataService } from '../../core/data.ts'
import { createAttachmentStore } from '../../core/attachment-store.ts'
import { createFilesConnector } from '../../connectors/files/index.ts'
import { metaRoutes } from './index.ts'
import { dataRoutes } from '../../core/data-routes.ts'
import type { ApiRouter } from '../../core/router.ts'
import type { CoreServices } from '../../core/services.ts'

const clone = <T>(v: T): T => structuredClone(v)

/* ------------------------------------------------------------------ in-memory MetaStore */

export class FakeMetaStore implements MetaStore {
  counters = new Map<string, number>()
  auditLog: { userId: string | null; action: string; tableId?: string; rowId?: string; details?: unknown }[] = []
  private u = new Map<string, UserRecord>()
  private r = new Map<string, RoleDef>()
  private t = new Map<string, TableDef>()
  private a = new Map<string, { meta: AppMeta; definition: AppDef }>()
  private c = new Map<string, ConnectionRecord>()
  private s = new Map<string, SolutionDef>()
  private f = new Map<string, DataFileDef & { storageKey: string; originalName: string }>()
  private att = new Map<string, AttachmentRecord>()
  sessionsLog = new Map<string, { userId: string; expiresOn: Date }>()

  db: SqlDb = {
    query: async () => [],
    exec: async (sql: string, params: unknown[] = []) => {
      if (/INSERT INTO ab_counters/i.test(sql)) {
        const k = String(params[0])
        this.counters.set(k, Math.max(this.counters.get(k) ?? 0, Number(params[1])))
      }
      return { affectedRows: 1 }
    },
    tx: async (fn) => fn(this.db),
    serverVersion: async () => 'Fake 1.0',
    close: async () => {},
  }
  async migrate() {}

  users = {
    list: async () => [...this.u.values()].map(clone),
    get: async (id: string) => clone(this.u.get(id) ?? null),
    byEmail: async (email: string) => clone([...this.u.values()].find((x) => x.email.toLowerCase() === email.toLowerCase()) ?? null),
    count: async () => this.u.size,
    insert: async (x: UserRecord) => { this.u.set(x.id, clone(x)) },
    update: async (id: string, patch: Partial<UserRecord>) => { this.u.set(id, { ...this.u.get(id)!, ...clone(patch) }) },
    remove: async (id: string) => { this.u.delete(id) },
  }
  sessions = {
    insert: async (x: { idHash: string; userId: string; expiresOn: Date; userAgent: string }) => { this.sessionsLog.set(x.idHash, { userId: x.userId, expiresOn: x.expiresOn }) },
    get: async (h: string) => this.sessionsLog.get(h) ?? null,
    touch: async () => {},
    remove: async (h: string) => { this.sessionsLog.delete(h) },
    removeForUser: async (userId: string) => { for (const [k, v] of this.sessionsLog) if (v.userId === userId) this.sessionsLog.delete(k) },
    purgeExpired: async () => 0,
  }
  roles = {
    list: async () => [...this.r.values()].map(clone),
    get: async (id: string) => clone(this.r.get(id) ?? null),
    upsert: async (x: RoleDef) => { this.r.set(x.id, clone(x)) },
    remove: async (id: string) => { this.r.delete(id) },
  }
  tables = {
    list: async () => [...this.t.values()].map(clone),
    get: async (k: string) => clone(this.t.get(k) ?? [...this.t.values()].find((x) => x.name.toLowerCase() === k.toLowerCase()) ?? null),
    upsert: async (x: TableDef) => { this.t.set(x.id, clone(x)) },
    remove: async (id: string) => { this.t.delete(id) },
  }
  apps = {
    list: async () => [...this.a.values()].map((x) => clone(x.meta)),
    get: async (id: string) => clone(this.a.get(id) ?? null),
    upsert: async (meta: AppMeta, definition: AppDef) => { this.a.set(meta.id, clone({ meta, definition })) },
    remove: async (id: string) => { this.a.delete(id) },
  }
  connections = {
    list: async () => [...this.c.values()].map(clone),
    get: async (id: string) => clone(this.c.get(id) ?? null),
    upsert: async (x: ConnectionRecord) => { this.c.set(x.id, clone(x)) },
    remove: async (id: string) => { this.c.delete(id) },
  }
  solutions = {
    list: async () => [...this.s.values()].map(clone),
    upsert: async (x: SolutionDef) => { this.s.set(x.id, clone(x)) },
    remove: async (id: string) => { this.s.delete(id) },
  }
  files = {
    list: async () => [...this.f.values()].map(clone),
    get: async (id: string) => clone(this.f.get(id) ?? null),
    upsert: async (x: DataFileDef & { storageKey: string; originalName: string }) => { this.f.set(x.id, clone(x)) },
    remove: async (id: string) => { this.f.delete(id) },
  }
  attachments = {
    get: async (id: string) => this.att.get(id) ?? null,
    many: async (ids: string[]) => ids.map((i) => this.att.get(i)).filter((x): x is AttachmentRecord => !!x),
    insert: async (x: AttachmentRecord) => { this.att.set(x.id, x) },
    remove: async (id: string) => { this.att.delete(id) },
    forRows: async (tableId: string, rowIds: string[]) => [...this.att.values()].filter((x) => x.tableId === tableId && rowIds.includes(x.rowId)),
  }
  async nextCounter(key: string) {
    const n = (this.counters.get(key) ?? 0) + 1
    this.counters.set(key, n)
    return n
  }
  async audit(e: { userId: string | null; action: string; tableId?: string; rowId?: string; details?: unknown }) { this.auditLog.push(e) }
}

/* ------------------------------------------------------------------ in-memory connector ("mysql" stand-in) */

export class MemoryConnector implements Connector {
  readonly kind = 'mysql' as const
  readonly capabilities = { ddl: true, write: true, pushdown: false, transactions: false }
  tablesBySource = new Map<string, { def: TableDef; rows: RawRow[] }>()
  external = new Map<string, { columns: SourceColumn[]; rows: RawRow[] }>()
  ops: string[] = []
  failTest: string | null = null
  async test() { return this.failTest ? { ok: false as const, message: this.failTest } : { ok: true as const, message: 'MemoryDB 1.0' } }
  async listSourceTables() {
    return [
      ...[...this.tablesBySource].map(([source, t]) => ({ source, columns: t.def.columns.map((c) => ({ name: c.name, type: c.type })), rowCount: t.rows.length })),
      ...[...this.external].map(([source, t]) => ({ source, columns: t.columns, rowCount: t.rows.length })),
    ]
  }
  async describe(source: string) {
    const e = this.external.get(source)
    if (e) return e.columns
    return (this.tablesBySource.get(source)?.def.columns ?? []).map((c) => ({ name: c.name, type: c.type }))
  }
  private tbl(def: TableDef) {
    const t = this.tablesBySource.get(def.source!)
    if (!t) throw new Error(`no such table ${def.source}`)
    return t
  }
  async createTable(def: TableDef) {
    if (this.tablesBySource.has(def.source!)) throw new Error(`table ${def.source} exists`)
    this.ops.push(`create:${def.source}`)
    this.tablesBySource.set(def.source!, { def: clone(def), rows: [] })
  }
  async addColumn(def: TableDef, col: ColumnDef) {
    this.ops.push(`addColumn:${def.source}.${col.name}`)
    const t = this.tablesBySource.get(def.source!)
    if (t) for (const r of t.rows) r[col.name] = null
    else {
      const e = this.external.get(def.source!)
      if (e) { e.columns.push({ name: col.name, type: col.type }); for (const r of e.rows) r[col.name] = null }
    }
  }
  async alterColumn(def: TableDef, before: ColumnDef, after: ColumnDef) { this.ops.push(`alterColumn:${def.source}.${before.name}->${after.type}`) }
  async dropColumn(def: TableDef, name: string) {
    this.ops.push(`dropColumn:${def.source}.${name}`)
    for (const r of this.tbl(def).rows) delete r[name]
  }
  async dropTable(def: TableDef) { this.ops.push(`drop:${def.source}`); this.tablesBySource.delete(def.source!) }
  async select(def: TableDef, q: Query) {
    const t = this.tablesBySource.get(def.source!) ?? { rows: this.external.get(def.source!)?.rows ?? [] }
    return applyQuery(t.rows.map((r) => ({ ...r })), q)
  }
  async insert(def: TableDef, rows: RawRow[]) {
    const t = this.tablesBySource.get(def.source!) ?? { rows: this.external.get(def.source!)?.rows ?? [] }
    for (const r of rows) t.rows.push({ ...r })
  }
  async update(def: TableDef, id: string, changes: RawRow, guard?: Condition) {
    const t = this.tablesBySource.get(def.source!) ?? { rows: this.external.get(def.source!)?.rows ?? [] }
    const row = t.rows.find((r) => r.id === id)
    if (!row || (guard && !evaluateCondition(guard, row))) return 0
    Object.assign(row, changes)
    return 1
  }
  async delete(def: TableDef, ids: string[], guard?: Condition) {
    const t = this.tbl(def)
    const keep = t.rows.filter((r) => !(ids.includes(String(r.id)) && (!guard || evaluateCondition(guard, r))))
    const n = t.rows.length - keep.length
    t.rows = keep
    return n
  }
  async close() {}
}

/* ------------------------------------------------------------------ router */

interface Reg { method: string; segs: string[]; handler: Handler; opts: RouteOptions }

export class FakeRouter implements Router {
  regs: Reg[] = []
  add(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', pattern: string, handler: Handler, opts: RouteOptions) {
    // like server/core/router.ts: patterns with or without the /api/v1 prefix
    this.regs.push({ method, segs: pattern.replace(/^\/api\/v1(?=\/|$)/, '').split('/').filter(Boolean), handler, opts })
  }
  find(method: string, pathname: string) {
    const segs = pathname.replace(/^\/api\/v1(?=\/|$)/, '').split('/').filter(Boolean)
    let best: { r: Reg; params: Record<string, string>; lit: number } | null = null
    for (const r of this.regs) {
      if (r.method !== method || r.segs.length !== segs.length) continue
      const params: Record<string, string> = {}
      let ok = true
      let lit = 0
      r.segs.forEach((s, i) => {
        if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(segs[i])
        else if (s === segs[i]) lit++
        else ok = false
      })
      if (ok && (!best || lit > best.lit)) best = { r, params, lit }
    }
    return best
  }
}

export interface CallResult<T = any> { status: number; body: T; code?: string; raw?: { headers?: Record<string, string>; body: Buffer | string } }

export interface Harness {
  services: Services
  router: FakeRouter
  meta: FakeMetaStore
  mem: MemoryConnector
  dir: string
  ids: { admin: string; maker: string; viewer: string }
  call(as: string | null, method: string, url: string, body?: unknown, opts?: { raw?: Buffer }): Promise<CallResult>
  cleanup(): void
}

export async function makeHarness(opts: { workspace?: (dir: string) => void } = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-meta-'))
  if (opts.workspace) opts.workspace(dir)
  const meta = new FakeMetaStore()
  const mem = new MemoryConnector()
  const config = { workspaceDir: dir, filesDir: path.join(dir, 'files'), attachmentsDir: path.join(dir, 'attachments'), host: '127.0.0.1', port: 0, distDir: path.join(dir, 'dist') }
  fs.mkdirSync(config.filesDir, { recursive: true })
  const env: ConnectorEnv = { workspaceDir: dir, filesDir: config.filesDir, fetch: globalThis.fetch, log: () => {} }
  const getMeta = () => meta as MetaStore
  const connections = createConnectionManager(getMeta, env)
  const memFactory: ConnectorFactory = () => mem
  connections.register('mysql', memFactory)
  connections.register('files', createFilesConnector)
  const security = createSecurityEngine(getMeta)
  const attachments = createAttachmentStore(config.attachmentsDir)
  const data = createDataService({ meta: getMeta, connections, attachments, log: env.log })
  let n = 0
  const services = {
    config, secrets: createSecretBox(Buffer.alloc(32, 7)), ready: () => true, meta, security, data, connections, attachments, env,
    uid: (p?: string) => `${p ?? 'id'}_${(++n).toString(16).padStart(8, '0')}`, now: () => new Date().toISOString(),
  } as unknown as Services

  await meta.connections.upsert({ id: 'conn_default', name: 'Default database', connector: 'mysql', status: 'connected', settings: { host: 'x', port: '3306', database: 'x', user: 'x', ssl: 'false' }, secret: 'pw', isDefault: true, scope: 'server' })
  await meta.connections.upsert({ id: 'conn_files', name: 'Data files', connector: 'files', status: 'connected', settings: {}, isDefault: false, scope: 'device' })
  await meta.roles.upsert({ id: 'role_admin', name: 'Administrator', isAdmin: true, privileges: [], apps: 'all' })
  await meta.roles.upsert({ id: 'role_maker', name: 'Maker', isMaker: true, privileges: [], apps: 'all' } as RoleDef)
  await meta.roles.upsert({ id: 'role_viewer', name: 'Viewer', privileges: [], apps: 'all' })
  const mk = (id: string, name: string, role: string): UserRecord => ({ id, name, email: `${id}@example.test`, roleIds: [role], status: 'active', passwordHash: null })
  await meta.users.insert(mk('user_admin', 'Ada Admin', 'role_admin'))
  await meta.users.insert(mk('user_maker', 'Mia Maker', 'role_maker'))
  await meta.users.insert(mk('user_viewer', 'Vic Viewer', 'role_viewer'))

  const router = new FakeRouter()
  // core data routes too (same registration order as server/core/app.ts), e.g. GET /tables/:id/csv
  dataRoutes(router as unknown as ApiRouter, services as unknown as CoreServices)
  metaRoutes(router, services)

  async function call(as: string | null, method: string, url: string, body?: unknown, o: { raw?: Buffer } = {}): Promise<CallResult> {
    const u = new URL(url, 'http://localhost')
    const found = router.find(method, u.pathname)
    if (!found) return { status: 404, body: { error: { code: 'not-found', message: `no route ${method} ${u.pathname}` } }, code: 'not-found' }
    const { r, params } = found
    try {
      let user
      if (r.opts.auth !== 'none') {
        const rec = as ? await meta.users.get(as) : null
        if (!rec) throw new HttpError(401, 'unauthenticated', 'Please sign in.')
        const { passwordHash, ...def } = rec
        user = await security.forUser({ ...def, hasPassword: !!passwordHash } as UserDef)
        if (r.opts.auth === 'admin' && !user.privileges.isAdmin) throw new HttpError(403, 'denied', 'Administrators only.')
        if (r.opts.auth === 'maker' && !user.privileges.isMaker && !user.privileges.isAdmin) throw new HttpError(403, 'denied', 'Makers only.')
      }
      const ctx = {
        req: {}, res: {}, method, path: u.pathname, params, query: u.searchParams, body: r.opts.raw ? undefined : body, rawBody: o.raw, user, services,
        setSessionCookie: () => {},
      } as unknown as Ctx
      const out = await r.handler(ctx)
      if (out && typeof out === 'object' && (out as { raw?: boolean }).raw === true) {
        const ro = out as { status?: number; headers?: Record<string, string>; body: Buffer | string }
        return { status: ro.status ?? 200, body: undefined, raw: { headers: ro.headers, body: ro.body } }
      }
      return { status: 200, body: out === undefined ? null : JSON.parse(JSON.stringify(out)) }
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, code: e.code, body: { error: { code: e.code, message: e.message, field: e.field } } }
      throw e
    }
  }

  return {
    services, router, meta, mem, dir, ids: { admin: 'user_admin', maker: 'user_maker', viewer: 'user_viewer' }, call,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

export type { ConnectionRef }
