/**
 * Keyset cursors for Query v2 paging (docs/dev/query-v2.md, "Paging"). A cursor names the last row of a page by its
 * normalised sort-key values plus the natural-order tie-breakers (createdOn, id), so the next page is
 * "rows after this position in the total order", stable under inserts and deletes elsewhere in the table.
 *
 * Format: "c2." + base64url(UTF-8 JSON) of
 *   { "s": "<sort spec>", "k": [<key>...], "c": "<createdOn ISO>" | null, "i": "<id>" }
 * where the sort spec is the plan's sort keys as "col:asc,col2:desc" ("" when unsorted) and each key is the
 * normalised value of SortKeyV2 order: number (number; boolean as 0/1; datetime as epoch ms) | string (lower-cased text;
 * date as 'YYYY-MM-DD') | null (a NULL date or datetime: before every value). Cursors are opaque to clients and only
 * valid for the same sort.
 */
import type { FxRecord, FxValue } from '../../contracts.ts'
import type { ColumnKind, QueryPlan, SortKeyV2, TableSchemaInfo } from '../../platform/query.ts'

export type KeyValue = number | string | null

export interface DecodedCursor {
  spec: string
  keys: KeyValue[]
  createdOn: string | null
  id: string
}

export class CursorError extends Error {}

/** the normalised sort value of a cell (see SortKeyV2) */
export function sortKeyValue(kind: ColumnKind, v: FxValue): KeyValue {
  const blank = v === null || v === undefined
  switch (kind) {
    case 'number': return blank ? 0 : (v as number)
    case 'boolean': return blank ? 0 : v ? 1 : 0
    case 'text': return blank ? '' : String(v).toLowerCase()
    case 'date': {
      if (blank) return null
      const d = v as Date
      return `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    case 'datetime': return blank ? null : (v as Date).getTime()
    default: throw new CursorError('column kind can not be sorted')
  }
}

/** compare two normalised key tuples under the given directions (null sorts before everything) */
export function compareKeys(a: KeyValue[], b: KeyValue[], dirs: ('asc' | 'desc')[]): number {
  for (let i = 0; i < dirs.length; i++) {
    const x = a[i] ?? null
    const y = b[i] ?? null
    let d = 0
    if (x === null || y === null) d = x === y ? 0 : x === null ? -1 : 1
    else d = x < y ? -1 : x > y ? 1 : 0
    if (d !== 0) return dirs[i] === 'desc' ? -d : d
  }
  return 0
}

export function sortSpec(sort: SortKeyV2[] | undefined): string {
  return (sort ?? []).map((k) => `${k.col}:${k.dir}`).join(',')
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** a cursor from already-normalised keys (the PostgreSQL executor computes them in SQL) */
export function cursorFromKeys(plan: QueryPlan, keys: KeyValue[], createdOn: string | null, id: string): string {
  return 'c2.' + toBase64Url(JSON.stringify({ s: sortSpec(plan.sort), k: keys, c: createdOn, i: id }))
}

/** the cursor that points just after `row` in `plan`'s order */
export function encodeCursor(plan: QueryPlan, row: FxRecord, schema: TableSchemaInfo): string {
  const keys = (plan.sort ?? []).map((k) => {
    const kind = schema.columns[k.col]
    if (kind === undefined) throw new CursorError(`unknown column ${k.col}`)
    return sortKeyValue(kind, Object.prototype.hasOwnProperty.call(row, k.col) ? row[k.col]! : null)
  })
  const c = row.createdOn
  const createdOn = c instanceof Date ? c.toISOString() : typeof c === 'string' ? c : null
  const id = row.id
  return 'c2.' + toBase64Url(JSON.stringify({ s: sortSpec(plan.sort), k: keys, c: createdOn, i: typeof id === 'string' ? id : String(id ?? '') }))
}

/** parse and check a cursor against the plan's sort; throws CursorError when it is malformed or for another sort */
export function decodeCursor(plan: QueryPlan, cursor: string): DecodedCursor {
  if (!cursor.startsWith('c2.')) throw new CursorError('not a v2 cursor')
  let raw: unknown
  try {
    raw = JSON.parse(fromBase64Url(cursor.slice(3)))
  } catch {
    throw new CursorError('malformed cursor')
  }
  const o = raw as { s?: unknown; k?: unknown; c?: unknown; i?: unknown }
  if (typeof o !== 'object' || o === null || typeof o.s !== 'string' || !Array.isArray(o.k) || typeof o.i !== 'string' || !(o.c === null || typeof o.c === 'string')) {
    throw new CursorError('malformed cursor')
  }
  if (o.s !== sortSpec(plan.sort)) throw new CursorError('the cursor belongs to a different sort order')
  if (o.k.length !== (plan.sort ?? []).length || !o.k.every((x) => x === null || typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)))) {
    throw new CursorError('malformed cursor')
  }
  return { spec: o.s, keys: o.k as KeyValue[], createdOn: o.c, id: o.i }
}
