/**
 * Export environment data (P0 package M; docs/admin/backup-and-restore.md "Export environment data"): every table of the
 * current environment that lives in the default database, as one CSV per table in a ZIP, streamed (no temporary file,
 * memory bounded by one page of rows), plus `attachments.csv` (a manifest of the attachment files, not the files) and
 * `manifest.json` (environment, time, tables with row counts and columns).
 *
 * Security: environment administrators only, after a recent sign-in (requireRecentAuth) or with a one-use ticket that
 * one gave out a minute before (a browser download is a plain link), audited as `environment.export_data`. The export
 * is a full copy of the data (row and column security do not apply: an administrator reads everything anyway). Text
 * cells that a spreadsheet would run as a formula get a leading quote (csvExportText).
 *
 *   POST /api/v1/admin/export-data/ticket   -> { url }
 *   GET  /api/v1/admin/export-data[?ticket=] -> application/zip
 */
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import Papa from 'papaparse'
import type { TableDef } from '../../src/platform/contracts.ts'
import type { Ctx, RawResponse, SqlDb } from './contracts.ts'
import type { ApiRouter } from './router.ts'
import { HttpError } from './contracts.ts'
import type { CoreServices } from './services.ts'
import { currentEnvironment } from './env-context.ts'
import { DEFAULT_CONNECTION_ID } from './connections.ts'
import { csvExportText } from './values.ts'
import { requireRecentAuth } from './identity/index.ts'
import { audit } from '../routes/meta/tables-core.ts'
import { RECYCLE_COLUMN_NAMES, hasRecycleBin, liveRowsSql } from '../connectors/postgres/sql.ts'
import { CHAT_SYSTEM_TABLES } from './chat/ddl.ts'

const PAGE = 2000

/* ------------------------------------------------------------------ a streaming ZIP writer (deflate, data descriptors) */

interface Entry { name: Buffer; crc: number; size: number; csize: number; offset: number; time: number; date: number }

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/**
 * Writes ZIP entries one after the other to `push`. Each entry's data is deflated as it arrives; its CRC and sizes go in
 * a data descriptor after the data (general purpose bit 3), names are UTF-8 (bit 11). No ZIP64: an entry or the archive
 * past 4 GiB fails loudly rather than writing a broken file.
 */
export class ZipStream {
  private offset = 0
  private entries: Entry[] = []

  private count(b: Buffer): Buffer {
    this.offset += b.length
    if (this.offset > 0xffffffff) throw new Error('The export is larger than 4 GiB; export fewer tables.')
    return b
  }

  /** the bytes of one entry, produced while `chunks` is read */
  async *entry(name: string, chunks: AsyncIterable<string | Buffer>): AsyncGenerator<Buffer> {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/').replace(/^\/+/, ''), 'utf8')
    const { time, date } = dosTime(new Date())
    const e: Entry = { name: nameBuf, crc: 0, size: 0, csize: 0, offset: this.offset, time, date }
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0)
    h.writeUInt16LE(20, 4)
    h.writeUInt16LE(0x0808, 6) // bit 3: data descriptor, bit 11: UTF-8 names
    h.writeUInt16LE(8, 8) // deflate
    h.writeUInt16LE(time, 10)
    h.writeUInt16LE(date, 12)
    h.writeUInt16LE(nameBuf.length, 26)
    yield this.count(Buffer.concat([h, nameBuf]))
    const deflate = zlib.createDeflateRaw({ level: 6 })
    const pending: Buffer[] = []
    deflate.on('data', (c: Buffer) => pending.push(c))
    const take = (): Buffer[] => {
      const out = pending.splice(0)
      for (const c of out) { e.csize += c.length; this.count(c) }
      return out
    }
    for await (const chunk of chunks) {
      const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      e.crc = zlib.crc32(b, e.crc)
      e.size += b.length
      if (e.size > 0xffffffff) throw new Error(`${name} is larger than 4 GiB.`)
      await new Promise<void>((resolve, reject) => deflate.write(b, (err) => (err ? reject(err) : resolve())))
      yield* take()
    }
    // 'end' (not 'finish'): the last compressed bytes are emitted after the write side finished
    const ended = new Promise<void>((resolve, reject) => { deflate.once('end', resolve); deflate.once('error', reject) })
    deflate.end()
    await ended
    yield* take()
    const dd = Buffer.alloc(16)
    dd.writeUInt32LE(0x08074b50, 0)
    dd.writeUInt32LE(e.crc >>> 0, 4)
    dd.writeUInt32LE(e.csize, 8)
    dd.writeUInt32LE(e.size, 12)
    yield this.count(dd)
    this.entries.push(e)
  }

  /** the central directory and its end record */
  *finish(): Generator<Buffer> {
    const start = this.offset
    for (const e of this.entries) {
      const c = Buffer.alloc(46)
      c.writeUInt32LE(0x02014b50, 0)
      c.writeUInt16LE(20, 4)
      c.writeUInt16LE(20, 6)
      c.writeUInt16LE(0x0808, 8)
      c.writeUInt16LE(8, 10)
      c.writeUInt16LE(e.time, 12)
      c.writeUInt16LE(e.date, 14)
      c.writeUInt32LE(e.crc >>> 0, 16)
      c.writeUInt32LE(e.csize, 20)
      c.writeUInt32LE(e.size, 24)
      c.writeUInt16LE(e.name.length, 28)
      c.writeUInt32LE(e.offset, 42)
      yield this.count(Buffer.concat([c, e.name]))
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(this.entries.length, 8)
    end.writeUInt16LE(this.entries.length, 10)
    end.writeUInt32LE(this.offset - start, 12)
    end.writeUInt32LE(start, 16)
    yield this.count(end)
  }
}

/* ------------------------------------------------------------------ the export */

const qi = (id: string) => `"${id.replace(/"/g, '""')}"`

function cell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return v.toString('base64')
  if (typeof v === 'object') return csvExportText(JSON.stringify(v))
  return csvExportText(v as string | number | boolean)
}

/**
 * the tables of the export: the default database's own tables (system tables with rows included, views left out). Never
 * the chat tables (P3-A): administrators do not read conversations; one conversation is exported through the audited and
 * announced chat export (docs/admin/chat.md).
 */
export function exportableTables(all: TableDef[]): TableDef[] {
  return all.filter((t) => (t.connectionId ?? DEFAULT_CONNECTION_ID) === DEFAULT_CONNECTION_ID && !!t.source && t.reporting?.kind !== 'view' && t.systemKind !== 'projection' && !CHAT_SYSTEM_TABLES.includes(t.id))
}

async function physicalColumns(db: SqlDb, schema: string, table: string): Promise<string[]> {
  return (await db.query<{ c: string }>('SELECT column_name AS c FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position', [schema, table])).map((r) => r.c)
}

async function* tableCsv(db: SqlDb, schema: string, def: TableDef, counts: Map<string, number>, includeDeleted: boolean): AsyncGenerator<string> {
  const have = new Set(await physicalColumns(db, schema, def.source!))
  const cols = def.columns.map((c) => c.name).filter((c) => have.has(c))
  if (!cols.length) return
  // recycle bin: deleted rows only when the administrator asked for them (with the three columns that say so)
  const bin = hasRecycleBin(def) && RECYCLE_COLUMN_NAMES.every((c) => have.has(c))
  if (bin && includeDeleted) cols.push(...RECYCLE_COLUMN_NAMES)
  const live = bin && !includeDeleted ? liveRowsSql(def) : 'TRUE'
  yield Papa.unparse({ fields: cols, data: [] }, { newline: '\r\n' }) + '\r\n'
  const sel = cols.map(qi).join(', ')
  const T = `${qi(schema)}.${qi(def.source!)}`
  const keyed = cols.includes('id')
  let last: string | null = null
  let n = 0
  for (let offset = 0; ; offset += PAGE) {
    // keyset pages on the primary key (a table without id: offset pages)
    const rows: Record<string, unknown>[] = keyed
      ? await db.query<Record<string, unknown>>(`SELECT ${sel} FROM ${T} WHERE ${live}${last === null ? '' : ' AND "id" > $1'} ORDER BY "id" LIMIT ${PAGE}`, last === null ? [] : [last])
      : await db.query<Record<string, unknown>>(`SELECT ${sel} FROM ${T} WHERE ${live} LIMIT ${PAGE} OFFSET ${offset}`)
    if (!rows.length) break
    n += rows.length
    yield Papa.unparse({ fields: cols, data: rows.map((r) => cols.map((c) => cell(r[c]))) }, { header: false, newline: '\r\n' }) + '\r\n'
    if (rows.length < PAGE) break
    if (keyed) last = String(rows[rows.length - 1]!.id)
  }
  counts.set(def.id, n)
}

/** the export as a stream of ZIP bytes (schema and tables captured up front: the stream runs after the route returned) */
export function exportStream(db: SqlDb, env: { id: string; schema: string; name: string }, tables: TableDef[], o: { by: string; includeDeleted?: boolean; onDone?(counts: Map<string, number>): void }): Readable {
  const counts = new Map<string, number>()
  const used = new Set<string>()
  const fileName = (t: TableDef) => {
    let base = (t.name || t.id).replace(/[^A-Za-z0-9_.-]/g, '_')
    for (let i = 2; used.has(base.toLowerCase()); i++) base = `${(t.name || t.id).replace(/[^A-Za-z0-9_.-]/g, '_')}_${i}`
    used.add(base.toLowerCase())
    return `tables/${base}.csv`
  }
  return Readable.from((async function* () {
    const zip = new ZipStream()
    const files: { table: TableDef; file: string }[] = []
    for (const t of tables) {
      const file = fileName(t)
      files.push({ table: t, file })
      yield* zip.entry(file, tableCsv(db, env.schema, t, counts, o.includeDeleted === true))
    }
    const attachments = await db.query<Record<string, unknown>>(
      `SELECT id, table_id, row_id, col AS column_name, file_name, mime AS content_type, size_bytes AS size, sha256, created_on FROM ${qi(env.schema)}."ab_attachments" WHERE table_id <> ALL($1::text[]) ORDER BY id`,
      [CHAT_SYSTEM_TABLES],
    )
    const fields = ['id', 'table_id', 'row_id', 'column_name', 'file_name', 'content_type', 'size', 'sha256', 'created_on']
    yield* zip.entry('attachments.csv', (async function* () {
      yield Papa.unparse({ fields, data: attachments.map((a) => fields.map((f) => cell(a[f]))) }, { newline: '\r\n' }) + '\r\n'
    })())
    const manifest = {
      kind: 'appbuilder/environment-data', version: 1, environment: { id: env.id, name: env.name }, exportedOn: new Date().toISOString(), exportedBy: o.by, includesDeletedRows: o.includeDeleted === true,
      note: 'One CSV per table (UTF-8, comma separated, first line = column names). Text that a spreadsheet would read as a formula starts with an added single quote. attachments.csv lists the attachment files; the files themselves are in a backup, not in this export.',
      tables: files.map(({ table, file }) => ({ id: table.id, name: table.name, displayName: table.displayName, file, rows: counts.get(table.id) ?? 0, system: !!table.system, columns: table.columns.map((c) => ({ name: c.name, type: c.type })) })),
      attachments: attachments.length,
    }
    yield* zip.entry('manifest.json', (async function* () { yield JSON.stringify(manifest, null, 2) })())
    yield* zip.finish()
    o.onDone?.(counts)
  })())
}

/* ------------------------------------------------------------------ routes */

export function registerExportRoutes(router: ApiRouter, s: CoreServices): void {
  const tickets = new Map<string, { user: string; env: string; until: number }>()
  const sweep = () => { const now = Date.now(); for (const [k, v] of tickets) if (v.until < now) tickets.delete(k) }

  const admin = (ctx: Ctx) => {
    if (!ctx.user?.privileges.isAdmin) throw new HttpError(403, 'denied', 'Only administrators of this environment can export its data.')
    return ctx.user
  }

  router.add('POST', '/admin/export-data/ticket', async (ctx) => {
    const u = admin(ctx)
    requireRecentAuth(ctx)
    sweep()
    const t = randomBytes(24).toString('base64url')
    tickets.set(t, { user: u.user.id, env: currentEnvironment().id, until: Date.now() + 60_000 })
    // recycle bin: deleted rows only when the administrator ticks "include deleted" (they then carry deletedOn)
    const deleted = (ctx.body as { includeDeleted?: unknown } | null)?.includeDeleted === true ? '&includeDeleted=1' : ''
    return { url: `/api/v1/admin/export-data?ticket=${t}&env=${encodeURIComponent(currentEnvironment().id)}${deleted}` }
  }, { auth: 'admin' })

  router.add('GET', '/admin/export-data', async (ctx): Promise<RawResponse> => {
    const u = admin(ctx)
    const env = currentEnvironment()
    const t = ctx.query.get('ticket')
    const hit = t ? tickets.get(t) : undefined
    if (t) tickets.delete(t)
    if (!(hit && hit.user === u.user.id && hit.env === env.id && hit.until >= Date.now())) requireRecentAuth(ctx)
    const db = s.state.db
    if (!db) throw new HttpError(503, 'unavailable', 'The database is not available.')
    const tables = exportableTables(await s.meta.tables.list())
    const rec = await s.environments.get(env.id).catch(() => null)
    const name = rec?.name ?? env.id
    const includeDeleted = ctx.query.get('includeDeleted') === '1'
    await audit(s, ctx, 'environment.export_data', { tables: tables.length, ...(includeDeleted ? { includeDeleted: true } : {}) })
    const stamp = new Date().toISOString().slice(0, 10)
    return {
      raw: true,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${`${name}-data-${stamp}`.replace(/[^A-Za-z0-9._-]/g, '_')}.zip"`,
        'Cache-Control': 'no-store',
      },
      body: exportStream(db, { id: env.id, schema: env.schema, name }, tables, { by: u.user.email, includeDeleted }),
    }
  }, { auth: 'admin' })
}
