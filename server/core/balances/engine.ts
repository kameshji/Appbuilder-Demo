/**
 * Synchronous balances (P3 package P, docs/dev/balances.md). A table with `TableDef.balance` holds, per key, the sum of
 * the signed quantity of the rows of its movements table. The DataService (data.ts) calls this module inside the unit of
 * work of every movement write (insert, update, delete, recycle-bin delete and restore, CSV import): the movement rows
 * are locked and read before the change and read again after it, the difference per key is applied to the balance row
 * under a per-key advisory lock plus the row lock, and a change that would take a balance below its floor is refused,
 * which rolls back the whole unit. READ COMMITTED is enough: every statement after the lock sees the latest committed
 * balance, and the locks are held to commit.
 */
import { HttpError } from '../contracts.ts'
import type { RawRow, SqlDb } from '../contracts.ts'
import type { BalanceDef, ColumnDef, TableDef } from '../../../src/platform/contracts.ts'
import { currentEnvironment } from '../env-context.ts'
import { hasRecycleBin, physicalName, quoteId } from '../../connectors/postgres/sql.ts'
import { DEFAULT_CONNECTION_ID } from '../connections.ts'
import { rowUid } from '../util.ts'

type Row = Record<string, unknown>
const NUMERIC = new Set(['number', 'decimal', 'currency'])
const MAX_KEYS = 4
const lc = (s: string) => s.toLowerCase()
const isDefault = (t: TableDef) => (t.connectionId ?? DEFAULT_CONNECTION_ID) === DEFAULT_CONNECTION_ID
const blank = (v: unknown) => v === null || v === undefined || v === ''

/** one declared balance: the balance table, its declaration and the movements table it reads */
export interface Ledger {
  balance: TableDef
  spec: BalanceDef
  movements: TableDef
  /** default 0; null = no floor */
  floor: number | null
}

/** a balance row the platform inserted or changed (data.ts writes its outbox row) */
export interface BalanceChange {
  table: TableDef
  op: 'insert' | 'update'
  rowId: string
  before: RawRow | null
  after: RawRow
  column: string
}

export interface BalanceDeps {
  db(): SqlDb | null
}

const colOf = (t: TableDef, name: string): ColumnDef | undefined => t.columns.find((c) => c.name === name) ?? t.columns.find((c) => lc(c.name) === lc(name))

/**
 * What is wrong with a balance declaration (null: nothing). `tables`: every table of the environment, the balance
 * table as it will be stored included.
 */
export function balanceProblem(balance: TableDef, tables: TableDef[]): string | null {
  const b = balance.balance
  if (!b) return null
  const name = balance.displayName || balance.name
  if (!b || typeof b !== 'object') return `${name}: the balance setting must be an object.`
  const mv = tables.find((t) => t.id === b.movements) ?? tables.find((t) => lc(t.name) === lc(String(b.movements ?? '')))
  if (!mv) return `${name}: the movements table "${String(b.movements ?? '')}" does not exist.`
  if (mv.id === balance.id) return `${name}: a balance cannot be kept from its own rows.`
  if (!isDefault(balance) || !isDefault(mv)) return `${name}: a balance and its movements must both be stored in the default database (they are written in one transaction).`
  if (mv.balance) return `${name}: "${mv.displayName}" is itself a balance; its rows are kept by the platform.`
  const q = colOf(mv, String(b.quantity ?? ''))
  if (!q || !NUMERIC.has(q.type)) return `${name}: the quantity "${String(b.quantity ?? '')}" must be a number, decimal or currency column of "${mv.displayName}".`
  if (q.computed?.kind === 'rollup') return `${name}: the quantity cannot be a rollup column.`
  const c = colOf(balance, String(b.column ?? ''))
  if (!c || !NUMERIC.has(c.type) || c.computed) return `${name}: the balance column "${String(b.column ?? '')}" must be a number, decimal or currency column of this table (not a formula or rollup).`
  if (!Array.isArray(b.keys) || !b.keys.length || b.keys.length > MAX_KEYS) return `${name}: a balance has 1 to ${MAX_KEYS} key columns.`
  const seen = new Set<string>()
  for (const k of b.keys) {
    const kc = k && typeof k === 'object' ? colOf(balance, String(k.column ?? '')) : undefined
    const kf = k && typeof k === 'object' ? colOf(mv, String(k.from ?? '')) : undefined
    if (!kc || !kf) return `${name}: the key "${String(k?.column ?? '')} = ${mv.displayName}.${String(k?.from ?? '')}" names a column that does not exist.`
    if (kc.type !== kf.type || (kc.type === 'lookup' && lc(kc.lookupTable ?? '') !== lc(kf.lookupTable ?? ''))) return `${name}: the key ${kc.name} and ${mv.displayName}.${kf.name} must have the same type (and lookup table).`
    if (kc.name === c.name) return `${name}: the balance column cannot be a key.`
    if (seen.has(lc(kc.name))) return `${name}: the key column ${kc.name} is listed twice.`
    seen.add(lc(kc.name))
  }
  if (b.floor !== undefined && b.floor !== null && !Number.isFinite(b.floor)) return `${name}: the floor must be a number (or null for no floor).`
  if (b.minColumn !== undefined) {
    const m = colOf(balance, b.minColumn)
    if (!m || !NUMERIC.has(m.type)) return `${name}: the minimum column "${b.minColumn}" must be a number column of this table.`
  }
  if (b.label !== undefined && (typeof b.label !== 'string' || b.label.length > 60)) return `${name}: the label is a text of at most 60 characters.`
  if (b.message !== undefined && (typeof b.message !== 'string' || b.message.length > 300)) return `${name}: the message is a text of at most 300 characters.`
  return null
}

/**
 * A balance declaration from a package or pack (untrusted JSON): only the known keys with the right types; null when it
 * is not one. Whether the names fit the tables is checked when a movement is written (balanceProblem).
 */
export function sanitizeBalance(raw: unknown): BalanceDef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const name = (v: unknown) => (typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(v) ? v : null)
  const movements = typeof o.movements === 'string' && o.movements.length <= 64 ? o.movements : null
  const quantity = name(o.quantity)
  const column = name(o.column)
  if (!movements || !quantity || !column || !Array.isArray(o.keys) || !o.keys.length || o.keys.length > MAX_KEYS) return null
  const keys: BalanceDef['keys'] = []
  for (const k of o.keys as unknown[]) {
    const kk = k && typeof k === 'object' ? (k as Record<string, unknown>) : {}
    const c = name(kk.column)
    const f = name(kk.from)
    if (!c || !f) return null
    keys.push({ column: c, from: f })
  }
  const out: BalanceDef = { movements, quantity, column, keys }
  if (o.floor === null) out.floor = null
  else if (typeof o.floor === 'number' && Number.isFinite(o.floor)) out.floor = o.floor
  if (name(o.minColumn)) out.minColumn = o.minColumn as string
  if (typeof o.label === 'string' && o.label.length <= 60) out.label = o.label
  if (typeof o.message === 'string' && o.message.length <= 300) out.message = o.message
  return out
}

/** the balance and key columns of a balance table: written only by the platform (data.ts ignores client values) */
export function maintainedColumns(def: TableDef): Set<string> {
  const b = def.balance
  if (!b) return new Set()
  return new Set([b.column, ...(Array.isArray(b.keys) ? b.keys.map((k) => k.column) : [])].filter((x) => typeof x === 'string'))
}

export type Balances = ReturnType<typeof createBalances>

export function createBalances(deps: BalanceDeps) {
  const db = (): SqlDb => {
    const d = deps.db()
    if (!d) throw new HttpError(503, 'unavailable', 'The database is not configured yet.')
    return d
  }
  const schema = () => currentEnvironment().schema
  const T = (t: TableDef) => `${quoteId(schema())}.${quoteId(physicalName(t))}`
  const live = (t: TableDef, ref = '') => (hasRecycleBin(t) ? ` AND ${ref}"deletedOn" IS NULL` : '')

  async function allTables(): Promise<TableDef[]> {
    const rows = await db().query<{ id: string; name: string; connection_id: string | null; source: string | null; def: TableDef }>(`SELECT id, name, connection_id, source, def FROM ${quoteId(schema())}."ab_tables"`)
    return rows.map((r) => ({ ...r.def, id: r.id, name: r.name, ...(r.connection_id ? { connectionId: r.connection_id } : {}), ...(r.source ? { source: r.source } : {}) }))
  }

  /**
   * The balances fed by this table (it is their movements table). One small metadata query; a declaration that no
   * longer fits (a column removed) refuses the write rather than letting the balance drift.
   */
  async function sources(def: TableDef): Promise<Ledger[]> {
    if (!deps.db() || !isDefault(def) || def.system) return []
    const rows = await db().query<{ id: string }>(`SELECT id FROM ${quoteId(schema())}."ab_tables" WHERE def ? 'balance'`)
    if (!rows.length) return []
    const tables = await allTables()
    const out: Ledger[] = []
    for (const b of tables) {
      if (!b.balance) continue
      const mv = tables.find((t) => t.id === b.balance!.movements) ?? tables.find((t) => lc(t.name) === lc(String(b.balance!.movements ?? '')))
      if (!mv || mv.id !== def.id) continue
      const problem = balanceProblem(b, tables)
      if (problem) throw new HttpError(422, 'invalid', `This change moves a balance that is not set up correctly: ${problem}`)
      // names as stored (case)
      const spec: BalanceDef = {
        ...b.balance,
        quantity: colOf(mv, b.balance.quantity)!.name,
        column: colOf(b, b.balance.column)!.name,
        keys: b.balance.keys.map((k) => ({ column: colOf(b, k.column)!.name, from: colOf(mv, k.from)!.name })),
        ...(b.balance.minColumn ? { minColumn: colOf(b, b.balance.minColumn)!.name } : {}),
      }
      out.push({ balance: b, spec, movements: mv, floor: b.balance.floor === null ? null : (b.balance.floor ?? 0) })
    }
    return out
  }

  /** the movement columns the ledgers read */
  const columnsOf = (ledgers: Ledger[]) => [...new Set(ledgers.flatMap((l) => [l.spec.quantity, ...l.spec.keys.map((k) => k.from)]))]

  async function select(def: TableDef, ledgers: Ledger[], ids: string[], lock: boolean): Promise<RawRow[]> {
    const uniq = [...new Set(ids)].sort()
    if (!uniq.length) return []
    const cols = ['id', ...columnsOf(ledgers)].map(quoteId).join(', ')
    const out: RawRow[] = []
    for (let i = 0; i < uniq.length; i += 1000) {
      out.push(...await db().query<RawRow>(`SELECT ${cols} FROM ${T(def)} WHERE "id" = ANY($1::text[])${live(def)} ORDER BY "id"${lock ? ' FOR UPDATE' : ''}`, [uniq.slice(i, i + 1000)]))
    }
    return out
  }

  /** the live movement rows with these ids, locked until the unit ends (before a change: nobody else moves them meanwhile) */
  const lock = (def: TableDef, ledgers: Ledger[], ids: string[]) => select(def, ledgers, ids, true)
  /** the live movement rows with these ids (after a change) */
  const read = (def: TableDef, ledgers: Ledger[], ids: string[]) => select(def, ledgers, ids, false)

  const num = (v: unknown): number => {
    if (blank(v)) return 0
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : 0
  }
  /** key of a movement row for a ledger; null when a key column is blank (such a row moves no balance) */
  const keyOf = (l: Ledger, r: RawRow): string[] | null => {
    const vals: string[] = []
    for (const k of l.spec.keys) {
      const v = r[k.from]
      if (blank(v)) return null
      vals.push(v instanceof Date ? v.toISOString() : String(v))
    }
    return vals
  }
  /** quantities are summed in fixed point (6 decimals) so that 0.1 + 0.2 - 0.3 is exactly 0 */
  const fx = (n: number) => Math.round(n * 1e6)

  async function labelOf(b: TableDef, column: string, value: string): Promise<string> {
    const col = colOf(b, column)
    if (col?.type !== 'lookup' || !col.lookupTable) return value
    try {
      const tables = await allTables()
      const target = tables.find((t) => lc(t.name) === lc(col.lookupTable!) || t.id === col.lookupTable)
      if (!target || !isDefault(target)) return value
      const pc = colOf(target, target.primaryColumn)?.name ?? 'id'
      const r = await db().query<Row>(`SELECT ${quoteId(pc)} AS v FROM ${T(target)} WHERE "id" = $1`, [value])
      return r.length && !blank(r[0].v) ? String(r[0].v) : value
    } catch {
      return value
    }
  }

  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6))

  async function refusal(l: Ledger, key: string[], available: number, requested: number, floor: number): Promise<HttpError> {
    const labels: Record<string, string> = {}
    for (const [i, k] of l.spec.keys.entries()) labels[k.column] = await labelOf(l.balance, k.column, key[i])
    const keyText = l.spec.keys.map((k) => labels[k.column]).join(' at ')
    const label = l.spec.label || l.balance.displayName || l.balance.name
    const floorText = floor === 0 ? 'zero' : fmt(floor)
    const parts: Record<string, string> = { label, keys: keyText, floor: floorText, available: fmt(available), requested: fmt(requested), ...labels }
    const text = l.spec.message
      ? l.spec.message.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, k: string) => parts[k] ?? all)
      : `${label} of ${keyText} would go below ${floorText}: available ${fmt(available)}, requested ${fmt(requested)}.`
    return new HttpError(422, 'invalid', text, l.spec.quantity, { balance: { table: l.balance.id, key: Object.fromEntries(l.spec.keys.map((k, i) => [k.column, key[i]])), available, requested, floor } })
  }

  /**
   * Applies the difference between the movement rows before and after a change (by id; a row missing on one side was
   * inserted or deleted). Keys are processed in a fixed order (no deadlock between two movers), each under
   * pg_advisory_xact_lock(balance table, key) and the balance row's FOR UPDATE. A key whose balance goes down below its
   * floor (or its minimum column) refuses the change: the caller's unit of work rolls back, the balance included.
   */
  async function apply(ledgers: Ledger[], before: RawRow[], after: RawRow[]): Promise<BalanceChange[]> {
    const changes: BalanceChange[] = []
    for (const l of ledgers) {
      const deltas = new Map<string, { key: string[]; d: number }>()
      const add = (r: RawRow, sign: 1 | -1) => {
        const key = keyOf(l, r)
        const q = fx(num(r[l.spec.quantity]))
        if (!key || q === 0) return
        const k = JSON.stringify(key)
        const e = deltas.get(k) ?? { key, d: 0 }
        e.d += sign * q
        deltas.set(k, e)
      }
      for (const r of before) add(r, -1)
      for (const r of after) add(r, 1)
      const B = T(l.balance)
      const qc = quoteId(l.spec.column)
      const where = l.spec.keys.map((k, i) => `${quoteId(k.column)} = $${i + 1}`).join(' AND ')
      const minSel = l.spec.minColumn ? `, ${quoteId(l.spec.minColumn)} AS "__min"` : ''
      for (const [k, { key, d }] of [...deltas.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
        if (d === 0) continue
        await db().query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [`ab.balance:${schema()}:${l.balance.id}`, k])
        const found = await db().query<Row>(`SELECT "id", ${qc} AS "__q"${minSel} FROM ${B} WHERE ${where}${live(l.balance)} ORDER BY "id" LIMIT 1 FOR UPDATE`, key)
        const old = found.length ? fx(num(found[0].__q)) : 0
        const next = old + d
        if (d < 0) {
          const min = found.length && l.spec.minColumn && !blank(found[0].__min) ? fx(num(found[0].__min)) : (l.floor === null ? null : fx(l.floor))
          if (min !== null && next < min) throw await refusal(l, key, old / 1e6, -d / 1e6, min / 1e6)
        }
        const value = next / 1e6
        const now = new Date()
        if (found.length) {
          const id = String(found[0].id)
          await db().query(`UPDATE ${B} SET ${qc} = $1, "modifiedOn" = $2 WHERE "id" = $3`, [value, now, id])
          changes.push({ table: l.balance, op: 'update', rowId: id, column: l.spec.column, before: { id, [l.spec.column]: old / 1e6 }, after: { id, [l.spec.column]: value, ...Object.fromEntries(l.spec.keys.map((kk, i) => [kk.column, key[i]])) } })
        } else {
          const id = rowUid(now.getTime())
          const cols = ['id', ...l.spec.keys.map((kk) => kk.column), l.spec.column, 'createdOn', 'modifiedOn']
          const missing = new Set(l.balance.missingSystem ?? [])
          const use = cols.filter((c) => !missing.has(c))
          const vals: Record<string, unknown> = { id, [l.spec.column]: value, createdOn: now, modifiedOn: now, ...Object.fromEntries(l.spec.keys.map((kk, i) => [kk.column, key[i]])) }
          await db().query(`INSERT INTO ${B} (${use.map(quoteId).join(', ')}) VALUES (${use.map((_, i) => `$${i + 1}`).join(', ')})`, use.map((c) => vals[c]))
          changes.push({ table: l.balance, op: 'insert', rowId: id, column: l.spec.column, before: null, after: vals as RawRow })
        }
      }
    }
    return changes
  }

  /**
   * Rebuilds a balance table from its movements (repairs writes made outside the platform): locks the balance table
   * against concurrent movers, sets every key's balance to the sum of its live movements, adds missing keys. Floors are
   * not checked (it states what the movements say). Returns the number of balance rows changed or added.
   */
  async function reconcile(balance: TableDef): Promise<number> {
    const tables = await allTables()
    const b = tables.find((t) => t.id === balance.id)
    if (!b?.balance) return 0
    const problem = balanceProblem(b, tables)
    if (problem) throw new HttpError(422, 'invalid', problem)
    const l = (await sourcesFor(b, tables))
    const run = async () => {
      const B = T(b)
      const M = T(l.movements)
      await db().query(`LOCK TABLE ${B} IN SHARE ROW EXCLUSIVE MODE`)
      const keysM = l.spec.keys.map((k) => `m.${quoteId(k.from)}`)
      const notBlank = l.spec.keys.map((k) => `m.${quoteId(k.from)} IS NOT NULL AND m.${quoteId(k.from)}::text <> ''`).join(' AND ')
      const sums = await db().query<Row>(`SELECT ${keysM.map((k, i) => `${k}::text AS "k${i}"`).join(', ')}, COALESCE(sum(m.${quoteId(l.spec.quantity)}), 0) AS "s" FROM ${M} m WHERE ${notBlank}${live(l.movements, 'm.')} GROUP BY ${keysM.join(', ')}`)
      const have = await db().query<Row>(`SELECT "id", ${l.spec.keys.map((k, i) => `${quoteId(k.column)}::text AS "k${i}"`).join(', ')}, ${quoteId(l.spec.column)} AS "q" FROM ${B} WHERE TRUE${live(b)}`)
      const keyStr = (r: Row) => JSON.stringify(l.spec.keys.map((_, i) => String(r[`k${i}`])))
      const want = new Map(sums.map((r) => [keyStr(r), { key: l.spec.keys.map((_, i) => String(r[`k${i}`])), s: num(r.s) }]))
      let n = 0
      const done = new Set<string>()
      for (const r of have) {
        const k = keyStr(r)
        const target = want.get(k)?.s ?? 0
        if (done.has(k)) continue
        done.add(k)
        if (num(r.q) !== target || blank(r.q)) {
          await db().query(`UPDATE ${B} SET ${quoteId(l.spec.column)} = $1, "modifiedOn" = now() WHERE "id" = $2`, [target, String(r.id)])
          n++
        }
      }
      for (const [k, w] of want) {
        if (done.has(k) || fx(w.s) === 0) continue
        await apply([{ ...l, floor: null }], [], [{ id: 'reconcile', [l.spec.quantity]: w.s, ...Object.fromEntries(l.spec.keys.map((kk, i) => [kk.from, w.key[i]])) }])
        n++
      }
      return n
    }
    return db().tx(() => run())
  }

  async function sourcesFor(b: TableDef, tables: TableDef[]): Promise<Ledger> {
    const mv = tables.find((t) => t.id === b.balance!.movements) ?? tables.find((t) => lc(t.name) === lc(b.balance!.movements))!
    const ls = await sources(mv)
    const l = ls.find((x) => x.balance.id === b.id)
    if (!l) throw new HttpError(422, 'invalid', `${b.displayName}: the balance is not set up.`)
    return l
  }

  return { sources, lock, read, apply, reconcile, maintainedColumns }
}
