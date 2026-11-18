/**
 * Tables, columns, move between connections, create from CSV (CSV export: server/core/data-routes.ts).
 * Physical DDL always goes through the connector of the table's connection; the TableDef lives in ab_tables.
 */
import type { ColumnDef, TableDef } from '../../../src/platform/contracts.ts'
import { DEFAULT_ROW_CAP } from '../../../src/platform/http.ts'
import { HttpError } from '../../core/contracts.ts'
import { removeTableAttachments } from '../../core/attachments.ts'
import type { CoreServices } from '../../core/services.ts'
import type { Connector, ConnectionRecord, Router, Services } from '../../core/contracts.ts'
import {
  IDENT, MAX_COLUMNS, MAX_IDENT, SYSTEM_NAMES, bodyObj, buildColumn, clone, conflict, defaultFor, inferType, invalid, isAttachmentType, isBlankCell,
  normalizeForConversion, optString, parseCsvText, reqString, systemColumns, toIdentifier, tryCoerce, uniqueIdentifier, unparseCsv,
} from './util.ts'
import type { RoleX } from './util.ts'
import {
  audit, createPhysical, friendly, grantDefaults, lookupReferrers, pickSource, requireTable, resolveConnection,
  resolver, unregisterTable,
} from './tables-core.ts'

/* ------------------------------------------------------------------ helpers */

async function tableResolver(s: Services) {
  return resolver(await s.meta.tables.list())
}

function needWritable(def: TableDef, what: string): void {
  if (def.readOnly) throw invalid(`"${def.displayName}" is linked read-only, so ${what} is not possible.`)
}

async function connectorOf(s: Services, def: TableDef): Promise<{ connector: Connector; name: string }> {
  const { record, connector } = await resolveConnection(s, def.connectionId)
  return { connector, name: record.name }
}

async function connectorForDdl(s: Services, def: TableDef): Promise<Connector> {
  const { connector, name } = await connectorOf(s, def)
  if (!connector.capabilities.ddl) throw invalid(`The connection "${name}" does not allow changing table structure.`)
  return connector
}

async function rowCount(connector: Connector, def: TableDef): Promise<number> {
  const r = await connector.select(def, { select: ['id'], count: true, top: 1 })
  return r.total ?? r.rows.length
}

/** every value of one column (+ id), straight from the connector */
async function columnValues(connector: Connector, def: TableDef, col: string): Promise<{ id: string; v: unknown }[]> {
  const r = await connector.select(def, { select: ['id', col], orderBy: [{ col: 'createdOn', dir: 'asc' }] })
  return r.rows.map((row) => ({ id: String(row.id ?? ''), v: row[col] }))
}

function validateName(s: string | undefined, taken: string[]): void {
  if (s === undefined) return
  if (!IDENT.test(s) || s.length > MAX_IDENT - 8) throw invalid(`Table name "${s}" is not a valid identifier (letters, digits and underscore, not starting with a digit).`, 'name')
  if (taken.some((t) => t.toLowerCase() === s.toLowerCase())) throw conflict(`A table named "${s}" already exists.`)
}

/** values of a lookup column must point at existing rows of the target table */
async function checkLookupValues(s: Services, col: ColumnDef, values: unknown[]): Promise<void> {
  const target = col.lookupTable ? await s.meta.tables.get(col.lookupTable) : null
  if (!target) throw invalid('A lookup column needs an existing target table.', 'lookupTable')
  const distinct = [...new Set(values.filter((v) => !isBlankCell(v)).map(String))]
  if (!distinct.length) return
  const { connector } = await connectorOf(s, target)
  const found = new Set<string>()
  for (let i = 0; i < distinct.length; i += 400) {
    const chunk = distinct.slice(i, i + 400)
    const r = await connector.select(target, { select: ['id'], where: { col: 'id', op: 'in', value: chunk } })
    for (const row of r.rows) found.add(String(row.id))
  }
  const missing = distinct.find((v) => !found.has(v))
  if (missing !== undefined) throw invalid(`${col.displayName}: some rows point at a row that does not exist in "${target.displayName}" (for example "${missing}").`)
}

async function backfill(s: Services, connector: Connector, def: TableDef, col: ColumnDef): Promise<void> {
  const rows = await connector.select(def, { select: ['id'], orderBy: [{ col: 'createdOn', dir: 'asc' }] })
  if (!rows.rows.length) return
  const now = new Date()
  for (const r of rows.rows) {
    const id = String(r.id)
    if (col.type === 'autonumber') {
      const n = await s.meta.nextCounter(`${def.id}:${col.name}`)
      await connector.update(def, id, { [col.name]: `${col.prefix ?? ''}${String(n).padStart(4, '0')}` })
    } else {
      const d = defaultFor(col, now)
      if (d !== null) await connector.update(def, id, { [col.name]: d })
    }
  }
}

/** remove CLS entries of a column from every role (row filters stay: a filter on a missing column grants nothing) */
async function dropColumnFromRoles(s: Services, tableId: string, column: string): Promise<void> {
  for (const role of (await s.meta.roles.list()) as RoleX[]) {
    let changed = false
    const privileges = role.privileges.map((p) => {
      if (p.table === tableId && p.columns && column in p.columns) {
        const { [column]: _gone, ...rest } = p.columns
        void _gone
        changed = true
        return { ...p, columns: rest }
      }
      return p
    })
    if (changed) await s.meta.roles.upsert({ ...role, privileges } as RoleX)
  }
}

export async function rollbackCreate(s: Services, connector: Connector, def: TableDef): Promise<void> {
  await connector.dropTable(def).catch(() => {})
  await unregisterTable(s, def).catch(() => {})
}

/* ------------------------------------------------------------------ routes */

export function registerTableRoutes(router: Router, s: Services): void {
  /* create */
  router.add('POST', '/api/v1/tables', async (ctx) => {
    const b = bodyObj(ctx)
    const displayName = reqString(b, 'displayName', 'A table needs a display name.', 200)
    const all = await s.meta.tables.list()
    const taken = all.map((t) => t.name)
    let name = optString(b, 'name')
    if (name === '') name = undefined
    validateName(name, taken)
    name ??= uniqueIdentifier(toIdentifier(displayName, 'Table'), taken)
    const connectionId = optString(b, 'connectionId')
    const { record, connector } = await resolveConnection(s, connectionId || undefined)
    if (record.connector === 'files') throw invalid('Tables on the Data files connection are created by adding a data file.', 'connectionId')
    if (record.connector === 'gsheets' && !connector.capabilities.ddl) throw invalid(`The connection "${record.name}" cannot create tables.`, 'connectionId')
    const rawCols = b.columns
    if (rawCols !== undefined && !Array.isArray(rawCols)) throw invalid('"columns" must be a list.', 'columns')
    const requested = (rawCols as Partial<ColumnDef>[] | undefined)?.length ? (rawCols as Partial<ColumnDef>[]) : [{ displayName: 'Name', type: 'text' as const }]
    if (requested.length > MAX_COLUMNS) throw invalid(`A table can have at most ${MAX_COLUMNS} columns.`, 'columns')
    const resolveT = resolver(all)
    const userCols: ColumnDef[] = []
    for (const p of requested) {
      if (typeof p !== 'object' || p === null) throw invalid('A column definition is malformed.', 'columns')
      userCols.push(buildColumn(p, { existing: [...systemColumns(), ...userCols], selfName: name, resolveTable: resolveT, now: new Date() }))
    }
    const now = s.now()
    const def: TableDef = {
      id: s.uid('tbl'), name, displayName, primaryColumn: userCols[0].name,
      columns: [...systemColumns(), ...userCols], createdOn: now, modifiedOn: now,
      connectionId: record.id,
    }
    const description = optString(b, 'description', { max: 1000 })
    if (description) def.description = description
    def.source = await pickSource(s, record, connector, name)
    await createPhysical(s, record, connector, def)
    await audit(s, ctx, 'table.create', { name, connection: record.id }, def.id)
    return def
  }, { auth: 'maker' })

  /* create from csv */
  router.add('POST', '/api/v1/tables/from-csv', async (ctx) => {
    const b = bodyObj(ctx)
    const displayName = reqString(b, 'displayName', 'A table needs a display name.', 200)
    const csv = b.csv
    if (typeof csv !== 'string' || !csv.trim()) throw invalid('The CSV is empty.', 'csv')
    const { headers, records } = parseCsvText(csv)
    const usable = headers.filter((h) => h !== '')
    if (!usable.length) throw invalid('The CSV has no header row.', 'csv')
    const all = await s.meta.tables.list()
    const name = uniqueIdentifier(toIdentifier(displayName, 'Table'), all.map((t) => t.name))
    const { record, connector } = await resolveConnection(s, optString(b, 'connectionId') || undefined)
    if (record.connector === 'files') throw invalid('Use the data files page to add a file.', 'connectionId')
    const cols: ColumnDef[] = []
    const header2col = new Map<string, ColumnDef>()
    const pairs: { h: string; col: ColumnDef }[] = []
    for (const h of usable) {
      if (header2col.has(h)) continue
      if (cols.length >= MAX_COLUMNS) throw invalid(`The CSV has more than ${MAX_COLUMNS} columns.`, 'csv')
      const col: ColumnDef = {
        name: uniqueIdentifier(toIdentifier(h, 'Column'), [...SYSTEM_NAMES, ...cols.map((c) => c.name)]),
        displayName: h.slice(0, 200), type: inferType(records.map((r) => r[h] ?? '')),
      }
      cols.push(col)
      header2col.set(h, col)
      pairs.push({ h, col })
    }
    const now = s.now()
    const def: TableDef = {
      id: s.uid('tbl'), name, displayName, primaryColumn: (cols.find((c) => c.type === 'text') ?? cols[0]).name,
      columns: [...systemColumns(), ...cols], createdOn: now, modifiedOn: now, connectionId: record.id,
    }
    def.source = await pickSource(s, record, connector, name)
    await createPhysical(s, record, connector, def)
    try {
      const normalized = unparseCsv(pairs.map((x) => x.col.name), records.map((r) => pairs.map((x) => r[x.h] ?? '')))
      await s.data.importCsv(null, def, normalized, 'replace')
    } catch (e) {
      await rollbackCreate(s, connector, def)
      throw e
    }
    await audit(s, ctx, 'table.create', { name, connection: record.id, fromCsv: true }, def.id)
    return def
  }, { auth: 'maker', maxBodyMB: 25 })

  /* update */
  router.add('PATCH', '/api/v1/tables/:id', async (ctx) => {
    const def = await requireTable(s, ctx.params.id)
    const b = bodyObj(ctx)
    const next = clone(def)
    if (b.displayName !== undefined) next.displayName = reqString(b, 'displayName', 'The display name', 200)
    if (b.description !== undefined) {
      const d = optString(b, 'description', { max: 1000 })
      if (d) next.description = d
      else delete next.description
    }
    if (b.primaryColumn !== undefined) {
      const pc = optString(b, 'primaryColumn')
      if (!pc || !next.columns.some((c) => c.name === pc)) throw invalid(`Column "${String(b.primaryColumn)}" does not exist.`, 'primaryColumn')
      next.primaryColumn = pc
    }
    next.modifiedOn = s.now()
    await s.meta.tables.upsert(next)
    s.security.invalidate()
    await audit(s, ctx, 'table.update', { name: def.name }, def.id)
    return next
  }, { auth: 'maker' })

  /* delete */
  router.add('DELETE', '/api/v1/tables/:id', async (ctx) => {
    const def = await requireTable(s, ctx.params.id)
    const refs = await lookupReferrers(s, def)
    if (refs.length) throw conflict(`"${def.displayName}" is used by lookup columns in: ${refs.map((t) => t.displayName).join(', ')}. Remove those columns first.`)
    const drop = ctx.query.get('dropSource') === '1'
    if (drop) {
      if (def.readOnly) throw invalid(`"${def.displayName}" is linked read-only; its source cannot be dropped from here.`)
      const { connector } = await connectorOf(s, def)
      try {
        await connector.dropTable(def)
      } catch (e) {
        throw friendly(e, 'Could not drop the source table')
      }
    }
    await unregisterTable(s, def)
    if ('internals' in s.data) await removeTableAttachments(s as CoreServices, def.id).catch(() => 0)
    await audit(s, ctx, 'table.delete', { name: def.name, dropSource: drop }, def.id)
    return { ok: true }
  }, { auth: 'maker' })

  /* add column */
  router.add('POST', '/api/v1/tables/:id/columns', async (ctx) => {
    const def = await requireTable(s, ctx.params.id)
    needWritable(def, 'adding columns')
    if (def.columns.length >= MAX_COLUMNS + 5) throw invalid(`A table can have at most ${MAX_COLUMNS} columns.`)
    const connector = await connectorForDdl(s, def)
    const col = buildColumn(bodyObj(ctx) as Partial<ColumnDef>, {
      existing: def.columns, selfName: def.name, resolveTable: await tableResolver(s), now: new Date(),
    })
    const total = col.unique && col.default !== undefined ? await rowCount(connector, def) : 0
    if (total > 1) throw invalid(`A unique column with a default value cannot be added to a table that already has ${total} rows.`, 'unique')
    const next: TableDef = { ...clone(def), columns: [...def.columns, col], modifiedOn: s.now() }
    try {
      await connector.addColumn(next, col)
    } catch (e) {
      throw friendly(e, 'Could not add the column')
    }
    try {
      if (col.type === 'autonumber' || col.default !== undefined) await backfill(s, connector, next, col)
      await s.meta.tables.upsert(next)
    } catch (e) {
      await connector.dropColumn(next, col.name).catch(() => {})
      throw friendly(e, 'Could not add the column')
    }
    s.security.invalidate()
    await audit(s, ctx, 'column.add', { table: def.name, column: col.name }, def.id)
    return next
  }, { auth: 'maker' })

  /* update column */
  router.add('PATCH', '/api/v1/tables/:id/columns/:name', async (ctx) => {
    const def = await requireTable(s, ctx.params.id)
    needWritable(def, 'changing columns')
    const idx = def.columns.findIndex((c) => c.name === ctx.params.name)
    if (idx < 0) throw new HttpError(404, 'not-found', `Column "${ctx.params.name}" was not found.`)
    const old = def.columns[idx]
    if (old.system) throw invalid(`"${old.displayName}" is a system column and cannot be changed.`)
    const p = bodyObj(ctx) as Partial<ColumnDef>
    if (p.name !== undefined && p.name !== old.name) throw invalid('Columns can only be renamed through their display name.', 'name')
    if (p.system !== undefined && p.system !== old.system) throw invalid('The system flag cannot be changed.', 'system')
    const merged: ColumnDef = { ...old }
    if (p.displayName !== undefined) {
      if (typeof p.displayName !== 'string' || !p.displayName.trim()) throw invalid('The display name cannot be empty.', 'displayName')
      merged.displayName = p.displayName.trim().slice(0, 200)
    }
    if (p.type !== undefined) merged.type = p.type
    for (const k of ['required', 'unique'] as const) {
      if (k in p) {
        if (p[k]) merged[k] = true
        else delete merged[k]
      }
    }
    if ('default' in p) {
      if (p.default === undefined || p.default === null || p.default === '') delete merged.default
      else merged.default = String(p.default)
    }
    if ('choices' in p) merged.choices = [...new Set((p.choices ?? []).map((x) => String(x).trim()).filter(Boolean))]
    if ('lookupTable' in p) merged.lookupTable = p.lookupTable
    if ('prefix' in p) merged.prefix = p.prefix ?? ''
    for (const k of ['multiple', 'accept', 'maxSizeMB'] as const) if (k in p) (merged as unknown as Record<string, unknown>)[k] = p[k]
    // revalidate the merged column through the same rules as a new column
    const checked = buildColumn({ ...merged, name: undefined, displayName: merged.displayName }, {
      existing: def.columns.filter((c) => c.name !== old.name), selfName: def.name, resolveTable: await tableResolver(s), now: new Date(),
    })
    const next: ColumnDef = { ...checked, name: old.name }
    const typeChanged = next.type !== old.type
    const uniqueChanged = !!next.unique !== !!old.unique
    const lookupChanged = next.type === 'lookup' && next.lookupTable?.toLowerCase() !== old.lookupTable?.toLowerCase()
    if (typeChanged) {
      if (isAttachmentType(next.type) !== isAttachmentType(old.type)) throw invalid('Attachment columns cannot be converted to or from other types. Add a new column instead.', 'type')
    }
    let connector: Connector | null = null
    if (typeChanged || uniqueChanged || lookupChanged) {
      connector = await connectorForDdl(s, def)
      const rows = await columnValues(connector, def, old.name)
      if (typeChanged && next.type === 'autonumber' && rows.length > 0) throw invalid('Cannot change the type: a column can only become an autonumber while the table is empty. Add a new autonumber column instead.', 'type')
      if (typeChanged) {
        const updates: { id: string; v: string }[] = []
        for (const [i, r] of rows.entries()) {
          const res = tryCoerce(next, r.v as string | number | boolean | Date | null, old)
          if (!res.ok) throw invalid(`Cannot change the type: row ${i + 1} — ${res.message}`, 'type')
          if (typeof r.v === 'string' && res.value !== null && ['number', 'decimal', 'currency', 'boolean', 'date', 'datetime'].includes(next.type)) {
            const n = normalizeForConversion(next, r.v)
            if (n !== null && n !== r.v) updates.push({ id: r.id, v: n })
          }
        }
        for (const u of updates) await connector.update(def, u.id, { [old.name]: u.v })
      }
      if ((typeChanged || lookupChanged) && next.type === 'lookup') await checkLookupValues(s, next, rows.map((r) => r.v))
      if (next.unique && (uniqueChanged || typeChanged)) {
        const seen = new Set<string>()
        for (const r of rows) {
          if (isBlankCell(r.v)) continue
          const k = r.v instanceof Date ? String(r.v.getTime()) : String(r.v).trim().toLowerCase()
          if (seen.has(k)) throw invalid(`Cannot make "${next.displayName}" unique: the value "${String(r.v)}" appears more than once.`, 'unique')
          seen.add(k)
        }
      }
    }
    const columns = [...def.columns]
    columns[idx] = next
    const nextDef: TableDef = { ...clone(def), columns, modifiedOn: s.now() }
    if (connector && (typeChanged || uniqueChanged)) {
      try {
        await connector.alterColumn(nextDef, old, next)
      } catch (e) {
        throw friendly(e, 'Could not change the column')
      }
    }
    await s.meta.tables.upsert(nextDef)
    s.security.invalidate()
    await audit(s, ctx, 'column.update', { table: def.name, column: old.name, type: next.type }, def.id)
    return nextDef
  }, { auth: 'maker' })

  /* remove column */
  router.add('DELETE', '/api/v1/tables/:id/columns/:name', async (ctx) => {
    const def = await requireTable(s, ctx.params.id)
    needWritable(def, 'removing columns')
    const col = def.columns.find((c) => c.name === ctx.params.name)
    if (!col) throw new HttpError(404, 'not-found', `Column "${ctx.params.name}" was not found.`)
    if (col.system) throw invalid(`"${col.displayName}" is a system column and cannot be removed.`)
    const connector = await connectorForDdl(s, def)
    const columns = def.columns.filter((c) => c.name !== col.name)
    const next: TableDef = {
      ...clone(def), columns, modifiedOn: s.now(),
      primaryColumn: def.primaryColumn === col.name ? (columns.find((c) => !c.system)?.name ?? 'id') : def.primaryColumn,
    }
    try {
      await connector.dropColumn(next, col.name)
    } catch (e) {
      throw friendly(e, 'Could not remove the column')
    }
    await s.meta.tables.upsert(next)
    await dropColumnFromRoles(s, def.id, col.name)
    s.security.invalidate()
    await audit(s, ctx, 'column.remove', { table: def.name, column: col.name }, def.id)
    return next
  }, { auth: 'maker' })

  /* move to another connection (copy rows through the DataService as system) */
  router.add('POST', '/api/v1/tables/:id/move', async (ctx) => {
    const def = await requireTable(s, ctx.params.id)
    const target = reqString(bodyObj(ctx), 'connectionId', 'The target connection')
    needWritable(def, 'moving it')
    if (target === (def.connectionId ?? (await s.connections.defaultId()))) throw invalid('The table is already stored in that connection.', 'connectionId')
    const { record, connector } = await resolveConnection(s, target)
    if (record.connector === 'files') throw invalid('Tables cannot be moved into the Data files connection.', 'connectionId')
    if (!connector.capabilities.ddl || !connector.capabilities.write) throw invalid(`The connection "${record.name}" cannot store tables.`, 'connectionId')
    const moved = await moveTable(s, def, record, connector)
    await audit(s, ctx, 'table.move', { name: def.name, to: record.id }, def.id)
    return moved
  }, { auth: 'maker' })
  // CSV export (GET /tables/:id/csv) lives in server/core/data-routes.ts (DataService: RBAC + RLS + CLS)
}

/** copy a table's rows into a new physical table on another connection; the table id and name stay (apps keep working) */
export async function moveTable(s: Services, def: TableDef, record: ConnectionRecord, connector: Connector): Promise<TableDef> {
  const connectionName = record.name
  const fresh: TableDef = { ...clone(def), connectionId: record.id, modifiedOn: s.now() }
  delete fresh.origin
  fresh.source = await pickSource(s, record, connector, def.name)
  try {
    await connector.createTable(fresh)
  } catch (e) {
    throw friendly(e, `Could not create the table in "${connectionName}"`)
  }
  try {
    let skip = 0
    for (;;) {
      const r = await s.data.query(null, def, { top: DEFAULT_ROW_CAP, skip, orderBy: [{ col: 'createdOn', dir: 'asc' }] })
      for (const row of r.rows) {
        try {
          await s.data.insert(null, fresh, row)
        } catch (e) {
          throw invalid(`Cannot copy the rows: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (r.rows.length < DEFAULT_ROW_CAP) break
      skip += r.rows.length
    }
  } catch (e) {
    await connector.dropTable(fresh).catch(() => {})
    throw e
  }
  if (def.origin?.kind === 'file') {
    const f = await s.meta.files.get(def.origin.fileId)
    if (f) await s.meta.files.upsert({ ...(f as typeof f & { storageKey: string; originalName: string }), tableIds: f.tableIds.filter((x) => x !== def.id) })
  }
  await s.meta.tables.upsert(fresh)
  await grantDefaults(s, [fresh])
  s.security.invalidate()
  return fresh
}

