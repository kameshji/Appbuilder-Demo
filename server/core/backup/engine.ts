/**
 * The backup engine (docs/dev/backup.md): writes one archive per backup, reads it back, verifies it and restores schemas,
 * tables and workspace folders from it. No HTTP, no catalogue: service.ts and cli.ts drive it.
 *
 * Consistency: the database part of a backup comes from ONE transaction (REPEATABLE READ, READ ONLY) on one connection.
 * Its snapshot is exported (pg_export_snapshot) and pg_dump runs with --snapshot=<it>, so the row counts and catalogue
 * the engine records, and the data pg_dump writes, are the same instant for every schema of the backup (an install
 * backup: ab and every environment). The built-in exporter copies every table inside that transaction itself. Writers
 * keep working meanwhile; what they commit later is simply not in the backup.
 */
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { pipeline } from 'node:stream/promises'
import { PassThrough, Transform, Writable, type Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { createHash, randomBytes } from 'node:crypto'
import { from as copyFrom } from 'pg-copy-streams'
import type { DatabaseSettings, EnvironmentDirs } from '../contracts.ts'
import { poolConfig } from '../../connectors/postgres/db.ts'
import {
  ArchiveError, MANIFEST_NAME, MARKER_NAME, TarWriter, encryptedFileSink, listTar, memberBuffer, memberStream, openReader, plainFileSink,
  type MemberInfo, type RandomReader, type TarEntry,
} from './archive.ts'
import {
  LineCounter, RestoreDataParser, catalogOf, copyColumns, copyInto, countRows, exportTable, postDataSql, preDataSql, qi, renameInSql,
  skipRestoreStatement, splitSql, type Catalog,
} from './dbdump.ts'
import { connArgs, findPgTools, pgEnv, runTool, toolProblem, type PgTools } from './pgtools.ts'

export const FORMAT = 'appbuilder-backup'
export const FORMAT_VERSION = 1
export const INSTALL_SCHEMA = 'ab'
/** tables of schema ab whose rows are never backed up: sign-in sessions (everyone signs in again after a restore), single-use sign-in tokens (reset, invitation and email codes) and the backup catalogue itself */
export const AB_NO_DATA = ['sessions', 'auth_tokens', 'backups', 'backup_ops']

export type BackupKind = 'install' | 'environment'
export type BackupMethod = 'pg_dump' | 'builtin'
export type BackupTrigger = 'manual' | 'schedule' | 'pre-upgrade' | 'pre-delete' | 'pre-restore' | 'pre-migration' | 'upload'

export interface ManifestEnvironment {
  id: string
  name: string
  type: string
  schema: string
  schemaVersion: number
  locked?: boolean
  description?: string
  attachments: { count: number; bytes: number; missing: number }
  dataFiles: { count: number; bytes: number }
  /** tables made in Appbuilder (ab_tables), with the physical table and its rows */
  tables: { id: string; name: string; source: string | null; connectionId: string | null; rows: number | null; columns: { name: string; type: string }[] }[]
}

export interface ManifestSchema {
  name: string
  /** install: schema ab; environment: an environment schema (environment id) */
  environment?: string
  tables: { name: string; rows: number; noData?: boolean }[]
}

export interface Manifest {
  format: typeof FORMAT
  formatVersion: number
  id: string
  kind: BackupKind
  trigger: BackupTrigger
  note?: string
  createdOn: string
  finishedOn: string
  createdBy: { id: string; name: string; email: string } | null
  app: { version: string; schemaVersion: number }
  server: { version: string; database: string }
  method: BackupMethod
  pgDump?: { version: string }
  snapshot: { isolation: 'repeatable read'; exported: boolean; at: string }
  includesKey: boolean
  schemas: ManifestSchema[]
  environments: ManifestEnvironment[]
  /** every member except the marker and this manifest, with its size and sha256 */
  files: MemberInfo[]
  warnings: string[]
}

export interface Progress { phase: 'snapshot' | 'database' | 'files' | 'finishing' | 'verifying' | 'restoring' | 'checking'; done: number; total: number; message?: string }

export interface EnvSource { id: string; name: string; type: string; schema: string; schemaVersion: number; locked?: boolean; description?: string }

export interface CreateSpec {
  id: string
  kind: BackupKind
  environments: EnvSource[]
  /** final path of the archive (written as a temporary file next to it, then renamed) */
  file: string
  method: 'auto' | BackupMethod
  pgBin?: string | null
  passphrase?: string | null
  /** the install's secret key (hex) when the administrator chose to include it */
  secretKey?: string | null
  trigger: BackupTrigger
  note?: string
  createdBy: Manifest['createdBy']
  appVersion: string
  schemaVersion: number
  dirs(envId: string): EnvironmentDirs
  /** pending writes of data files reach disk (files connector) */
  flushFiles?(envId: string): Promise<void>
  onProgress?(p: Progress): void
  signal?: AbortSignal
  /** tests: called while the snapshot transaction is open, after the snapshot was taken */
  afterSnapshot?(): Promise<void>
}

export interface Connection { settings: DatabaseSettings; password: string }

export async function connect(c: Connection, o: { statementTimeoutMs?: number } = {}): Promise<pg.Client> {
  const client = new pg.Client(poolConfig(c.settings, c.password, { max: 1, connectTimeoutMs: 15_000 }))
  client.on('error', () => {})
  await client.connect()
  await client.query(`SET statement_timeout = ${Math.max(0, Math.trunc(o.statementTimeoutMs ?? 0))}`)
  return client
}

const posix = (p: string): string => p.split(path.sep).join('/')

async function walk(dir: string): Promise<{ abs: string; rel: string; size: number }[]> {
  const out: { abs: string; rel: string; size: number }[] = []
  async function go(d: string, rel: string): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const e of entries) {
      const abs = path.join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await go(abs, r)
      else if (e.isFile()) {
        try {
          out.push({ abs, rel: r, size: (await fs.promises.stat(abs)).size })
        } catch { /* removed meanwhile */ }
      }
    }
  }
  await go(dir, '')
  return out
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('The backup was cancelled.')
}

/* ------------------------------------------------------------------ create */

export async function createArchive(conn: Connection, spec: CreateSpec): Promise<{ bytes: number; sha256: string; manifest: Manifest; manifestSha256: string }> {
  const dir = path.dirname(spec.file)
  await fs.promises.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.tmp-${spec.id}.abbak`)
  const work = path.join(dir, `.work-${spec.id}`)
  await fs.promises.rm(work, { recursive: true, force: true })
  await fs.promises.mkdir(work, { recursive: true, mode: 0o700 })
  const warnings: string[] = []
  const progress = { phase: 'snapshot' as Progress['phase'], done: 0, total: 0 }
  const report = (p: Partial<Progress>) => {
    Object.assign(progress, p)
    spec.onProgress?.({ ...progress })
  }
  report({ phase: 'snapshot', done: 0, total: 0, message: 'Taking a consistent snapshot of the database' })
  const createdOn = new Date().toISOString()
  const client = await connect(conn)
  let sink: Awaited<ReturnType<typeof encryptedFileSink>> | null = null
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    const snap = await client.query<{ s: string; v: string; n: string; db: string }>(
      "SELECT pg_catalog.pg_export_snapshot() AS s, pg_catalog.current_setting('server_version') AS v, pg_catalog.current_setting('server_version_num') AS n, pg_catalog.current_database() AS db")
    const snapshotId = snap.rows[0].s
    const serverMajor = Math.floor(Number(snap.rows[0].n) / 10000)
    const snapshotAt = new Date().toISOString()
    await spec.afterSnapshot?.()
    // what goes in
    const schemas: { name: string; environment?: string; noData: string[] }[] = []
    if (spec.kind === 'install') schemas.push({ name: INSTALL_SCHEMA, noData: AB_NO_DATA })
    for (const e of spec.environments) schemas.push({ name: e.schema, environment: e.id, noData: [] })
    const catalogs = new Map<string, Catalog>()
    for (const s of schemas) {
      const exists = await client.query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1', [s.name])
      if (!exists.rowCount) throw new Error(`The database schema ${s.name} does not exist.`)
      const cat = await catalogOf(client, s.name, s.noData)
      if (cat.unsupported.length) warnings.push(`Schema ${s.name} has ${cat.unsupported.join(', ')} that the built-in exporter does not copy${spec.method === 'builtin' ? '' : ' (pg_dump does)'}.`)
      catalogs.set(s.name, cat)
    }
    // database size for progress
    const sizes = await client.query<{ n: string }>(
      `SELECT COALESCE(sum(pg_catalog.pg_table_size(c.oid)), 0)::text AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1::text[]) AND c.relkind = 'r'`, [schemas.map((s) => s.name)])
    const dbBytes = Number(sizes.rows[0].n) || 0
    // attachment records in the snapshot (to report files that are missing on disk)
    const attachmentKeys = new Map<string, Set<string>>()
    for (const e of spec.environments) {
      const r = await client.query<{ k: string }>(`SELECT storage_key AS k FROM ${qi(e.schema)}."ab_attachments"`).catch(() => ({ rows: [] as { k: string }[] }))
      attachmentKeys.set(e.id, new Set(r.rows.map((x) => x.k)))
    }
    // the method
    let method: BackupMethod = 'builtin'
    let tools: PgTools | null = null
    if (spec.method !== 'builtin') {
      tools = await findPgTools(spec.pgBin)
      const problem = toolProblem(tools.dump, 'pg_dump', serverMajor)
      if (!problem) method = 'pg_dump'
      else if (spec.method === 'pg_dump') throw new Error(`pg_dump cannot be used: ${problem}.`)
      else warnings.push(`Made with the built-in exporter: ${problem}.`)
    }
    // the archive
    sink = spec.passphrase ? await encryptedFileSink(tmp, spec.passphrase) : plainFileSink(tmp)
    const tar = new TarWriter(sink)
    await tar.addBuffer(MARKER_NAME, Buffer.from(JSON.stringify({ format: FORMAT, formatVersion: FORMAT_VERSION, id: spec.id, kind: spec.kind, createdOn }, null, 2) + '\n'))
    const files: MemberInfo[] = []
    const fileBytes = new Map<string, number>()
    let filesTotal = 0
    const envFiles = new Map<string, { att: Awaited<ReturnType<typeof walk>>; data: Awaited<ReturnType<typeof walk>> }>()
    for (const e of spec.environments) {
      await spec.flushFiles?.(e.id).catch((err) => warnings.push(`Pending data file writes of ${e.id} could not be flushed first: ${(err as Error).message}`))
      const d = spec.dirs(e.id)
      const att = await walk(d.attachments)
      const data = await walk(d.files)
      envFiles.set(e.id, { att, data })
      filesTotal += [...att, ...data].reduce((a, f) => a + f.size, 0)
    }
    const total = dbBytes + filesTotal
    report({ phase: 'database', done: 0, total, message: method === 'pg_dump' ? `pg_dump ${tools!.dump!.version}` : 'Built-in exporter' })
    let done = 0
    const add = (n: number) => {
      done += n
      report({ done })
    }
    if (method === 'pg_dump') {
      for (const s of schemas) await countRows(client, s.name, catalogs.get(s.name)!)
      const out = path.join(work, 'dump.pgc')
      const args = [...connArgs(conn.settings), '--format=custom', '--compress=6', `--snapshot=${snapshotId}`, '--no-owner', '--no-acl', '--file', out]
      for (const s of schemas) args.push('--schema', s.name)
      for (const t of AB_NO_DATA) if (spec.kind === 'install') args.push('--exclude-table-data', `${INSTALL_SCHEMA}.${t}`)
      const run = runTool(tools!.dump!.path, args, pgEnv(conn.settings, conn.password), { signal: spec.signal })
      const timer = setInterval(() => {
        fs.promises.stat(out).then((st) => report({ done: Math.min(dbBytes, st.size * 3), message: `pg_dump ${tools!.dump!.version}` }), () => {})
      }, 500)
      try {
        await run.done
      } finally {
        clearInterval(timer)
      }
      done = dbBytes
      files.push(await tar.addFile('db/dump.pgc', out))
      await fs.promises.rm(out, { force: true })
    } else {
      for (const s of schemas) {
        const cat = catalogs.get(s.name)!
        await fs.promises.mkdir(path.join(work, s.name), { recursive: true })
        for (const t of cat.tables) {
          throwIfAborted(spec.signal)
          const f = path.join(work, s.name, `${t.name}.copy.gz`)
          const r = await exportTable(client, s.name, t, f, (n) => add(Math.min(n, Math.max(0, dbBytes - done))))
          t.rows = r.rows
          files.push(await tar.addFile(`db/${s.name}/${t.name}.copy.gz`, f))
          await fs.promises.rm(f, { force: true })
        }
      }
      done = dbBytes
    }
    for (const s of schemas) {
      files.push(await tar.addBuffer(`db/${s.name}/schema.json`, Buffer.from(JSON.stringify(catalogs.get(s.name)))))
    }
    // the Appbuilder tables of each environment (names, sources, rows) for the console and table restores
    const envManifest: ManifestEnvironment[] = []
    for (const e of spec.environments) {
      const cat = catalogs.get(e.schema)!
      const rowsOf = new Map(cat.tables.map((t) => [t.name, t.rows ?? null]))
      const defs = await client.query<{ id: string; name: string; source: string | null; connection_id: string | null; def: { columns?: { name: string; type: string }[]; displayName?: string } }>(
        `SELECT id, name, source, connection_id, def FROM ${qi(e.schema)}."ab_tables" ORDER BY lower(name) COLLATE "C", id`)
      envManifest.push({
        id: e.id, name: e.name, type: e.type, schema: e.schema, schemaVersion: e.schemaVersion, ...(e.locked ? { locked: true } : {}), ...(e.description ? { description: e.description } : {}),
        attachments: { count: 0, bytes: 0, missing: 0 }, dataFiles: { count: 0, bytes: 0 },
        tables: defs.rows.map((d) => ({
          id: d.id, name: d.name, source: d.source, connectionId: d.connection_id,
          rows: d.source && rowsOf.has(d.source) ? rowsOf.get(d.source)! : null,
          columns: (d.def?.columns ?? []).map((c) => ({ name: c.name, type: c.type })),
        })),
      })
    }
    // the snapshot is no longer needed: the database part is complete
    await client.query('COMMIT')
    report({ phase: 'files', done, total, message: 'Attachments and data files' })
    for (const e of spec.environments) {
      const { att, data } = envFiles.get(e.id)!
      const m = envManifest.find((x) => x.id === e.id)!
      const present = new Set<string>()
      for (const f of att) {
        throwIfAborted(spec.signal)
        try {
          files.push(await tar.addFile(`files/${e.id}/attachments/${f.rel}`, f.abs, add))
          m.attachments.count++
          m.attachments.bytes += f.size
          present.add(path.posix.basename(f.rel))
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw err
        }
      }
      for (const f of data) {
        throwIfAborted(spec.signal)
        // data files can be rewritten at any moment: copy first, then add the copy (its size cannot change)
        const copy = path.join(work, `datafile-${randomBytes(6).toString('hex')}`)
        try {
          await fs.promises.copyFile(f.abs, copy)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw err
        }
        files.push(await tar.addFile(`files/${e.id}/files/${f.rel}`, copy, add))
        await fs.promises.rm(copy, { force: true })
        m.dataFiles.count++
        m.dataFiles.bytes += f.size
      }
      const missing = [...(attachmentKeys.get(e.id) ?? [])].filter((k) => !present.has(k))
      m.attachments.missing = missing.length
      if (missing.length) warnings.push(`${missing.length} attachment file(s) of ${e.name} were missing on disk (their records are in the backup, the files are not).`)
      fileBytes.set(e.id, m.attachments.bytes + m.dataFiles.bytes)
    }
    if (spec.secretKey) files.push(await tar.addBuffer('key/secret-key', Buffer.from(spec.secretKey.trim() + '\n')))
    report({ phase: 'finishing', done: total, total, message: 'Writing the manifest' })
    const manifest: Manifest = {
      format: FORMAT, formatVersion: FORMAT_VERSION, id: spec.id, kind: spec.kind, trigger: spec.trigger, ...(spec.note ? { note: spec.note } : {}),
      createdOn, finishedOn: new Date().toISOString(), createdBy: spec.createdBy,
      app: { version: spec.appVersion, schemaVersion: spec.schemaVersion },
      server: { version: `PostgreSQL ${snap.rows[0].v.split(' ')[0]}`, database: snap.rows[0].db },
      method, ...(method === 'pg_dump' ? { pgDump: { version: tools!.dump!.version } } : {}),
      snapshot: { isolation: 'repeatable read', exported: method === 'pg_dump', at: snapshotAt },
      includesKey: !!spec.secretKey,
      schemas: schemas.map((s) => ({
        name: s.name, ...(s.environment ? { environment: s.environment } : {}),
        tables: catalogs.get(s.name)!.tables.map((t) => ({ name: t.name, rows: t.rows ?? 0, ...(t.noData ? { noData: true } : {}) })),
      })),
      environments: envManifest,
      files,
      warnings,
    }
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 1))
    await tar.addBuffer(MANIFEST_NAME, manifestBuf)
    const res = await tar.finish()
    sink = null
    await fs.promises.rename(tmp, spec.file)
    return { ...res, manifest, manifestSha256: createHash('sha256').update(manifestBuf).digest('hex') }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    await sink?.abort().catch(() => {})
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
    throw e
  } finally {
    await client.end().catch(() => {})
    await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

/* ------------------------------------------------------------------ open */

export interface BackupArchive {
  file: string
  reader: RandomReader
  entries: Map<string, TarEntry>
  manifest: Manifest
  manifestSha256: string
  encrypted: boolean
  stream(name: string): Readable
  buffer(name: string): Promise<Buffer>
  catalog(schema: string): Promise<Catalog>
  /** a work folder for this archive (pg_restore needs the dump as a seekable file); removed by close() */
  workDir(): Promise<string>
  /** db/dump.pgc as a file (pg_dump archives) */
  dumpFile(): Promise<string>
  close(): Promise<void>
}

export async function openArchive(file: string, passphrase?: string | null, o: { workRoot?: string } = {}): Promise<BackupArchive> {
  const reader = await openReader(file, passphrase)
  try {
    const list = await listTar(reader)
    if (!list.length || list[0].name !== MARKER_NAME) throw new ArchiveError('format', 'This file is not an Appbuilder backup.')
    const marker = JSON.parse((await memberBuffer(reader, list[0])).toString('utf8')) as { format?: string; formatVersion?: number }
    if (marker.format !== FORMAT) throw new ArchiveError('format', 'This file is not an Appbuilder backup.')
    if ((marker.formatVersion ?? 0) > FORMAT_VERSION) throw new ArchiveError('format', `This backup was made by a newer Appbuilder (archive format ${marker.formatVersion}; this version reads ${FORMAT_VERSION}). Restore it with that version or newer.`)
    const entries = new Map(list.map((e) => [e.name, e]))
    const me = entries.get(MANIFEST_NAME)
    if (!me || list[list.length - 1].name !== MANIFEST_NAME) throw new ArchiveError('corrupt', 'The backup has no manifest at its end: it is incomplete or was changed.')
    const mbuf = await memberBuffer(reader, me)
    let manifest: Manifest
    try {
      manifest = JSON.parse(mbuf.toString('utf8')) as Manifest
    } catch {
      throw new ArchiveError('corrupt', 'The manifest of this backup is damaged.')
    }
    let work: string | null = null
    let dump: string | null = null
    const cats = new Map<string, Catalog>()
    const a: BackupArchive = {
      file, reader, entries, manifest, encrypted: reader.encrypted,
      manifestSha256: createHash('sha256').update(mbuf).digest('hex'),
      stream(name) {
        const e = entries.get(name)
        if (!e) throw new ArchiveError('corrupt', `The backup has no member ${name}.`)
        return memberStream(reader, e)
      },
      async buffer(name) {
        const e = entries.get(name)
        if (!e) throw new ArchiveError('corrupt', `The backup has no member ${name}.`)
        return memberBuffer(reader, e)
      },
      async catalog(schema) {
        if (!cats.has(schema)) cats.set(schema, JSON.parse((await a.buffer(`db/${schema}/schema.json`)).toString('utf8')) as Catalog)
        return cats.get(schema)!
      },
      async workDir() {
        if (!work) {
          const root = o.workRoot ?? path.dirname(file)
          work = path.join(root, `.work-open-${randomBytes(6).toString('hex')}`)
          await fs.promises.mkdir(work, { recursive: true, mode: 0o700 })
        }
        return work
      },
      async dumpFile() {
        if (!dump) {
          const f = path.join(await a.workDir(), 'dump.pgc')
          await pipeline(a.stream('db/dump.pgc'), fs.createWriteStream(f, { mode: 0o600 }))
          dump = f
        }
        return dump
      },
      async close() {
        await reader.close().catch(() => {})
        if (work) await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {})
      },
    }
    return a
  } catch (e) {
    await reader.close().catch(() => {})
    throw e
  }
}

/* ------------------------------------------------------------------ verify */

export interface VerifyResult {
  ok: boolean
  errors: string[]
  notes: string[]
  files: number
  bytes: number
  /** rows counted again from the archive (null: not possible without pg_restore) */
  rows: number | null
}

/** extracts one table's COPY block from pg_restore --data-only output */
export class CopyBlock extends Transform {
  private buf: Buffer = Buffer.alloc(0)
  private state: 'before' | 'in' | 'after' = 'before'
  columns: string[] = []
  _transform(chunk: Buffer, _e: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    let start = 0
    let i = this.buf.indexOf(10)
    while (i >= 0) {
      // pg_restore on Windows ends lines with CR LF (text mode); COPY text never holds a raw CR
      const cr = i > start && this.buf[i - 1] === 0x0d
      const line = this.buf.subarray(start, cr ? i - 1 : i)
      if (this.state === 'before') {
        const m = /^COPY\s+\S+\s*\(([^)]*)\)\s+FROM\s+stdin;/i.exec(line.toString('utf8'))
        if (m) {
          this.columns = m[1].split(',').map((x) => x.trim().replace(/^"|"$/g, '').replace(/""/g, '"'))
          this.state = 'in'
          this.emit('columns', this.columns)
        }
      } else if (this.state === 'in') {
        if (line.length === 2 && line[0] === 0x5c && line[1] === 0x2e) this.state = 'after'
        else this.push(cr ? Buffer.concat([line, Buffer.from('\n')]) : this.buf.subarray(start, i + 1))
      }
      start = i + 1
      i = this.buf.indexOf(10, start)
    }
    this.buf = Buffer.from(this.buf.subarray(start))
    cb()
  }
}

/**
 * The rows of one table as COPY text (one line per row) and the column names, from either kind of archive.
 * pg_dump archives need pg_restore.
 */
export async function tableData(a: BackupArchive, schema: string, table: string, tools?: PgTools | null): Promise<{ columns: string[]; stream: Readable; done: Promise<void> }> {
  const cat = await a.catalog(schema)
  const t = cat.tables.find((x) => x.name === table)
  if (!t) throw new ArchiveError('format', `The backup has no table ${schema}.${table}.`)
  if (a.manifest.method === 'builtin') {
    const s = a.stream(`db/${schema}/${table}.copy.gz`).pipe(createGunzip())
    return { columns: copyColumns(t), stream: s, done: Promise.resolve() }
  }
  const tool = (tools ?? (await findPgTools())).restore
  if (!tool) throw new Error('This backup was made with pg_dump: reading it needs pg_restore (PostgreSQL client tools), which was not found.')
  const dump = await a.dumpFile()
  const run = runTool(tool.path, ['--data-only', '--schema', schema, '--table', table, '--file', '-', dump], process.env)
  const block = new CopyBlock()
  run.child.stdout!.pipe(block)
  run.done.catch((e) => block.destroy(e))
  return { columns: copyColumns(t), stream: block, done: run.done }
}

export async function verifyArchive(a: BackupArchive, o: { tools?: PgTools | null; onProgress?(p: Progress): void; expectedManifestSha256?: string | null } = {}): Promise<VerifyResult> {
  const errors: string[] = []
  const notes: string[] = []
  const m = a.manifest
  if (o.expectedManifestSha256 && o.expectedManifestSha256 !== a.manifestSha256) errors.push('The manifest is not the one written when this backup was made (the archive was changed).')
  const listed = new Set(m.files.map((f) => f.name))
  for (const name of a.entries.keys()) {
    if (name !== MARKER_NAME && name !== MANIFEST_NAME && !listed.has(name)) errors.push(`The archive contains ${name}, which the manifest does not list.`)
  }
  const total = m.files.reduce((s, f) => s + f.size, 0)
  let done = 0
  for (const f of m.files) {
    const e = a.entries.get(f.name)
    if (!e) { errors.push(`${f.name} is missing from the archive.`); continue }
    if (e.size !== f.size) { errors.push(`${f.name} has ${e.size} bytes, the manifest says ${f.size}.`); continue }
    const h = createHash('sha256')
    try {
      for await (const c of a.stream(f.name)) {
        h.update(c as Buffer)
        done += (c as Buffer).length
        o.onProgress?.({ phase: 'verifying', done, total, message: 'Checksums' })
      }
    } catch (err) {
      errors.push(err instanceof ArchiveError ? err.message : `${f.name} could not be read: ${(err as Error).message}`)
      if (err instanceof ArchiveError && err.kind !== 'format') break
      continue
    }
    if (h.digest('hex') !== f.sha256) errors.push(`${f.name} does not match its checksum (changed or damaged).`)
  }
  // rows: counted again from the data
  let rows: number | null = 0
  if (!errors.length) {
    const expected = new Map<string, number>()
    for (const s of m.schemas) for (const t of s.tables) if (!t.noData) expected.set(`${s.name}.${t.name}`, t.rows)
    const seen = new Map<string, number>()
    if (m.method === 'builtin') {
      for (const s of m.schemas) {
        for (const t of s.tables) {
          if (t.noData) continue
          const counter = new LineCounter()
          await pipeline(a.stream(`db/${s.name}/${t.name}.copy.gz`), createGunzip(), counter, new Writable({ write: (_c, _e, cb) => cb() }))
          seen.set(`${s.name}.${t.name}`, counter.lines)
        }
      }
    } else {
      const tool = (o.tools ?? (await findPgTools())).restore
      if (!tool) {
        rows = null
        notes.push('Row counts were not checked again: pg_restore was not found (the checksums were).')
      } else {
        const run = runTool(tool.path, ['--data-only', '--file', '-'], process.env, { stdin: a.stream('db/dump.pgc') })
        let current: string | null = null
        let count = 0
        const parser = new RestoreDataParser({
          async onCopy(h) {
            current = `${h.schema}.${h.table}`
            count = 0
            return new Writable({ write(c: Buffer, _e, cb) { for (let i = c.indexOf(10); i >= 0; i = c.indexOf(10, i + 1)) count++; cb() } })
          },
          async onCopyEnd() { if (current) seen.set(current, count); current = null },
          async onStatement() { /* sequence values */ },
        })
        try {
          await Promise.all([pipeline(run.child.stdout!, parser), run.done])
        } catch (err) {
          errors.push(`pg_restore could not read the database dump: ${(err as Error).message}`)
        }
      }
    }
    if (rows !== null && !errors.length) {
      for (const [k, n] of expected) {
        const got = seen.get(k) ?? 0
        if (got !== n) errors.push(`Table ${k}: ${got} rows in the archive, the manifest says ${n}.`)
        rows! += got
      }
    }
  } else rows = null
  return { ok: !errors.length, errors, notes, files: m.files.length, bytes: total, rows }
}

/* ------------------------------------------------------------------ restore */

export interface RestoreSchemaOptions {
  tools?: PgTools | null
  onProgress?(p: Progress): void
  /** tests: throw after this many tables were filled (the caller's transaction then rolls everything back) */
  failAfterTables?: number
}

/**
 * Creates `target` and restores schema `source` of the archive into it, on `c` (call inside a transaction: on any
 * error nothing remains). The target must not exist. Returns the rows stored per table; every count is checked
 * against the manifest.
 */
export async function restoreSchema(c: pg.Client, a: BackupArchive, source: string, target: string, o: RestoreSchemaOptions = {}): Promise<Map<string, number>> {
  const ms = a.manifest.schemas.find((s) => s.name === source)
  if (!ms) throw new ArchiveError('format', `The backup does not contain the schema ${source}.`)
  const expected = new Map(ms.tables.map((t) => [t.name, t.noData ? 0 : t.rows]))
  const stored = new Map<string, number>()
  const total = ms.tables.reduce((s, t) => s + (t.noData ? 0 : t.rows), 0)
  let done = 0
  let filled = 0
  const check = (table: string, n: number) => {
    stored.set(table, n)
    done += n
    o.onProgress?.({ phase: 'restoring', done, total, message: `${source}.${table}` })
    if (expected.has(table) && expected.get(table) !== n) throw new Error(`Table ${table}: ${n} rows restored, the backup says ${expected.get(table)}.`)
    filled++
    if (o.failAfterTables !== undefined && filled >= o.failAfterTables) throw new Error(`Restore stopped on purpose after ${filled} table(s) (test).`)
  }
  await c.query(`CREATE SCHEMA ${qi(target)}`)
  if (a.manifest.method === 'builtin') {
    const cat = await a.catalog(source)
    for (const s of preDataSql(cat, target)) await c.query(s)
    for (const t of cat.tables) {
      if (t.noData) continue
      const n = await copyInto(c, target, t.name, copyColumns(t), a.stream(`db/${source}/${t.name}.copy.gz`).pipe(createGunzip()))
      check(t.name, n)
    }
    for (const s of postDataSql(cat, target)) await c.query(s)
    return stored
  }
  const tool = (o.tools ?? (await findPgTools())).restore
  if (!tool) throw new Error('This backup was made with pg_dump: restoring it needs pg_restore (PostgreSQL client tools), which was not found. Install them or set the PostgreSQL tools folder.')
  const dumpMajor = Number((a.manifest.pgDump?.version ?? '0').split('.')[0])
  if (tool.major < dumpMajor) throw new Error(`This backup was made with pg_dump ${a.manifest.pgDump?.version}; pg_restore ${tool.version} cannot read it. Use pg_restore ${dumpMajor} or newer.`)
  const dump = await a.dumpFile()
  const base = ['--schema', source, '--no-owner', '--no-acl', '--no-comments', '--file', '-', dump]
  const ddl = async (section: 'pre-data' | 'post-data') => {
    let text = ''
    const run = runTool(tool.path, [`--section=${section}`, ...base], process.env)
    run.child.stdout!.on('data', (d: Buffer) => { text += d.toString('utf8') })
    await run.done
    // psql meta-commands (\restrict, \unrestrict) are not SQL
    text = text.split('\n').filter((l) => !l.startsWith('\\')).join('\n')
    const { statements, rest } = splitSql(text)
    if (rest.trim() && !/^\s*(--[^\n]*\n?\s*)*$/.test(rest)) statements.push(rest.trim())
    for (const s of statements) if (!skipRestoreStatement(s)) await c.query(renameInSql(s, source, target))
  }
  await ddl('pre-data')
  const run = runTool(tool.path, ['--section=data', ...base], process.env)
  let cur: { done: Promise<void>; sink: { rowCount?: number } } | null = null
  const parser = new RestoreDataParser({
    async onCopy(h) {
      if (h.schema !== source) throw new Error(`pg_restore returned data of ${h.schema}.${h.table}, outside ${source}`)
      const sink = c.query(copyFrom(`COPY ${qi(target)}.${qi(h.table)} (${h.columns.map(qi).join(', ')}) FROM STDIN`))
      const pass = new PassThrough()
      const done = pipeline(pass, sink)
      done.catch(() => {})
      cur = { done, sink: sink as unknown as { rowCount?: number } }
      return pass
    },
    async onCopyEnd(h) {
      const x = cur!
      cur = null
      await x.done
      check(h.table, Number(x.sink.rowCount ?? 0))
    },
    async onStatement(sql) { await c.query(renameInSql(sql, source, target)) },
  })
  try {
    await Promise.all([pipeline(run.child.stdout!, parser), run.done])
  } catch (e) {
    run.child.kill()
    throw e
  }
  await ddl('post-data')
  // tables without rows produce no COPY block in some pg_restore versions: they hold 0 rows
  for (const [t, n] of expected) if (!stored.has(t) && n !== 0) throw new Error(`Table ${t}: no data was restored, the backup says ${n} rows.`)
  return stored
}

/** paths inside the archive must stay inside the target folder */
function safeRel(rel: string): string {
  const parts = rel.split('/')
  if (!rel || rel.startsWith('/') || parts.some((p) => p === '..' || p === '' || p.includes('\\') || p.includes(':'))) throw new ArchiveError('corrupt', `The backup contains an unsafe path: ${rel}`)
  return parts.join(path.sep)
}

/** writes an environment's attachments and data files from the archive into `root` ({attachments,files}), checking checksums */
export async function extractEnvironmentFiles(a: BackupArchive, envId: string, root: string, onBytes?: (n: number) => void): Promise<{ files: number; bytes: number }> {
  const prefix = `files/${envId}/`
  let files = 0
  let bytes = 0
  await fs.promises.mkdir(path.join(root, 'attachments'), { recursive: true })
  await fs.promises.mkdir(path.join(root, 'files'), { recursive: true })
  for (const f of a.manifest.files) {
    if (!f.name.startsWith(prefix)) continue
    const rel = safeRel(f.name.slice(prefix.length))
    const dest = path.join(root, rel)
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })
    const h = createHash('sha256')
    const tap = new Transform({ transform(c: Buffer, _e, cb) { h.update(c); onBytes?.(c.length); cb(null, c) } })
    await pipeline(a.stream(f.name), tap, fs.createWriteStream(dest))
    if (h.digest('hex') !== f.sha256) throw new ArchiveError('corrupt', `${f.name} does not match its checksum.`)
    files++
    bytes += f.size
  }
  return { files, bytes }
}

/** the schema of an environment inside the archive */
export function schemaOf(a: BackupArchive, envId: string): string {
  const e = a.manifest.environments.find((x) => x.id === envId)
  if (!e) throw new ArchiveError('format', `The backup does not contain the environment "${envId}".`)
  return e.schema
}

export { posix }
