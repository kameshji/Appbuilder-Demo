/**
 * Database side of backups (docs/dev/backup.md):
 *
 *  - catalogOf(): the structure of one schema read from PostgreSQL's catalogue inside the backup's snapshot (tables,
 *    columns with their exact types, defaults, identity columns, constraints, indexes, sequences, views). Stored in
 *    every archive as db/<schema>/schema.json, whatever the method: the restore and the table browser need it.
 *  - the built-in exporter: COPY ... TO STDOUT per table (text format) inside the same REPEATABLE READ snapshot,
 *    gzip-compressed into db/<schema>/<table>.copy.gz. Used when pg_dump is missing or too old.
 *  - restore primitives for both kinds of archive: DDL from schema.json for a target schema of any name, or pg_restore's
 *    SQL with the schema renamed; COPY ... FROM STDIN fed from either source; the COPY text format parser (browsing).
 */
import type pg from 'pg'
import { from as copyFrom, to as copyTo } from 'pg-copy-streams'
import { Transform, Writable, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import fs from 'node:fs'

export const qi = (id: string): string => `"${id.replace(/"/g, '""')}"`

export interface CatalogColumn {
  name: string
  /** format_type(): "character varying(255)", "timestamp(3) with time zone", "jsonb", ... */
  type: string
  notNull: boolean
  default?: string
  /** a for ALWAYS, d for BY DEFAULT */
  identity?: 'a' | 'd'
  identityOptions?: { start: string; increment: string; min: string; max: string; cache: string; cycle: boolean }
  /** expression of a stored generated column (not copied: computed again) */
  generated?: string
  collation?: string
}
export interface CatalogTable {
  name: string
  columns: CatalogColumn[]
  /** primary key, unique, check, exclusion constraints (in the table), foreign keys (after every table) */
  constraints: { name: string; type: string; def: string }[]
  /** CREATE INDEX statements of indexes that do not back a constraint, schema written as {{schema}} */
  indexes: string[]
  /** identity sequences: value to set after the rows are in */
  identity: { column: string; lastValue: string; isCalled: boolean }[]
  /** exact rows in the snapshot (filled by the exporter) */
  rows?: number
  /** data not copied (sessions, the backup catalogue) */
  noData?: boolean
}
export interface Catalog {
  schema: string
  tables: CatalogTable[]
  sequences: { name: string; def: string; lastValue: string; isCalled: boolean }[]
  views: { name: string; def: string; materialized: boolean }[]
  /** objects the built-in exporter does not copy (pg_dump does): functions, triggers, types */
  unsupported: string[]
}

const SCHEMA_TOKEN = '{{schema}}'

/** replaces `"schema".` / `schema.` qualifications in catalogue text (index, view and default definitions) */
export function renameSchemaRefs(text: string, from: string, to: string): string {
  const bare = /^[a-z_][a-z0-9_$]*$/.test(from)
  const forms = bare ? [qi(from), from] : [qi(from)]
  let out = text
  for (const f of forms) {
    const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9_$"])${esc}\\.`, 'g'), (_m, pre: string) => `${pre}${to}.`)
  }
  return out
}

/** the structure of a schema (run inside the backup's transaction: it is part of the snapshot) */
export async function catalogOf(c: pg.Client | pg.PoolClient, schema: string, noData: string[] = []): Promise<Catalog> {
  const rel = await c.query<{ oid: number; relname: string; relkind: string }>(
    `SELECT c.oid::int AS oid, c.relname, c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'S') ORDER BY c.relname`, [schema])
  const tables: CatalogTable[] = []
  const views: Catalog['views'] = []
  const sequences: Catalog['sequences'] = []
  const ownedSeq = new Set<string>()
  for (const r of rel.rows.filter((x) => x.relkind === 'r' || x.relkind === 'p')) {
    const cols = await c.query<{ attname: string; type: string; attnotnull: boolean; def: string | null; attidentity: string; attgenerated: string; coll: string | null; seq: string | null }>(
      `SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
              pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity::text AS attidentity, a.attgenerated::text AS attgenerated,
              CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN pg_catalog.quote_ident(cn.nspname) || '.' || pg_catalog.quote_ident(co.collname) END AS coll,
              pg_catalog.pg_get_serial_sequence(pg_catalog.quote_ident($2) || '.' || pg_catalog.quote_ident(c.relname), a.attname) AS seq
         FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
        WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [r.oid, schema])
    const t: CatalogTable = { name: r.relname, columns: [], constraints: [], indexes: [], identity: [] }
    if (noData.includes(r.relname)) t.noData = true
    for (const a of cols.rows) {
      const col: CatalogColumn = { name: a.attname, type: a.type, notNull: a.attnotnull }
      if (a.coll) col.collation = a.coll
      if (a.attgenerated === 's') col.generated = renameSchemaRefs(a.def ?? 'NULL', schema, SCHEMA_TOKEN)
      else if (a.def !== null && !a.attidentity) col.default = renameSchemaRefs(a.def, schema, SCHEMA_TOKEN)
      if (a.attidentity === 'a' || a.attidentity === 'd') {
        col.identity = a.attidentity
        if (a.seq) {
          ownedSeq.add(a.seq)
          const s = await c.query<{ seqstart: string; seqincrement: string; seqmin: string; seqmax: string; seqcache: string; seqcycle: boolean }>(
            'SELECT seqstart::text, seqincrement::text, seqmin::text, seqmax::text, seqcache::text, seqcycle FROM pg_catalog.pg_sequence WHERE seqrelid = $1::regclass', [a.seq])
          const o = s.rows[0]
          if (o) col.identityOptions = { start: o.seqstart, increment: o.seqincrement, min: o.seqmin, max: o.seqmax, cache: o.seqcache, cycle: o.seqcycle }
          const v = await c.query<{ last_value: string; is_called: boolean }>(`SELECT last_value::text, is_called FROM ${a.seq}`)
          t.identity.push({ column: a.attname, lastValue: v.rows[0].last_value, isCalled: v.rows[0].is_called })
        }
      }
      t.columns.push(col)
    }
    const cons = await c.query<{ conname: string; contype: string; def: string }>(
      `SELECT conname, contype::text AS contype, pg_catalog.pg_get_constraintdef(oid, true) AS def FROM pg_catalog.pg_constraint
        WHERE conrelid = $1 AND contype IN ('p', 'u', 'c', 'f', 'x') ORDER BY contype = 'f', conname`, [r.oid])
    t.constraints = cons.rows.map((x) => ({ name: x.conname, type: x.contype, def: renameSchemaRefs(x.def, schema, SCHEMA_TOKEN) }))
    const idx = await c.query<{ def: string }>(
      `SELECT pg_catalog.pg_get_indexdef(i.indexrelid) AS def FROM pg_catalog.pg_index i
        WHERE i.indrelid = $1 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid = i.indexrelid AND k.conrelid = i.indrelid)
        ORDER BY i.indexrelid`, [r.oid])
    const on = ` ON ${qi(schema)}.`
    const onBare = ` ON ${schema}.`
    t.indexes = idx.rows.map((x) => {
      // the table reference after ON is the only schema-qualified name in an index definition we create
      const d = x.def
      const k = d.indexOf(onBare) >= 0 ? d.indexOf(onBare) : d.indexOf(on)
      if (k < 0) return renameSchemaRefs(d, schema, SCHEMA_TOKEN)
      const len = d.indexOf(onBare) >= 0 ? onBare.length : on.length
      return `${d.slice(0, k)} ON ${SCHEMA_TOKEN}.${d.slice(k + len)}`
    })
    tables.push(t)
  }
  for (const r of rel.rows.filter((x) => x.relkind === 'S')) {
    const full = `${qi(schema)}.${qi(r.relname)}`
    if (ownedSeq.has(full) || ownedSeq.has(`${schema}.${r.relname}`)) continue
    const s = await c.query<{ seqstart: string; seqincrement: string; seqmin: string; seqmax: string; seqcache: string; seqcycle: boolean; typ: string }>(
      'SELECT seqstart::text, seqincrement::text, seqmin::text, seqmax::text, seqcache::text, seqcycle, pg_catalog.format_type(seqtypid, NULL) AS typ FROM pg_catalog.pg_sequence WHERE seqrelid = $1', [r.oid])
    const o = s.rows[0]
    const v = await c.query<{ last_value: string; is_called: boolean }>(`SELECT last_value::text, is_called FROM ${full}`)
    sequences.push({
      name: r.relname,
      def: `AS ${o.typ} INCREMENT BY ${o.seqincrement} MINVALUE ${o.seqmin} MAXVALUE ${o.seqmax} START WITH ${o.seqstart} CACHE ${o.seqcache}${o.seqcycle ? ' CYCLE' : ''}`,
      lastValue: v.rows[0].last_value, isCalled: v.rows[0].is_called,
    })
  }
  for (const r of rel.rows.filter((x) => x.relkind === 'v' || x.relkind === 'm')) {
    const v = await c.query<{ def: string }>('SELECT pg_catalog.pg_get_viewdef($1::oid, true) AS def', [r.oid])
    views.push({ name: r.relname, def: renameSchemaRefs(v.rows[0].def, schema, SCHEMA_TOKEN), materialized: r.relkind === 'm' })
  }
  const unsupported: string[] = []
  const fn = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1', [schema])
  if (fn.rows[0].n) unsupported.push(`${fn.rows[0].n} function(s)`)
  const tg = await c.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT g.tgisinternal', [schema])
  if (tg.rows[0].n) unsupported.push(`${tg.rows[0].n} trigger(s)`)
  const ty = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typtype IN ('e', 'd', 'c') AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.reltype = t.oid)", [schema])
  if (ty.rows[0].n) unsupported.push(`${ty.rows[0].n} type(s)`)
  return { schema, tables, sequences, views, unsupported }
}

/** the columns COPY carries (stored generated columns are computed again on restore) */
export const copyColumns = (t: CatalogTable): string[] => t.columns.filter((c) => !c.generated).map((c) => c.name)

/** exact row counts of every table in the snapshot (pg_dump archives: the exporter counts the COPY rows itself) */
export async function countRows(c: pg.Client | pg.PoolClient, schema: string, cat: Catalog): Promise<void> {
  for (const t of cat.tables) {
    if (t.noData) { t.rows = 0; continue }
    const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${qi(schema)}.${qi(t.name)}`)
    t.rows = Number(r.rows[0].n)
  }
}

/** counts the rows of a COPY text stream (one line per row: newlines inside values are escaped) */
export class LineCounter extends Transform {
  lines = 0
  bytes = 0
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void): void {
    for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10, i + 1)) this.lines++
    this.bytes += chunk.length
    cb(null, chunk)
  }
}

/** COPY one table to a gzip file in the snapshot; returns rows and bytes */
export async function exportTable(c: pg.Client | pg.PoolClient, schema: string, t: CatalogTable, file: string, onBytes?: (n: number) => void): Promise<{ rows: number; rawBytes: number }> {
  const counter = new LineCounter()
  if (t.noData) {
    await pipeline(async function* () { /* no rows */ }, createGzip(), fs.createWriteStream(file, { mode: 0o600 }))
    return { rows: 0, rawBytes: 0 }
  }
  const cols = copyColumns(t).map(qi).join(', ')
  const src = c.query(copyTo(`COPY ${qi(schema)}.${qi(t.name)} (${cols}) TO STDOUT`))
  let last = 0
  counter.on('data', () => { onBytes?.(counter.bytes - last); last = counter.bytes })
  await pipeline(src, counter, createGzip({ level: 6 }), fs.createWriteStream(file, { mode: 0o600 }))
  return { rows: counter.lines, rawBytes: counter.bytes }
}

/* ------------------------------------------------------------------ DDL for a target schema */

/** statements that create the tables, sequences (and nothing else) of a catalogue in `target` */
export function preDataSql(cat: Catalog, target: string, o: { tables?: string[] } = {}): string[] {
  const S = qi(target)
  const fill = (s: string) => s.split(SCHEMA_TOKEN).join(S)
  const out: string[] = []
  const pick = o.tables ? cat.tables.filter((t) => o.tables!.includes(t.name)) : cat.tables
  if (!o.tables) for (const s of cat.sequences) out.push(`CREATE SEQUENCE ${S}.${qi(s.name)} ${s.def}`)
  for (const t of pick) {
    const cols = t.columns.map((c) => {
      let d = `${qi(c.name)} ${c.type}`
      if (c.collation) d += ` COLLATE ${c.collation}`
      if (c.generated) d += ` GENERATED ALWAYS AS (${fill(c.generated)}) STORED`
      else if (c.identity) {
        const io = c.identityOptions
        d += ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY${io ? ` (START WITH ${io.start} INCREMENT BY ${io.increment} MINVALUE ${io.min} MAXVALUE ${io.max} CACHE ${io.cache}${io.cycle ? ' CYCLE' : ''})` : ''}`
      } else if (c.default !== undefined) d += ` DEFAULT ${fill(c.default)}`
      if (c.notNull) d += ' NOT NULL'
      return d
    })
    out.push(`CREATE TABLE ${S}.${qi(t.name)} (\n  ${cols.join(',\n  ')}\n)`)
  }
  return out
}

/** after the rows: sequence values, constraints, indexes, foreign keys, views */
export function postDataSql(cat: Catalog, target: string, o: { tables?: string[] } = {}): string[] {
  const S = qi(target)
  const fill = (s: string) => s.split(SCHEMA_TOKEN).join(S)
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`
  const out: string[] = []
  const pick = o.tables ? cat.tables.filter((t) => o.tables!.includes(t.name)) : cat.tables
  for (const t of pick) {
    for (const id of t.identity) {
      out.push(`SELECT pg_catalog.setval(pg_catalog.pg_get_serial_sequence(${lit(`${S}.${qi(t.name)}`)}, ${lit(id.column)}), ${id.lastValue}, ${id.isCalled})`)
    }
    for (const k of t.constraints.filter((x) => x.type !== 'f')) out.push(`ALTER TABLE ${S}.${qi(t.name)} ADD CONSTRAINT ${qi(k.name)} ${fill(k.def)}`)
    for (const ix of t.indexes) out.push(fill(ix))
  }
  if (!o.tables) {
    for (const s of cat.sequences) out.push(`SELECT pg_catalog.setval(${lit(`${S}.${qi(s.name)}`)}, ${s.lastValue}, ${s.isCalled})`)
    for (const t of pick) for (const k of t.constraints.filter((x) => x.type === 'f')) out.push(`ALTER TABLE ${S}.${qi(t.name)} ADD CONSTRAINT ${qi(k.name)} ${fill(k.def)}`)
    for (const v of cat.views) {
      out.push(v.materialized ? `CREATE MATERIALIZED VIEW ${S}.${qi(v.name)} AS ${fill(v.def).replace(/;\s*$/, '')} WITH NO DATA` : `CREATE VIEW ${S}.${qi(v.name)} AS ${fill(v.def).replace(/;\s*$/, '')}`)
    }
    for (const v of cat.views.filter((x) => x.materialized)) out.push(`REFRESH MATERIALIZED VIEW ${S}.${qi(v.name)}`)
  }
  return out
}

/** feeds a COPY text stream into a table; resolves with the number of rows PostgreSQL stored */
export async function copyInto(c: pg.Client | pg.PoolClient, schema: string, table: string, columns: string[], src: Readable | AsyncIterable<Buffer>): Promise<number> {
  const sink = c.query(copyFrom(`COPY ${qi(schema)}.${qi(table)} (${columns.map(qi).join(', ')}) FROM STDIN`))
  await pipeline(src, sink)
  return Number((sink as unknown as { rowCount?: number }).rowCount ?? 0)
}

/* ------------------------------------------------------------------ pg_restore output */

/**
 * Splits SQL text (pg_restore -f - output) into statements: semicolons outside quotes, dollar quotes and comments.
 * Returns the statements and the unconsumed tail (feed text in pieces).
 */
export function splitSql(text: string): { statements: string[]; rest: string } {
  const out: string[] = []
  let start = 0
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch === '-' && text[i + 1] === '-') {
      const e = text.indexOf('\n', i)
      if (e < 0) break
      i = e + 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2)
      if (e < 0) break
      i = e + 2
      continue
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1
      for (;;) {
        const k = text.indexOf(ch, j)
        if (k < 0) { j = -1; break }
        if (text[k + 1] === ch) { j = k + 2; continue }
        j = k + 1
        break
      }
      if (j < 0) break
      i = j
      continue
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64))
      if (m) {
        const e = text.indexOf(m[0], i + m[0].length)
        if (e < 0) break
        i = e + m[0].length
        continue
      }
    }
    if (ch === ';') {
      const stmt = text.slice(start, i).trim()
      if (stmt) out.push(stmt)
      start = i + 1
    }
    i++
  }
  return { statements: out, rest: text.slice(start) }
}

/** statements of pg_restore output we never run: session settings, the schema itself, owners, comments on the schema */
export function skipRestoreStatement(stmt: string): boolean {
  const s = stmt.replace(/^(\s*--[^\n]*\n)+/, '').trim()
  return /^SET\s/i.test(s) || /^SELECT pg_catalog\.set_config\(/i.test(s) || /^CREATE SCHEMA\s/i.test(s) || /^ALTER SCHEMA\s/i.test(s)
    || /^COMMENT ON SCHEMA\s/i.test(s) || /^ALTER (TABLE|SEQUENCE|VIEW|FUNCTION|TYPE|MATERIALIZED VIEW)\s.*\sOWNER TO\s/is.test(s) || /^\\/.test(s)
}

/**
 * Reads pg_restore --data-only output line by line: COPY blocks are handed to onCopy (header table and columns, the
 * data lines up to "\."), other statements (sequence values) to onStatement. Lines of COPY data never contain a raw
 * newline, so line splitting is exact.
 */
export class RestoreDataParser extends Writable {
  private buf: Buffer = Buffer.alloc(0)
  private sql = ''
  private copy: { schema: string; table: string; columns: string[]; sink: Writable } | null = null
  private onCopy: (h: { schema: string; table: string; columns: string[] }) => Promise<Writable>
  private onStatement: (sql: string) => Promise<void>
  private onCopyEnd: (h: { schema: string; table: string }) => Promise<void>
  constructor(h: {
    onCopy(h: { schema: string; table: string; columns: string[] }): Promise<Writable>
    onCopyEnd(h: { schema: string; table: string }): Promise<void>
    onStatement(sql: string): Promise<void>
  }) {
    super()
    this.onCopy = h.onCopy
    this.onCopyEnd = h.onCopyEnd
    this.onStatement = h.onStatement
  }

  private async line(l: Buffer): Promise<void> {
    if (this.copy) {
      if (l.length === 2 && l[0] === 0x5c && l[1] === 0x2e) {
        const c = this.copy
        this.copy = null
        await new Promise<void>((resolve, reject) => { c.sink.once('error', reject); c.sink.end(() => resolve()) })
        await this.onCopyEnd(c)
        return
      }
      const ok = this.copy.sink.write(Buffer.concat([l, Buffer.from('\n')]))
      if (!ok) await new Promise<void>((r) => this.copy!.sink.once('drain', () => r()))
      return
    }
    const text = l.toString('utf8')
    // psql meta-commands (\restrict / \unrestrict of newer pg_restore versions) are not SQL; comments and blank lines
    // between statements carry nothing
    if (text.startsWith('\\')) return
    if (!this.sql.trim() && (!text.trim() || text.startsWith('--'))) return
    const m = /^COPY\s+((?:"(?:[^"]|"")+"|[A-Za-z0-9_$]+))\.((?:"(?:[^"]|"")+"|[A-Za-z0-9_$]+))\s*\(([^)]*)\)\s+FROM\s+stdin;\s*$/i.exec(text)
    if (m && !this.sql.trim()) {
      const unq = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s)
      const columns = m[3].split(',').map((x) => unq(x.trim())).filter(Boolean)
      const h = { schema: unq(m[1]), table: unq(m[2]), columns }
      this.copy = { ...h, sink: await this.onCopy(h) }
      return
    }
    this.sql += text + '\n'
    const { statements, rest } = splitSql(this.sql)
    this.sql = rest
    for (const s of statements) if (!skipRestoreStatement(s)) await this.onStatement(s)
  }

  _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    ;(async () => {
      let i = this.buf.indexOf(10)
      let start = 0
      while (i >= 0) {
        await this.line(this.buf.subarray(start, i))
        start = i + 1
        i = this.buf.indexOf(10, start)
      }
      this.buf = Buffer.from(this.buf.subarray(start))
    })().then(() => cb(), cb)
  }

  _final(cb: (e?: Error | null) => void): void {
    ;(async () => {
      if (this.buf.length) await this.line(this.buf)
      if (this.copy) throw new Error('pg_restore output ended inside a COPY block')
      const { statements } = splitSql(this.sql + ';')
      for (const s of statements) if (!skipRestoreStatement(s)) await this.onStatement(s)
    })().then(() => cb(), cb)
  }
}

/** schema rename for pg_restore SQL: qualified names, CREATE SCHEMA, setval('schema.seq') literals */
export function renameInSql(stmt: string, from: string, to: string): string {
  if (from === to) return stmt
  let s = renameSchemaRefs(stmt, from, qi(to))
  // regclass literals: 'env_x.ab_audit_id_seq' -> '"env_y".ab_audit_id_seq'
  const lit = new RegExp(`'${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`, 'g')
  s = s.replace(lit, `'${qi(to).replace(/'/g, "''")}.`)
  return s
}

/* ------------------------------------------------------------------ COPY text format */

/** one COPY text line -> values (null for \N); the escapes of the text format */
export function parseCopyLine(line: string): (string | null)[] {
  const out: (string | null)[] = []
  for (const field of line.split('\t')) {
    if (field === '\\N') { out.push(null); continue }
    if (!field.includes('\\')) { out.push(field); continue }
    let v = ''
    for (let i = 0; i < field.length; i++) {
      const ch = field[i]
      if (ch !== '\\') { v += ch; continue }
      const n = field[++i]
      switch (n) {
        case 'b': v += '\b'; break
        case 'f': v += '\f'; break
        case 'n': v += '\n'; break
        case 'r': v += '\r'; break
        case 't': v += '\t'; break
        case 'v': v += '\v'; break
        case 'x': {
          const m = /^[0-9a-fA-F]{1,2}/.exec(field.slice(i + 1))
          if (m) { v += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length } else v += 'x'
          break
        }
        default:
          if (n !== undefined && n >= '0' && n <= '7') {
            const m = /^[0-7]{1,3}/.exec(field.slice(i))!
            v += String.fromCharCode(parseInt(m[0], 8))
            i += m[0].length - 1
          } else if (n !== undefined) v += n
      }
    }
    out.push(v)
  }
  return out
}

/** reads lines of a COPY text stream (offset, limit); stops reading once enough are collected */
export async function readCopyLines(src: AsyncIterable<Buffer>, offset: number, limit: number): Promise<{ lines: string[]; more: boolean }> {
  const lines: string[] = []
  let n = 0
  let tail = Buffer.alloc(0)
  for await (const chunk of src) {
    const buf = tail.length ? Buffer.concat([tail, chunk]) : chunk
    let start = 0
    let i = buf.indexOf(10)
    while (i >= 0) {
      if (n >= offset) {
        if (lines.length >= limit) return { lines, more: true }
        lines.push(buf.subarray(start, i).toString('utf8'))
      }
      n++
      start = i + 1
      i = buf.indexOf(10, start)
    }
    tail = Buffer.from(buf.subarray(start))
  }
  if (tail.length && n >= offset && lines.length < limit) lines.push(tail.toString('utf8'))
  return { lines, more: false }
}
