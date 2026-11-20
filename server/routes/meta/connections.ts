/**
 * Connections: CRUD (admin), test / source-tables / link (maker), default store (admin, postgres only).
 * Secrets are handed to the MetaStore (which seals them) and never come back in a response.
 */
import type { ColumnDef, ConnectionRef, ConnectorKind, TableDef } from '../../../src/platform/contracts.ts'
import type { ConnectionRecord, Connector, Router, Services, SourceColumn } from '../../core/contracts.ts'
import { ensureIdColumn } from '../../connectors/gsheets/index.ts'
import { HttpError } from '../../core/contracts.ts'
import { DEFAULT_CONNECTION_ID } from '../../core/connections.ts'
import { currentEnvironment } from '../../core/env-context.ts'
import {
  IDENT, MAX_IDENT, SYSTEM_NAMES, SYSTEM_TABLE_NAMES, bodyObj, conflict, invalid, isObj, notFound, optString, redact, reqString, systemColumns, toIdentifier,
  uniqueIdentifier,
} from './util.ts'
import { FILES_CONNECTION_ID, audit, ensureFilesConnection, friendly, grantDefaults, resolveConnection, toRef } from './tables-core.ts'
import { assertOutboundHost, hostProblem } from '../../core/net-policy.ts'

const KINDS: ConnectorKind[] = ['postgres', 'mysql', 'files', 'gsheets', 'http', 'email', 'whatsapp']
/** kinds that offer actions only (P1 package D, server/core/actions): no tables, tested by their action provider */
const ACTION_KINDS = new Set<string>(['http', 'email', 'whatsapp'])

/** P1-D: settings and secret of an action connection, checked by its provider (base URL, allow-list, auth ...) */
function checkActionConnection(s: Services, kind: ConnectorKind, settings: Record<string, string>, secret: string | undefined): void {
  if (!ACTION_KINDS.has(kind)) return
  const p = (s.actions as unknown as { provider?(k: string): { checkSettings(st: Record<string, string>, sec: string | undefined): string[] } | undefined } | undefined)?.provider?.(kind)
  if (!p) throw invalid(`The "${kind}" connector is not available on this server.`, 'connector')
  if (kind === 'http' && !settings.allowedHosts && settings.baseUrl) {
    try { settings.allowedHosts = new URL(settings.baseUrl).hostname.toLowerCase() } catch { /* reported below */ }
  }
  const problems = p.checkSettings(settings, secret)
  if (problems.length) throw invalid(problems.slice(0, 4).join(' '), 'settings')
}
/** P1-D: the action service's per-connection state (breaker, DNS pins, OAuth token) is dropped on edits and deletes */
function forgetActionState(s: Services, id: string): void {
  const a = s.actions as unknown as { forget?(env: string, id: string): void } | undefined
  a?.forget?.(currentEnvironment().id, id)
}

/** schemas a postgres connection may not name: the system store's own (ab, env_*) and PostgreSQL's catalogs */
const RESERVED_SCHEMA = /^(ab|env_.*|pg_.*|information_schema)$/i

function cleanSettings(kind: ConnectorKind, raw: unknown, base: Record<string, string> = {}): Record<string, string> {
  if (raw !== undefined && !isObj(raw)) throw invalid('"settings" must be an object.', 'settings')
  const out: Record<string, string> = { ...base }
  for (const [k, v] of Object.entries(raw ?? {})) {
    // unknown non-secret settings (e.g. serviceAccountEmail) are kept as given
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)) throw invalid(`"${k}" is not a valid setting name.`, `settings.${k}`)
    if (v === null || v === undefined || typeof v === 'object') throw invalid(`Setting "${k}" must be text.`, `settings.${k}`)
    if (String(v).length > 2000) throw invalid(`Setting "${k}" is too long.`, `settings.${k}`)
    out[k] = String(v).trim()
  }
  if (kind === 'postgres') {
    out.schema ||= 'public'
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(out.schema)) throw invalid('The schema must be a plain name (letters, digits and underscore).', 'settings.schema')
    if (RESERVED_SCHEMA.test(out.schema)) throw invalid(`The schema "${out.schema}" is reserved (Appbuilder's system schemas and PostgreSQL's catalogs cannot be linked).`, 'settings.schema')
  }
  if (kind === 'mysql' || kind === 'postgres') {
    out.port ||= kind === 'mysql' ? '3306' : '5432'
    out.ssl = out.ssl === 'true' ? 'true' : 'false'
    for (const k of ['host', 'database', 'user']) if (!out[k]) throw invalid(`Setting "${k}" is required.`, `settings.${k}`)
    const port = Number(out.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid('The port must be a number between 1 and 65535.', 'settings.port')
    if (/\s/.test(out.host)) throw invalid('The host must not contain spaces.', 'settings.host')
    // outbound policy (net-policy.ts): never link-local / metadata / unspecified targets
    const problem = hostProblem(out.host)
    if (problem) throw invalid(problem, 'settings.host')
  }
  if (kind === 'gsheets' && !out.spreadsheetId) throw invalid('The spreadsheet URL or id is required.', 'settings.spreadsheetId')
  return out
}

function checkSecret(kind: ConnectorKind, secret: string): void {
  if (kind === 'gsheets') {
    let key: unknown
    try {
      key = JSON.parse(secret)
    } catch {
      throw invalid('The service-account key must be the JSON file downloaded from Google Cloud.', 'secret')
    }
    if (!isObj(key) || typeof key.client_email !== 'string' || typeof key.private_key !== 'string') {
      throw invalid('The service-account key must contain "client_email" and "private_key".', 'secret')
    }
  }
  if (kind === 'http' && secret) {
    let v: unknown
    try {
      v = JSON.parse(secret)
    } catch {
      throw invalid('The secret of an HTTP connection is a JSON object (apiKey, password, token, clientSecret, headers).', 'secret')
    }
    if (!isObj(v)) throw invalid('The secret of an HTTP connection is a JSON object (apiKey, password, token, clientSecret, headers).', 'secret')
  }
  if (secret.length > 20000) throw invalid('The secret is too long.', 'secret')
}

/** re-test a connection and store status + last error */
async function testAndStore(s: Services, id: string): Promise<{ ok: boolean; message: string; record: ConnectionRecord }> {
  const rec = (await s.meta.connections.get(id)) ?? (() => { throw notFound(`Connection "${id}" was not found.`) })()
  await s.connections.reset(id)
  let ok = false
  let message: string
  try {
    if (ACTION_KINDS.has(rec.connector)) {
      // P1-D: action connections are tested by their provider (the outbound policy applies to every request)
      const a = s.actions as unknown as { test?(env: string, id: string): Promise<{ ok: boolean; message: string }> } | undefined
      if (!a?.test) throw new Error(`The "${rec.connector}" connector is not available on this server.`)
      const r = await a.test(currentEnvironment().id, id)
      ok = r.ok
      message = r.message
    } else {
      // the host's addresses are checked against the outbound policy before anything connects
      if ((rec.connector === 'postgres' || rec.connector === 'mysql') && rec.id !== DEFAULT_CONNECTION_ID && rec.settings?.host) await assertOutboundHost(String(rec.settings.host), 'Connection')
      const connector = await s.connections.get(id)
      const r = await connector.test()
      ok = r.ok
      message = r.message
    }
  } catch (e) {
    message = e instanceof Error ? e.message : 'The connection could not be tested.'
  }
  message = redact(message, rec.secret)
  const next: ConnectionRecord = { ...rec, status: ok ? 'connected' : 'error' }
  if (ok) delete next.lastError
  else next.lastError = message
  await s.meta.connections.upsert(next)
  return { ok, message, record: next }
}

function sourceColumnsToDef(cols: SourceColumn[]): ColumnDef[] {
  const sys = new Map(systemColumns().map((c) => [c.name, c]))
  const out: ColumnDef[] = []
  const taken = new Set<string>()
  // system columns that exist in the source first, in their canonical order
  for (const [name, def] of sys) if (cols.some((c) => c.name === name)) { out.push({ ...def }); taken.add(name.toLowerCase()) }
  for (const c of cols) {
    if (SYSTEM_NAMES.has(c.name) || taken.has(c.name.toLowerCase())) continue
    taken.add(c.name.toLowerCase())
    out.push({ name: c.name, displayName: c.name, type: c.type })
  }
  return out
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * What physical store a connection points at: two connections with the same key reach the same tables (e.g. a second
 * connection to the same external database). null when it cannot be told.
 */
export function physicalKey(rec: Pick<ConnectionRecord, 'connector' | 'settings'> & { id?: string }): string | null {
  const st = rec.settings ?? {}
  if (rec.connector === 'mysql' || rec.connector === 'postgres') {
    const host = String(st.host ?? '').trim().toLowerCase()
    if (!host || !st.database) return null
    const where = `${LOOPBACK_NAMES.has(host) ? 'loopback' : host}|${Number(st.port) || (rec.connector === 'mysql' ? 3306 : 5432)}`
    if (rec.connector === 'mysql') return `mysql|${where}|${String(st.database).trim().toLowerCase()}`
    // PostgreSQL database names are case-sensitive; the default connection's schema is the environment's
    const schema = rec.id === DEFAULT_CONNECTION_ID ? currentEnvironment().schema : String(st.schema || 'public')
    return `postgres|${where}|${String(st.database).trim()}|${schema}`
  }
  if (rec.connector === 'gsheets') return st.spreadsheetId ? `gsheets|${String(st.spreadsheetId).trim()}` : null
  return null
}

/** ids of the connections that reach the same physical store as `rec` (always includes rec.id) */
async function sameStore(s: Services, rec: ConnectionRecord): Promise<Set<string>> {
  const key = physicalKey(rec)
  const out = new Set([rec.id])
  if (!key) return out
  for (const c of await s.meta.connections.list()) if (physicalKey(c) === key) out.add(c.id)
  return out
}

/** the registered table that already uses this physical source (through this or an equivalent connection) */
async function linkedAs(s: Services, rec: ConnectionRecord, source: string, tables?: TableDef[]): Promise<TableDef | undefined> {
  const conns = await sameStore(s, rec)
  const defaultId = await s.connections.defaultId().catch(() => DEFAULT_CONNECTION_ID)
  const low = source.toLowerCase()
  return (tables ?? (await s.meta.tables.list())).find((t) => conns.has(t.connectionId ?? defaultId) && (t.source ?? `t_${t.name.toLowerCase()}`).toLowerCase() === low)
}

export function registerConnectionRoutes(router: Router, s: Services): void {
  router.add('POST', '/api/v1/connections', async (ctx) => {
    const b = bodyObj(ctx)
    const name = reqString(b, 'name', 'A connection needs a name.', 100)
    const kind = b.connector as ConnectorKind
    if (!KINDS.includes(kind)) throw invalid(`The connector "${String(b.connector)}" is not available yet (use postgres, mysql, gsheets, files, http, email or whatsapp).`, 'connector')
    const existing = await s.meta.connections.list()
    if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw conflict(`A connection named "${name}" already exists.`)
    if (kind === 'files' && existing.some((c) => c.connector === 'files')) throw conflict('The Data files connection already exists.')
    const settings = cleanSettings(kind, b.settings)
    let secret: string | undefined
    if (b.secret !== undefined && b.secret !== null) {
      if (typeof b.secret !== 'string') throw invalid('"secret" must be text.', 'secret')
      secret = b.secret
    }
    if (kind === 'gsheets' && !secret) throw invalid('Google Sheets needs the service-account key.', 'secret')
    if (secret) checkSecret(kind, secret)
    checkActionConnection(s, kind, settings, secret)
    const rec: ConnectionRecord = {
      id: s.uid('conn'), name, connector: kind, status: 'not-configured', settings, isDefault: false,
      scope: kind === 'files' ? 'device' : 'server', ...(secret !== undefined ? { secret } : {}), hasSecret: !!secret,
    }
    await s.meta.connections.upsert(rec)
    const res = await testAndStore(s, rec.id)
    await audit(s, ctx, 'connection.create', { id: rec.id, name, connector: kind }, undefined)
    return toRef(res.record)
  }, { auth: 'admin' })

  router.add('PATCH', '/api/v1/connections/:id', async (ctx) => {
    const rec = await s.meta.connections.get(ctx.params.id)
    if (!rec) throw notFound('Connection not found.')
    if (rec.id === DEFAULT_CONNECTION_ID) {
      // rewritten from server.json / APPBUILDER_DB_* at every start: an edit here would silently revert
      throw new HttpError(400, 'invalid', 'The default database connection is managed by the setup (workspace/server.json or the APPBUILDER_DB_* settings) and cannot be edited here. To use another database, change the server configuration and restart.')
    }
    const b = bodyObj(ctx)
    const next: ConnectionRecord = { ...rec }
    let retest = false
    if (b.name !== undefined) {
      const name = reqString(b, 'name', 'A connection needs a name.', 100)
      const others = await s.meta.connections.list()
      if (others.some((c) => c.id !== rec.id && c.name.toLowerCase() === name.toLowerCase())) throw conflict(`A connection named "${name}" already exists.`)
      next.name = name
    }
    if (b.settings !== undefined) {
      next.settings = cleanSettings(rec.connector, b.settings, rec.settings)
      retest = true
    }
    if (b.secret !== undefined) {
      if (typeof b.secret !== 'string') throw invalid('"secret" must be text.', 'secret')
      if (b.secret !== '') checkSecret(rec.connector, b.secret)
      next.secret = b.secret
      next.hasSecret = b.secret !== ''
      retest = true
    }
    if (b.status !== undefined) {
      if (!['connected', 'error', 'not-configured'].includes(String(b.status))) throw invalid('Unknown status.', 'status')
      next.status = b.status as ConnectionRef['status']
    }
    if (ACTION_KINDS.has(rec.connector) && (b.settings !== undefined || b.secret !== undefined)) checkActionConnection(s, rec.connector, next.settings ?? {}, next.secret)
    await s.meta.connections.upsert(next)
    await s.connections.reset(rec.id)
    forgetActionState(s, rec.id)
    await audit(s, ctx, 'connection.update', { id: rec.id, name: next.name, settingsChanged: b.settings !== undefined, secretChanged: b.secret !== undefined })
    if (retest) return toRef((await testAndStore(s, rec.id)).record)
    return toRef(next)
  }, { auth: 'admin' })

  router.add('DELETE', '/api/v1/connections/:id', async (ctx) => {
    const rec = await s.meta.connections.get(ctx.params.id)
    if (!rec) throw notFound('Connection not found.')
    if (rec.isDefault) throw conflict('The default connection cannot be deleted. Make another PostgreSQL connection the default first.')
    if (rec.id === FILES_CONNECTION_ID) throw conflict('The Data files connection is built in and cannot be deleted.')
    const users = (await s.meta.tables.list()).filter((t) => t.connectionId === rec.id)
    if (users.length) throw conflict(`${users.length} table(s) use this connection: ${users.slice(0, 5).map((t) => t.displayName).join(', ')}${users.length > 5 ? ', ...' : ''}. Move or remove them first.`)
    if ((await s.meta.files.list()).some((f) => f.connectionId === rec.id)) throw conflict('Data files use this connection. Remove them first.')
    const now = s.now()
    for (const sol of await s.meta.solutions.list()) {
      if (sol.components.some((c) => c.kind === 'connection' && c.id === rec.id)) {
        await s.meta.solutions.upsert({ ...sol, components: sol.components.filter((c) => !(c.kind === 'connection' && c.id === rec.id)), modifiedOn: now })
      }
    }
    await s.connections.reset(rec.id)
    // P1-D: custom actions and access grants go with the connection
    const acts = s.actions as unknown as { custom?: { removeAll(id: string): Promise<void> } } | undefined
    await acts?.custom?.removeAll(rec.id)
    forgetActionState(s, rec.id)
    await s.meta.connections.remove(rec.id)
    await audit(s, ctx, 'connection.delete', { id: rec.id, name: rec.name })
    return { ok: true }
  }, { auth: 'admin' })

  router.add('POST', '/api/v1/connections/:id/test', async (ctx) => {
    if (!(await s.meta.connections.get(ctx.params.id))) throw notFound('Connection not found.')
    const r = await testAndStore(s, ctx.params.id)
    return { ok: r.ok, message: r.message }
  }, { auth: 'maker' })

  router.add('POST', '/api/v1/connections/:id/default', async (ctx) => {
    const rec = await s.meta.connections.get(ctx.params.id)
    if (!rec) throw notFound('Connection not found.')
    if (rec.connector !== 'postgres') throw invalid('Only a PostgreSQL connection can be the default store for new tables.')
    const r = await testAndStore(s, rec.id)
    if (!r.ok) throw conflict(`This connection cannot be the default store: ${r.message}`)
    let next = r.record
    for (const c of await s.meta.connections.list()) {
      if (c.id !== rec.id && c.isDefault) {
        await s.meta.connections.upsert({ ...c, isDefault: false })
        await s.connections.reset(c.id)
      }
    }
    next = { ...next, isDefault: true }
    await s.meta.connections.upsert(next)
    await s.connections.reset(rec.id)
    await audit(s, ctx, 'connection.default', { id: rec.id, name: rec.name })
    return toRef(next)
  }, { auth: 'admin' })

  router.add('GET', '/api/v1/connections/:id/source-tables', async (ctx) => {
    const { record, connector } = await resolveConnection(s, ctx.params.id)
    // makers and administrators only (route level). There is no per-connection permission: a maker can list every table
    // the connection's database user can see. Tables already linked (through this or an equivalent connection) are left out.
    const conns = await sameStore(s, record)
    const defaultId = await s.connections.defaultId().catch(() => DEFAULT_CONNECTION_ID)
    const registered = new Set((await s.meta.tables.list()).filter((t) => conns.has(t.connectionId ?? defaultId)).map((t) => (t.source ?? `t_${t.name.toLowerCase()}`).toLowerCase()))
    let list
    try {
      list = await connector.listSourceTables()
    } catch (e) {
      throw friendly(e, 'Could not list the tables')
    }
    const items = list
      .filter((t) => !registered.has(t.source.toLowerCase()) && !((record.connector === 'mysql' || record.connector === 'postgres') && (t.source.toLowerCase().startsWith('ab_') || SYSTEM_TABLE_NAMES.has(t.source.toLowerCase()))))
      .map((t) => ({ source: t.source, columns: t.columns.map((c) => ({ name: c.name, type: c.type })), ...(t.rowCount !== undefined ? { rowCount: t.rowCount } : {}) }))
    return { items }
  }, { auth: 'maker' })

  router.add('POST', '/api/v1/connections/:id/link', (ctx) => s.transaction(async () => {
    const b = bodyObj(ctx)
    const source = reqString(b, 'source', 'The source table', 300)
    const { record, connector } = await resolveConnection(s, ctx.params.id)
    if (record.connector === 'files') throw invalid('File tables are created by adding a data file.')
    const all = await s.meta.tables.list()
    // one registration per physical table: a second one would come with fresh default privileges (a way around the
    // privileges of the first) and two definitions of the same rows
    const existing = await linkedAs(s, record, source, all)
    if (existing) throw conflict(`"${source}" is already linked as the table "${existing.displayName}" (${existing.name}). Use that table, or delete it first.`)
    let found: { source: string; columns: SourceColumn[]; hasId?: boolean } | undefined
    try {
      found = (await connector.listSourceTables()).find((t) => t.source === source) as typeof found
    } catch (e) {
      throw friendly(e, 'Could not read the source tables')
    }
    if (!found) throw notFound(`"${source}" was not found in "${record.name}".`)
    const present = new Set(found.columns.map((c) => c.name))
    const hasId = found.hasId ?? present.has('id')
    const consent = b.ensureIdColumn === true
    const wantReadOnly = b.readOnly === true
    let readOnly = wantReadOnly || !connector.capabilities.write
    // system columns the source lacks; with consent (and a writable link) they are added, otherwise the link is read-only
    let missing = systemColumns().map((c) => c.name).filter((n) => n === 'id' ? !hasId : !present.has(n))
    const sqlFix = (record.connector === 'mysql' || record.connector === 'postgres') && connector.capabilities.ddl && typeof connector.ensureSystemColumns === 'function'
    const canFix = consent && !readOnly && missing.length > 0 && (record.connector === 'gsheets' || sqlFix)
    if (missing.length && !canFix) readOnly = true
    const displayName = optString(b, 'displayName', { max: 200 })?.trim() || source
    let name = optString(b, 'name')
    if (name === '') name = undefined
    if (name !== undefined) {
      if (!IDENT.test(name) || name.length > MAX_IDENT - 8) throw invalid(`Table name "${name}" is not a valid identifier.`, 'name')
      if (all.some((t) => t.name.toLowerCase() === name!.toLowerCase())) throw conflict(`A table named "${name}" already exists.`)
    } else name = uniqueIdentifier(toIdentifier(displayName, 'Table'), all.map((t) => t.name))
    const now = s.now()
    if (canFix) {
      try {
        if (sqlFix) await connector.ensureSystemColumns!(source)
        else {
          if (!hasId) await ensureIdColumn(connector as Connector, source)
          const withId: TableDef = { id: '', name: source, displayName: source, primaryColumn: 'id', columns: [], createdOn: now, modifiedOn: now, source }
          for (const f of systemColumns()) if (f.name !== 'id' && missing.includes(f.name)) await connector.addColumn(withId, f)
        }
      } catch (e) {
        throw friendly(e, 'Could not add the system columns')
      }
      for (const n of missing) present.add(n)
      missing = []
    }
    const columns = sourceColumnsToDef([...found.columns, ...systemColumns().filter((c) => present.has(c.name) && !found!.columns.some((x) => x.name === c.name)).map((c) => ({ name: c.name, type: c.type }))])
    const userCols = columns.filter((c) => !c.system)
    const def: TableDef = {
      id: s.uid('tbl'), name, displayName, primaryColumn: (userCols.find((c) => c.type === 'text') ?? userCols[0])?.name ?? 'id',
      columns: [...columns], createdOn: now, modifiedOn: now, connectionId: record.id, source,
    }
    if (readOnly) def.readOnly = true
    if (missing.length) def.missingSystem = missing
    await s.meta.tables.upsert(def)
    await grantDefaults(s, [def])
    await audit(s, ctx, 'table.link', { name, connection: record.id, source, readOnly, ...(canFix ? { addedSystemColumns: true } : {}), ...(missing.length ? { missingSystem: missing } : {}) }, def.id)
    return def
  }), { auth: 'maker' })
}

export { ensureFilesConnection }
