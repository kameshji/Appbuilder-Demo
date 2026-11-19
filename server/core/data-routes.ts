/**
 * Data routes (security enforced by the DataService) and GET /workspace.
 *   POST /data/:table/query   POST /data/:table/rows   PATCH /data/:table/rows/:id
 *   POST /data/:table/delete  POST /data/:table/import GET /tables/:id/csv   GET /workspace
 *   recycle bin: GET /data/:table/deleted  POST /data/:table/restore  POST /data/:table/purge  GET /data/:table/recycle
 */
import { HttpError } from './contracts.ts'
import type { Ctx, UserContext } from './contracts.ts'
import type { DataFileDef, TableDef } from '../../src/platform/contracts.ts'
import type { QueryResponse, RowResponse, WorkspaceResponse } from '../../src/platform/http.ts'
import type { QueryV2Response } from '../../src/platform/query.ts'
import type { ApiRouter } from './router.ts'
import type { CoreServices } from './services.ts'
import { hasAnyTableAccess } from './security.ts'
import { toConnectionRef } from './connections.ts'
import { toUserDef } from './auth.ts'
import { listEnvironments } from './environments.ts'

export async function tableParam(services: CoreServices, idOrName: string): Promise<TableDef> {
  const t = idOrName ? await services.meta.tables.get(idOrName) : null
  if (!t) throw new HttpError(404, 'not-found', `Table "${idOrName}" does not exist.`)
  return t
}

function body(ctx: Ctx): Record<string, unknown> {
  const b = ctx.body
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(422, 'invalid', 'Request body must be a JSON object.')
  return b as Record<string, unknown>
}

/** tables the user is not allowed to know about at all answer 404 (no existence leak) */
function ensureTableVisible(user: UserContext, t: TableDef): void {
  if (!user.privileges.isMaker && !hasAnyTableAccess(user, t)) throw new HttpError(404, 'not-found', `Table "${t.name}" does not exist.`)
}

function csvFileName(name: string): string {
  return `${name.replace(/[^A-Za-z0-9_-]+/g, '_') || 'table'}.csv`
}

export function dataRoutes(router: ApiRouter, services: CoreServices): void {
  /**
   * Data API v2 query (docs/dev/data-api.md, docs/dev/query-v2.md): body { plan }. The table is plan.table (name or id).
   * RBAC, the caller's row scope and row filters, and column-level security are applied by the DataService.
   */
  router.add('POST', '/query', async (ctx): Promise<QueryV2Response> => {
    const b = body(ctx)
    const plan = b.plan
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new HttpError(422, 'invalid', 'The body must be { plan }.', 'plan')
    const name = (plan as { table?: unknown }).table
    if (typeof name !== 'string' || !name) throw new HttpError(422, 'invalid', 'The plan needs a table.', 'plan.table')
    const t = await tableParam(services, name)
    ensureTableVisible(ctx.user!, t)
    return services.data.queryV2(ctx.user!, t, plan)
  }, { auth: 'user' })

  router.add('POST', '/data/:table/query', async (ctx): Promise<QueryResponse> => {
    const t = await tableParam(services, ctx.params.table)
    ensureTableVisible(ctx.user!, t)
    const res = await services.data.query(ctx.user!, t, (ctx.body ?? {}) as never)
    const out: QueryResponse = { rows: res.rows, truncated: res.truncated }
    if (res.total !== undefined) out.total = res.total
    return out
  }, { auth: 'user' })

  router.add('POST', '/data/:table/rows', async (ctx): Promise<RowResponse> => {
    const t = await tableParam(services, ctx.params.table)
    ensureTableVisible(ctx.user!, t)
    const b = body(ctx)
    return { row: await services.data.insert(ctx.user!, t, (b.values ?? {}) as never) }
  }, { auth: 'user' })

  router.add('PATCH', '/data/:table/rows/:id', async (ctx): Promise<RowResponse> => {
    const t = await tableParam(services, ctx.params.table)
    ensureTableVisible(ctx.user!, t)
    const b = body(ctx)
    // ifModifiedOn: optimistic concurrency (a stale save answers 409 with the current row)
    const opts = b.ifModifiedOn !== undefined && b.ifModifiedOn !== null ? { ifModifiedOn: b.ifModifiedOn as string } : undefined
    return { row: await services.data.update(ctx.user!, t, ctx.params.id, (b.changes ?? {}) as never, opts) }
  }, { auth: 'user' })

  router.add('POST', '/data/:table/delete', async (ctx) => {
    const t = await tableParam(services, ctx.params.table)
    ensureTableVisible(ctx.user!, t)
    const b = body(ctx)
    if (!Array.isArray(b.ids)) throw new HttpError(422, 'invalid', 'ids must be a list of row ids.', 'ids')
    // batch: the recycle bin's handle for "Undo" (null when the table keeps no deleted rows: the delete was final)
    const res = await services.data.deleteRows(ctx.user!, t, b.ids as string[], { source: 'user' })
    return res.batch ? { deleted: res.deleted, batch: res.batch } : { deleted: res.deleted }
  }, { auth: 'user' })

  /* ---------------------------------------------------------------- recycle bin (docs/dev/recycle-bin.md) */

  /** the Deleted view: deleted rows the caller could delete and can see (administrators: all), newest first */
  router.add('GET', '/data/:table/deleted', async (ctx) => {
    const t = await tableParam(services, ctx.params.table)
    ensureTableVisible(ctx.user!, t)
    const num = (k: string) => (ctx.query.get(k) === null ? undefined : Number(ctx.query.get(k)))
    return services.data.recycle.listDeleted(ctx.user!, t, { limit: num('limit'), skip: num('skip'), batch: ctx.query.get('batch') ?? undefined })
  }, { auth: 'user' })

  /** restore a batch (default: the whole delete operation) or one row of it: { batch } | { rowId } */
  router.add('POST', '/data/:table/restore', async (ctx) => {
    const t = await tableParam(services, ctx.params.table)
    ensureTableVisible(ctx.user!, t)
    const b = body(ctx)
    const batch = typeof b.batch === 'string' && b.batch ? b.batch : undefined
    const rowId = typeof b.rowId === 'string' && b.rowId ? b.rowId : undefined
    if (!batch && !rowId) throw new HttpError(422, 'invalid', 'Say what to restore: { batch } or { rowId }.', 'batch')
    return services.data.restore(ctx.user!, t, { batch, rowId })
  }, { auth: 'user' })

  /** restore a batch by its id alone (formulas: Restore(batch)); the batch's own table decides who may */
  router.add('POST', '/recycle/restore', async (ctx) => {
    const b = body(ctx)
    if (typeof b.batch !== 'string' || !b.batch) throw new HttpError(422, 'invalid', 'Say which batch to restore: { batch }.', 'batch')
    const tableId = await services.data.recycle.batchTable(b.batch)
    const t = tableId ? await services.meta.tables.get(tableId) : null
    if (!t) throw new HttpError(404, 'not-found', 'This deletion batch does not exist.')
    ensureTableVisible(ctx.user!, t)
    return services.data.restore(ctx.user!, t, { batch: b.batch })
  }, { auth: 'user' })

  /** administrators: delete for good now, one batch ({ batch }) or the whole bin of the table ({ all: true, confirm: "<table name>" }) */
  router.add('POST', '/data/:table/purge', async (ctx) => {
    const t = await tableParam(services, ctx.params.table)
    ensureTableVisible(ctx.user!, t)
    const b = body(ctx)
    if (b.all === true) return services.data.recycle.emptyTable(ctx.user!, t, b.confirm)
    if (typeof b.batch !== 'string' || !b.batch) throw new HttpError(422, 'invalid', 'Say what to delete for good: { batch } or { all: true, confirm }.', 'batch')
    return services.data.recycle.purgeOne(ctx.user!, t, b.batch)
  }, { auth: 'user' })

  /** the recycle bin of a table: setting, deleted rows and their size (table details), one batch (Undo, Restore(batch)) */
  router.add('GET', '/data/:table/recycle', async (ctx) => {
    const t = await tableParam(services, ctx.params.table)
    ensureTableVisible(ctx.user!, t)
    const batch = ctx.query.get('batch')
    if (batch) return { batch: await services.data.recycle.batchInfo(ctx.user!, t, batch) }
    const st = await services.data.recycle.stats(t)
    // counts and size are table-wide: makers and administrators only; everyone learns whether the bin is on
    const user = ctx.user!
    return user.privileges.isMaker || user.privileges.isAdmin ? st : { enabled: st.enabled, keepDays: st.keepDays }
  }, { auth: 'user' })

  router.add('POST', '/data/:table/import', async (ctx) => {
    const t = await tableParam(services, ctx.params.table)
    ensureTableVisible(ctx.user!, t)
    const b = body(ctx)
    const mode = b.mode === 'replace' ? 'replace' : b.mode === 'append' || b.mode === undefined ? 'append' : null
    if (!mode) throw new HttpError(422, 'invalid', "mode must be 'append' or 'replace'.", 'mode')
    if (typeof b.csv !== 'string') throw new HttpError(422, 'invalid', 'csv must be text.', 'csv')
    return { imported: await services.data.importCsv(ctx.user!, t, b.csv, mode) }
  }, { auth: 'user' })

  router.add('GET', '/tables/:id/csv', async (ctx) => {
    const t = await tableParam(services, ctx.params.id)
    ensureTableVisible(ctx.user!, t)
    const csv = await services.data.exportCsv(ctx.user!, t)
    return {
      raw: true as const,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csvFileName(t.name)}"`,
      },
      body: '﻿' + csv,
    }
  }, { auth: 'user' })

  router.add('GET', '/workspace', async (ctx): Promise<WorkspaceResponse> => {
    const user = ctx.user!
    const meta = services.meta
    const { isAdmin, isMaker } = user.privileges
    const [apps, tables, roles, users, conns, solutions, files, environments] = await Promise.all([
      meta.apps.list(),
      meta.tables.list(),
      isAdmin ? meta.roles.list() : Promise.resolve(user.roles),
      isAdmin ? meta.users.list() : Promise.resolve(null),
      isMaker ? meta.connections.list() : Promise.resolve([]),
      isMaker ? meta.solutions.list() : Promise.resolve([]),
      isMaker ? meta.files.list() : Promise.resolve([]),
      listEnvironments(services, user),
    ])
    const dataFiles: DataFileDef[] = files.map((f) => ({
      id: f.id, connectionId: f.connectionId, fileName: f.fileName, kind: f.kind, sizeBytes: f.sizeBytes,
      checksum: f.checksum, importedOn: f.importedOn, tableIds: f.tableIds, modifiedSinceImport: f.modifiedSinceImport,
    }))
    return {
      apps: isMaker ? apps : apps.filter((a) => user.canRunApp(a.id)),
      // a session without any environment sees no tables (system tables are readable by every member of one)
      tables: environments.length === 0 && !user.privileges.isInstallAdmin ? [] : tables.filter((t) => isMaker || hasAnyTableAccess(user, t)).map((t) => user.visibleDef(t)),
      roles,
      users: users ? users.map(toUserDef) : [user.user],
      connections: conns.map(toConnectionRef),
      solutions,
      dataFiles,
      session: user.session(),
      // host, port and database name: administrators only (like GET /status)
      storage: { kind: 'postgres', location: isAdmin ? (services.state.location ?? '') : 'Server database' },
      environments,
    }
  }, { auth: 'user', noEnvironment: true })
}
