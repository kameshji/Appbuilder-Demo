/**
 * Connections: CRUD (admin), test / source-tables / link (maker), default store (admin, mysql only).
 * Secrets are handed to the MetaStore (which seals them) and never come back in a response.
 */
import type { ColumnDef, ConnectionRef, ConnectorKind, TableDef } from '../../../src/platform/contracts.ts'
import { HttpError } from '../../core/contracts.ts'
import type { ConnectionRecord, Connector, Router, Services, SourceColumn } from '../../core/contracts.ts'
import { ensureIdColumn } from '../../connectors/gsheets/index.ts'
import {
  IDENT, MAX_IDENT, SYSTEM_NAMES, SYSTEM_TABLE_NAMES, bodyObj, conflict, invalid, isObj, notFound, optString, redact, reqString, systemColumns, toIdentifier,
  uniqueIdentifier,
} from './util.ts'
import { FILES_CONNECTION_ID, audit, ensureFilesConnection, friendly, grantDefaults, resolveConnection, toRef } from './tables-core.ts'

const KINDS: ConnectorKind[] = ['mysql', 'files', 'gsheets']
const SETTING_KEYS: Record<string, string[]> = { mysql: ['host', 'port', 'database', 'user', 'ssl'], gsheets: ['spreadsheetId'], files: [] }

function cleanSettings(kind: ConnectorKind, raw: unknown, base: Record<string, string> = {}): Record<string, string> {
  if (raw !== undefined && !isObj(raw)) throw invalid('"settings" must be an object.', 'settings')
  const allowed = SETTING_KEYS[kind] ?? []
  const out: Record<string, string> = { ...base }
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!allowed.includes(k)) throw invalid(`Unknown setting "${k}" for a ${kind} connection.`, `settings.${k}`)
    if (v === null || v === undefined || typeof v === 'object') throw invalid(`Setting "${k}" must be text.`, `settings.${k}`)
    out[k] = String(v).trim()
  }
  if (kind === 'mysql') {
    out.port ||= '3306'
    out.ssl = out.ssl === 'true' ? 'true' : 'false'
    for (const k of ['host', 'database', 'user']) if (!out[k]) throw invalid(`Setting "${k}" is required.`, `settings.${k}`)
    const port = Number(out.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid('The port must be a number between 1 and 65535.', 'settings.port')
    if (/\s/.test(out.host)) throw invalid('The host must not contain spaces.', 'settings.host')
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
  if (secret.length > 20000) throw invalid('The secret is too long.', 'secret')
}

/** re-test a connection and store status + last error */
async function testAndStore(s: Services, id: string): Promise<{ ok: boolean; message: string; record: ConnectionRecord }> {
  const rec = (await s.meta.connections.get(id)) ?? (() => { throw notFound(`Connection "${id}" was not found.`) })()
  await s.connections.reset(id)
  let ok = false
  let message: string
  try {
    const connector = await s.connections.get(id)
    const r = await connector.test()
    ok = r.ok
    message = r.message
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

export function registerConnectionRoutes(router: Router, s: Services): void {
  router.add('POST', '/api/v1/connections', async (ctx) => {
    const b = bodyObj(ctx)
    const name = reqString(b, 'name', 'A connection needs a name.', 100)
    const kind = b.connector as ConnectorKind
    if (!KINDS.includes(kind)) throw invalid(`The connector "${String(b.connector)}" is not available yet (use mysql, gsheets or files).`, 'connector')
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
    await s.meta.connections.upsert(next)
    await s.connections.reset(rec.id)
    await audit(s, ctx, 'connection.update', { id: rec.id, name: next.name, settingsChanged: b.settings !== undefined, secretChanged: b.secret !== undefined })
    if (retest) return toRef((await testAndStore(s, rec.id)).record)
    return toRef(next)
  }, { auth: 'admin' })

  router.add('DELETE', '/api/v1/connections/:id', async (ctx) => {
    const rec = await s.meta.connections.get(ctx.params.id)
    if (!rec) throw notFound('Connection not found.')
    if (rec.isDefault) throw conflict('The default connection cannot be deleted. Make another MySQL connection the default first.')
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
    if (rec.connector !== 'mysql') throw invalid('Only a MySQL connection can be the default store for new tables.')
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
    const registered = new Set((await s.meta.tables.list()).filter((t) => t.connectionId === record.id).map((t) => (t.source ?? '').toLowerCase()))
    let list
    try {
      list = await connector.listSourceTables()
    } catch (e) {
      throw friendly(e, 'Could not list the tables')
    }
    const items = list
      .filter((t) => !registered.has(t.source.toLowerCase()) && !(record.connector === 'mysql' && SYSTEM_TABLE_NAMES.has(t.source.toLowerCase())))
      .map((t) => ({ source: t.source, columns: t.columns.map((c) => ({ name: c.name, type: c.type })), ...(t.rowCount !== undefined ? { rowCount: t.rowCount } : {}) }))
    return { items }
  }, { auth: 'maker' })

  router.add('POST', '/api/v1/connections/:id/link', async (ctx) => {
    const b = bodyObj(ctx)
    const source = reqString(b, 'source', 'The source table', 300)
    const { record, connector } = await resolveConnection(s, ctx.params.id)
    if (record.connector === 'files') throw invalid('File tables are created by adding a data file.')
    const all = await s.meta.tables.list()
    if (all.some((t) => t.connectionId === record.id && (t.source ?? '').toLowerCase() === source.toLowerCase())) throw conflict(`"${source}" is already linked.`)
    let found: { source: string; columns: SourceColumn[]; hasId?: boolean } | undefined
    try {
      found = (await connector.listSourceTables()).find((t) => t.source === source) as typeof found
    } catch (e) {
      throw friendly(e, 'Could not read the source tables')
    }
    if (!found) throw notFound(`"${source}" was not found in "${record.name}".`)
    const hasId = found.hasId ?? found.columns.some((c) => c.name === 'id')
    const consent = b.ensureIdColumn === true
    const wantReadOnly = b.readOnly === true
    let readOnly = wantReadOnly || !connector.capabilities.write
    const fixes: ColumnDef[] = []
    const present = new Set(found.columns.map((c) => c.name))
    if (!readOnly) {
      if (!hasId) {
        // gsheets can fill ids with the user's consent; a MySQL table without an id cannot be made writable here
        if (consent && record.connector === 'gsheets') fixes.push(...systemColumns().filter((c) => !present.has(c.name)))
        else readOnly = true
      } else if (consent && connector.capabilities.ddl) {
        fixes.push(...systemColumns().filter((c) => !present.has(c.name)))
      }
    }
    const displayName = optString(b, 'displayName', { max: 200 })?.trim() || source
    let name = optString(b, 'name')
    if (name === '') name = undefined
    if (name !== undefined) {
      if (!IDENT.test(name) || name.length > MAX_IDENT - 8) throw invalid(`Table name "${name}" is not a valid identifier.`, 'name')
      if (all.some((t) => t.name.toLowerCase() === name!.toLowerCase())) throw conflict(`A table named "${name}" already exists.`)
    } else name = uniqueIdentifier(toIdentifier(displayName, 'Table'), all.map((t) => t.name))
    const columns = sourceColumnsToDef(found.columns)
    const userCols = columns.filter((c) => !c.system)
    const now = s.now()
    const def: TableDef = {
      id: s.uid('tbl'), name, displayName, primaryColumn: (userCols.find((c) => c.type === 'text') ?? userCols[0])?.name ?? 'id',
      columns: [...columns], createdOn: now, modifiedOn: now, connectionId: record.id, source,
    }
    if (readOnly) def.readOnly = true
    if (fixes.length) {
      try {
        if (record.connector === 'gsheets' && !hasId) await ensureIdColumn(connector as Connector, source)
        const withSys: TableDef = { ...def, columns: [...systemColumns().filter((c) => c.name === 'id' || present.has(c.name) || fixes.some((f) => f.name === c.name)), ...userCols] }
        for (const f of fixes) if (!(f.name === 'id' && record.connector === 'gsheets' && !hasId)) await connector.addColumn(withSys, f)
        def.columns = withSys.columns
      } catch (e) {
        throw friendly(e, 'Could not add the system columns')
      }
    }
    await s.meta.tables.upsert(def)
    await grantDefaults(s, [def])
    await audit(s, ctx, 'table.link', { name, connection: record.id, source, readOnly }, def.id)
    return def
  }, { auth: 'maker' })
}

export { ensureFilesConnection }
