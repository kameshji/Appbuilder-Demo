/**
 * Data files (files connector, device only): upload -> one table per sheet, replace, download, delete.
 * Wraps inspect/store/replace/read/remove of server/connectors/files and keeps the metadata in sync.
 */
import type { ColumnDef, DataFileDef, TableDef } from '../../../src/platform/contracts.ts'
import { HttpError } from '../../core/contracts.ts'
import type { Ctx, Router, Services, UserContext } from '../../core/contracts.ts'
import { readDataFile, removeDataFile, replaceDataFile, storeDataFile } from '../../connectors/files/index.ts'
import type { StoredFile } from '../../connectors/files/index.ts'
import { conflict, denied, invalid, me, notFound, reqString, systemColumns, toIdentifier, uniqueIdentifier } from './util.ts'
import { FILES_CONNECTION_ID, audit, ensureFilesConnection, friendly, grantDefaults, unregisterTable } from './tables-core.ts'
import type { RoleX } from './util.ts'

type FileRow = DataFileDef & { storageKey: string; originalName: string }

const KIND_MIME: Record<string, string> = {
  csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

export function cleanFileName(raw: string | null | undefined): string {
  const base = (raw ?? '').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f"]/g, '').trim()
  if (!base) throw invalid('The file name is required (?name=).', 'name')
  if (base.length > 200) throw invalid('The file name is too long.', 'name')
  if (!/\.(csv|xlsx|json)$/i.test(base)) throw invalid('Only .csv, .xlsx and .json files are supported.', 'name')
  return base
}

function primaryOf(cols: ColumnDef[]): string {
  return (cols.find((c) => c.type === 'text') ?? cols[0])?.name ?? 'id'
}

function sheetColumns(sheet: StoredFile['sheets'][number]): ColumnDef[] {
  return sheet.columns.map((c) => ({ name: c.name, displayName: c.displayName, type: c.type }))
}

/** can this user read the whole table (all rows, all columns)? Needed for raw file downloads and packages. */
export function canReadWholeTable(u: UserContext, t: TableDef): boolean {
  if (u.privileges.isAdmin) return true
  const eff = u.privileges.tables[t.id]
  if (!eff || eff.read !== 'all' || eff.filtered) return false
  return !Object.values(eff.columns ?? {}).includes('none')
}

export interface RegisterOptions {
  displayName?: string
  /** package hints: sheet name -> original table name / display name / description / primary column */
  hints?: Record<string, { name?: string; displayName?: string; description?: string; primaryColumn?: string }>
}

/** store the bytes as a data file, register the file and one table per sheet (default privileges granted) */
export async function registerDataFile(s: Services, fileName: string, bytes: Buffer, opts: RegisterOptions = {}): Promise<{ file: DataFileDef; tables: TableDef[] }> {
  await ensureFilesConnection(s)
  const fileId = s.uid('file')
  let stored: StoredFile
  try {
    stored = await storeDataFile(s.env, fileId, bytes, fileName)
  } catch (e) {
    throw friendly(e, 'Could not read the file')
  }
  const tables: TableDef[] = []
  try {
    const existing = await s.meta.tables.list()
    const taken = existing.map((t) => t.name)
    const now = s.now()
    for (const sh of stored.sheets) {
      const hint = opts.hints?.[sh.sheet]
      const single = stored.sheets.length === 1
      const base = opts.displayName?.trim()
      const displayName = hint?.displayName ?? (base ? (single ? base : `${base} - ${sh.sheet}`) : sh.sheet)
      const name = uniqueIdentifier(hint?.name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(hint.name) ? hint.name : toIdentifier(displayName, 'Table'), [...taken, ...tables.map((t) => t.name)])
      const user = sheetColumns(sh)
      const def: TableDef = {
        id: s.uid('tbl'), name, displayName: displayName.slice(0, 200),
        primaryColumn: hint?.primaryColumn && user.some((c) => c.name === hint.primaryColumn) ? hint.primaryColumn : primaryOf(user),
        columns: [...systemColumns(), ...user], createdOn: now, modifiedOn: now,
        connectionId: FILES_CONNECTION_ID, source: `${fileId}/${sh.sheet}`,
        origin: { kind: 'file', fileId, fileName, sheet: sh.sheet, importedOn: now },
      }
      if (hint?.description) def.description = hint.description
      tables.push(def)
    }
    const file: FileRow = {
      id: fileId, connectionId: FILES_CONNECTION_ID, fileName, kind: stored.kind, sizeBytes: stored.sizeBytes,
      checksum: stored.checksum, importedOn: now, tableIds: tables.map((t) => t.id), modifiedSinceImport: false,
      storageKey: stored.storageKey, originalName: fileName,
    }
    await s.meta.files.upsert(file)
    for (const t of tables) await s.meta.tables.upsert(t)
    await grantDefaults(s, tables)
    return { file, tables }
  } catch (e) {
    for (const t of tables) await unregisterTable(s, t).catch(() => {})
    await s.meta.files.remove(fileId).catch(() => {})
    await removeDataFile(s.env, fileId).catch(() => {})
    throw e
  }
}

/** remove a file and (optionally) its tables */
export async function deleteDataFile(s: Services, f: DataFileDef, dropTables: boolean): Promise<void> {
  const tables = (await s.meta.tables.list()).filter((t) => t.origin?.kind === 'file' && t.origin.fileId === f.id)
  if (tables.length && !dropTables) {
    throw conflict(`This file still has ${tables.length} table(s): ${tables.map((t) => t.displayName).join(', ')}. Move them to the database first, or remove the file together with its tables.`)
  }
  for (const t of tables) await unregisterTable(s, t)
  await removeDataFile(s.env, f.id).catch((e) => { if (!(e instanceof HttpError && e.status === 404)) throw e })
  await s.meta.files.remove(f.id)
}

async function needFile(s: Services, id: string): Promise<FileRow> {
  const f = await s.meta.files.get(id)
  if (!f) throw notFound('Data file not found.')
  return f as FileRow
}

const rawBody = (ctx: Ctx): Buffer => {
  const b = ctx.rawBody
  if (!b || b.length === 0) throw invalid('The request body must be the file.')
  return b
}

export function registerFileRoutes(router: Router, s: Services): void {
  router.add('POST', '/api/v1/files', async (ctx) => {
    const fileName = cleanFileName(ctx.query.get('name'))
    const displayName = ctx.query.get('displayName')?.trim() || undefined
    const { file, tables } = await registerDataFile(s, fileName, rawBody(ctx), { displayName })
    await audit(s, ctx, 'file.add', { id: file.id, fileName, tables: tables.map((t) => t.name) })
    return file
  }, { auth: 'maker', raw: true, maxBodyMB: 25 })

  router.add('POST', '/api/v1/files/:id/replace', async (ctx) => {
    const f = await needFile(s, ctx.params.id)
    const fileName = cleanFileName(ctx.query.get('name') ?? f.fileName)
    let stored: StoredFile
    try {
      stored = await replaceDataFile(s.env, f.id, rawBody(ctx), fileName)
    } catch (e) {
      throw friendly(e, 'Could not replace the file')
    }
    const now = s.now()
    const all = await s.meta.tables.list()
    const mine = all.filter((t) => t.origin?.kind === 'file' && t.origin.fileId === f.id)
    const keep: TableDef[] = []
    for (const sh of stored.sheets) {
      const incoming = sheetColumns(sh)
      const have = mine.find((t) => t.origin?.sheet === sh.sheet)
      if (have) {
        const known = new Map(have.columns.map((c) => [c.name, c]))
        const user: ColumnDef[] = incoming.map((c) => ({ ...(known.get(c.name) ?? {}), ...c, ...(known.get(c.name)?.displayName ? { displayName: known.get(c.name)!.displayName } : {}) }))
        const next: TableDef = {
          ...have, columns: [...have.columns.filter((c) => c.system), ...user], modifiedOn: now,
          primaryColumn: user.some((c) => c.name === have.primaryColumn) || have.columns.some((c) => c.system && c.name === have.primaryColumn) ? have.primaryColumn : primaryOf(user),
          origin: { ...have.origin!, fileName, importedOn: now },
        }
        await s.meta.tables.upsert(next)
        keep.push(next)
      } else {
        const taken = [...all.map((t) => t.name), ...keep.map((t) => t.name)]
        const def: TableDef = {
          id: s.uid('tbl'), name: uniqueIdentifier(toIdentifier(sh.sheet, 'Table'), taken), displayName: sh.sheet,
          primaryColumn: primaryOf(incoming), columns: [...systemColumns(), ...incoming], createdOn: now, modifiedOn: now,
          connectionId: FILES_CONNECTION_ID, source: `${f.id}/${sh.sheet}`, origin: { kind: 'file', fileId: f.id, fileName, sheet: sh.sheet, importedOn: now },
        }
        await s.meta.tables.upsert(def)
        keep.push(def)
      }
    }
    const keepIds = new Set(keep.map((t) => t.id))
    const newOnes = keep.filter((t) => !mine.some((m) => m.id === t.id))
    for (const t of mine) {
      if (keepIds.has(t.id)) {
        // columns that vanished from the file lose their column security entries
        const gone = t.columns.filter((c) => !c.system && !keep.find((k) => k.id === t.id)!.columns.some((x) => x.name === c.name))
        if (gone.length) {
          for (const role of (await s.meta.roles.list()) as RoleX[]) {
            const privileges = role.privileges.map((p) => {
              if (p.table !== t.id || !p.columns) return p
              const cols = { ...p.columns }
              for (const g of gone) delete cols[g.name]
              return { ...p, columns: cols }
            })
            await s.meta.roles.upsert({ ...role, privileges } as RoleX)
          }
        }
      } else await unregisterTable(s, t)
    }
    if (newOnes.length) await grantDefaults(s, newOnes)
    const file: FileRow = {
      ...f, fileName, kind: stored.kind, sizeBytes: stored.sizeBytes, checksum: stored.checksum, importedOn: now,
      tableIds: keep.map((t) => t.id), modifiedSinceImport: false, storageKey: stored.storageKey, originalName: fileName,
    }
    await s.meta.files.upsert(file)
    s.security.invalidate()
    await audit(s, ctx, 'file.replace', { id: f.id, fileName })
    return file
  }, { auth: 'maker', raw: true, maxBodyMB: 25 })

  router.add('GET', '/api/v1/files/:id/download', async (ctx) => {
    const u = me(ctx)
    const f = await needFile(s, ctx.params.id)
    const tables = (await s.meta.tables.list()).filter((t) => t.origin?.kind === 'file' && t.origin.fileId === f.id)
    if (!tables.every((t) => canReadWholeTable(u, t))) throw denied('Downloading a data file needs full read access to all of its tables.')
    const bytes = await readDataFile(s.env, f.id).catch((e) => { throw friendly(e, 'Could not read the file') })
    const safe = f.fileName.replace(/[^A-Za-z0-9._ -]/g, '_')
    return { raw: true as const, headers: { 'Content-Type': KIND_MIME[f.kind] ?? 'application/octet-stream', 'Content-Disposition': `attachment; filename="${safe}"` }, body: bytes }
  }, { auth: 'maker' })

  router.add('DELETE', '/api/v1/files/:id', async (ctx) => {
    const f = await needFile(s, ctx.params.id)
    await deleteDataFile(s, f, ctx.query.get('dropTables') === '1')
    await audit(s, ctx, 'file.delete', { id: f.id, fileName: f.fileName })
    return { ok: true }
  }, { auth: 'maker' })
}

export { reqString }
