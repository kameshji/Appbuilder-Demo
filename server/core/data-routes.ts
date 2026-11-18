/**
 * Data routes (security enforced by the DataService) and GET /workspace.
 *   POST /data/:table/query   POST /data/:table/rows   PATCH /data/:table/rows/:id
 *   POST /data/:table/delete  POST /data/:table/import GET /tables/:id/csv   GET /workspace
 */
import { HttpError } from './contracts.ts'
import type { Ctx, UserContext } from './contracts.ts'
import type { DataFileDef, TableDef } from '../../src/platform/contracts.ts'
import type { QueryResponse, RowResponse, WorkspaceResponse } from '../../src/platform/http.ts'
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
    return { row: await services.data.update(ctx.user!, t, ctx.params.id, (b.changes ?? {}) as never) }
  }, { auth: 'user' })

  router.add('POST', '/data/:table/delete', async (ctx) => {
    const t = await tableParam(services, ctx.params.table)
    ensureTableVisible(ctx.user!, t)
    const b = body(ctx)
    if (!Array.isArray(b.ids)) throw new HttpError(422, 'invalid', 'ids must be a list of row ids.', 'ids')
    return { deleted: await services.data.delete(ctx.user!, t, b.ids as string[]) }
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
      tables: tables.filter((t) => isMaker || hasAnyTableAccess(user, t)).map((t) => user.visibleDef(t)),
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
  }, { auth: 'user' })
}
